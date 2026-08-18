import type { UsageEvent } from "./event";

/**
 * The ingestion buffer.
 *
 * Metered usage arrives one event at a time and in volume, and this Medusa talks
 * to Postgres over the internet rather than over a socket on the same box. A
 * round trip per event is not a performance detail there, it is the difference
 * between metering a request and not being able to. So `record` puts the event
 * here and returns, and the writes leave in batches.
 *
 * What that trades away, stated plainly: events sitting in this buffer are in
 * memory only. A SIGKILL loses them. That is the acceptable side of the asymmetry
 * this plugin is built around - usage that is missing is a visibly small number,
 * usage that is counted twice is an invoice that is quietly wrong - and the
 * exposure is bounded by the flush interval, by the batch size, and by the flush
 * on shutdown. A host that will not accept even that can set
 * `flushMode: "immediate"` and pay the round trip.
 *
 * The buffer is deliberately a plain, synchronous, testable object: no timers, no
 * promises, no I/O. Deciding *when* to flush is the service's job; this only
 * knows what is waiting.
 */

/** When a flush should happen. All three are plugin options. */
export interface UsageBufferPolicy {
  /** Flush as soon as this many events are waiting. */
  batchSize: number;
  /** Flush when the oldest waiting event is this old, however few there are. */
  flushIntervalMs: number;
  /**
   * Hard ceiling on events held in memory. Reaching it is back pressure, not a
   * drop: the caller is made to wait for a flush, and told to retry if that
   * flush fails. Retrying is safe precisely because keys are derived.
   */
  maxBufferedEvents: number;
}

export interface UsageBufferAdmission {
  /** Events now waiting to be written. */
  queued: number;
  /**
   * Events discarded because an event with the same key was already waiting.
   * The first line of defence against a double count, and the cheapest: a retry
   * that lands inside the same flush window never reaches the database at all.
   */
  deduplicated: number;
}

export class UsageBuffer {
  /**
   * Insertion-ordered, keyed by deduplication key. The Map does double duty: it
   * preserves the order events arrived in, and it makes a duplicate inside the
   * current window free to detect.
   */
  private readonly waiting = new Map<string, UsageEvent>();

  /** When the oldest currently-waiting event was admitted. Drives the age flush. */
  private oldestAt: number | null = null;

  /**
   * When the oldest event of the batch currently being written was admitted.
   *
   * Kept separately so a batch that fails and comes back keeps the age it had.
   * Without it, a batch that fails repeatedly would restart its own clock on
   * every attempt and could sit unwritten indefinitely while newer events flushed
   * around it.
   */
  private inFlightOldestAt: number | null = null;

  get size(): number {
    return this.waiting.size;
  }

  /** Milliseconds the oldest waiting event has been waiting, or 0 when empty. */
  ageMs(now: number): number {
    return this.oldestAt === null ? 0 : Math.max(0, now - this.oldestAt);
  }

  /** True when this key is already waiting to be written. */
  has(key: string): boolean {
    return this.waiting.has(key);
  }

  /**
   * Admit events.
   *
   * A key already waiting is dropped rather than replacing what is there: the two
   * are the same event by definition, and keeping the first preserves its
   * position in the queue.
   */
  add(events: readonly UsageEvent[], now: number): UsageBufferAdmission {
    let deduplicated = 0;
    for (const event of events) {
      if (this.waiting.has(event.key)) {
        deduplicated += 1;
        continue;
      }
      this.waiting.set(event.key, event);
      this.oldestAt ??= now;
    }
    return { deduplicated, queued: this.waiting.size };
  }

  /**
   * Take up to `limit` events, oldest first, and remove them.
   *
   * They are gone from the buffer while the write is in flight. If the write
   * fails, the caller hands them back with `requeue`.
   */
  takeBatch(limit: number): UsageEvent[] {
    const previousOldestAt = this.oldestAt;
    const batch: UsageEvent[] = [];
    for (const [key, event] of this.waiting) {
      if (batch.length >= limit) {
        break;
      }
      batch.push(event);
      this.waiting.delete(key);
    }
    this.inFlightOldestAt = batch.length > 0 ? previousOldestAt : null;
    // What is left is younger than what was taken, but this only ever makes the
    // remainder look older, which flushes it sooner. Erring that way is free;
    // erring the other way delays a write.
    this.oldestAt = this.waiting.size === 0 ? null : previousOldestAt;
    return batch;
  }

  /**
   * Put a failed batch back at the front, keeping its order.
   *
   * A batch that failed to write must be retried before newer events, so that a
   * persistent failure cannot starve the oldest usage into never being written.
   * An event that arrived again in the meantime is already present under the same
   * key, and the returning copy is dropped in favour of it - either way exactly
   * one survives.
   */
  requeue(events: readonly UsageEvent[], now: number): void {
    if (events.length === 0) {
      return;
    }
    const newer = [...this.waiting.entries()];
    this.waiting.clear();
    for (const event of events) {
      this.waiting.set(event.key, event);
    }
    for (const [key, event] of newer) {
      if (!this.waiting.has(key)) {
        this.waiting.set(key, event);
      }
    }
    // The returning events are older than anything admitted since, so the clock
    // goes back to when they were first admitted rather than to now - a batch
    // that keeps failing must not keep pushing its own deadline out.
    this.oldestAt = Math.min(this.inFlightOldestAt ?? now, this.oldestAt ?? now);
    this.inFlightOldestAt = null;
  }

  /** Drop everything. Only used when a buffer is being abandoned outright. */
  clear(): void {
    this.waiting.clear();
    this.oldestAt = null;
    this.inFlightOldestAt = null;
  }
}

/** True when the buffer has reached either flush trigger. */
export function shouldFlush(
  state: { size: number; ageMs: number },
  policy: Pick<UsageBufferPolicy, "batchSize" | "flushIntervalMs">,
): boolean {
  if (state.size === 0) {
    return false;
  }
  return state.size >= policy.batchSize || state.ageMs >= policy.flushIntervalMs;
}
