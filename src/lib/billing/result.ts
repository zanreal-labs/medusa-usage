import { createHash } from "node:crypto";
import { MedusaError } from "@medusajs/framework/utils";
import type { JsonValue } from "../usage/canonical-json";
import { canonicalJson } from "../usage/canonical-json";
import type { RatedLine } from "./rating";

/**
 * The frozen period result.
 *
 * This is where the package stops. It says "period P, for subject S, over
 * `[from, to)`, rated to T minor units of currency C, and here is the line for
 * every meter that produced it". It says nothing about invoices, documents,
 * payments, tax or dunning, and it never will: those are the host's, and a
 * metering package that acquired an opinion about Polish VAT would stop being
 * usable by anyone outside Poland.
 *
 * ## Why it is stored, when the snapshot is not
 *
 * A usage snapshot is a value, computed on demand and kept by whoever asked. A
 * period result is a row, written once, and the difference is the whole point.
 *
 * The moment a number is billed it stops being a question about the log and
 * becomes a fact about what was charged. Those two can drift - a late event, a
 * correction, a rate change - and when they do, the invoice must not move. So the
 * result is frozen at the instant of closing and read back verbatim afterwards.
 * A host builds its document from this row and never from a live query, because a
 * live query answers "what does the log say now", which is a different question
 * from "what did we charge".
 *
 * The row is append-only, like the event log. There is no update path and none
 * should be added. A period that was rated wrongly is not edited: the correction
 * is a usage event in the open period, exactly as the log's own corrections are.
 *
 * ## What makes it explain itself
 *
 * Every line carries the quantity, the event count, the first and last instants
 * inside the window, the rate that was applied and the digest of the usage
 * snapshot it was rated from. An invoice line nobody can justify is worse than no
 * invoice, so the amount never appears without the arithmetic that produced it,
 * and the arithmetic never appears without a pointer back into the log.
 *
 * ## The digest
 *
 * A hash over the question and the answer together, in the same spirit as the
 * usage snapshot's. Recompute the result months later from the log and the rates
 * on the stored lines, compare one string, and either the log behind the invoice
 * is unchanged or it is not. `sink` and `closedAt` are outside the digest: who
 * answered and when they answered are facts about the closing, not about the
 * money, and a result re-derived from a migrated log has to still match.
 */

/** Bumped only if the digested shape changes. Two versions never compare equal. */
export const PERIOD_RESULT_VERSION = 1;

/** Prefix on every result digest, so it is recognisable wherever it is stored. */
export const PERIOD_RESULT_DIGEST_PREFIX = "uper_";

/** An immutable, storable statement of what a closed period came to. */
export interface PeriodResult {
  version: number;
  /** The period this rates. Also the primary key of the row it is stored in. */
  periodId: string;
  subject: string;
  /** Inclusive lower bound, ISO 8601 UTC. */
  from: string;
  /** Exclusive upper bound, ISO 8601 UTC. */
  to: string;
  /** The currency every amount below is denominated in. */
  currency: string;
  /** One line per rated meter, including the ones that came to nothing. */
  lines: RatedLine[];
  /** Sum of the line amounts, in minor currency units. Exact. */
  total: number;
  /** Events behind the whole result. Zero means the period is provably empty. */
  eventCount: number;
  /** Hash over every field above. See the note on re-derivation. */
  digest: string;
  /** Which sink answered the aggregates. Outside the digest. */
  sink: string;
  /** When the period was closed. Outside the digest. */
  closedAt: string;
}

/** The digested subset: the question, and the answer to it. */
type DigestedFields = Omit<PeriodResult, "digest" | "sink" | "closedAt">;

/** What `closePeriod` returns. `alreadyClosed` is the idempotency showing. */
export interface ClosedPeriod {
  /** The frozen result. On a repeat close this is the one written the first time. */
  result: PeriodResult;
  /**
   * False when this call is the one that closed the period, true when it was
   * already closed and this is the stored answer read back.
   *
   * A host wiring an invoice to a close must key off this: it is the difference
   * between "bill this" and "this was billed, here is what it came to". Closing is
   * safe to retry precisely because the second call cannot report false.
   */
  alreadyClosed: boolean;
}

/** The hash over the question and the answer. Stable across processes and years. */
export function periodResultDigest(fields: DigestedFields): string {
  const digest = createHash("sha256")
    .update(canonicalJson(fields as unknown as JsonValue), "utf8")
    .digest("hex");
  return `${PERIOD_RESULT_DIGEST_PREFIX}${digest}`;
}

/** Everything needed to freeze a period, with nothing derived from configuration. */
export interface PeriodResultInput {
  periodId: string;
  subject: string;
  from: Date;
  to: Date;
  currency: string;
  lines: RatedLine[];
  sink: string;
  closedAt: Date;
}

/**
 * Assemble the result for a closed period.
 *
 * The total is summed here rather than taken from a caller, so a stored result
 * cannot disagree with its own lines. It is checked for exactness for the same
 * reason a usage total is: an approximate number that ends up priced is the
 * failure this package exists to prevent.
 */
export function buildPeriodResult(input: PeriodResultInput): PeriodResult {
  const total = input.lines.reduce((sum, line) => sum + line.amount, 0);
  if (!Number.isSafeInteger(total)) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      `medusa-usage: the total for period ${input.periodId} (${String(total)}) is beyond exact integer arithmetic and cannot be billed.`,
    );
  }

  const digested: DigestedFields = {
    currency: input.currency,
    eventCount: input.lines.reduce((sum, line) => sum + line.eventCount, 0),
    from: input.from.toISOString(),
    lines: input.lines,
    periodId: input.periodId,
    subject: input.subject,
    to: input.to.toISOString(),
    total,
    version: PERIOD_RESULT_VERSION,
  };

  return Object.freeze({
    ...digested,
    closedAt: input.closedAt.toISOString(),
    digest: periodResultDigest(digested),
    sink: input.sink,
  });
}

/** One meter's side of a re-derivation. */
export interface VerifiedLine {
  meter: string;
  /** The quantity that was billed. */
  quantity: number;
  /** The quantity the log holds for that window today. */
  currentQuantity: number;
  amount: number;
  currentAmount: number;
  /** Positive when the log has gained usage in this window since it was closed. */
  quantityDelta: number;
  amountDelta: number;
}

/** Whether a frozen result still falls out of the log it was computed from. */
export interface PeriodVerification {
  periodId: string;
  /** True when the log behind the result is byte-for-byte the log it was billed from. */
  matches: boolean;
  storedDigest: string;
  recomputedDigest: string;
  storedTotal: number;
  recomputedTotal: number;
  /** Positive when the log now says the period was worth more than it was billed. */
  totalDelta: number;
  lines: VerifiedLine[];
}

/**
 * Compare a stored result against the same period rated again from the log.
 *
 * A mismatch is not corruption and it is not an error. It is the one thing that
 * can honestly be said about a period whose window has gained events since it was
 * frozen: the invoice stands, and here is exactly how much it now differs by, per
 * meter, so a host can decide what to do about it. What it must not do is silently
 * restate the result, which is why nothing here writes anything.
 */
export function verifyPeriodResult(stored: PeriodResult, recomputed: PeriodResult): PeriodVerification {
  const byMeter = new Map(recomputed.lines.map((line) => [line.meter, line]));

  return {
    lines: stored.lines.map((line) => {
      const now = byMeter.get(line.meter);
      const currentQuantity = now?.quantity ?? 0;
      const currentAmount = now?.amount ?? 0;
      return {
        amount: line.amount,
        amountDelta: currentAmount - line.amount,
        currentAmount,
        currentQuantity,
        meter: line.meter,
        quantity: line.quantity,
        quantityDelta: currentQuantity - line.quantity,
      };
    }),
    matches: stored.digest === recomputed.digest,
    periodId: stored.periodId,
    recomputedDigest: recomputed.digest,
    recomputedTotal: recomputed.total,
    storedDigest: stored.digest,
    storedTotal: stored.total,
    totalDelta: recomputed.total - stored.total,
  };
}
