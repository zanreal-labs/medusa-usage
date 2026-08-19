import type { PeriodResult, PeriodVerification } from "../../lib/billing/result";
import { describe, expect, it } from "vitest";
import type { PeriodRow, UsageStatusResponse } from "./api";
import { readClosability, readIngestion, readRateCard, readVerification } from "./verdicts";

const RATES: NonNullable<UsageStatusResponse["rates"]> = {
  closeDelayMs: 3_600_000,
  currency: "EUR",
  meters: [{ includedUnits: 0, meter: "api_request", perUnits: 1, unitAmount: 2 }],
};

const status = (overrides: Partial<UsageStatusResponse> = {}): UsageStatusResponse => ({
  batch_size: 500,
  buffered: 0,
  flush_interval_ms: 5000,
  flush_mode: "buffered",
  last_flush_at: null,
  last_flush_error: null,
  oldest_buffered_ms: 0,
  rates: RATES,
  sink: "postgres",
  sinks: ["postgres"],
  ...overrides,
});

const period = (overrides: Partial<PeriodRow> = {}): PeriodRow => ({
  closed_at: null,
  created_at: "2026-08-01T00:00:00.000Z",
  ends_at: "2026-09-01T00:00:00.000Z",
  id: "ubp_1",
  starts_at: "2026-08-01T00:00:00.000Z",
  subject: "cus_01",
  ...overrides,
});

describe("readIngestion", () => {
  it("calls a flush error what it is, and says the usage is only in memory", () => {
    const verdict = readIngestion(
      status({ buffered: 40, last_flush_error: "connection refused" }),
    );
    expect(verdict.tone).toBe("red");
    expect(verdict.detail).toContain("connection refused");
    expect(verdict.detail).toContain("only in memory");
  });

  it("prefers the flush error over the healthy-looking counts beside it", () => {
    // A recent successful flush does not make a current failure less current.
    const verdict = readIngestion(
      status({
        buffered: 0,
        last_flush_at: "2026-08-19T11:00:00.000Z",
        last_flush_error: "connection refused",
      }),
    );
    expect(verdict.tone).toBe("red");
  });

  it("does not report a buffer an immediate installation does not have", () => {
    const verdict = readIngestion(status({ flush_mode: "immediate" }));
    expect(verdict.tone).toBe("green");
    expect(verdict.detail).toContain("as it arrives");
  });

  it("flags a buffer that has never been flushed, which a healthy one has", () => {
    const verdict = readIngestion(status({ buffered: 12, oldest_buffered_ms: 900 }));
    expect(verdict.tone).toBe("orange");
    expect(verdict.headline).toBe("Buffering, nothing written yet");
  });

  it("is content with a buffer that is being flushed", () => {
    const verdict = readIngestion(
      status({ buffered: 12, last_flush_at: "2026-08-19T11:00:00.000Z", oldest_buffered_ms: 900 }),
    );
    expect(verdict.tone).toBe("green");
    expect(verdict.detail).toContain("12 events waiting");
  });

  it("refuses to call an empty, never-flushed instance either healthy or broken", () => {
    // This is the state a fresh install is in, and the state a dead producer
    // leaves behind. Saying so is the whole point of the grey.
    const verdict = readIngestion(status());
    expect(verdict.tone).toBe("grey");
    expect(verdict.detail).toContain("broken producer");
  });

  it("says the counts describe one instance, not the deployment", () => {
    expect(readIngestion(status()).detail).toContain("served this request");
  });
});

describe("readRateCard", () => {
  it("treats a missing rate card as a configuration, not a fault", () => {
    const verdict = readRateCard(status({ rates: null }));
    expect(verdict.tone).toBe("grey");
    expect(verdict.detail).toContain("not closed");
  });

  it("counts the priced meters and names the currency", () => {
    expect(readRateCard(status()).detail).toContain("1 meter priced in EUR");
  });
});

describe("readClosability", () => {
  it("reports a closed period as closed, and says a second close cannot bill twice", () => {
    const verdict = readClosability(
      period({ closed_at: "2026-09-01T02:00:00.000Z" }),
      RATES,
      new Date("2026-09-02T00:00:00.000Z"),
    );
    expect(verdict.state).toBe("closed");
    expect(verdict.reason).toContain("bill twice");
  });

  it("does not blame a missing rate card before it has read one", () => {
    // `undefined` is "not read yet" and `null` is "there is none". Reporting the
    // second while waiting for the first would send an operator to configure
    // something that may already be configured.
    const verdict = readClosability(period(), undefined, new Date("2026-09-02T00:00:00.000Z"));
    expect(verdict.state).toBe("unknown");
  });

  it("blocks a close with no rate card to rate it against", () => {
    const verdict = readClosability(period(), null, new Date("2026-09-02T00:00:00.000Z"));
    expect(verdict.state).toBe("no-rate-card");
  });

  it("reproduces the server's hold, so the reason is read before the button is pressed", () => {
    // `assertClosable` refuses until ends_at + closeDelayMs. The window below is
    // over, but the hour of grace is not.
    const verdict = readClosability(period(), RATES, new Date("2026-09-01T00:30:00.000Z"));
    expect(verdict.state).toBe("too-early");
    expect(verdict.closableAt).toBe("2026-09-01T01:00:00.000Z");
  });

  it("allows the close on the instant the hold expires, exactly as the server does", () => {
    expect(readClosability(period(), RATES, new Date("2026-09-01T01:00:00.000Z")).state).toBe(
      "closable",
    );
  });

  it("does not mention a hold that is not configured", () => {
    const verdict = readClosability(
      period(),
      { ...RATES, closeDelayMs: 0 },
      new Date("2026-08-31T23:59:59.999Z"),
    );
    expect(verdict.state).toBe("too-early");
    expect(verdict.reason).not.toContain("held open");
  });
});

describe("readVerification", () => {
  const result = { currency: "EUR" } as PeriodResult;

  const verification = (overrides: Partial<PeriodVerification> = {}): PeriodVerification => ({
    lines: [],
    matches: true,
    periodId: "ubp_1",
    recomputedDigest: "uper_a",
    recomputedTotal: 1000,
    storedDigest: "uper_a",
    storedTotal: 1000,
    totalDelta: 0,
    ...overrides,
  });

  it("says a match is about the evidence, not about the number", () => {
    const verdict = readVerification(verification(), result);
    expect(verdict.tone).toBe("green");
    expect(verdict.detail).toContain("10.00 EUR");
  });

  it("explains a mismatch where nothing moved, rather than saying 0 of 2 differ", () => {
    // A digest covers the instants a line spans and the snapshot it was rated
    // from, so events that cancel out fail to verify with every delta at zero.
    const verdict = readVerification(
      verification({
        lines: [
          {
            amount: 1000,
            amountDelta: 0,
            currentAmount: 1000,
            currentQuantity: 500,
            meter: "api_request",
            quantity: 500,
            quantityDelta: 0,
          },
        ],
        matches: false,
        recomputedDigest: "uper_b",
      }),
      result,
    );

    expect(verdict.tone).toBe("orange");
    expect(verdict.detail).not.toContain("0 of 1");
    expect(verdict.detail).toContain("cancel out");
  });

  it("reports a mismatch as a difference, not as an error, and says nothing was rewritten", () => {
    const verdict = readVerification(
      verification({
        lines: [
          {
            amount: 1000,
            amountDelta: 200,
            currentAmount: 1200,
            currentQuantity: 600,
            meter: "api_request",
            quantity: 500,
            quantityDelta: 100,
          },
          {
            amount: 0,
            amountDelta: 0,
            currentAmount: 0,
            currentQuantity: 0,
            meter: "storage_gb",
            quantity: 0,
            quantityDelta: 0,
          },
        ],
        matches: false,
        recomputedDigest: "uper_b",
        recomputedTotal: 1200,
        totalDelta: 200,
      }),
      result,
    );

    expect(verdict.tone).toBe("orange");
    expect(verdict.detail).toContain("1 of 2 meters differ");
    expect(verdict.detail).toContain("+2.00 EUR");
    expect(verdict.detail).toContain("has not been rewritten");
  });
});
