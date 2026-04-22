import { config } from '../config';
import { logger } from './logger';

/** Sleep for ms milliseconds */
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Retry an async operation with exponential backoff + full jitter.
 *
 * Jitter formula: random(0, base * 2^attempt)
 * This avoids thundering-herd when many jobs fail simultaneously.
 */
export async function retry<T>(
  fn: () => Promise<T>,
  {
    maxAttempts = config.MAX_JOB_RETRIES,
    baseDelayMs  = config.INITIAL_RETRY_DELAY_MS,
    label        = 'operation',
    onRetry,
  }: {
    maxAttempts?: number;
    baseDelayMs?: number;
    label?: string;
    onRetry?: (attempt: number, err: Error) => void;
  } = {},
): Promise<T> {
  let lastError!: Error;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt + 1 >= maxAttempts) break;

      // Full jitter: sleep random ms in [0, baseDelayMs * 2^attempt]
      const cap   = baseDelayMs * Math.pow(2, attempt);
      const delay = Math.floor(Math.random() * cap);

      logger.warn(`[retry] ${label} failed (attempt ${attempt + 1}/${maxAttempts}), retrying in ${delay}ms`, {
        error: lastError.message,
      });

      onRetry?.(attempt + 1, lastError);
      await sleep(delay);
    }
  }

  throw lastError;
}