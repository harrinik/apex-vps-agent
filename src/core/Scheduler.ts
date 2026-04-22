import { logger } from '../utils/logger';

interface ScheduledTask {
  id: string;
  intervalMs: number;
  fn: () => void | Promise<void>;
  lastRun: number;
  timer?: NodeJS.Timeout;
}

/**
 * Lightweight cron-style scheduler.
 * Each task runs at its interval independently — a slow task
 * does NOT delay other tasks (non-blocking).
 */
export class Scheduler {
  private readonly tasks = new Map<string, ScheduledTask>();

  /** Register a recurring task */
  register(id: string, intervalMs: number, fn: () => void | Promise<void>): void {
    if (this.tasks.has(id)) {
      logger.warn('[Scheduler] task already registered, replacing', { id });
      this.unregister(id);
    }
    const task: ScheduledTask = { id, intervalMs, fn, lastRun: 0 };
    this.tasks.set(id, task);
    logger.info('[Scheduler] registered task', { id, intervalMs });
  }

  /** Start all registered tasks. Runs each task once immediately, then on interval */
  start(): void {
    for (const task of this.tasks.values()) {
      this.schedule(task);
    }
    logger.info('[Scheduler] started', { tasks: this.tasks.size });
  }

  /** Stop all tasks */
  stop(): void {
    for (const task of this.tasks.values()) {
      if (task.timer) clearTimeout(task.timer);
    }
    logger.info('[Scheduler] stopped');
  }

  unregister(id: string): void {
    const task = this.tasks.get(id);
    if (task?.timer) clearTimeout(task.timer);
    this.tasks.delete(id);
  }

  private schedule(task: ScheduledTask): void {
    const run = async () => {
      const start = Date.now();
      try {
        await task.fn();
        task.lastRun = Date.now();
        logger.debug('[Scheduler] task ran', { id: task.id, ms: Date.now() - start });
      } catch (err) {
        logger.error('[Scheduler] task error', {
          id: task.id,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        // Schedule next run, regardless of success/failure
        task.timer = setTimeout(() => run(), task.intervalMs);
      }
    };

    // Run immediately on first start
    setImmediate(() => run());
  }
}