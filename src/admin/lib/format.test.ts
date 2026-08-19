import { describe, expect, it } from "vitest";
import {
  abbreviate,
  formatAmount,
  formatAmountDelta,
  formatDelta,
  formatDuration,
  formatInstant,
  formatQuantity,
} from "./format";

describe("formatQuantity", () => {
  it("groups a large count and keeps a fractional one", () => {
    expect(formatQuantity(1_234_567)).toBe("1,234,567");
    expect(formatQuantity(0.5)).toBe("0.5");
  });

  it("renders a non-number as absent rather than as NaN", () => {
    expect(formatQuantity(Number.NaN)).toBe("-");
  });
});

describe("formatDelta", () => {
  it("signs a gain, because the sign is the message", () => {
    expect(formatDelta(12)).toBe("+12");
    expect(formatDelta(-12)).toBe("-12");
    expect(formatDelta(0)).toBe("0");
  });
});

describe("formatAmount", () => {
  it("moves the decimal point through the digits rather than dividing", () => {
    // The float division this avoids - 987654321 / 100 - is not exactly
    // 9876543.21, and an amount that came out a unit short of what was charged
    // would be worse than no screen.
    expect(formatAmount(987_654_321, "EUR")).toBe("9,876,543.21 EUR");
  });

  it("uses the currency's own exponent", () => {
    expect(formatAmount(1234, "JPY")).toBe("1,234 JPY");
    expect(formatAmount(1234, "USD")).toBe("12.34 USD");
  });

  it("pads an amount smaller than one major unit", () => {
    expect(formatAmount(7, "USD")).toBe("0.07 USD");
  });

  it("keeps the sign outside the digits", () => {
    expect(formatAmount(-1234, "USD")).toBe("-12.34 USD");
    expect(formatAmountDelta(1234, "USD")).toBe("+12.34 USD");
  });

  it("falls back to two places for a code Intl does not know", () => {
    expect(formatAmount(1234, "ZZZ")).toBe("12.34 ZZZ");
  });
});

describe("formatInstant", () => {
  it("renders in UTC, always, so two boundaries can be compared", () => {
    expect(formatInstant("2026-08-19T11:39:07.512Z")).toBe("2026-08-19 11:39:07 UTC");
  });

  it("renders a missing or unparseable instant as absent", () => {
    expect(formatInstant(null)).toBe("-");
    expect(formatInstant("")).toBe("-");
    expect(formatInstant("not an instant")).toBe("-");
  });
});

describe("formatDuration", () => {
  it("picks the largest unit that leaves a number worth reading", () => {
    expect(formatDuration(900)).toBe("900ms");
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(90_000)).toBe("1.5m");
    expect(formatDuration(7_200_000)).toBe("2h");
    expect(formatDuration(172_800_000)).toBe("2d");
  });

  it("renders zero, which is what an unset close delay looks like", () => {
    expect(formatDuration(0)).toBe("0ms");
  });
});

describe("abbreviate", () => {
  it("shortens a digest but leaves a short one alone", () => {
    expect(abbreviate("uper_0123456789abcdef", 14)).toBe("uper_012345678...");
    expect(abbreviate("short")).toBe("short");
  });
});
