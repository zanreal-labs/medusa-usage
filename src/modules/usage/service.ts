import { MedusaError, MedusaService } from "@medusajs/framework/utils";
import type { ResolvedUsageOptions, UsagePluginOptions } from "../../lib/options";
import { resolveUsageOptions } from "../../lib/options";
import { selectSinkId, sinkRegistrationKey } from "../../lib/sink/registry";
import type {
  UsageAggregateQuery,
  UsageEventPage,
  UsageListQuery,
  UsageSinkProvider,
} from "../../lib/sink/types";
import { USAGE_SINK_IDENTIFIERS } from "../../lib/sink/types";
import { shouldFlush, UsageBuffer } from "../../lib/usage/buffer";
import type { UsageEvent, UsageEventInput } from "../../lib/usage/event";
import { normalizeUsageEvent } from "../../lib/usage/event";
import type { UsageSnapshot } from "../../lib/usage/snapshot";
import { assertUsageWindow, buildUsageSnapshot } from "../../lib/usage/snapshot";
import UsageEventModel from "./models/usage-event";

/**
 * The usage module.
 *
 * Two jobs, and nothing else:
 *
 * 1. **Take usage in cheaply.** `record` validates, keys and buffers; batches
 *    leave for the sink on a size or age trigger. This Medusa talks to its
 *    database over the internet, so a round trip per event is not a tuning
 *    question, it is the difference between being able to meter and not.
 *
 * 2. **Answer questions about the log.** `aggregate` returns an immutable
 *    snapshot computed from the events every time, never from a running counter,
 *    so the number behind an invoice can be re-derived and checked long after the
 *    invoice was sent.
 *
 * Where the events are stored is the sink's business (see
 * `src/lib/sink/types.ts`). What happens to the number afterwards is the host's.
 * This service is the seam between those two, and it deliberately knows nothing
 * about either.
 */

/** What one `record` call did. */
export interface RecordUsageResult {
  /** One key per input event, in the order they were given. */
  keys: string[];
  /** Events admitted. */
  accepted: number;
  /** Events dropped because the same key was already waiting to be written. */
  deduplicated: number;
  /** Events waiting to be written after this call. Always 0 in `immediate` mode. */
  buffered: number;
  /** Rows appended, when the call wrote through. Null when it only buffered. */
  written: number | null;
}

/** What one flush did. */
export interface FlushSummary {
  batches: number;
  /** Events handed to the sink. */
  submitted: number;
  /** Rows the sink appended. */
  appended: number;
  /** Events the sink already had. Not an error. */
  duplicates: number;
}

/** The plugin's operational state, for an admin surface or a health check. */
export interface UsageStatus {
  /** The sink events are being written to. */
  sink: string;
  /** Every registered sink. */
  sinks: string[];
  flushMode: ResolvedUsageOptions["flushMode"];
  batchSize: number;
  flushIntervalMs: number;
  /** Events currently waiting in memory. */
  buffered: number;
  /** How long the oldest of them has been waiting. */
  oldestBufferedMs: number;
  lastFlushAt: string | null;
  /** The last flush failure, cleared by the next flush that succeeds. */
  lastFlushError: string | null;
}

/** The slice of the module container this service reaches into. */
type ModuleCradle = Record<string, unknown>;

export default class UsageModuleService extends MedusaService({
  UsageEvent: UsageEventModel,
}) {
  private readonly options: ResolvedUsageOptions;
  private readonly cradle: ModuleCradle;
  private readonly buffer = new UsageBuffer();

  /**
   * The in-flight flush, if any. Flushes are serialized rather than allowed to
   * overlap: two concurrent drains would interleave batches, and a failure in one
   * would requeue events the other had already taken.
   */
  private flushing: Promise<FlushSummary> | null = null;

  /** Fires the age-based flush. Unreferenced, so it never holds the process open. */
  private timer: ReturnType<typeof setInterval> | null = null;

  private lastFlushAt: Date | null = null;
  private lastFlushError: string | null = null;

  constructor(cradle: ModuleCradle, moduleOptions?: Partial<UsagePluginOptions>) {
    // MedusaService's generated base reads the full argument list.
    super(...arguments);
    this.cradle = cradle ?? {};
    // Resolved here as well as in the loader. The loader is what turns a bad
    // option into a readable boot failure; this is what guarantees no code path
    // downstream ever sees a half-applied option object.
    this.options = resolveUsageOptions(moduleOptions);
  }

  /**
   * Flush anything still buffered when the application is shutting down.
   *
   * The one moment where a graceful stop can turn a bounded loss into no loss at
   * all. It cannot help a `SIGKILL`, and nothing can - that is the stated cost of
   * buffering, and the reason `flushMode: "immediate"` exists.
   */
  get __hooks(): { onApplicationShutdown: () => Promise<void> } {
    return {
      onApplicationShutdown: async (): Promise<void> => {
        this.stopTimer();
        if (this.buffer.size === 0) {
          return;
        }
        await this.flush();
      },
    };
  }

  /** The resolved options. No secrets in here; safe to serialize. */
  get resolvedOptions(): ResolvedUsageOptions {
    return this.options;
  }

  /**
   * Record usage.
   *
   * Returns as soon as the events are validated, keyed and queued - the write
   * happens on a batch. Every returned key is deterministic, which is what makes
   * a retry of this call safe: the same events produce the same keys and the sink
   * keeps one row per key, so calling twice cannot count twice.
   */
  async record(input: UsageEventInput | UsageEventInput[]): Promise<RecordUsageResult> {
    const inputs = Array.isArray(input) ? input : [input];
    if (inputs.length === 0) {
      return { accepted: 0, buffered: this.buffer.size, deduplicated: 0, keys: [], written: null };
    }
    if (inputs.length > this.options.maxEventsPerCall) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `medusa-usage: ${inputs.length} events in one call, over the \`maxEventsPerCall\` limit of ${this.options.maxEventsPerCall}. Split the batch; the keys are derived, so a split cannot double count.`,
      );
    }

    const now = new Date();
    // Validated before anything is queued, so one bad event rejects the call
    // rather than half-applying it.
    const events = inputs.map((entry) => normalizeUsageEvent(entry, now));
    const keys = events.map((event) => event.key);

    if (this.options.flushMode === "immediate") {
      const written = await this.writeThrough(events);
      return {
        accepted: written.submitted,
        buffered: 0,
        deduplicated: events.length - written.submitted,
        keys,
        written: written.appended,
      };
    }

    const admission = this.buffer.add(events, now.getTime());
    this.startTimer();

    if (this.buffer.size >= this.options.maxBufferedEvents) {
      // Back pressure, not a drop: the caller waits for the writer to catch up.
      // If that flush fails the error reaches the caller, who can retry safely.
      await this.flush();
    } else if (shouldFlush({ ageMs: this.buffer.ageMs(now.getTime()), size: this.buffer.size }, this.options)) {
      // Deliberately not awaited: a full batch should leave now, but the caller
      // recording usage should not wait for the database to acknowledge it. A
      // failure is captured on the service and retried from the buffer.
      void this.flush().catch(() => undefined);
    }

    return {
      accepted: events.length - admission.deduplicated,
      buffered: this.buffer.size,
      deduplicated: admission.deduplicated,
      keys,
      written: null,
    };
  }

  /**
   * Write everything currently buffered.
   *
   * Serialized: a call made while a flush is running waits for it and then drains
   * whatever is left, so a caller that needs the buffer empty (taking a snapshot,
   * shutting down) gets that guarantee.
   */
  async flush(): Promise<FlushSummary> {
    const next = (this.flushing ?? Promise.resolve(emptyFlush()))
      .catch(() => emptyFlush())
      .then(async () => this.drain());
    this.flushing = next;
    try {
      return await next;
    } finally {
      if (this.flushing === next) {
        this.flushing = null;
      }
    }
  }

  /**
   * Usage for one meter, one subject and one half-open window, as an immutable
   * snapshot.
   *
   * Buffered events are flushed first. Without that, a snapshot taken moments
   * after the usage it covers would silently miss whatever had not been written
   * yet, and the number would be wrong in the one direction that matters least
   * but is hardest to explain.
   *
   * That guarantee is local to this process. Another instance of the application
   * has its own buffer, and this cannot reach it - so a window should be closed
   * before it is snapshotted, by at least the flush interval. That is a property
   * of running more than one process, not of this plugin, and pretending
   * otherwise would be worse than saying it.
   */
  async aggregate(query: UsageAggregateQuery): Promise<UsageSnapshot> {
    assertUsageWindow(query.from, query.to);
    await this.flush();
    const sinkId = await this.activeSinkId();
    const sink = await this.resolveSink();
    const result = await sink.aggregate(query);
    return buildUsageSnapshot(query, result, sinkId, new Date());
  }

  /**
   * The events behind an aggregate, oldest first.
   *
   * The audit path: whoever disputes a number gets the rows it was computed from,
   * not a recomputation of it.
   */
  async listEvents(query: UsageListQuery): Promise<UsageEventPage> {
    assertUsageWindow(query.from, query.to);
    await this.flush();
    const sink = await this.resolveSink();
    return sink.listEvents(query);
  }

  /** Operational state. Cheap, and safe to expose over an authenticated route. */
  async getStatus(): Promise<UsageStatus> {
    return {
      batchSize: this.options.batchSize,
      buffered: this.buffer.size,
      flushIntervalMs: this.options.flushIntervalMs,
      flushMode: this.options.flushMode,
      lastFlushAt: this.lastFlushAt?.toISOString() ?? null,
      lastFlushError: this.lastFlushError,
      oldestBufferedMs: this.buffer.ageMs(Date.now()),
      sink: await this.activeSinkId(),
      sinks: this.registeredSinkIds(),
    };
  }

  /** The sink currently being written to. Throws with instructions if ambiguous. */
  async resolveSink(): Promise<UsageSinkProvider> {
    const id = selectSinkId(this.registeredSinkIds(), this.options.sink);
    const sink = this.cradle[sinkRegistrationKey(id)] as UsageSinkProvider | undefined;
    if (!sink) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `medusa-usage: the sink "${id}" is listed as registered but could not be resolved from the module container. This is a wiring failure in the provider package, not a configuration mistake.`,
      );
    }
    return sink;
  }

  /** Which sink id is in effect. Separated so `getStatus` can report it. */
  private async activeSinkId(): Promise<string> {
    return selectSinkId(this.registeredSinkIds(), this.options.sink);
  }

  /**
   * The registered sink ids.
   *
   * An unregistered key means no provider loaded at all, which `selectSinkId`
   * turns into a message about configuration rather than an awilix stack trace.
   */
  private registeredSinkIds(): string[] {
    try {
      const ids = this.cradle[USAGE_SINK_IDENTIFIERS];
      return Array.isArray(ids) ? (ids as string[]) : [];
    } catch {
      return [];
    }
  }

  /** Write a batch straight through, for `flushMode: "immediate"`. */
  private async writeThrough(events: readonly UsageEvent[]): Promise<{
    submitted: number;
    appended: number;
  }> {
    // Two identical events inside one call are one event; the sink would reject
    // the second anyway, and deduplicating here keeps the statement smaller.
    const distinct = [...new Map(events.map((event) => [event.key, event])).values()];
    const sink = await this.resolveSink();
    const result = await sink.write(distinct);
    this.lastFlushAt = new Date();
    this.lastFlushError = null;
    return { appended: result.appended, submitted: distinct.length };
  }

  /** Drain the buffer batch by batch until it is empty or a write fails. */
  private async drain(): Promise<FlushSummary> {
    const summary = emptyFlush();
    if (this.buffer.size === 0) {
      return summary;
    }
    const sink = await this.resolveSink();

    while (this.buffer.size > 0) {
      const batch = this.buffer.takeBatch(this.options.batchSize);
      try {
        const result = await sink.write(batch);
        summary.batches += 1;
        summary.submitted += batch.length;
        summary.appended += result.appended;
        summary.duplicates += result.duplicates;
      } catch (error) {
        // The batch goes back to the front of the queue, ahead of anything newer,
        // so a persistent failure cannot starve the oldest usage. Retrying is safe
        // whatever the sink managed to persist before it failed, because the keys
        // are derived and the sink keeps one row per key.
        this.buffer.requeue(batch, Date.now());
        this.lastFlushError = error instanceof Error ? error.message : String(error);
        throw error;
      }
    }

    this.lastFlushAt = new Date();
    this.lastFlushError = null;
    return summary;
  }

  /**
   * Start the age-based flush.
   *
   * Lazy, so a process that never records usage never creates a timer, and
   * unreferenced, so a buffered event cannot keep a CLI or a one-shot script
   * alive. The scheduled job is the floor underneath this: it flushes even in a
   * process where nothing has called `record` since the last restart.
   */
  private startTimer(): void {
    if (this.timer !== null) {
      return;
    }
    this.timer = setInterval(() => {
      if (shouldFlush({ ageMs: this.buffer.ageMs(Date.now()), size: this.buffer.size }, this.options)) {
        void this.flush().catch(() => undefined);
      }
    }, this.options.flushIntervalMs);
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

const emptyFlush = (): FlushSummary => ({
  appended: 0,
  batches: 0,
  duplicates: 0,
  submitted: 0,
});
