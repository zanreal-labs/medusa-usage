import { MedusaError, MedusaService } from "@medusajs/framework/utils";
import type { BillingPeriod } from "../../lib/billing/period";
import { assertClosable, assertPeriodWindow, periodIdFor } from "../../lib/billing/period";
import type { RateCard } from "../../lib/billing/rates";
import { rateSnapshot, rerateLine } from "../../lib/billing/rating";
import type { ClosedPeriod, PeriodResult, PeriodVerification } from "../../lib/billing/result";
import { buildPeriodResult, verifyPeriodResult } from "../../lib/billing/result";
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
import type { ManagerLike } from "../../lib/sql/raw";
import type { UsageSnapshot } from "../../lib/usage/snapshot";
import { assertUsageWindow, buildUsageSnapshot } from "../../lib/usage/snapshot";
import BillingPeriodModel from "./models/billing-period";
import PeriodResultModel from "./models/period-result";
import type { PeriodQuery } from "./period-store";
import { PeriodStore } from "./period-store";
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
 * 3. **Close billing periods.** A period is a subject and a half-open window;
 *    closing one rates the usage inside it against the configured rate card and
 *    freezes the answer in a row that is never updated. That row is what a host
 *    bills from. Closing is idempotent through the same mechanism ingestion uses:
 *    an identity derived from meaning, and a primary key that refuses the second
 *    write.
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
  /**
   * The configured rate card, or null when the plugin only meters. Amounts are
   * included: a rate is not a secret, and an operator asking why an invoice came
   * out at that number should be able to see the price it was rated at without
   * reading the config file on a server.
   */
  rates: {
    currency: string;
    closeDelayMs: number;
    meters: { meter: string; unitAmount: number; perUnits: number; includedUnits: number }[];
  } | null;
}


/** Naming a period to open. The window is half-open, `[startsAt, endsAt)`. */
export interface OpenPeriodInput {
  subject: string;
  startsAt: Date;
  endsAt: Date;
}

/**
 * Naming the period to close.
 *
 * Either by id, which must already be open, or by describing it - in which case
 * it is opened first, idempotently, so a host that generates its own boundaries
 * can close a period in one call without opening it in a separate one.
 */
export type ClosePeriodInput = { periodId: string } | OpenPeriodInput;

/** The slice of the module container this service reaches into. */
type ModuleCradle = Record<string, unknown>;

export default class UsageModuleService extends MedusaService({
  BillingPeriod: BillingPeriodModel,
  PeriodResult: PeriodResultModel,
  UsageEvent: UsageEventModel,
}) {
  private readonly options: ResolvedUsageOptions;
  private readonly cradle: ModuleCradle;
  private readonly buffer = new UsageBuffer();
  private readonly periodStore: PeriodStore;

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
    this.periodStore = new PeriodStore(this.cradle as { manager?: ManagerLike });
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
    return this.snapshotOf(query, new Date());
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


  /**
   * Open a billing period, or return the one that is already open.
   *
   * Idempotent, because the id is derived from the subject and the two instants
   * rather than generated: a job that runs twice after a redeploy opens one
   * period. Opening a period is not a promise that it will be closed, and nothing
   * happens automatically when it ends - the host decides when to close it, which
   * is the only way a package that does not know what a billing cycle is can be
   * right about when one ends.
   */
  async openPeriod(input: OpenPeriodInput): Promise<BillingPeriod> {
    assertPeriodWindow(input.startsAt, input.endsAt);
    const subject = requireSubject(input.subject);
    const id = periodIdFor(subject, input.startsAt, input.endsAt);
    const { period } = await this.periodStore.openPeriod({
      endsAt: input.endsAt,
      id,
      startsAt: input.startsAt,
      subject,
    });
    return period;
  }

  /** One period, with `closedAt` filled in from its result if it has one. */
  async getPeriod(id: string): Promise<BillingPeriod | null> {
    return this.periodStore.getPeriod(id);
  }

  /** Periods, newest window first. Filter by subject, by status, by end instant. */
  async listPeriods(query: PeriodQuery = {}): Promise<BillingPeriod[]> {
    return this.periodStore.listPeriods(query);
  }

  /**
   * The frozen result of a closed period, or null while it is still open.
   *
   * Null and a zero total are different answers and a host must treat them so:
   * null is "this period has not been closed, do not bill it yet", while a result
   * whose `total` is 0 is "this period is closed and provably came to nothing".
   * The second is a normal outcome of a free subscription, not an edge case, and
   * the thing to do with it is issue no invoice at all.
   */
  async getPeriodResult(periodId: string): Promise<PeriodResult | null> {
    return this.periodStore.getResult(periodId);
  }

  /**
   * Close a period: rate the usage inside it and freeze the answer.
   *
   * Every meter on the rate card is aggregated over the period's window, rated,
   * and written as a line - including the meters that came to nothing, so the
   * result proves each one was looked at rather than leaving a host to wonder
   * whether a missing line means zero usage or a forgotten rate.
   *
   * ## Closing twice does not bill twice
   *
   * The result is inserted under the period's own derived id, and the insert
   * ignores a conflict. The first call appends the row and reports
   * `alreadyClosed: false`; every call after it appends nothing and reports the
   * stored result with `alreadyClosed: true`. Nothing is read before the write, so
   * there is no window for a concurrent close to slip through - two callers race,
   * one writes, and both come away with the same numbers.
   *
   * A caller that turns a close into an invoice must therefore key off
   * `alreadyClosed`, and only that: it is the one flag that cannot be true twice.
   *
   * ## Events that arrive after this returns
   *
   * They land in the log, in the window they occurred in, and they change nothing
   * here. The result is what was billed and it does not move. `verifyPeriod` is
   * how the drift is found, and a correction is carried into an open period as
   * usage. The README says this in full, under "A period that closes while events
   * are still arriving".
   */
  async closePeriod(input: ClosePeriodInput, now: Date = new Date()): Promise<ClosedPeriod> {
    const card = this.requireRateCard();
    const period = await this.periodToClose(input);
    assertClosable(period, now, card.closeDelayMs);

    // One flush for the whole close rather than one per meter, so every line is
    // rated over the same buffer state.
    await this.flush();

    const lines = await Promise.all(
      card.rates.map(async (rate) =>
        rateSnapshot(
          rate,
          await this.snapshotOf(
            { from: period.startsAt, meter: rate.meter, subject: period.subject, to: period.endsAt },
            now,
          ),
        ),
      ),
    );

    const result = buildPeriodResult({
      closedAt: now,
      currency: card.currency,
      from: period.startsAt,
      lines,
      periodId: period.id,
      sink: await this.activeSinkId(),
      subject: period.subject,
      to: period.endsAt,
    });

    if (await this.periodStore.appendResult(result)) {
      return { alreadyClosed: false, result };
    }

    // Someone else closed it, possibly a millisecond ago and possibly last month.
    // Theirs is the billing record, so theirs is what comes back.
    const stored = await this.periodStore.getResult(period.id);
    if (!stored) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `medusa-usage: the result for period ${period.id} was reported as already written but could not be read back.`,
      );
    }
    return { alreadyClosed: true, result: stored };
  }

  /**
   * Rate a closed period again from the log and say whether it still comes out the
   * same.
   *
   * The rates come off the stored lines, never out of the current configuration,
   * so this checks the log rather than the config file: changing a price must not
   * be able to restate what was already billed.
   *
   * Nothing is written. A mismatch means the window gained or lost events after it
   * was frozen, which is a fact about the log and a decision for the host, not
   * something this package may resolve by quietly rewriting an invoice.
   */
  async verifyPeriod(periodId: string): Promise<PeriodVerification> {
    const stored = await this.periodStore.getResult(periodId);
    if (!stored) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `medusa-usage: the period ${periodId} has no frozen result, so there is nothing to re-derive. Only a closed period can be verified.`,
      );
    }

    await this.flush();
    const now = new Date();
    const from = new Date(stored.from);
    const to = new Date(stored.to);

    const lines = await Promise.all(
      stored.lines.map(async (line) =>
        rerateLine(
          line,
          await this.snapshotOf(
            { from, meter: line.meter, subject: stored.subject, to },
            now,
          ),
        ),
      ),
    );

    return verifyPeriodResult(
      stored,
      buildPeriodResult({
        closedAt: new Date(stored.closedAt),
        currency: stored.currency,
        from,
        lines,
        periodId: stored.periodId,
        sink: await this.activeSinkId(),
        subject: stored.subject,
        to,
      }),
    );
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
      rates: this.options.billing
        ? {
            closeDelayMs: this.options.billing.closeDelayMs,
            currency: this.options.billing.currency,
            meters: this.options.billing.rates.map((rate) => ({ ...rate })),
          }
        : null,
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


  /** A snapshot from the active sink, without flushing. Callers flush once. */
  private async snapshotOf(query: UsageAggregateQuery, computedAt: Date): Promise<UsageSnapshot> {
    const sinkId = await this.activeSinkId();
    const sink = await this.resolveSink();
    return buildUsageSnapshot(query, await sink.aggregate(query), sinkId, computedAt);
  }

  /**
   * The rate card, or a refusal that says what to configure.
   *
   * Rating with no card would mean rating everything at zero, and a period that
   * came to nothing because nobody configured a price is indistinguishable from a
   * period in which nothing was consumed. One of those should be invoiced for
   * nothing and the other is a bug, so the plugin refuses instead of guessing.
   */
  private requireRateCard(): RateCard {
    if (!this.options.billing) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        "medusa-usage: no rate card is configured, so a period cannot be rated. Set the plugin's `billing` option with a `currency` and a `rates` entry for each meter you charge for. Metering works without it; closing a period does not.",
      );
    }
    return this.options.billing;
  }

  /** Resolve what to close: an existing period by id, or one named outright. */
  private async periodToClose(input: ClosePeriodInput): Promise<BillingPeriod> {
    if ("periodId" in input) {
      const period = await this.periodStore.getPeriod(input.periodId);
      if (!period) {
        throw new MedusaError(
          MedusaError.Types.NOT_FOUND,
          `medusa-usage: there is no period ${input.periodId}. Open it first, or close it by subject and window instead.`,
        );
      }
      return period;
    }
    return this.openPeriod(input);
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

/** A subject is an identifier here for the same reason it is one on an event. */
const requireSubject = (subject: string): string => {
  const trimmed = typeof subject === "string" ? subject.trim() : "";
  if (!trimmed) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "medusa-usage: a billing period needs a `subject`, the same opaque identifier its usage events carry.",
    );
  }
  return trimmed;
};

const emptyFlush = (): FlushSummary => ({
  appended: 0,
  batches: 0,
  duplicates: 0,
  submitted: 0,
});
