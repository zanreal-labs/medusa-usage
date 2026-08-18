import type { JsonScalar } from "../usage/canonical-json";
import type { UsageEvent } from "../usage/event";

/**
 * The event sink contract.
 *
 * Where usage events are stored is an infrastructure decision, not a business
 * one. A store with a few thousand events a month wants them in the Postgres it
 * already runs. A store with a few billion wants a column store built for it. The
 * usage the host is billed for is the same either way, so the choice belongs to
 * the host, and this module owns only the contract.
 *
 * That is exactly the shape Medusa already uses for fulfillment, notification,
 * payment and file: the module defines the interface and the lifecycle, the
 * implementation is named in `medusa-config.ts`, and it is registered into the
 * module's container by a loader. Nothing here is new, and nothing here is
 * specific to a particular store.
 *
 * ## What an implementation must guarantee
 *
 * 1. **Append only.** There is no update and no delete in this interface, and
 *    none should be added. A number that will end up on an invoice has to be
 *    re-derivable from the same rows in a year, which is only true if the rows
 *    cannot change. Corrections are new events with a negative `quantity`.
 *
 * 2. **At most one row per key.** `write` may be called any number of times with
 *    the same event. The second and later calls must not add a row. `UsageEvent.key`
 *    is derived (see `../usage/dedupe.ts`) so a retry, a redeploy or a replayed
 *    message produces the identical key. This is the guarantee the whole plugin
 *    rests on: a sink that cannot enforce it is not a usable sink.
 *
 * 3. **Retry-safe partial writes.** A `write` that throws may still have
 *    persisted part of its batch. The module retries the whole batch, so
 *    guarantee 2 must absorb the overlap. Nothing needs to be transactional; it
 *    needs to be idempotent.
 *
 * 4. **Event time, never ingestion time.** `aggregate` and `listEvents` filter on
 *    `occurredAt`, on a half-open window `[from, to)`. A batch that arrived late
 *    still belongs to the period it happened in, and the same query over an
 *    unchanged log returns the same answer whenever it is asked.
 *
 * 5. **Exact arithmetic.** Quantities are whole numbers and must be summed
 *    exactly. A sink that accumulates in floating point can return two different
 *    totals for one log.
 *
 * 6. **UTC.** Every timestamp crossing this interface is a `Date`, compared as an
 *    instant. No implementation may apply a local time zone.
 *
 * ## What an implementation is not asked to do
 *
 * Rating, periods, quotas, currency and invoicing are all absent, deliberately.
 * This interface ends at "how much of this meter did this subject consume between
 * these two instants". What happens to that number afterwards is the host's
 * business.
 */

/** An event as the sink stored it: the event, plus when the sink accepted it. */
export interface StoredUsageEvent extends UsageEvent {
  /**
   * When the sink appended the row. Auditing only - it is never a filter, because
   * filtering on it would make a late-arriving batch change an answer that had
   * already been given.
   */
  recordedAt: Date;
}

/** Outcome of one `write`. Counts, so a host can alert on a sink that rejects everything. */
export interface UsageSinkWriteResult {
  /** Events handed to the sink. */
  received: number;
  /** Rows the sink actually appended. */
  appended: number;
  /** Events already present under the same key. Not an error; the mechanism working. */
  duplicates: number;
}

/**
 * A question about the log.
 *
 * The window is half-open, `[from, to)`. Half-open rather than closed so that
 * consecutive periods tile without overlapping: August's `to` is September's
 * `from`, and the event on the boundary is counted exactly once, in September.
 * A closed window would count it twice, which is the exact failure this plugin
 * exists to avoid.
 */
export interface UsageAggregateQuery {
  meter: string;
  /** Omitted or null aggregates every subject on the meter. */
  subject?: string | null;
  /** Inclusive lower bound on `occurredAt`. */
  from: Date;
  /** Exclusive upper bound on `occurredAt`. */
  to: Date;
  /**
   * Optional dimension filter. Every entry must match the event's `properties`
   * exactly; an event missing the property does not match. Scalars only - a
   * filter is an equality, not a query language, and keeping it that way is what
   * lets every sink implement it the same way.
   */
  properties?: Record<string, JsonScalar> | null;
}

/** The answer. Nothing derived, nothing rounded, nothing priced. */
export interface UsageAggregateResult {
  /** Sum of `quantity` over the matching events. Exact. */
  total: number;
  /** How many events contributed. The tamper-evidence beside the total. */
  eventCount: number;
  /** Earliest and latest `occurredAt` among them, or null when there are none. */
  firstOccurredAt: Date | null;
  lastOccurredAt: Date | null;
}

/** A page of the raw log, for proving an aggregate to whoever disputes it. */
export interface UsageListQuery extends UsageAggregateQuery {
  limit: number;
  /**
   * Opaque, sink-defined continuation token from a previous page. Ordering is by
   * `occurredAt` then `key`, which is total and stable over an append-only log.
   */
  cursor?: string | null;
}

export interface UsageEventPage {
  events: StoredUsageEvent[];
  /** Null when this was the last page. */
  nextCursor: string | null;
}

/**
 * What a sink implementation provides.
 *
 * Implementations extend `AbstractUsageSinkProviderService`, which supplies the
 * identifier plumbing and nothing else.
 */
export interface UsageSinkProvider {
  /** The provider's own identifier, e.g. "postgres". */
  getIdentifier: () => string;
  /**
   * Append a batch. Must satisfy guarantees 2 and 3 above.
   *
   * Called with between one and `batchSize` events, already validated and keyed.
   * An implementation may assume the batch contains no two events with the same
   * key, and must not assume the batch is new.
   */
  write: (events: readonly UsageEvent[]) => Promise<UsageSinkWriteResult>;
  /** Answer a question about the log. Must satisfy guarantees 4, 5 and 6. */
  aggregate: (query: UsageAggregateQuery) => Promise<UsageAggregateResult>;
  /** The events behind an aggregate, oldest first. */
  listEvents: (query: UsageListQuery) => Promise<UsageEventPage>;
}

/**
 * The static side: an identifier, and an optional chance to reject bad options
 * at boot. Medusa's module provider loader calls `validateOptions` before it ever
 * constructs the service, which is what turns a typo in `medusa-config.ts` into a
 * failed boot rather than a failed write six hours later.
 */
export interface UsageSinkProviderConstructor {
  new (container: Record<string, unknown>, options: Record<string, unknown>): UsageSinkProvider;
  identifier: string;
  validateOptions?: (options: Record<string, unknown>) => void | Promise<void>;
}

/**
 * Container key each sink is registered under, suffixed with the id the host gave
 * it in `medusa-config.ts`. Mirrors how the notification module registers its
 * providers.
 */
export const USAGE_SINK_REGISTRATION_PREFIX = "usage_sink_";

/** Container key holding the list of registered sink ids. */
export const USAGE_SINK_IDENTIFIERS = "usage_sink_ids";
