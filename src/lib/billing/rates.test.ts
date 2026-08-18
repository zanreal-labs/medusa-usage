import { describe, expect, it } from "vitest";
import { rateFor, resolveRateCard } from "./rates";

const card = (overrides: Record<string, unknown> = {}) =>
  resolveRateCard({
    currency: "PLN",
    rates: [{ meter: "api_request", unitAmount: 12 }],
    ...overrides,
  } as never);

describe("resolveRateCard", () => {
  it("is null when the host configured no rates, so the plugin only meters", () => {
    expect(resolveRateCard()).toBeNull();
    expect(resolveRateCard(null)).toBeNull();
  });

  it("fills in the defaults a plain per-unit rate leaves out", () => {
    expect(card()?.rates[0]).toEqual({
      includedUnits: 0,
      meter: "api_request",
      perUnits: 1,
      unitAmount: 12,
    });
  });

  it("keeps the allowance and the denominator when they are given", () => {
    const resolved = card({
      rates: [{ includedUnits: 1000, meter: "api_request", perUnits: 10_000, unitAmount: 12 }],
    });
    expect(resolved?.rates[0]).toMatchObject({ includedUnits: 1000, perUnits: 10_000 });
  });

  it("does not close a period early by default", () => {
    expect(card()?.closeDelayMs).toBe(0);
  });

  it("carries the currency verbatim, without resolving it against anything", () => {
    expect(card({ currency: "PLN" })?.currency).toBe("PLN");
    expect(card({ currency: " EUR " })?.currency).toBe("EUR");
  });

  it("is frozen, rates and all", () => {
    const resolved = card();
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved?.rates[0])).toBe(true);
  });

  it("prices a meter at nothing when that is what the host asked for", () => {
    expect(card({ rates: [{ meter: "api_request", unitAmount: 0 }] })?.rates[0].unitAmount).toBe(0);
  });

  it("finds a meter's rate, and says so plainly when there is none", () => {
    const resolved = card();
    expect(rateFor(resolved!, "api_request")?.unitAmount).toBe(12);
    expect(rateFor(resolved!, "gb_egress")).toBeNull();
  });
});

describe("resolveRateCard: what it refuses", () => {
  it("refuses an amount with no currency, rather than guessing one", () => {
    expect(() => card({ currency: "" })).toThrow(/`billing.currency` is required/u);
    expect(() => card({ currency: 42 })).toThrow(/`billing.currency` is required/u);
  });

  it("refuses a currency that cannot be one", () => {
    expect(() => card({ currency: "a-very-long-currency-name" })).toThrow(/not a currency code/u);
  });

  it("refuses a card with no rates, which would close every period at zero", () => {
    expect(() => card({ rates: [] })).toThrow(/at least one meter/u);
    expect(() => card({ rates: "PLN" })).toThrow(/at least one meter/u);
  });

  it("refuses a rate with no meter", () => {
    expect(() => card({ rates: [{ unitAmount: 12 }] })).toThrow(/needs a `meter`/u);
  });

  /** Two prices for one meter is a total that depends on which one was applied. */
  it("refuses two rates for the same meter", () => {
    expect(() =>
      card({
        rates: [
          { meter: "api_request", unitAmount: 12 },
          { meter: "api_request", unitAmount: 13 },
        ],
      }),
    ).toThrow(/two rates are configured/u);
  });

  it("refuses a price that is not a whole number of minor units", () => {
    expect(() => card({ rates: [{ meter: "api_request", unitAmount: 0.5 }] })).toThrow(
      /whole number/u,
    );
  });

  it("refuses a negative price, which is a discount and not a rate", () => {
    expect(() => card({ rates: [{ meter: "api_request", unitAmount: -1 }] })).toThrow(
      /at least 0/u,
    );
  });

  it("refuses a denominator of zero, which is not a division", () => {
    expect(() => card({ rates: [{ meter: "api_request", perUnits: 0, unitAmount: 1 }] })).toThrow(
      /at least 1/u,
    );
  });

  it("refuses a negative allowance", () => {
    expect(() =>
      card({ rates: [{ includedUnits: -5, meter: "api_request", unitAmount: 1 }] }),
    ).toThrow(/at least 0/u);
  });

  it("refuses a negative close delay", () => {
    expect(() => card({ closeDelayMs: -1 })).toThrow(/at least 0/u);
  });

  it("refuses a meter name that could break the identity it is joined into", () => {
    expect(() => card({ rates: [{ meter: "apirequest", unitAmount: 1 }] })).toThrow(
      /control character/u,
    );
  });
});
