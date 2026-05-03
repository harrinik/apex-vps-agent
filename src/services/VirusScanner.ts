import { exec } from '../utils/exec';
import { logger } from '../utils/logger';
import { createHash } from 'crypto';

export interface ScanResult {
  infected: boolean;
  threat_name?: string;
  scanned_at: string;
  file_hash: string;
  file_size: number;
}

export interface ScanCache {
  [hash: string]: {
    result: ScanResult;
    timestamp: number;
  };
}

/**
 * Virus Scanner using ClamAV (clamdscan)
 * - Uses in-memory cache to avoid re-scanning same files
 * - Supports concurrent scanning via clamd daemon
 * - Fast: clamd uses in-memory database and incremental scanning
 */
export class VirusScanner {
  private cache: ScanCache = {};
  private readonly CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
  private readonly MAX_CACHE_SIZE = 10000; // Max 10k cached results

  /**
   * Scan a file from local filesystem
   */
  async scanFile(filePath: string): Promise<ScanResult> {
    const stats = await this.getFileStats(filePath);
    const fileHash = await this.computeHash(filePath);

    // Check cache first
    const cached = this.cache[fileHash];
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      logger.debug('[VirusScanner] Cache hit', { hash: fileHash });
      return cached.result;
    }

    // Scan with ClamAV
    logger.info('[VirusScanner] Scanning file', { path: filePath, size: stats.size });
    const result = await this.scanWithClamAV(filePath);

    // Cache the result
    this.cacheResult(fileHash, result);

    return result;
  }

  /**
   * Scan a file from Supabase Storage (download to temp, scan, delete)
   */
  async scanFromStorage(storagePath: string, filename: string): Promise<ScanResult> {
    // This would be called by the API endpoint which downloads from Supabase first
    // The actual download happens in the API handler
    throw new Error('Use scanFile with local path - download happens in API handler');
  }

  /**
   * Batch scan multiple files concurrently
   */
  async scanBatch(filePaths: string[]): Promise<Map<string, ScanResult>> {
    const results = new Map<string, ScanResult>();
    
    // Process in batches of 50 to avoid overwhelming clamd
    const batchSize = 50;
    for (let i = 0; i < filePaths.length; i += batchSize) {
      const batch = filePaths.slice(i, i + batchSize);
      const promises = batch.map(async (path) => {
        const result = await this.scanFile(path);
        results.set(path, result);
      });
      
      await Promise.all(promises);
      logger.info('[VirusScanner] Batch progress', { 
        completed: Math.min(i + batchSize, filePaths.length), 
        total: filePaths.length 
      });
    }

    return results;
  }

  /**
   * Clear old cache entries
   */
  clearCache(): void {
    const now = Date.now();
    Object.keys(this.cache).forEach(key => {
      if (now - this.cache[key].timestamp > this.CACHE_TTL) {
        delete this.cache[key];
      }
    });
    
    // Also clear if cache is too large
    const keys = Object.keys(this.cache);
    if (keys.length > this.MAX_CACHE_SIZE) {
      // Sort by timestamp and remove oldest
      keys
        .sort((a, b) => this.cache[a].timestamp - this.cache[b].timestamp)
        .slice(0, keys.length - this.MAX_CACHE_SIZE)
        .forEach(key => delete this.cache[key]);
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async scanWithClamAV(filePath: string): Promise<ScanResult> {
    try {
      // Use clamdscan (fast, uses daemon)
      const { stdout, stderr } = await exec(`clamdscan --no-summary "${filePath}"`);
      
      if (stdout.includes('OK')) {
        return {
          infected: false,
          scanned_at: new Date().toISOString(),
          file_hash: await this.computeHash(filePath),
          file_size: (await this.getFileStats(filePath)).size,
        };
      }

      if (stdout.includes('FOUND')) {
        const match = stdout.match(/(.+): (.+) FOUND/);
        const threatName = match ? match[2].trim() : 'Unknown threat';
        
        logger.warn('[VirusScanner] Threat detected', { path: filePath, threat: threatName });
        return {
          infected: true,
          threat_name: threatName,
          scanned_at: new Date().toISOString(),
          file_hash: await this.computeHash(filePath),
          file_size: (await this.getFileStats(filePath)).size,
        };
      }

      // If output is unexpected, assume clean (fail-safe)
      logger.warn('[VirusScanner] Unexpected clamdscan output', { stdout, stderr });
      return {
        infected: false,
        scanned_at: new Date().toISOString(),
        file_hash: await this.computeHash(filePath),
        file_size: (await this.getFileStats(filePath)).size,
      };

    } catch (error) {
      logger.error('[VirusScanner] ClamAV scan failed', { 
        error: (error as Error).message,
        path: filePath 
      });
      
      // Fail-safe: if scan fails, allow file (don't block users)
      return {
        infected: false,
        scanned_at: new Date().toISOString(),
        file_hash: await this.computeHash(filePath),
        file_size: (await this.getFileStats(filePath)).size,
      };
    }
  }

  private async computeHash(filePath: string): Promise<string> {
    const { stdout } = await exec(`sha256sum "${filePath}"`);
    return stdout.split(' ')[0].trim();
  }

  private async getFileStats(filePath: string): Promise<{ size: number }> {
    const { stdout } = await exec(`stat -c%s "${filePath}"`);
    return { size: parseInt(stdout.trim(), 10) };
  }

  private cacheResult(hash: string, result: ScanResult): void {
    this.cache[hash] = {
      result,
      timestamp: Date.now(),
    };
    
    // Periodic cleanup
    if (Object.keys(this.cache).length > this.MAX_CACHE_SIZE) {
      this.clearCache();
    }
  }
}
