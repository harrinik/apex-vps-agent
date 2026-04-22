/**
 * Apex Mail Cloud — VPS Agent v2
 *
 * Production-ready, autonomous daemon that bridges Supabase with
 * Postfix / Dovecot / OpenDKIM running on the VPS mail server.
 *
 * Architecture:
 *   - Supabase Realtime WebSocket → instant event processing
 *   - Priority job queue with idempotency + exponential-backoff retries
 *   - Periodic full-sync to recover from missed events
 *   - HTTP API for ops tooling, health checks, and Prometheus metrics
 *   - Graceful shutdown — drains in-flight jobs before exit
 */
import { Agent } from './core/Agent';
import { startApiServer } from './api/server';
import { logger } from './utils/logger';

const agent = new Agent();
let shuttingDown = false;

async function main(): Promise<void> {
  logger.info('[Main] apex-vps-agent v2 starting');

  await agent.start();
  await startApiServer(agent);

  logger.info('[Main] ready');
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info(`[Main] received ${signal}, shutting down gracefully…`);
  try {
    await agent.stop();
    logger.info('[Main] shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error('[Main] shutdown error', { error: (err as Error).message });
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  logger.error('[Main] uncaughtException', { error: err.message, stack: err.stack });
  // Give logger time to flush, then exit — PM2 will restart
  setTimeout(() => process.exit(1), 500);
});

process.on('unhandledRejection', (reason) => {
  logger.error('[Main] unhandledRejection', { reason: String(reason) });
});

main().catch((err) => {
  logger.error('[Main] fatal startup error', { error: (err as Error).message });
  process.exit(1);
});