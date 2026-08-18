import { createHash } from "node:crypto";
import { MedusaError } from "@medusajs/framework/utils";
import type { UsageAggregateQuery, UsageAggregateResult } from "../sink/types";
import type { JsonScalar, JsonValue } from "./canonical-json";
import { canonicalJson } from "./canonical-json";

/**
 * The snapshot.
 *
 * This is where the plugin stops. It answers "usage for this meter, this subject,
 * this window is N", hands over an immutable record of that answer, and has
 * nothing to say about what the host does next. No price, no currency, no
 * invoice, no order.
 *
 * The snapshot is a value, not a row. It is not stored here and there is no
 * counter behind it: it is computed from the event log every time it is asked
 * for, which is the only way the number on an invoice from March can still be
 * checked in November. A counter, by contrast, remembers what someone believed at
 * the time and cannot be audited at all.
 *
 * ## The digest
 *
 * `digest` is a hash over the question and the answer together. It exists to make
 * a re-derivation checkable rather than merely possible: keep the snapshot beside
 * whatever you billed, recompute it months later, and compare one string. Equal
 * means the log behind the number is byte-for-byte the same log. Different means
 * something changed, and `total` against `eventCount` says whether the change
 * added events, removed them, or restated them.
 *
 * `sink` and `computedAt` are outside the digest on purpose. Who answered and
 * when they answered are facts about the query, not about the usage, and a
 * snapshot re-derived from a migrated log must still match.
 */

/** Bumped only if the digested shape changes. Two versions never compare equal. */
export const SNAPSHOT_VERSION = 1;

/** Prefix on every digest, so it is recognisable wherever a host stores it. */
export const SNAPSHOT_DIGEST_PREFIX = "usnap_";

/** An immutable answer about a window of the log. Safe to serialize and keep. */
export interface UsageSnapshot {
  version: number;
  meter: string;
  /** null when the snapshot covers every subject on the meter. */
  subject: string | null;
  /** Inclusive lower bound, ISO 8601 UTC. */
  from: string;
  /** Exclusive upper bound, ISO 8601 UTC. */
  to: string;
  /** The dimension filter that was applied, if any. */
  properties: Record<string, JsonScalar> | null;
  /** Sum of quantity. Exact. */
  total: number;
  /** How many events contributed. */
  eventCount: number;
  firstOccurredAt: string | null;
  lastOccurredAt: string | null;
  /** Hash over every field above. See the note on re-derivation. */
  digest: string;
  /** Which sink answered. Outside the digest. */
  sink: string;
  /** When this was computed. Outside the digest. */
  computedAt: string;
}

/** The digested subset: the question, and the answer to it. */
type DigestedFields = Omit<UsageSnapshot, "digest" | "sink" | "computedAt">;

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/**
 * Reject a window that cannot mean what it says before anything is counted over
 * it. An inverted or empty window silently returns zero, and a zero that came
 * from a typo looks exactly like a customer who used nothing.
 */
export function assertUsageWindow(from: Date, to: Date): void {
  if (!(from instanceof Date) || Number.isNaN(from.getTime())) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "medusa-usage: `from` is not a date.");
  }
  if (!(to instanceof Date) || Number.isNaN(to.getTime())) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "medusa-usage: `to` is not a date.");
  }
  if (from.getTime() >= to.getTime()) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `medusa-usage: the window [${from.toISOString()}, ${to.toISOString()}) is empty or inverted. It is half-open, so \`to\` has to be strictly after \`from\`, and one period's \`to\` is the next period's \`from\`.`,
    );
  }
}

/**
 * A sum too large for exact integer arithmetic is refused rather than rounded.
 *
 * Beyond 2^53 a JavaScript number stops being able to represent every integer, so
 * the total would be quietly approximate - and an approximate number that ends up
 * priced is the failure this plugin is built to prevent. Reaching this means the
 * meter's unit is too small for its volume, and the fix is a coarser unit, not a
 * wider float.
 */
function assertExact(total: number, eventCount: number): void {
  if (!Number.isSafeInteger(total)) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      `medusa-usage: the total over ${eventCount} events (${String(total)}) is beyond exact integer arithmetic. Meter a coarser unit; a total this size can no longer be summed without rounding.`,
    );
  }
}

/** The hash over the question and the answer. Stable across processes and years. */
export function snapshotDigest(fields: DigestedFields): string {
  const digest = createHash("sha256")
    .update(canonicalJson(fields as unknown as JsonValue), "utf8")
    .digest("hex");
  return `${SNAPSHOT_DIGEST_PREFIX}${digest}`;
}

/** Assemble a snapshot from the query that was asked and the answer a sink gave. */
export function buildUsageSnapshot(
  query: UsageAggregateQuery,
  result: UsageAggregateResult,
  sink: string,
  computedAt: Date,
): UsageSnapshot {
  assertExact(result.total, result.eventCount);

  const digested: DigestedFields = {
    eventCount: result.eventCount,
    firstOccurredAt: iso(result.firstOccurredAt),
    from: query.from.toISOString(),
    lastOccurredAt: iso(result.lastOccurredAt),
    meter: query.meter,
    properties: query.properties ?? null,
    subject: query.subject ?? null,
    to: query.to.toISOString(),
    total: result.total,
    version: SNAPSHOT_VERSION,
  };

  return Object.freeze({
    ...digested,
    computedAt: computedAt.toISOString(),
    digest: snapshotDigest(digested),
    sink,
  });
}
