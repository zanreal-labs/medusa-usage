import { createHash } from "node:crypto";
import { MedusaError } from "@medusajs/framework/utils";
import { assertUsageWindow } from "../usage/snapshot";

/**
 * Billing periods.
 *
 * A period is a subject and a half-open window: "everything customer X consumed
 * in `[start, end)`". That is the whole model. It is not a subscription, it has no
 * price, and it does not know what a month is - a host that bills calendar months
 * opens one period per calendar month, and a host that bills every 30 days from
 * the day someone signed up opens those instead. Both are the same object here.
 *
 * ## Half-open, like everything else
 *
 * `[start, end)`, matching the aggregation the plugin already does. Consecutive
 * periods tile without overlapping: August's `end` is September's `start`, and an
 * event on the boundary is billed exactly once, in September. A closed window
 * would bill it in both, which is the double-charge this package is built to make
 * impossible.
 *
 * ## The identity is derived, exactly like an event's
 *
 * A period's id is a hash of what the period MEANS - its subject and its two
 * instants - and nothing ambient. No sequence, no random bytes, no creation time.
 * Two calls describing the same period produce the same id, so opening a period
 * twice opens one period, and closing it twice writes one result: the identity is
 * the primary key, and the database refuses the second row rather than the code
 * checking for it first. It is the same mechanism the ingestion path uses, for the
 * same reason, and it is why a retried close cannot bill twice.
 *
 * The consequence worth stating: moving a period's boundary by one millisecond
 * makes it a different period, with a different id, which can be closed and billed
 * separately. That is correct - it is a different question about the log - but it
 * means a host must generate its boundaries deterministically rather than from
 * whatever `new Date()` said when a job happened to run.
 */

/** Pins the derivation. If the rules below change, this changes with them. */
export const PERIOD_SCHEME = "ubp1";

/** Prefix on every period id, so one is recognisable wherever it is stored. */
export const PERIOD_ID_PREFIX = "ubp_";

/** Field separator. Cannot occur inside a subject, so the join is injective. */
const SEPARATOR = "\u001F";

/** A period, as this package stores it. Nothing here changes after it is opened. */
export interface BillingPeriod {
  /** Derived from subject and window. See the note above. */
  id: string;
  subject: string;
  /** Inclusive lower bound. */
  startsAt: Date;
  /** Exclusive upper bound. */
  endsAt: Date;
  /** When the row was appended. Auditing only; never a filter. */
  createdAt: Date;
  /**
   * When the period was closed, or null while it is still open. Reads through
   * from the frozen result, which is the only thing that decides whether a period
   * is closed - there is no status column that could disagree with it.
   */
  closedAt: Date | null;
}

/** The exact text that is hashed. Exported so a period id can be reproduced. */
export function periodMaterialFor(subject: string, startsAt: Date, endsAt: Date): string {
  return [PERIOD_SCHEME, subject, startsAt.toISOString(), endsAt.toISOString()].join(SEPARATOR);
}

/** A period's identity. Pure, and the same in any process, in any year. */
export function periodIdFor(subject: string, startsAt: Date, endsAt: Date): string {
  const digest = createHash("sha256").update(periodMaterialFor(subject, startsAt, endsAt), "utf8");
  return `${PERIOD_ID_PREFIX}${digest.digest("hex")}`;
}

/**
 * Reject a window that cannot be a period before anything is derived from it.
 *
 * Delegates the half-open rules to the same assertion the aggregate path uses, so
 * a window that would be refused as a query cannot slip in as a period.
 */
export function assertPeriodWindow(startsAt: Date, endsAt: Date): void {
  assertUsageWindow(startsAt, endsAt);
}

/**
 * Refuse to close a period that is not over yet.
 *
 * A period whose end is in the future is still accruing by definition, and
 * freezing it would produce a result that is wrong the moment it is written -
 * wrong in the direction that undercharges silently and can never be corrected,
 * because the period is now closed.
 *
 * `closeDelayMs` extends that past the end of the window, for a log that settles
 * slowly. It is a floor on when a period may be frozen, not a promise that
 * everything has arrived by then: see the README on late events for what happens
 * when one turns up afterwards regardless.
 */
export function assertClosable(period: BillingPeriod, now: Date, closeDelayMs: number): void {
  const closableAt = period.endsAt.getTime() + closeDelayMs;
  if (now.getTime() < closableAt) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      `medusa-usage: the period ${period.id} cannot be closed until ${new Date(closableAt).toISOString()}; it ends at ${period.endsAt.toISOString()}${
        closeDelayMs > 0 ? ` and \`billing.closeDelayMs\` holds it open for a further ${closeDelayMs}ms` : ""
      }. A period that is still accruing would freeze at a number it has not reached.`,
    );
  }
}

/** A period named outright, after parsing. */
export interface PeriodWindowInput {
  subject: string;
  startsAt: Date;
  endsAt: Date;
}

/** Either an existing period, or one described in full. */
export type PeriodTarget = { periodId: string } | PeriodWindowInput;

const invalid = (message: string): never => {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, `medusa-usage: ${message}`);
};

/**
 * An instant from a request body or query string.
 *
 * A bare number is refused for the same reason it is refused on a usage event: it
 * is a seconds-or-milliseconds guess, and guessing wrong moves a period boundary,
 * which moves money between two invoices.
 */
const instant = (value: unknown, field: string): Date => {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return invalid(`\`${field}\` is an Invalid Date.`);
    }
    return new Date(value.getTime());
  }
  if (typeof value !== "string" || !value.trim()) {
    return invalid(
      `\`${field}\` is required, as a Date or an ISO 8601 instant. A bare number is ambiguous between seconds and milliseconds, and guessing wrong moves a period boundary.`,
    );
  }
  const parsed = new Date(value.trim());
  if (Number.isNaN(parsed.getTime())) {
    return invalid(`\`${field}\` is not an ISO 8601 instant: ${value}`);
  }
  return parsed;
};

/** The first of the given keys that carries a value. */
const pick = (source: Record<string, unknown>, keys: string[]): unknown =>
  keys.map((key) => source[key]).find((value) => value !== undefined && value !== null);

/**
 * Parse a period out of a request.
 *
 * Both spellings of every field are accepted - `starts_at` because that is what
 * the rest of the admin API speaks, `startsAt` because that is what the module
 * takes - so a caller cannot get it subtly wrong and receive a period boundary an
 * hour away from the one it meant.
 */
export function parsePeriodWindow(source: Record<string, unknown>): PeriodWindowInput {
  const subject = pick(source, ["subject"]);
  if (typeof subject !== "string" || !subject.trim()) {
    invalid("`subject` is required: a period belongs to whoever the usage belongs to.");
  }
  const startsAt = instant(pick(source, ["starts_at", "startsAt", "from"]), "starts_at");
  const endsAt = instant(pick(source, ["ends_at", "endsAt", "to"]), "ends_at");
  assertPeriodWindow(startsAt, endsAt);
  return { endsAt, startsAt, subject: (subject as string).trim() };
}

/** The same, but an id alone is enough when the period already exists. */
export function parsePeriodTarget(source: Record<string, unknown>): PeriodTarget {
  const periodId = pick(source, ["period_id", "periodId", "id"]);
  if (typeof periodId === "string" && periodId.trim()) {
    return { periodId: periodId.trim() };
  }
  return parsePeriodWindow(source);
}

/** A period as the admin API serves it: snake case, instants as ISO 8601. */
export function serializePeriod(period: BillingPeriod): Record<string, string | null> {
  return {
    closed_at: period.closedAt?.toISOString() ?? null,
    created_at: period.createdAt.toISOString(),
    ends_at: period.endsAt.toISOString(),
    id: period.id,
    starts_at: period.startsAt.toISOString(),
    subject: period.subject,
  };
}
