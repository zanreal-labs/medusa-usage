import { describe, expect, it } from "vitest";
import { MAX_IDENTIFIER_LENGTH, MAX_PROPERTIES_LENGTH, normalizeUsageEvent } from "./event";

const NOW = new Date("2026-08-18T09:15:00.000Z");
const valid = { meter: "api_request", quantity: 1, subject: "cus_01" };

describe("normalizeUsageEvent", () => {
  it("returns a frozen event carrying its own key", () => {
    const event = normalizeUsageEvent(valid, NOW);
    expect(event.key).toMatch(/^uev_[0-9a-f]{64}$/u);
    expect(Object.isFrozen(event)).toBe(true);
  });

  it("defaults occurredAt to now", () => {
    expect(normalizeUsageEvent(valid, NOW).occurredAt).toEqual(NOW);
  });

  it("copies the clock rather than aliasing it", () => {
    const now = new Date(NOW.getTime());
    const event = normalizeUsageEvent(valid, now);
    now.setFullYear(1999);
    expect(event.occurredAt).toEqual(NOW);
  });

  it("trims identifiers", () => {
    const event = normalizeUsageEvent({ ...valid, meter: "  api_request  " }, NOW);
    expect(event.meter).toBe("api_request");
  });

  it("accepts an ISO string with an offset", () => {
    const event = normalizeUsageEvent({ ...valid, occurredAt: "2026-08-18T11:15:00+02:00" }, NOW);
    expect(event.occurredAt.toISOString()).toBe("2026-08-18T09:15:00.000Z");
  });

  it("refuses a timestamp with no UTC offset, rather than guessing the server's zone", () => {
    expect(() => normalizeUsageEvent({ ...valid, occurredAt: "2026-08-18T11:15:00" }, NOW)).toThrow(
      /UTC offset/u,
    );
  });

  it("refuses a number for occurredAt, because seconds and milliseconds are indistinguishable", () => {
    expect(() =>
      normalizeUsageEvent({ ...valid, occurredAt: 1_755_508_500 as never }, NOW),
    ).toThrow(/ambiguous/u);
  });

  it("refuses an unparseable date", () => {
    expect(() => normalizeUsageEvent({ ...valid, occurredAt: "yesterdayZ" }, NOW)).toThrow(
      /not a valid date/u,
    );
    expect(() => normalizeUsageEvent({ ...valid, occurredAt: new Date("nope") }, NOW)).toThrow(
      /Invalid Date/u,
    );
  });

  it("refuses a fractional quantity and says what to do instead", () => {
    expect(() => normalizeUsageEvent({ ...valid, quantity: 1.5 }, NOW)).toThrow(/whole number/u);
    expect(() => normalizeUsageEvent({ ...valid, quantity: 1.5 }, NOW)).toThrow(/smaller unit/u);
  });

  it("refuses a quantity beyond exact integer arithmetic", () => {
    expect(() => normalizeUsageEvent({ ...valid, quantity: 2 ** 53 }, NOW)).toThrow(
      /whole number/u,
    );
  });

  it("refuses NaN and Infinity", () => {
    expect(() => normalizeUsageEvent({ ...valid, quantity: Number.NaN }, NOW)).toThrow(/finite/u);
    expect(() =>
      normalizeUsageEvent({ ...valid, quantity: Number.POSITIVE_INFINITY }, NOW),
    ).toThrow(/finite/u);
  });

  it("accepts a negative quantity, which is how a correction is expressed", () => {
    expect(normalizeUsageEvent({ ...valid, quantity: -4 }, NOW).quantity).toBe(-4);
  });

  it("accepts zero", () => {
    expect(normalizeUsageEvent({ ...valid, quantity: 0 }, NOW).quantity).toBe(0);
  });

  it("requires a meter and a subject", () => {
    expect(() => normalizeUsageEvent({ ...valid, meter: "  " }, NOW)).toThrow(/`meter`/u);
    expect(() => normalizeUsageEvent({ ...valid, subject: undefined as never }, NOW)).toThrow(
      /`subject`/u,
    );
  });

  it("caps identifier length", () => {
    expect(() =>
      normalizeUsageEvent({ ...valid, meter: "m".repeat(MAX_IDENTIFIER_LENGTH + 1) }, NOW),
    ).toThrow(/longer than/u);
  });

  it("rejects control characters in identifiers", () => {
    expect(() =>
      normalizeUsageEvent({ ...valid, subject: `cus${String.fromCharCode(0x1f)}01` }, NOW),
    ).toThrow(/control character/u);
  });

  it("collapses an empty property bag to null", () => {
    expect(normalizeUsageEvent({ ...valid, properties: {} }, NOW).properties).toBeNull();
  });

  it("keeps a property bag as given", () => {
    expect(normalizeUsageEvent({ ...valid, properties: { region: "eu" } }, NOW).properties).toEqual(
      { region: "eu" },
    );
  });

  it("refuses a property bag that is not serializable", () => {
    expect(() =>
      normalizeUsageEvent({ ...valid, properties: { at: new Date() } as never }, NOW),
    ).toThrow(/not serializable/u);
  });

  it("refuses an array of properties", () => {
    expect(() => normalizeUsageEvent({ ...valid, properties: [1] as never }, NOW)).toThrow(
      /object of dimensions/u,
    );
  });

  it("caps the size of the property bag", () => {
    expect(() =>
      normalizeUsageEvent(
        { ...valid, properties: { big: "x".repeat(MAX_PROPERTIES_LENGTH) } },
        NOW,
      ),
    ).toThrow(/over the/u);
  });

  it("refuses anything that is not an object", () => {
    expect(() => normalizeUsageEvent("event" as never, NOW)).toThrow(/must be an object/u);
    expect(() => normalizeUsageEvent(null as never, NOW)).toThrow(/must be an object/u);
  });

  it("prefixes every message so a host can tell whose validation failed", () => {
    expect(() => normalizeUsageEvent({ ...valid, quantity: 1.5 }, NOW)).toThrow(/medusa-usage:/u);
  });
});
