import { describe, expect, it } from "vitest";
import { buildUsageSnapshot } from "../usage/snapshot";
import type { MeterRate } from "./rates";
import { amountFor, chargeableQuantity, rateSnapshot, rerateLine } from "./rating";

/**
 * The money tests.
 *
 * These get the same treatment the deduplication key gets, and for a symmetrical
 * reason: a key that is wrong counts an event twice, and an amount that is wrong
 * charges for it twice. Every case below is a number someone could be invoiced
 * for.
 */

const rate = (overrides: Partial<MeterRate> = {}): MeterRate => ({
  includedUnits: 0,
  meter: "api_request",
  perUnits: 1,
  unitAmount: 12,
  ...overrides,
});

const COMPUTED_AT = new Date("2026-09-01T02:00:00.000Z");

const snapshot = (total: number, meter = "api_request", eventCount = 3) =>
  buildUsageSnapshot(
    {
      from: new Date("2026-08-01T00:00:00.000Z"),
      meter,
      subject: "cus_01",
      to: new Date("2026-09-01T00:00:00.000Z"),
    },
    {
      eventCount,
      firstOccurredAt: new Date("2026-08-01T00:00:00.000Z"),
      lastOccurredAt: new Date("2026-08-31T00:00:00.000Z"),
      total,
    },
    "postgres",
    COMPUTED_AT,
  );

describe("chargeableQuantity", () => {
  it("charges for everything when there is no allowance", () => {
    expect(chargeableQuantity(1000, 0)).toBe(1000);
  });

  it("forgives the allowance and charges for the rest", () => {
    expect(chargeableQuantity(150, 100)).toBe(50);
  });

  it("charges for nothing when usage lands exactly on the allowance", () => {
    expect(chargeableQuantity(100, 100)).toBe(0);
  });

  it("charges for nothing when usage stays under the allowance", () => {
    expect(chargeableQuantity(1, 100)).toBe(0);
  });

  it("leaves a period that consumed nothing at nothing", () => {
    expect(chargeableQuantity(0, 100)).toBe(0);
    expect(chargeableQuantity(0, 0)).toBe(0);
  });

  /**
   * A net-negative period is corrections outweighing usage. An allowance forgives
   * consumption; it must not be able to turn a credit into zero, because that
   * would swallow money the customer is owed.
   */
  it("passes a credit through untouched rather than clamping it with the allowance", () => {
    expect(chargeableQuantity(-40, 100)).toBe(-40);
    expect(chargeableQuantity(-40, 0)).toBe(-40);
  });

  it("refuses a total that is not a whole number", () => {
    expect(() => chargeableQuantity(1.5, 0)).toThrow(/not a whole number/u);
  });
});

describe("amountFor", () => {
  it("is quantity times rate", () => {
    expect(amountFor(1000, rate({ unitAmount: 12 }))).toBe(12_000);
  });

  it("charges nothing for a meter priced at nothing", () => {
    expect(amountFor(1_000_000, rate({ unitAmount: 0 }))).toBe(0);
  });

  it("charges nothing for no usage", () => {
    expect(amountFor(0, rate())).toBe(0);
  });

  /**
   * The reason a rate has a denominator: 12 grosze per 10 000 requests is a real
   * price, and without one it could only be expressed by inventing a meter that
   * counts ten-thousands of requests.
   */
  it("divides by the rate's denominator, once, at the end", () => {
    expect(amountFor(1_234_567, rate({ perUnits: 10_000, unitAmount: 12 }))).toBe(1481);
  });

  it("drops the fraction of a minor unit rather than rounding it up", () => {
    // 9999 * 12 / 10000 is 11.9988. A fraction of a grosz cannot be invoiced.
    expect(amountFor(9999, rate({ perUnits: 10_000, unitAmount: 12 }))).toBe(11);
  });

  /**
   * The property that makes a correction able to undo a charge exactly. Truncating
   * toward zero is symmetric; flooring is not, and under flooring a reversal would
   * refund a grosz more than was charged.
   */
  it("rates a credit as the exact negation of the charge it reverses", () => {
    const priced = rate({ perUnits: 10_000, unitAmount: 12 });
    for (const quantity of [1, 9999, 1_234_567, 500_000_001]) {
      // `0 - x` rather than `-x`, so a zero amount compares as a zero rather than
      // as a negative zero. The amount itself is never a negative zero: it comes
      // out of `Number(0n)`.
      expect(amountFor(-quantity, priced)).toBe(0 - amountFor(quantity, priced));
    }
  });

  /**
   * The intermediate product here is about 9 * 10^18, far past what a double can
   * represent exactly. Done in doubles this returns 9007199254740992, which is one
   * unit too many and would be a real overcharge.
   */
  it("keeps the intermediate product exact past 2^53", () => {
    expect(
      amountFor(Number.MAX_SAFE_INTEGER, rate({ perUnits: 1000, unitAmount: 1000 })),
    ).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("refuses an amount beyond exact integer arithmetic rather than rounding it", () => {
    expect(() => amountFor(Number.MAX_SAFE_INTEGER, rate({ unitAmount: 1000 }))).toThrow(
      /beyond exact integer arithmetic/u,
    );
  });
});

describe("rateSnapshot", () => {
  it("carries the arithmetic that produced the amount, not just the amount", () => {
    const line = rateSnapshot(rate({ includedUnits: 100, unitAmount: 5 }), snapshot(150));

    expect(line).toMatchObject({
      amount: 250,
      chargeableQuantity: 50,
      eventCount: 3,
      includedUnits: 100,
      meter: "api_request",
      perUnits: 1,
      quantity: 150,
      unitAmount: 5,
    });
  });

  it("points at the usage snapshot it was rated from", () => {
    const taken = snapshot(150);
    expect(rateSnapshot(rate(), taken).usageDigest).toBe(taken.digest);
  });

  it("carries the window's first and last instants, so a line can be placed in time", () => {
    const line = rateSnapshot(rate(), snapshot(150));
    expect(line.firstOccurredAt).toBe("2026-08-01T00:00:00.000Z");
    expect(line.lastOccurredAt).toBe("2026-08-31T00:00:00.000Z");
  });

  it("rates an empty period to a line of zeroes rather than to no line at all", () => {
    const empty = buildUsageSnapshot(
      {
        from: new Date("2026-08-01T00:00:00.000Z"),
        meter: "api_request",
        subject: "cus_01",
        to: new Date("2026-09-01T00:00:00.000Z"),
      },
      { eventCount: 0, firstOccurredAt: null, lastOccurredAt: null, total: 0 },
      "postgres",
      COMPUTED_AT,
    );
    const line = rateSnapshot(rate(), empty);

    expect(line.amount).toBe(0);
    expect(line.eventCount).toBe(0);
    expect(line.quantity).toBe(0);
    expect(line.firstOccurredAt).toBeNull();
  });

  it("is frozen, because a line that can be edited justifies nothing", () => {
    expect(Object.isFrozen(rateSnapshot(rate(), snapshot(150)))).toBe(true);
  });

  it("refuses a snapshot of a different meter", () => {
    expect(() => rateSnapshot(rate(), snapshot(150, "gb_egress"))).toThrow(
      /was handed to the rate for/u,
    );
  });
});

describe("rerateLine", () => {
  it("re-rates from the recorded rate, not from anything current", () => {
    const billed = rateSnapshot(rate({ includedUnits: 100, unitAmount: 5 }), snapshot(150));
    const again = rerateLine(billed, snapshot(150));

    expect(again).toEqual(billed);
  });

  it("shows the difference when the log has moved under a closed period", () => {
    const billed = rateSnapshot(rate({ unitAmount: 5 }), snapshot(150));
    const again = rerateLine(billed, snapshot(170));

    expect(billed.amount).toBe(750);
    expect(again.amount).toBe(850);
    expect(again.unitAmount).toBe(5);
  });
});
