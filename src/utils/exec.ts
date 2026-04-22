import { exec as nodeExec } from 'child_process';
import { promisify } from 'util';
import { logger } from './logger';

const execAsync = promisify(nodeExec);

export interface ExecResult {
  stdout: string;
  stderr: string;
}

/**
 * Safe shell executor — always awaited, logs command + duration.
 * Never lets a failed command silently pass.
 */
export async function exec(cmd: string, timeoutMs = 30_000): Promise<ExecResult> {
  const start = Date.now();
  logger.debug('[exec] run', { cmd });
  try {
    const result = await execAsync(cmd, { timeout: timeoutMs });
    logger.debug('[exec] done', { cmd, ms: Date.now() - start });
    return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    logger.error('[exec] failed', { cmd, error: e.message, stderr: e.stderr });
    throw new Error(`Command failed: ${cmd}\n${e.stderr || e.message}`);
  }
}

/** Returns true if a binary exists on PATH */
export async function commandExists(binary: string): Promise<boolean> {
  try {
    await execAsync(`which ${binary}`);
    return true;
  } catch {
    return false;
  }
}