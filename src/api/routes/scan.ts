import { Router, Request, Response } from 'express';
import { bearerAuth } from '../middleware/auth';
import { VirusScanner } from '../../services/VirusScanner';
import { exec } from '../../utils/exec';
import { logger } from '../../utils/logger';
import { unlink } from 'fs/promises';
import { tmpdir } from 'os';

const router = Router();
const scanner = new VirusScanner();

// Apply auth middleware
router.use(bearerAuth);

interface ScanRequest {
  storage_path: string;
  filename: string;
  size?: number;
}

/**
 * POST /api/scan
 * Scan a file downloaded from Supabase Storage
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { storage_path, filename, size }: ScanRequest = req.body;

    if (!storage_path || !filename) {
      return res.status(400).json({ error: 'Missing storage_path or filename' });
    }

    // Skip files > 50MB (configurable)
    const MAX_SCAN_SIZE = 50 * 1024 * 1024;
    if (size && size > MAX_SCAN_SIZE) {
      logger.info('[Scan] File too large, skipping', { filename, size });
      return res.json({
        infected: false,
        skipped: true,
        reason: 'File exceeds 50MB limit'
      });
    }

    // Download file from Supabase to temp location
    const tempPath = `${tmpdir()}/${Date.now()}-${filename}`;
    logger.info('[Scan] Downloading file from Supabase', { storage_path, tempPath });

    // Download using curl (faster than Node fetch for large files)
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    
    await exec(
      `curl -s -H "Authorization: Bearer ${supabaseKey}" ` +
      `"${supabaseUrl}/storage/v1/object/email-attachments/${storage_path}" ` +
      `-o "${tempPath}"`
    );

    // Scan the file
    const result = await scanner.scanFile(tempPath);

    // Clean up temp file
    await unlink(tempPath).catch(err => {
      logger.warn('[Scan] Failed to delete temp file', { error: (err as Error).message });
    });

    logger.info('[Scan] Scan complete', { filename, infected: result.infected });
    return res.json(result);

  } catch (error) {
    logger.error('[Scan] Scan error', { error: (error as Error).message });
    return res.status(500).json({ 
      error: 'Scan failed',
      infected: false, // Fail-safe: allow file on error
      skipped: true,
      reason: 'Scan service error'
    });
  }
});

/**
 * POST /api/scan/batch
 * Scan multiple files concurrently
 */
router.post('/batch', async (req: Request, res: Response) => {
  try {
    const { files }: { files: Array<{ storage_path: string; filename: string; size?: number }> } = req.body;

    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'Missing or invalid files array' });
    }

    if (files.length > 1000) {
      return res.status(400).json({ error: 'Maximum 1000 files per batch' });
    }

    logger.info('[Scan] Batch scan started', { count: files.length });

    // Download all files to temp directory
    const tempDir = `${tmpdir()}/batch-${Date.now()}`;
    await exec(`mkdir -p "${tempDir}"`);

    const downloadPromises = files.map(async (file, index) => {
      const tempPath = `${tempDir}/${index}-${file.filename}`;
      const supabaseUrl = process.env.SUPABASE_URL;
      const supabaseKey = process.env.SUPABASE_SERVICE_KEY_KEY;
      
      try {
        await exec(
          `curl -s -H "Authorization: Bearer ${supabaseKey}" ` +
          `"${supabaseUrl}/storage/v1/object/email-attachments/${file.storage_path}" ` +
          `-o "${tempPath}"`
        );
        return { storage_path: file.storage_path, tempPath };
      } catch (err) {
        logger.error('[Scan] Download failed', { file: file.filename, error: (err as Error).message });
        return null;
      }
    });

    const downloadedFiles = (await Promise.all(downloadPromises)).filter(Boolean) as Array<{
      storage_path: string;
      tempPath: string;
    }>;

    // Scan all files concurrently
    const filePaths = downloadedFiles.map(f => f.tempPath);
    const scanResults = await scanner.scanBatch(filePaths);

    // Map results back to storage paths
    const results = files.map(file => {
      const downloaded = downloadedFiles.find(d => d.storage_path === file.storage_path);
      const scanResult = downloaded ? scanResults.get(downloaded.tempPath) : null;
      
      return {
        storage_path: file.storage_path,
        filename: file.filename,
        infected: scanResult?.infected || false,
        threat_name: scanResult?.threat_name,
        scanned_at: scanResult?.scanned_at,
      };
    });

    // Clean up temp directory
    await exec(`rm -rf "${tempDir}"`).catch(err => {
      logger.warn('[Scan] Failed to cleanup temp dir', { error: (err as Error).message });
    });

    logger.info('[Scan] Batch scan complete', { count: files.length });
    return res.json({ results });

  } catch (error) {
    logger.error('[Scan] Batch scan error', { error: (error as Error).message });
    return res.status(500).json({ error: 'Batch scan failed' });
  }
});

/**
 * GET /api/scan/health
 * Health check for virus scanner
 */
router.get('/health', async (_req: Request, res: Response) => {
  try {
    // Check if clamd is running
    const { stdout } = await exec('systemctl is-active clamav-freshclam || systemctl is-active clamav-daemon');
    
    return res.json({
      status: 'healthy',
      clamav: stdout.trim(),
      cache_size: Object.keys((scanner as any).cache || {}).length,
    });
  } catch (error) {
    return res.status(503).json({
      status: 'unhealthy',
      error: (error as Error).message,
    });
  }
});

export default router;
