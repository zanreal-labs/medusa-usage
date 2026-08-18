import { describe, expect, it } from "vitest";
import { DEDUPE_KEY_LENGTH, DEDUPE_KEY_PREFIX, dedupeKeyFor, dedupeMaterialFor } from "./dedupe";
import type { UsageEventFacts } from "./event";
import { normalizeUsageEvent } from "./event";

const facts = (overrides: Partial<UsageEventFacts> = {}): UsageEventFacts => ({
  meter: "api_request",
  occurredAt: new Date("2026-08-18T09:15:00.000Z"),
  properties: null,
  quantity: 3,
  source: null,
  subject: "cus_01",
  ...overrides,
});

const US = String.fromCharCode(0x1f);

/**
 * The pinned vectors.
 *
 * These four hashes ARE the deduplication contract. A change to the joined
 * material, the field order, the separator, the timestamp format, the number
 * format, the canonical JSON rules or the hash function moves them, and moving
 * them means every key already written to a production log stops matching the key
 * the same event would derive today - so every one of those events would be
 * counted a second time. If a change here is genuinely wanted, it is a new scheme
 * (`usg2`) alongside the old one, not an edit to these numbers.
 */
describe("dedupeKeyFor: pinned vectors", () => {
  it("derives the documented key for a bare event", () => {
    expect(dedupeKeyFor(facts())).toBe(
      "uev_5c8ec3ea62721af70f0521af0552578f89da8d295f45829ec6ab33fa38317745",
    );
  });

  it("derives the documented key for an event with a source and properties", () => {
    expect(
      dedupeKeyFor(facts({ properties: { model: "m", region: "eu" }, source: "gateway" })),
    ).toBe("uev_129387c9f2479ce9870ab6269a4917523071b432857c93c57834ab392a3f1d95");
  });

  it("derives the documented key for an explicit idempotency key", () => {
    expect(dedupeKeyFor(facts(), "req_9")).toBe(
      "uev_f90ad0ebe9d0da7f1c31d03452422228b1acebd217c64a7280f432c085c14fa5",
    );
  });

  it("scopes an explicit key to its meter", () => {
    expect(dedupeKeyFor(facts({ meter: "tokens_out" }), "req_9")).toBe(
      "uev_a390c83652ffa29c44aee102c5c5dbc9969b3e42eadded998315f3a3823626d3",
    );
  });
});

describe("dedupeMaterialFor", () => {
  it("joins the derived fields in the documented order", () => {
    expect(dedupeMaterialFor(facts({ source: "gateway" }), null).split(US)).toEqual([
      "usg1",
      "derived",
      "api_request",
      "cus_01",
      "2026-08-18T09:15:00.000Z",
      "3",
      "gateway",
      "null",
    ]);
  });

  it("joins the explicit fields in the documented order", () => {
    expect(dedupeMaterialFor(facts(), "req_9").split(US)).toEqual([
      "usg1",
      "explicit",
      "api_request",
      "cus_01",
      "req_9",
    ]);
  });
});

describe("dedupeKeyFor: what it must not depend on", () => {
  it("is stable across calls, so a retry cannot produce a second count", () => {
    expect(dedupeKeyFor(facts())).toBe(dedupeKeyFor(facts()));
  });

  it("ignores the order of keys in the property bag", () => {
    expect(dedupeKeyFor(facts({ properties: { a: 1, b: 2 } }))).toBe(
      dedupeKeyFor(facts({ properties: { b: 2, a: 1 } })),
    );
  });

  it("ignores the time zone the Date was constructed in", () => {
    expect(dedupeKeyFor(facts({ occurredAt: new Date("2026-08-18T11:15:00.000+02:00") }))).toBe(
      dedupeKeyFor(facts({ occurredAt: new Date("2026-08-18T09:15:00.000Z") })),
    );
  });

  it("treats an absent property bag and an empty one as the same event", () => {
    expect(normalizeUsageEvent({ meter: "m", quantity: 1, subject: "s", occurredAt: facts().occurredAt }).key).toBe(
      normalizeUsageEvent({
        meter: "m",
        occurredAt: facts().occurredAt,
        properties: {},
        quantity: 1,
        subject: "s",
      }).key,
    );
  });
});

describe("dedupeKeyFor: what it must separate", () => {
  it("separates two meters", () => {
    expect(dedupeKeyFor(facts({ meter: "other" }))).not.toBe(dedupeKeyFor(facts()));
  });

  it("separates two subjects", () => {
    expect(dedupeKeyFor(facts({ subject: "cus_02" }))).not.toBe(dedupeKeyFor(facts()));
  });

  it("separates two quantities", () => {
    expect(dedupeKeyFor(facts({ quantity: 4 }))).not.toBe(dedupeKeyFor(facts()));
  });

  it("separates a reversal from the event it reverses", () => {
    expect(dedupeKeyFor(facts({ quantity: -3 }))).not.toBe(dedupeKeyFor(facts()));
  });

  it("separates two instants one millisecond apart", () => {
    expect(dedupeKeyFor(facts({ occurredAt: new Date("2026-08-18T09:15:00.001Z") }))).not.toBe(
      dedupeKeyFor(facts()),
    );
  });

  it("separates two producers of otherwise identical usage", () => {
    expect(dedupeKeyFor(facts({ source: "gateway" }))).not.toBe(
      dedupeKeyFor(facts({ source: "worker" })),
    );
  });

  it("separates a null source from the empty-looking string a join could confuse it with", () => {
    // "" is refused by validation, so this can only be reached through the pure
    // function - the point is that the joined material still differs.
    expect(dedupeMaterialFor(facts({ source: null }), null)).not.toBe(
      dedupeMaterialFor(facts({ source: "null" }), null),
    );
  });

  it("separates two property bags", () => {
    expect(dedupeKeyFor(facts({ properties: { region: "eu" } }))).not.toBe(
      dedupeKeyFor(facts({ properties: { region: "us" } })),
    );
  });

  it("never collides an explicit key with a derived one", () => {
    expect(dedupeKeyFor(facts(), "req_9")).not.toBe(dedupeKeyFor(facts()));
  });

  it("cannot be confused by a field that looks like the joined material", () => {
    // The separator is a control character, and validation rejects those in every
    // identifier, so no caller can smuggle one in. Proven here on the pure
    // function: even a subject shaped like two joined fields stays distinct.
    expect(dedupeKeyFor(facts({ meter: "a", subject: "b" }))).not.toBe(
      dedupeKeyFor(facts({ meter: "a", subject: "b" }), "x"),
    );
    expect(() =>
      normalizeUsageEvent({ meter: `a${US}b`, quantity: 1, subject: "s" }),
    ).toThrow(/control character/u);
  });
});

describe("key shape", () => {
  it("is a fixed-width prefixed hex digest", () => {
    const key = dedupeKeyFor(facts());
    expect(key.startsWith(DEDUPE_KEY_PREFIX)).toBe(true);
    expect(key).toHaveLength(DEDUPE_KEY_LENGTH);
    expect(key.slice(DEDUPE_KEY_PREFIX.length)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("is the same width however long the explicit key was", () => {
    expect(dedupeKeyFor(facts(), "x".repeat(180))).toHaveLength(DEDUPE_KEY_LENGTH);
  });
});
