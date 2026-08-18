import { describe, expect, it } from "vitest";
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_FLUSH_INTERVAL_MS,
  DEFAULT_SINK_ID,
  resolveUsageOptions,
} from "./options";

describe("resolveUsageOptions", () => {
  it("works with no options at all", () => {
    const resolved = resolveUsageOptions();
    expect(resolved.providers).toEqual([
      { id: DEFAULT_SINK_ID, resolve: "@zanreal/medusa-usage/providers/postgres" },
    ]);
    expect(resolved.batchSize).toBe(DEFAULT_BATCH_SIZE);
    expect(resolved.flushIntervalMs).toBe(DEFAULT_FLUSH_INTERVAL_MS);
    expect(resolved.flushMode).toBe("buffered");
    expect(resolved.sink).toBeNull();
  });

  it("keeps the host's providers", () => {
    const providers = [{ id: "warehouse", options: { url: "x" }, resolve: "@acme/sink" }];
    expect(resolveUsageOptions({ providers }).providers).toEqual(providers);
  });

  it("refuses an empty provider list rather than silently defaulting", () => {
    expect(() => resolveUsageOptions({ providers: [] })).toThrow(/nowhere to put usage events/u);
  });

  it("requires a resolve and an id on every provider", () => {
    expect(() => resolveUsageOptions({ providers: [{ id: "x" } as never] })).toThrow(/`resolve`/u);
    expect(() => resolveUsageOptions({ providers: [{ resolve: "@acme/sink" } as never] })).toThrow(
      /`id`/u,
    );
  });

  it("refuses two providers with the same id", () => {
    expect(() =>
      resolveUsageOptions({
        providers: [
          { id: "same", resolve: "@acme/a" },
          { id: "same", resolve: "@acme/b" },
        ],
      }),
    ).toThrow(/share the id/u);
  });

  it("refuses a flushMode it does not implement", () => {
    expect(() => resolveUsageOptions({ flushMode: "eventual" as never })).toThrow(/flushMode/u);
  });

  it("refuses sizes that are not whole positive numbers", () => {
    expect(() => resolveUsageOptions({ batchSize: 0 })).toThrow(/batchSize/u);
    expect(() => resolveUsageOptions({ batchSize: 1.5 })).toThrow(/batchSize/u);
    expect(() => resolveUsageOptions({ maxEventsPerCall: -1 })).toThrow(/maxEventsPerCall/u);
  });

  it("keeps the flush interval above a floor, so a misconfiguration cannot become a busy loop", () => {
    expect(() => resolveUsageOptions({ flushIntervalMs: 10 })).toThrow(/flushIntervalMs/u);
  });

  it("refuses a buffer ceiling below the batch size", () => {
    expect(() => resolveUsageOptions({ batchSize: 500, maxBufferedEvents: 100 })).toThrow(
      /back pressure/u,
    );
  });

  it("trims the sink id", () => {
    expect(resolveUsageOptions({ sink: " warehouse " }).sink).toBe("warehouse");
  });

  it("refuses a blank sink id", () => {
    expect(() => resolveUsageOptions({ sink: "  " })).toThrow(/`sink`/u);
  });
});

describe("resolveUsageOptions: billing", () => {
  it("is null when the host only wants metering", () => {
    expect(resolveUsageOptions({}).billing).toBeNull();
  });

  it("carries the rate card through, with its defaults applied", () => {
    const resolved = resolveUsageOptions({
      billing: { currency: "PLN", rates: [{ meter: "api_request", unitAmount: 12 }] },
    });

    expect(resolved.billing).toMatchObject({ closeDelayMs: 0, currency: "PLN" });
    expect(resolved.billing?.rates[0]).toEqual({
      includedUnits: 0,
      meter: "api_request",
      perUnits: 1,
      unitAmount: 12,
    });
  });

  it("fails the boot on a rate card that cannot mean what it says", () => {
    expect(() =>
      resolveUsageOptions({ billing: { currency: "", rates: [] } as never }),
    ).toThrow(/`billing.currency` is required/u);
  });
});
