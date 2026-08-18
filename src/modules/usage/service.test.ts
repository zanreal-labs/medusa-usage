import { describe, expect, it, vi } from "vitest";
import type { BillingPeriod } from "../../lib/billing/period";
import { periodIdFor } from "../../lib/billing/period";
import type { PeriodResult } from "../../lib/billing/result";
import type { UsagePluginOptions } from "../../lib/options";
import { resolveUsageOptions } from "../../lib/options";
import { sinkRegistrationKey } from "../../lib/sink/registry";
import type { UsageAggregateQuery, UsageSinkProvider } from "../../lib/sink/types";
import { USAGE_SINK_IDENTIFIERS } from "../../lib/sink/types";
import { UsageBuffer } from "../../lib/usage/buffer";
import type { UsageEvent } from "../../lib/usage/event";
import UsageModuleService from "./service";

/**
 * Unit tests, not module-integration tests.
 *
 * Everything worth asserting here is above the database: whether a call buffers
 * instead of writing, whether a batch leaves when it should, what happens to a
 * batch whose write fails, and whether a snapshot is taken over a flushed buffer.
 * All of it is observable against a fake sink, so the sink is faked and the real
 * method bodies run - `this` is built on the prototype rather than the class being
 * instantiated, so none of this is a restatement of the implementation.
 *
 * The sink's own behaviour has its own tests, and its SQL was verified against a
 * real Postgres 16 while the migration was written.
 */

const fakeSink = (overrides: Partial<UsageSinkProvider> = {}) => {
  const written: UsageEvent[][] = [];
  const sink = {
    aggregate: vi.fn(async () => ({
      eventCount: 2,
      firstOccurredAt: new Date("2026-08-02T00:00:00.000Z"),
      lastOccurredAt: new Date("2026-08-30T00:00:00.000Z"),
      total: 8,
    })),
    getIdentifier: () => "postgres",
    listEvents: vi.fn(async () => ({ events: [], nextCursor: null })),
    write: vi.fn(async (events: readonly UsageEvent[]) => {
      written.push([...events]);
      return { appended: events.length, duplicates: 0, received: events.length };
    }),
    ...overrides,
  };
  return { sink: sink as unknown as UsageSinkProvider, written };
};

const buildService = (config: {
  options?: Partial<UsagePluginOptions>;
  sink?: UsageSinkProvider;
  sinkIds?: string[];
  periodStore?: ReturnType<typeof fakePeriodStore>;
} = {}) => {
  const service = Object.create(UsageModuleService.prototype) as UsageModuleService;
  const ids = config.sinkIds ?? ["postgres"];
  const cradle: Record<string, unknown> = { [USAGE_SINK_IDENTIFIERS]: ids };
  if (config.sink) {
    cradle[sinkRegistrationKey(ids[0] ?? "postgres")] = config.sink;
  }

  // Private fields, normally set by the constructor and the field initializers,
  // neither of which runs under Object.create.
  Object.assign(service as unknown as Record<string, unknown>, {
    buffer: new UsageBuffer(),
    cradle,
    flushing: null,
    lastFlushAt: null,
    lastFlushError: null,
    options: resolveUsageOptions(config.options),
    periodStore: config.periodStore ?? fakePeriodStore(),
    timer: null,
  });

  return service;
};

const usage = (overrides: Record<string, unknown> = {}) => ({
  meter: "api_request",
  occurredAt: "2026-08-18T09:15:00.000Z",
  quantity: 1,
  subject: "cus_01",
  ...overrides,
});

describe("record: buffered", () => {
  it("returns without writing", async () => {
    const { sink, written } = fakeSink();
    const service = buildService({ sink });

    const result = await service.record(usage());

    expect(written).toHaveLength(0);
    expect(result.buffered).toBe(1);
    expect(result.written).toBeNull();
    expect(result.keys[0]).toMatch(/^uev_[0-9a-f]{64}$/u);
  });

  it("returns the same key for the same event, so a retry is safe", async () => {
    const service = buildService({ sink: fakeSink().sink });
    const first = await service.record(usage());
    const second = await service.record(usage());
    expect(second.keys).toEqual(first.keys);
  });

  it("drops a repeat that lands before the batch has left", async () => {
    const service = buildService({ sink: fakeSink().sink });
    await service.record(usage());
    const again = await service.record(usage());
    expect(again.deduplicated).toBe(1);
    expect(again.accepted).toBe(0);
    expect(again.buffered).toBe(1);
  });

  it("accepts a list", async () => {
    const service = buildService({ sink: fakeSink().sink });
    const result = await service.record([usage({ quantity: 1 }), usage({ quantity: 2 })]);
    expect(result.accepted).toBe(2);
  });

  it("does nothing for an empty list", async () => {
    const { sink, written } = fakeSink();
    const service = buildService({ sink });
    expect(await service.record([])).toMatchObject({ accepted: 0, keys: [] });
    expect(written).toHaveLength(0);
  });

  it("rejects the whole call when one event is invalid, rather than queuing half of it", async () => {
    const service = buildService({ sink: fakeSink().sink });
    await expect(service.record([usage(), usage({ quantity: 1.5 })])).rejects.toThrow(
      /whole number/u,
    );
    expect((await service.getStatus()).buffered).toBe(0);
  });

  it("refuses a call larger than the per-call limit", async () => {
    const service = buildService({ options: { maxEventsPerCall: 2 }, sink: fakeSink().sink });
    await expect(
      service.record([usage({ quantity: 1 }), usage({ quantity: 2 }), usage({ quantity: 3 })]),
    ).rejects.toThrow(/maxEventsPerCall/u);
  });

  it("writes as soon as a batch is full", async () => {
    const { sink, written } = fakeSink();
    const service = buildService({ options: { batchSize: 2 }, sink });

    await service.record([usage({ quantity: 1 }), usage({ quantity: 2 })]);
    await service.flush();

    expect(written.flat()).toHaveLength(2);
  });

  it("makes the caller wait once the buffer hits its ceiling", async () => {
    const { sink, written } = fakeSink();
    const service = buildService({
      options: { batchSize: 2, maxBufferedEvents: 2 },
      sink,
    });

    const result = await service.record([usage({ quantity: 1 }), usage({ quantity: 2 })]);

    // The flush was awaited inside record, so the events are already gone and
    // the call reports an empty buffer rather than the ceiling it just hit.
    expect(written.flat()).toHaveLength(2);
    expect(result.accepted).toBe(2);
    expect(result.buffered).toBe(0);
    expect((await service.getStatus()).buffered).toBe(0);
  });
});

describe("record: immediate", () => {
  it("writes before it returns", async () => {
    const { sink, written } = fakeSink();
    const service = buildService({ options: { flushMode: "immediate" }, sink });

    const result = await service.record(usage());

    expect(written.flat()).toHaveLength(1);
    expect(result.written).toBe(1);
    expect(result.buffered).toBe(0);
  });

  it("collapses duplicates inside one call before writing", async () => {
    const { sink, written } = fakeSink();
    const service = buildService({ options: { flushMode: "immediate" }, sink });

    const result = await service.record([usage(), usage()]);

    expect(written.flat()).toHaveLength(1);
    expect(result.deduplicated).toBe(1);
  });

  it("lets a write failure reach the caller", async () => {
    const { sink } = fakeSink({
      write: vi.fn(async () => {
        throw new Error("connection refused");
      }),
    });
    const service = buildService({ options: { flushMode: "immediate" }, sink });
    await expect(service.record(usage())).rejects.toThrow(/connection refused/u);
  });
});

describe("flush", () => {
  it("writes in batches of the configured size", async () => {
    const { sink, written } = fakeSink();
    const service = buildService({ options: { batchSize: 2, maxBufferedEvents: 10 }, sink });

    await service.record([1, 2, 3, 4, 5].map((quantity) => usage({ quantity })));
    await service.flush();

    expect(written.map((batch) => batch.length)).toEqual([2, 2, 1]);
  });

  it("empties the buffer", async () => {
    const service = buildService({ sink: fakeSink().sink });
    await service.record(usage());
    await service.flush();
    expect((await service.getStatus()).buffered).toBe(0);
  });

  it("does not call the sink when there is nothing to write", async () => {
    const { sink, written } = fakeSink();
    const service = buildService({ sink });
    expect(await service.flush()).toEqual({ appended: 0, batches: 0, duplicates: 0, submitted: 0 });
    expect(written).toHaveLength(0);
  });

  it("puts a failed batch back and rethrows", async () => {
    const write = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockImplementation(async (events: readonly UsageEvent[]) => ({
        appended: events.length,
        duplicates: 0,
        received: events.length,
      }));
    const { sink } = fakeSink({ write });
    const service = buildService({ sink });

    await service.record(usage());
    await expect(service.flush()).rejects.toThrow(/connection refused/u);

    const status = await service.getStatus();
    expect(status.buffered).toBe(1);
    expect(status.lastFlushError).toMatch(/connection refused/u);

    // The retry succeeds and the same event is written exactly once more.
    await service.flush();
    expect((await service.getStatus()).buffered).toBe(0);
    expect((await service.getStatus()).lastFlushError).toBeNull();
  });

  it("counts what the sink already had as duplicates, not as failures", async () => {
    const { sink } = fakeSink({
      write: vi.fn(async (events: readonly UsageEvent[]) => ({
        appended: 0,
        duplicates: events.length,
        received: events.length,
      })),
    });
    const service = buildService({ sink });

    await service.record(usage());
    expect(await service.flush()).toMatchObject({ appended: 0, duplicates: 1, submitted: 1 });
  });

  it("serializes concurrent flushes rather than interleaving batches", async () => {
    let inFlight = 0;
    let overlapped = false;
    const { sink } = fakeSink({
      write: vi.fn(async (events: readonly UsageEvent[]) => {
        inFlight += 1;
        overlapped ||= inFlight > 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return { appended: events.length, duplicates: 0, received: events.length };
      }),
    });
    const service = buildService({ options: { batchSize: 1, maxBufferedEvents: 10 }, sink });

    await service.record([1, 2, 3, 4].map((quantity) => usage({ quantity })));
    await Promise.all([service.flush(), service.flush(), service.flush()]);

    expect(overlapped).toBe(false);
    expect((await service.getStatus()).buffered).toBe(0);
  });
});

describe("aggregate", () => {
  const window = {
    from: new Date("2026-08-01T00:00:00.000Z"),
    to: new Date("2026-09-01T00:00:00.000Z"),
  };

  it("flushes before it counts, so a fresh event is not missed", async () => {
    const { sink, written } = fakeSink();
    const service = buildService({ sink });

    await service.record(usage());
    await service.aggregate({ meter: "api_request", subject: "cus_01", ...window });

    expect(written.flat()).toHaveLength(1);
  });

  it("returns a snapshot naming the sink that answered", async () => {
    const { sink } = fakeSink();
    const service = buildService({ sink });

    const snapshot = await service.aggregate({
      meter: "api_request",
      subject: "cus_01",
      ...window,
    });

    expect(snapshot).toMatchObject({
      eventCount: 2,
      from: "2026-08-01T00:00:00.000Z",
      meter: "api_request",
      sink: "postgres",
      subject: "cus_01",
      to: "2026-09-01T00:00:00.000Z",
      total: 8,
    });
    expect(snapshot.digest).toMatch(/^usnap_[0-9a-f]{64}$/u);
  });

  it("refuses an inverted window before asking the sink anything", async () => {
    const { sink } = fakeSink();
    const service = buildService({ sink });

    await expect(
      service.aggregate({ from: window.to, meter: "api_request", to: window.from }),
    ).rejects.toThrow(/empty or inverted/u);
    expect(sink.aggregate).not.toHaveBeenCalled();
  });

  it("hands the query to the sink untouched", async () => {
    const { sink } = fakeSink();
    const service = buildService({ sink });
    const query = { meter: "api_request", properties: { region: "eu" }, ...window };

    await service.aggregate(query);
    expect(sink.aggregate).toHaveBeenCalledWith(query);
  });
});

describe("listEvents", () => {
  it("flushes first, then pages", async () => {
    const { sink, written } = fakeSink();
    const service = buildService({ sink });

    await service.record(usage());
    await service.listEvents({
      from: new Date("2026-08-01T00:00:00.000Z"),
      limit: 10,
      meter: "api_request",
      to: new Date("2026-09-01T00:00:00.000Z"),
    });

    expect(written.flat()).toHaveLength(1);
    expect(sink.listEvents).toHaveBeenCalledTimes(1);
  });
});

describe("sink selection", () => {
  it("refuses to accept usage when no sink is registered", async () => {
    const service = buildService({ sinkIds: [] });
    await expect(service.resolveSink()).rejects.toThrow(/no usage sink is registered/u);
  });

  it("refuses to guess between two sinks", async () => {
    const service = buildService({ sink: fakeSink().sink, sinkIds: ["postgres", "warehouse"] });
    await expect(service.resolveSink()).rejects.toThrow(/does not say which one/u);
  });

  it("uses the named sink", async () => {
    const service = buildService({
      options: { sink: "postgres" },
      sink: fakeSink().sink,
      sinkIds: ["postgres", "warehouse"],
    });
    expect((await service.getStatus()).sink).toBe("postgres");
  });

  it("says so when a listed sink cannot actually be resolved", async () => {
    const service = buildService({ sinkIds: ["postgres"] });
    await expect(service.resolveSink()).rejects.toThrow(/could not be resolved/u);
  });
});

describe("getStatus", () => {
  it("reports what an operator needs to see", async () => {
    const service = buildService({ sink: fakeSink().sink });
    await service.record(usage());

    expect(await service.getStatus()).toMatchObject({
      batchSize: 500,
      buffered: 1,
      flushMode: "buffered",
      lastFlushAt: null,
      lastFlushError: null,
      sink: "postgres",
      sinks: ["postgres"],
    });
  });
});

describe("shutdown", () => {
  it("flushes what is still buffered", async () => {
    const { sink, written } = fakeSink();
    const service = buildService({ sink });

    await service.record(usage());
    await service.__hooks.onApplicationShutdown();

    expect(written.flat()).toHaveLength(1);
  });

  it("does nothing when there is nothing waiting", async () => {
    const { sink, written } = fakeSink();
    const service = buildService({ sink });
    await service.__hooks.onApplicationShutdown();
    expect(written).toHaveLength(0);
  });
});

/**
 * Periods, rating and the frozen result.
 *
 * The store is faked in memory, but it is faked with the one behaviour the real
 * one is built around: `appendResult` refuses a second row for a period that
 * already has one, which is what the primary key does in Postgres. Everything
 * below about not billing twice rests on that and on nothing else.
 */
const fakePeriodStore = () => {
  const periods = new Map<string, BillingPeriod>();
  const results = new Map<string, PeriodResult>();

  return {
    appendResult: vi.fn(async (result: PeriodResult) => {
      if (results.has(result.periodId)) {
        return false;
      }
      results.set(result.periodId, result);
      return true;
    }),
    getPeriod: vi.fn(async (id: string) => {
      const period = periods.get(id);
      if (!period) {
        return null;
      }
      const result = results.get(id);
      return { ...period, closedAt: result ? new Date(result.closedAt) : null };
    }),
    getResult: vi.fn(async (id: string) => results.get(id) ?? null),
    listPeriods: vi.fn(async () => [...periods.values()]),
    openPeriod: vi.fn(async (period: { id: string; subject: string; startsAt: Date; endsAt: Date }) => {
      const existing = periods.get(period.id);
      if (existing) {
        return { opened: false, period: existing };
      }
      const opened: BillingPeriod = {
        ...period,
        closedAt: null,
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
      };
      periods.set(period.id, opened);
      return { opened: true, period: opened };
    }),
    periods,
    results,
  };
};

/** A sink whose totals can be moved between calls, which is what a late event is. */
const meteredSink = (totals: Record<string, number>) => {
  const state = { ...totals };
  const sink = {
    aggregate: vi.fn(async (query: UsageAggregateQuery) => {
      const total = state[query.meter] ?? 0;
      return {
        eventCount: total === 0 ? 0 : 3,
        firstOccurredAt: total === 0 ? null : new Date("2026-08-02T00:00:00.000Z"),
        lastOccurredAt: total === 0 ? null : new Date("2026-08-30T00:00:00.000Z"),
        total,
      };
    }),
    getIdentifier: () => "postgres",
    listEvents: vi.fn(async () => ({ events: [], nextCursor: null })),
    write: vi.fn(async (events: readonly UsageEvent[]) => ({
      appended: events.length,
      duplicates: 0,
      received: events.length,
    })),
  };
  return { sink: sink as unknown as UsageSinkProvider, state };
};

const CARD: Partial<UsagePluginOptions> = {
  billing: {
    currency: "PLN",
    rates: [
      { includedUnits: 1000, meter: "api_request", perUnits: 10_000, unitAmount: 12 },
      { meter: "gb_egress", unitAmount: 5 },
    ],
  },
};

const AUGUST = {
  endsAt: new Date("2026-09-01T00:00:00.000Z"),
  startsAt: new Date("2026-08-01T00:00:00.000Z"),
};

const SEPTEMBER_2ND = new Date("2026-09-02T00:00:00.000Z");

const august = (subject = "cus_01") => ({ ...AUGUST, subject });

describe("openPeriod", () => {
  it("derives the id from the subject and the window", async () => {
    const service = buildService({ sink: meteredSink({}).sink });
    const period = await service.openPeriod(august());

    expect(period.id).toBe(periodIdFor("cus_01", AUGUST.startsAt, AUGUST.endsAt));
    expect(period.closedAt).toBeNull();
  });

  it("opens one period however many times it is asked to", async () => {
    const periodStore = fakePeriodStore();
    const service = buildService({ periodStore, sink: meteredSink({}).sink });

    await service.openPeriod(august());
    await service.openPeriod(august());

    expect(periodStore.periods.size).toBe(1);
  });

  it("refuses a window that cannot mean what it says", async () => {
    const service = buildService({ sink: meteredSink({}).sink });
    await expect(
      service.openPeriod({ endsAt: AUGUST.startsAt, startsAt: AUGUST.endsAt, subject: "cus_01" }),
    ).rejects.toThrow(/empty or inverted/u);
  });

  it("refuses a period with no subject", async () => {
    const service = buildService({ sink: meteredSink({}).sink });
    await expect(service.openPeriod({ ...AUGUST, subject: "  " })).rejects.toThrow(
      /needs a `subject`/u,
    );
  });
});

describe("closePeriod", () => {
  it("rates every meter on the card and freezes the total", async () => {
    const { sink } = meteredSink({ api_request: 1_234_567, gb_egress: 50 });
    const service = buildService({ options: CARD, sink });

    const closed = await service.closePeriod(august(), SEPTEMBER_2ND);

    // 1 234 567 requests less the 1000 included, at 12 grosze per 10 000, is 1480.
    // 50 gigabytes at 5 grosze is 250. Nothing else is added, because there is
    // nothing else to add.
    expect(closed.result.lines).toHaveLength(2);
    expect(closed.result.lines[0]).toMatchObject({
      amount: 1480,
      chargeableQuantity: 1_233_567,
      meter: "api_request",
      quantity: 1_234_567,
    });
    expect(closed.result.total).toBe(1730);
    expect(closed.result.currency).toBe("PLN");
    expect(closed.alreadyClosed).toBe(false);
  });

  it("closes an empty period to a provable zero rather than to nothing at all", async () => {
    const { sink } = meteredSink({});
    const service = buildService({ options: CARD, sink });

    const closed = await service.closePeriod(august(), SEPTEMBER_2ND);

    expect(closed.result.total).toBe(0);
    expect(closed.result.eventCount).toBe(0);
    expect(closed.result.lines.map((line) => line.meter)).toEqual(["api_request", "gb_egress"]);
    expect(closed.result.digest).toMatch(/^uper_/u);
  });

  /** The property the whole feature exists to have. */
  it("does not bill twice when it is closed twice", async () => {
    const { sink } = meteredSink({ api_request: 1_234_567, gb_egress: 50 });
    const periodStore = fakePeriodStore();
    const service = buildService({ options: CARD, periodStore, sink });

    const first = await service.closePeriod(august(), SEPTEMBER_2ND);
    const second = await service.closePeriod(august(), SEPTEMBER_2ND);

    expect(first.alreadyClosed).toBe(false);
    expect(second.alreadyClosed).toBe(true);
    expect(periodStore.results.size).toBe(1);
    expect(second.result.digest).toBe(first.result.digest);
  });

  /**
   * The same, but with the log moving underneath. A retry after a late event must
   * return what was billed, not what the log says now - otherwise the second call
   * hands a host a different number for a period it has already invoiced.
   */
  it("returns the first answer even when the usage has changed since", async () => {
    const { sink, state } = meteredSink({ api_request: 1_234_567, gb_egress: 50 });
    const service = buildService({ options: CARD, sink });

    const first = await service.closePeriod(august(), SEPTEMBER_2ND);
    state.gb_egress = 5000;
    const second = await service.closePeriod(august(), SEPTEMBER_2ND);

    expect(second.result.total).toBe(first.result.total);
    expect(second.result.lines[1].quantity).toBe(50);
    expect(second.alreadyClosed).toBe(true);
  });

  it("writes the result without reading first, so two closers cannot both write", async () => {
    const { sink } = meteredSink({ api_request: 10 });
    const periodStore = fakePeriodStore();
    const service = buildService({ options: CARD, periodStore, sink });

    const [left, right] = await Promise.all([
      service.closePeriod(august(), SEPTEMBER_2ND),
      service.closePeriod(august(), SEPTEMBER_2ND),
    ]);

    expect(periodStore.results.size).toBe(1);
    expect([left.alreadyClosed, right.alreadyClosed].sort()).toEqual([false, true]);
    expect(left.result.digest).toBe(right.result.digest);
  });

  it("opens the period when it is named outright rather than by id", async () => {
    const periodStore = fakePeriodStore();
    const service = buildService({ options: CARD, periodStore, sink: meteredSink({}).sink });

    await service.closePeriod(august(), SEPTEMBER_2ND);

    expect(periodStore.periods.size).toBe(1);
  });

  it("refuses an id nobody opened", async () => {
    const service = buildService({ options: CARD, sink: meteredSink({}).sink });
    await expect(service.closePeriod({ periodId: "ubp_nope" }, SEPTEMBER_2ND)).rejects.toThrow(
      /there is no period/u,
    );
  });

  it("refuses to freeze a period that is still accruing", async () => {
    const service = buildService({ options: CARD, sink: meteredSink({}).sink });
    await expect(
      service.closePeriod(august(), new Date("2026-08-15T00:00:00.000Z")),
    ).rejects.toThrow(/cannot be closed until/u);
  });

  it("holds a period open for the configured settling delay", async () => {
    const service = buildService({
      options: { billing: { ...CARD.billing!, closeDelayMs: 86_400_000 } },
      sink: meteredSink({}).sink,
    });
    await expect(
      service.closePeriod(august(), new Date("2026-09-01T12:00:00.000Z")),
    ).rejects.toThrow(/closeDelayMs/u);
  });

  it("refuses to rate anything when no rate card is configured", async () => {
    const service = buildService({ sink: meteredSink({}).sink });
    await expect(service.closePeriod(august(), SEPTEMBER_2ND)).rejects.toThrow(
      /no rate card is configured/u,
    );
  });

  it("flushes the buffer before it rates, so nothing in memory is missed", async () => {
    const { sink } = meteredSink({ api_request: 10 });
    const service = buildService({ options: CARD, sink });

    await service.record(usage({ meter: "api_request" }));
    await service.closePeriod(august(), SEPTEMBER_2ND);

    expect(sink.write).toHaveBeenCalled();
  });

  it("names the sink that answered, so a migrated log is still traceable", async () => {
    const service = buildService({ options: CARD, sink: meteredSink({}).sink });
    expect((await service.closePeriod(august(), SEPTEMBER_2ND)).result.sink).toBe("postgres");
  });
});

describe("getPeriodResult", () => {
  it("is null while the period is open, which is not the same as a zero total", async () => {
    const periodStore = fakePeriodStore();
    const service = buildService({ options: CARD, periodStore, sink: meteredSink({}).sink });

    const period = await service.openPeriod(august());
    expect(await service.getPeriodResult(period.id)).toBeNull();

    await service.closePeriod({ periodId: period.id }, SEPTEMBER_2ND);
    const closed = await service.getPeriodResult(period.id);

    expect(closed?.total).toBe(0);
    expect(closed?.eventCount).toBe(0);
  });
});

describe("verifyPeriod", () => {
  it("matches when the log behind the result has not moved", async () => {
    const { sink } = meteredSink({ api_request: 1_234_567, gb_egress: 50 });
    const periodStore = fakePeriodStore();
    const service = buildService({ options: CARD, periodStore, sink });

    const closed = await service.closePeriod(august(), SEPTEMBER_2ND);
    const verification = await service.verifyPeriod(closed.result.periodId);

    expect(verification.matches).toBe(true);
    expect(verification.totalDelta).toBe(0);
  });

  /** A late event, found. The result stands; the difference is reported. */
  it("reports the drift when the window gains usage after it closed", async () => {
    const { sink, state } = meteredSink({ api_request: 1_234_567, gb_egress: 50 });
    const service = buildService({ options: CARD, sink });

    const closed = await service.closePeriod(august(), SEPTEMBER_2ND);
    state.gb_egress = 70;
    const verification = await service.verifyPeriod(closed.result.periodId);

    expect(verification.matches).toBe(false);
    expect(verification.totalDelta).toBe(100);
    expect(verification.lines[1]).toMatchObject({
      currentQuantity: 70,
      meter: "gb_egress",
      quantityDelta: 20,
    });
    expect((await service.getPeriodResult(closed.result.periodId))?.total).toBe(1730);
  });

  /**
   * The rate that was billed is the rate on the stored line, not the one in the
   * config file today. Otherwise raising a price would make every past period
   * fail to verify, and lowering one would quietly say an old invoice was wrong.
   */
  it("re-rates from the recorded rate, not from the current configuration", async () => {
    const { sink } = meteredSink({ api_request: 1_234_567, gb_egress: 50 });
    const periodStore = fakePeriodStore();
    const service = buildService({ options: CARD, periodStore, sink });

    const closed = await service.closePeriod(august(), SEPTEMBER_2ND);

    const repriced = buildService({
      options: {
        billing: {
          currency: "PLN",
          rates: [
            { includedUnits: 1000, meter: "api_request", perUnits: 10_000, unitAmount: 99 },
            { meter: "gb_egress", unitAmount: 99 },
          ],
        },
      },
      periodStore,
      sink,
    });

    expect((await repriced.verifyPeriod(closed.result.periodId)).matches).toBe(true);
  });

  it("refuses to verify a period that was never closed", async () => {
    const service = buildService({ options: CARD, sink: meteredSink({}).sink });
    const period = await service.openPeriod(august());

    await expect(service.verifyPeriod(period.id)).rejects.toThrow(/no frozen result/u);
  });
});

describe("getStatus: rates", () => {
  it("says what usage is worth, so an operator need not read the server's config", async () => {
    const service = buildService({ options: CARD, sink: meteredSink({}).sink });
    const status = await service.getStatus();

    expect(status.rates).toMatchObject({ closeDelayMs: 0, currency: "PLN" });
    expect(status.rates?.meters).toHaveLength(2);
  });

  it("is null when the plugin only meters", async () => {
    const service = buildService({ sink: meteredSink({}).sink });
    expect((await service.getStatus()).rates).toBeNull();
  });
});
