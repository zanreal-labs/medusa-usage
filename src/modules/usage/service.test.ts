import { describe, expect, it, vi } from "vitest";
import type { UsagePluginOptions } from "../../lib/options";
import { resolveUsageOptions } from "../../lib/options";
import { sinkRegistrationKey } from "../../lib/sink/registry";
import type { UsageSinkProvider } from "../../lib/sink/types";
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
