import { describe, expect, it } from "vitest";
import { buildUsageSnapshot } from "../usage/snapshot";
import type { PeriodResultInput } from "./result";
import { buildPeriodResult, PERIOD_RESULT_VERSION, verifyPeriodResult } from "./result";
import type { MeterRate } from "./rates";
import { rateSnapshot } from "./rating";

const FROM = new Date("2026-08-01T00:00:00.000Z");
const TO = new Date("2026-09-01T00:00:00.000Z");
const CLOSED_AT = new Date("2026-09-01T02:00:00.000Z");
const PERIOD_ID = "ubp_4ddb0a0076cf06a767a38993edf3527b2eba31376d58f60bf4af6e50ba2bca9d";

const rate = (overrides: Partial<MeterRate> = {}): MeterRate => ({
  includedUnits: 0,
  meter: "api_request",
  perUnits: 1,
  unitAmount: 12,
  ...overrides,
});

const line = (total: number, overrides: Partial<MeterRate> = {}, eventCount = 3) =>
  rateSnapshot(
    rate(overrides),
    buildUsageSnapshot(
      { from: FROM, meter: overrides.meter ?? "api_request", subject: "cus_01", to: TO },
      {
        eventCount,
        firstOccurredAt: eventCount === 0 ? null : FROM,
        lastOccurredAt: eventCount === 0 ? null : new Date("2026-08-31T00:00:00.000Z"),
        total,
      },
      "postgres",
      CLOSED_AT,
    ),
  );

const result = (overrides: Partial<PeriodResultInput> = {}) =>
  buildPeriodResult({
    closedAt: CLOSED_AT,
    currency: "PLN",
    from: FROM,
    lines: [line(1000)],
    periodId: PERIOD_ID,
    sink: "postgres",
    subject: "cus_01",
    to: TO,
    ...overrides,
  });

describe("buildPeriodResult", () => {
  it("carries the period, the currency and the total", () => {
    expect(result()).toMatchObject({
      currency: "PLN",
      eventCount: 3,
      from: "2026-08-01T00:00:00.000Z",
      periodId: PERIOD_ID,
      sink: "postgres",
      subject: "cus_01",
      to: "2026-09-01T00:00:00.000Z",
      total: 12_000,
      version: PERIOD_RESULT_VERSION,
    });
  });

  it("sums the lines rather than trusting a caller's total", () => {
    const summed = result({
      lines: [line(1000), line(50, { meter: "gb_egress", unitAmount: 100 })],
    });
    expect(summed.total).toBe(12_000 + 5_000);
    expect(summed.eventCount).toBe(6);
  });

  it("is frozen, because a result that can be edited is not a record of anything", () => {
    expect(Object.isFrozen(result())).toBe(true);
  });

  /**
   * A period that closed with nothing in it. This is a normal outcome of a free
   * subscription, not an edge case: the period is provably closed, provably empty,
   * and a host reads `eventCount: 0` and issues no invoice at all.
   */
  it("closes an empty period to a zero total with a line per meter", () => {
    const empty = result({ lines: [line(0, {}, 0), line(0, { meter: "gb_egress" }, 0)] });

    expect(empty.total).toBe(0);
    expect(empty.eventCount).toBe(0);
    expect(empty.lines).toHaveLength(2);
    expect(empty.lines[0]).toMatchObject({ amount: 0, meter: "api_request", quantity: 0 });
    expect(empty.digest).toMatch(/^uper_[0-9a-f]{64}$/u);
  });

  /**
   * The other zero. Usage happened and it was all inside the allowance, so the
   * period is closed, owes nothing, and says why: `eventCount` is not zero.
   */
  it("tells a period that used nothing apart from one that owed nothing", () => {
    const forgiven = result({ lines: [line(80, { includedUnits: 100 })] });

    expect(forgiven.total).toBe(0);
    expect(forgiven.eventCount).toBe(3);
    expect(forgiven.lines[0]).toMatchObject({ chargeableQuantity: 0, quantity: 80 });
  });

  it("reports a period whose corrections outweighed its usage as a credit", () => {
    expect(result({ lines: [line(-10)] }).total).toBe(-120);
  });

  it("refuses a total beyond exact integer arithmetic rather than billing a rounded one", () => {
    expect(() =>
      result({
        lines: [
          line(Number.MAX_SAFE_INTEGER, { unitAmount: 1, ...{} }),
          line(Number.MAX_SAFE_INTEGER, { meter: "gb_egress", unitAmount: 1 }),
        ],
      }),
    ).toThrow(/beyond exact integer arithmetic/u);
  });
});

describe("the digest", () => {
  /**
   * The pinned value. It is what a host compares months later to prove the number
   * it billed still falls out of the log. Moving it invalidates every result ever
   * frozen, so it moves only alongside `PERIOD_RESULT_VERSION`.
   */
  it("digests the documented value", () => {
    expect(result().digest).toBe(
      "uper_dd025dc6fdbdc3b9e6556e583d3e5429920f28eed8e9afd73dff321cb3d27886",
    );
  });

  it("re-derives the same digest whenever it is recomputed", () => {
    expect(result({ closedAt: new Date("2027-03-04T00:00:00.000Z") }).digest).toBe(
      result().digest,
    );
  });

  it("re-derives the same digest from a different sink, so a migration stays checkable", () => {
    expect(result({ sink: "tinybird" }).digest).toBe(result().digest);
  });

  it("changes when the money changes", () => {
    expect(result({ lines: [line(1000, { unitAmount: 13 })] }).digest).not.toBe(result().digest);
  });

  it("changes when the same amount comes from a different quantity", () => {
    expect(result({ lines: [line(2000, { unitAmount: 6 })] }).digest).not.toBe(result().digest);
  });

  it("changes when the currency changes, because the number means something else", () => {
    expect(result({ currency: "EUR" }).digest).not.toBe(result().digest);
  });

  it("changes when the window moves", () => {
    expect(result({ to: new Date("2026-09-02T00:00:00.000Z") }).digest).not.toBe(result().digest);
  });

  it("changes when the same total comes from a different number of events", () => {
    expect(result({ lines: [line(1000, {}, 4)] }).digest).not.toBe(result().digest);
  });

  it("survives a round trip through JSON, which is how it is stored", () => {
    const stored = JSON.parse(JSON.stringify(result())) as ReturnType<typeof result>;
    expect(
      buildPeriodResult({
        closedAt: new Date(stored.closedAt),
        currency: stored.currency,
        from: new Date(stored.from),
        lines: stored.lines,
        periodId: stored.periodId,
        sink: stored.sink,
        subject: stored.subject,
        to: new Date(stored.to),
      }).digest,
    ).toBe(stored.digest);
  });
});

describe("verifyPeriodResult", () => {
  it("matches when the log behind the result has not moved", () => {
    const verification = verifyPeriodResult(result(), result());

    expect(verification.matches).toBe(true);
    expect(verification.totalDelta).toBe(0);
    expect(verification.lines[0]).toMatchObject({ amountDelta: 0, quantityDelta: 0 });
  });

  /**
   * What a late event looks like from here: the frozen result stands, and the
   * verification says exactly how much the window has gained since. Nothing is
   * rewritten, because the invoice was sent for the number on the left.
   */
  it("reports the difference when the window has gained usage since it closed", () => {
    const verification = verifyPeriodResult(result(), result({ lines: [line(1100)] }));

    expect(verification.matches).toBe(false);
    expect(verification.storedTotal).toBe(12_000);
    expect(verification.recomputedTotal).toBe(13_200);
    expect(verification.totalDelta).toBe(1200);
    expect(verification.lines[0]).toMatchObject({
      amountDelta: 1200,
      currentQuantity: 1100,
      meter: "api_request",
      quantity: 1000,
      quantityDelta: 100,
    });
  });

  it("treats a meter that has vanished from the recomputation as zero, not as a match", () => {
    const verification = verifyPeriodResult(
      result({ lines: [line(1000), line(50, { meter: "gb_egress", unitAmount: 100 })] }),
      result({ lines: [line(1000)] }),
    );

    expect(verification.matches).toBe(false);
    expect(verification.lines[1]).toMatchObject({
      amount: 5000,
      currentAmount: 0,
      currentQuantity: 0,
      meter: "gb_egress",
    });
  });

  it("names the period it verified", () => {
    expect(verifyPeriodResult(result(), result()).periodId).toBe(PERIOD_ID);
  });
});
