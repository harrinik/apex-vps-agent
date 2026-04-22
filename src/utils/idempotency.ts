/**
 * In-memory idempotency store.
 *
 * Prevents the same job from being enqueued or executed twice
 * within a TTL window — critical for Realtime events which may
 * fire multiple times (reconnects, retries, etc.).
 */
export class IdempotencyStore {
  private readonly store = new Map<string, number>();
  private readonly ttlMs: number;

  constructor(ttlMs = 60_000) {
    this.ttlMs = ttlMs;
    // Purge expired keys every minute
    setInterval(() => this.purge(), 60_000).unref();
  }

  /** Returns true if this key was NOT already seen. Marks it as seen. */
  tryMarkSeen(key: string): boolean {
    const now = Date.now();
    if (this.store.has(key) && this.store.get(key)! > now) {
      return false; // already seen — duplicate
    }
    this.store.set(key, now + this.ttlMs);
    return true;
  }

  clear(key: string): void {
    this.store.delete(key);
  }

  private purge(): void {
    const now = Date.now();
    for (const [key, exp] of this.store) {
      if (exp <= now) this.store.delete(key);
    }
  }
}

export const idempotencyStore = new IdempotencyStore(120_000);