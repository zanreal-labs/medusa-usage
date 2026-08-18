import { MedusaError } from "@medusajs/framework/utils";
import type { JsonValue } from "./canonical-json";
import { canonicalJson } from "./canonical-json";
import { dedupeKeyFor } from "./dedupe";

/**
 * The event model.
 *
 * A usage event is one immutable statement of fact: *this much* of *this meter*
 * was consumed by *this subject* at *this instant*. That is the whole vocabulary.
 * There is nothing here about prices, plans, periods, currencies or invoices,
 * because none of those are facts about consumption - they are decisions made
 * later, by whoever is doing the billing, from a number this plugin produces.
 *
 * Events are appended and never changed. A mistake is corrected by appending its
 * reversal (a negative `quantity`), exactly like a ledger, so that an aggregate
 * computed today and the same aggregate recomputed in a year are computed from
 * the same rows.
 */

/** What a caller hands to `recordUsage`. Every field is validated. */
export interface UsageEventInput {
  /**
   * What is being metered: "api_request", "gb_egress", "seat_day". A stable
   * string chosen by the host, compared byte for byte, never interpreted here.
   */
  meter: string;
  /**
   * Who the usage belongs to. An opaque host identifier - a customer id, a
   * subscription id, a tenant key, an account number. This plugin never resolves
   * it against anything, which is what lets it stay out of the host's data model.
   */
  subject: string;
  /**
   * How much, as a whole number of the meter's own smallest unit.
   *
   * Integers, not decimals, and the reason is arithmetic rather than taste: a sum
   * of doubles depends on the order the terms are added, so the same event log
   * could produce two different totals on two different days and both would be
   * "right". Money derived from that is indefensible. If the thing being metered
   * is fractional, pick a smaller unit - bytes rather than gigabytes, milliseconds
   * rather than hours, thousandths of a credit rather than credits - and record
   * the count of those.
   *
   * May be negative. That is how a correction is expressed against an append-only
   * log: you do not edit the event that was wrong, you append the one that undoes
   * it.
   */
  quantity: number;
  /**
   * When the consumption happened, in the source system, not when this call was
   * made. This is the only timestamp aggregation ever filters on, so a batch of
   * events uploaded hours late still lands in the period it belongs to.
   *
   * A `Date` or an ISO 8601 string carrying a UTC offset. Bare numbers are refused
   * on purpose: a number is a seconds-or-milliseconds guess, and guessing wrong
   * moves usage between periods. Defaults to now, which is correct only for usage
   * recorded as it happens - anything replayed or imported must set it explicitly.
   */
  occurredAt?: Date | string;
  /**
   * Optional name of the producer, for auditing a log with several writers
   * ("gateway", "worker", "backfill-2026-08"). Part of the derived deduplication
   * key, so two producers reporting the same consumption are two events, not one.
   */
  source?: string;
  /**
   * Optional dimensions, for filtering an aggregate later ("region", "model",
   * "endpoint"). Part of the derived deduplication key.
   */
  properties?: Record<string, JsonValue>;
  /**
   * An explicit deduplication key, when the caller already has a natural one -
   * the id of the request being metered, of the upstream webhook, of the row
   * being imported. Preferred over the derived key whenever one exists: see
   * `./dedupe.ts` for what each of the two guarantees.
   */
  idempotencyKey?: string;
}

/** An input after validation, with its deduplication key derived. Immutable. */
export interface UsageEvent {
  /**
   * The deduplication key, and the identity of the row in the log. Derived, never
   * random: see `./dedupe.ts`.
   */
  key: string;
  meter: string;
  subject: string;
  quantity: number;
  /** Millisecond precision, UTC. */
  occurredAt: Date;
  source: string | null;
  properties: Record<string, JsonValue> | null;
}

/** The validated fields the deduplication key is derived from. */
export type UsageEventFacts = Omit<UsageEvent, "key">;

/**
 * Longest accepted meter, subject, source or explicit key.
 *
 * 191 rather than 255 so that a host mirroring these strings into its own schema
 * can index them under MySQL's utf8mb4 key-length limit without truncating. They
 * are identifiers, not descriptions - anything longer is a payload that belongs
 * in `properties`.
 */
export const MAX_IDENTIFIER_LENGTH = 191;

/**
 * Longest accepted canonical form of `properties`, in UTF-16 code units.
 *
 * A property bag is a handful of dimensions, not a document. The cap keeps the
 * log narrow enough to stay cheap to scan years later, and keeps the hashed input
 * to the deduplication key bounded.
 */
export const MAX_PROPERTIES_LENGTH = 4096;

const invalid = (message: string): never => {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, `medusa-usage: ${message}`);
};

/**
 * Identifiers are joined with a unit separator to build the deduplication key, so
 * they must not be able to contain one - otherwise two different events could
 * join to the same string and collapse into a single count. Rejecting the whole
 * C0/C1 control range is the blunt, checkable version of that rule.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/u;

/** An ISO 8601 string is only unambiguous if it says which zero it is measured from. */
const HAS_UTC_OFFSET = /([Zz]|[+-]\d{2}:?\d{2})$/u;

const identifier = (value: unknown, field: string): string => {
  if (typeof value !== "string") {
    return invalid(`\`${field}\` is required and must be a string.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return invalid(`\`${field}\` is required and must not be blank.`);
  }
  if (trimmed.length > MAX_IDENTIFIER_LENGTH) {
    return invalid(
      `\`${field}\` is longer than ${MAX_IDENTIFIER_LENGTH} characters. It identifies something; descriptions belong in \`properties\`.`,
    );
  }
  if (CONTROL_CHARACTERS.test(trimmed)) {
    return invalid(
      `\`${field}\` contains a control character. Identifiers are joined to derive the deduplication key, so they have to be free of separators.`,
    );
  }
  return trimmed;
};

const quantityOf = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return invalid("`quantity` is required and must be a finite number.");
  }
  if (!Number.isSafeInteger(value)) {
    return invalid(
      `\`quantity\` must be a whole number (received ${String(value)}). A sum of decimals depends on the order the terms are added, which would let one log produce two different totals. Meter a smaller unit instead.`,
    );
  }
  return value;
};

const occurredAtOf = (value: Date | string | undefined, now: Date): Date => {
  if (value === undefined || value === null) {
    return new Date(now.getTime());
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return invalid("`occurredAt` is an Invalid Date.");
    }
    return new Date(value.getTime());
  }
  if (typeof value !== "string") {
    return invalid(
      "`occurredAt` must be a Date or an ISO 8601 string. A bare number is ambiguous between seconds and milliseconds, and guessing wrong moves usage into the wrong period.",
    );
  }
  const text = value.trim();
  if (!HAS_UTC_OFFSET.test(text)) {
    return invalid(
      `\`occurredAt\` ("${value}") carries no UTC offset. Such a timestamp means a different instant depending on where the process runs, so it is refused rather than assumed.`,
    );
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    return invalid(`\`occurredAt\` is not a valid date: ${value}`);
  }
  return parsed;
};

const propertiesOf = (value: unknown): Record<string, JsonValue> | null => {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return invalid("`properties` must be an object of dimensions.");
  }
  const properties = value as Record<string, JsonValue>;
  if (Object.keys(properties).length === 0) {
    // An empty bag and no bag at all describe the same event, so they have to
    // hash the same. Collapsing here is what makes that true.
    return null;
  }
  let canonical: string;
  try {
    canonical = canonicalJson(properties);
  } catch (error) {
    return invalid(`\`properties\` is not serializable: ${(error as Error).message}`);
  }
  if (canonical.length > MAX_PROPERTIES_LENGTH) {
    return invalid(
      `\`properties\` serializes to ${canonical.length} characters, over the ${MAX_PROPERTIES_LENGTH} limit. It carries dimensions, not documents.`,
    );
  }
  return properties;
};

/**
 * Validate an input and derive its key.
 *
 * Pure, and deliberately so: the same input produces the same `UsageEvent` in any
 * process, on any machine, at any time - the property the whole deduplication
 * scheme rests on. The one impurity, defaulting `occurredAt` to now, is
 * injectable so tests can pin it.
 */
export function normalizeUsageEvent(input: UsageEventInput, now: Date = new Date()): UsageEvent {
  if (typeof input !== "object" || input === null) {
    invalid("a usage event must be an object.");
  }

  const facts: UsageEventFacts = {
    meter: identifier(input.meter, "meter"),
    occurredAt: occurredAtOf(input.occurredAt, now),
    properties: propertiesOf(input.properties),
    quantity: quantityOf(input.quantity),
    source:
      input.source === undefined || input.source === null
        ? null
        : identifier(input.source, "source"),
    subject: identifier(input.subject, "subject"),
  };

  const explicitKey =
    input.idempotencyKey === undefined || input.idempotencyKey === null
      ? null
      : identifier(input.idempotencyKey, "idempotencyKey");

  return Object.freeze({ ...facts, key: dedupeKeyFor(facts, explicitKey) });
}
