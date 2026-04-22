import { EventEmitter } from 'events';
import { logger } from '../utils/logger';
import { retry } from '../utils/retry';
import { idempotencyStore } from '../utils/idempotency';

export type JobType =
  | 'mailbox:create'
  | 'mailbox:delete'
  | 'mailbox:update_password'
  | 'domain:add'
  | 'domain:remove'
  | 'dkim:generate'
  | 'dkim:rotate'
  | 'postfix:reload'
  | 'full:sync';

export type JobPriority = 'high' | 'normal' | 'low';

export interface Job<T = unknown> {
  id: string;
  type: JobType;
  payload: T;
  priority: JobPriority;
  attempts: number;
  createdAt: number;
}

type Handler<T = unknown> = (job: Job<T>) => Promise<void>;

/**
 * Priority job queue with per-type handlers, concurrency controls,
 * exponential-backoff retries, and idempotency deduplication.
 *
 * Designed for single-process use (PM2 cluster = 1 instance per VPS).
 */
export class JobQueue extends EventEmitter {
  private readonly queues: Record<JobPriority, Job[]> = {
    high:   [],
    normal: [],
    low:    [],
  };

  private readonly handlers = new Map<JobType, Handler>();
  private readonly concurrency: number;
  private running = 0;
  private draining = false;

  constructor(concurrency = 20) {
    super();
    this.concurrency = concurrency;
  }

  /** Register a handler for a job type */
  handle<T>(type: JobType, handler: Handler<T>): void {
    this.handlers.set(type, handler as Handler);
  }

  /**
   * Enqueue a job.
   * @param idempotencyKey  If provided, duplicate jobs within TTL are silently dropped.
   */
  enqueue<T>(
    type: JobType,
    payload: T,
    options: { priority?: JobPriority; idempotencyKey?: string } = {},
  ): string | null {
    if (this.draining) {
      logger.warn('[Queue] draining — rejecting new job', { type });
      return null;
    }

    const key = options.idempotencyKey ?? `${type}:${JSON.stringify(payload)}`;
    if (!idempotencyStore.tryMarkSeen(key)) {
      logger.debug('[Queue] duplicate job skipped', { type, key });
      return null;
    }

    const job: Job<T> = {
      id:        key,
      type,
      payload,
      priority:  options.priority ?? 'normal',
      attempts:  0,
      createdAt: Date.now(),
    };

    this.queues[job.priority].push(job as Job);
    logger.debug('[Queue] enqueued', { type, id: job.id, priority: job.priority });
    this.emit('job:enqueued', job);
    setImmediate(() => this.tick());
    return job.id;
  }

  /** Total pending jobs across all priorities */
  get pending(): number {
    return this.queues.high.length + this.queues.normal.length + this.queues.low.length;
  }

  /** Graceful drain — resolves when all in-flight jobs complete */
  async drain(): Promise<void> {
    this.draining = true;
    logger.info('[Queue] draining…', { pending: this.pending, running: this.running });
    if (this.running === 0 && this.pending === 0) return;
    return new Promise(resolve => {
      const check = () => {
        if (this.running === 0 && this.pending === 0) resolve();
      };
      this.on('job:done',   check);
      this.on('job:failed', check);
    });
  }

  private dequeue(): Job | undefined {
    for (const priority of ['high', 'normal', 'low'] as JobPriority[]) {
      if (this.queues[priority].length) return this.queues[priority].shift();
    }
    return undefined;
  }

  private tick(): void {
    while (this.running < this.concurrency) {
      const job = this.dequeue();
      if (!job) break;
      this.run(job);
    }
  }

  private async run(job: Job): Promise<void> {
    this.running++;
    const handler = this.handlers.get(job.type);

    if (!handler) {
      logger.error('[Queue] no handler registered', { type: job.type });
      this.running--;
      this.emit('job:failed', job, new Error('No handler'));
      this.tick();
      return;
    }

    try {
      await retry(() => handler(job), {
        label:       job.type,
        maxAttempts: 5,
        onRetry:     (attempt) => { job.attempts = attempt; },
      });

      const ms = Date.now() - job.createdAt;
      logger.info('[Queue] job done', { type: job.type, id: job.id, ms });
      this.emit('job:done', job);
    } catch (err) {
      logger.error('[Queue] job permanently failed', {
        type:    job.type,
        id:      job.id,
        error:   err instanceof Error ? err.message : String(err),
        attempts: job.attempts,
      });
      this.emit('job:failed', job, err);
    } finally {
      this.running--;
      this.tick();
    }
  }
}