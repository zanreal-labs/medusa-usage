import { describe, expect, it, vi } from "vitest";
import { normalizeUsageEvent } from "../../lib/usage/event";
import PostgresUsageSinkService, { POSTGRES_USAGE_SINK } from "./service";

const NOW = new Date("2026-08-18T09:15:00.000Z");

const event = (overrides: Record<string, unknown> = {}) =>
  normalizeUsageEvent({ meter: "api_request", quantity: 3, subject: "cus_01", ...overrides }, NOW);

/**
 * A knex double that records what was asked and answers with what is queued.
 *
 * The statements it captures are the ones that were run against a real Postgres
 * 16 while this provider was written - the conflict no-op, the numeric sum, the
 * jsonb containment filter and the row-value cursor are all real behaviour, not
 * assumptions. What these tests pin is that the provider keeps generating them.
 */
const fakeSql = (results: unknown[][] = []) => {
  const calls: { sql: string; bindings: readonly unknown[] }[] = [];
  const raw = vi.fn(async (sql: string, bindings: readonly unknown[]) => {
    calls.push({ bindings, sql });
    return { rows: results.shift() ?? [] };
  });
  return { calls, raw };
};

const sink = (sql: ReturnType<typeof fakeSql>) =>
  // The double answers with rows the caller queued, which cannot be typed against
  // knex's generic `raw` without restating it; the cast keeps the double simple.
  new PostgresUsageSinkService({ manager: { getKnex: () => sql as never } });

describe("identity", () => {
  it("identifies itself", () => {
    expect(sink(fakeSql()).getIdentifier()).toBe(POSTGRES_USAGE_SINK);
  });

  it("takes no options, and says so rather than ignoring them", () => {
    expect(() => PostgresUsageSinkService.validateOptions({})).not.toThrow();
    expect(() => PostgresUsageSinkService.validateOptions({ table: "my_usage" })).toThrow(
      /takes no options/u,
    );
  });

  it("explains itself when the module has no database connection", async () => {
    const orphan = new PostgresUsageSinkService({});
    await expect(orphan.write([event()])).rejects.toThrow(/no database connection/u);
  });
});

describe("write", () => {
  it("appends a whole batch in one statement", async () => {
    const sql = fakeSql([[{ id: "uev_1" }, { id: "uev_2" }]]);
    const result = await sink(sql).write([event({ quantity: 1 }), event({ quantity: 2 })]);

    expect(sql.raw).toHaveBeenCalledTimes(1);
    expect(sql.calls[0].sql).toMatch(/insert into "usage_event"/u);
    expect(sql.calls[0].sql).toMatch(/values \(.+\), \(.+\)/u);
    expect(result).toEqual({ appended: 2, duplicates: 0, received: 2 });
  });

  it("leaves an event that is already there alone", async () => {
    const sql = fakeSql([[{ id: "uev_1" }]]);
    const result = await sink(sql).write([event({ quantity: 1 }), event({ quantity: 2 })]);

    expect(sql.calls[0].sql).toMatch(/on conflict \("id"\) do nothing/u);
    expect(result).toEqual({ appended: 1, duplicates: 1, received: 2 });
  });

  it("never updates an existing row, because the log is not mutable", async () => {
    const sql = fakeSql([[]]);
    await sink(sql).write([event()]);
    expect(sql.calls[0].sql).not.toMatch(/do update/u);
  });

  it("writes the key as the primary key, so the database enforces deduplication", async () => {
    const sql = fakeSql([[]]);
    const one = event();
    await sink(sql).write([one]);
    expect(sql.calls[0].bindings[0]).toBe(one.key);
  });

  it("writes the quantity as an exact numeric with its raw companion", async () => {
    const sql = fakeSql([[]]);
    await sink(sql).write([event({ quantity: 9_007_199_254_740_991 })]);
    expect(sql.calls[0].sql).toMatch(/\?::numeric/u);
    expect(sql.calls[0].bindings[3]).toBe("9007199254740991");
    expect(sql.calls[0].bindings[4]).toBe(
      JSON.stringify({ precision: 20, value: "9007199254740991" }),
    );
  });

  it("serializes the property bag for the jsonb column", async () => {
    const sql = fakeSql([[]]);
    await sink(sql).write([event({ properties: { region: "eu" } })]);
    expect(sql.calls[0].bindings[7]).toBe(JSON.stringify({ region: "eu" }));
  });

  it("does nothing at all for an empty batch", async () => {
    const sql = fakeSql();
    expect(await sink(sql).write([])).toEqual({ appended: 0, duplicates: 0, received: 0 });
    expect(sql.raw).not.toHaveBeenCalled();
  });
});

describe("aggregate", () => {
  const query = {
    from: new Date("2026-08-01T00:00:00.000Z"),
    meter: "api_request",
    subject: "cus_01",
    to: new Date("2026-09-01T00:00:00.000Z"),
  };

  it("sums in the database, exactly", async () => {
    const sql = fakeSql([
      [
        {
          event_count: "2",
          first_occurred_at: "2026-08-18T09:15:00.000Z",
          last_occurred_at: "2026-08-20T09:15:00.000Z",
          total: "8",
        },
      ],
    ]);

    expect(await sink(sql).aggregate(query)).toEqual({
      eventCount: 2,
      firstOccurredAt: new Date("2026-08-18T09:15:00.000Z"),
      lastOccurredAt: new Date("2026-08-20T09:15:00.000Z"),
      total: 8,
    });
    expect(sql.calls[0].sql).toMatch(/coalesce\(sum\("quantity"\), 0\)::text/u);
  });

  it("filters on the half-open window, so periods tile without overlapping", async () => {
    const sql = fakeSql([[]]);
    await sink(sql).aggregate(query);
    expect(sql.calls[0].sql).toMatch(/"occurred_at" >= \? and "occurred_at" < \?/u);
    expect(sql.calls[0].bindings).toEqual([query.meter, query.from, query.to, query.subject]);
  });

  it("never filters on when the row was written", async () => {
    const sql = fakeSql([[]]);
    await sink(sql).aggregate(query);
    expect(sql.calls[0].sql).not.toMatch(/created_at/u);
  });

  it("excludes soft-deleted rows, so nothing outside the plugin can change an answer", async () => {
    const sql = fakeSql([[]]);
    await sink(sql).aggregate(query);
    expect(sql.calls[0].sql).toMatch(/"deleted_at" is null/u);
  });

  it("aggregates every subject when none is named", async () => {
    const sql = fakeSql([[]]);
    await sink(sql).aggregate({ ...query, subject: null });
    expect(sql.calls[0].sql).not.toMatch(/"subject" = \?/u);
  });

  it("filters dimensions by containment", async () => {
    const sql = fakeSql([[]]);
    await sink(sql).aggregate({ ...query, properties: { region: "eu" } });
    expect(sql.calls[0].sql).toMatch(/"properties" @> \?::jsonb/u);
    expect(sql.calls[0].bindings.at(-1)).toBe(JSON.stringify({ region: "eu" }));
  });

  it("ignores an empty dimension filter", async () => {
    const sql = fakeSql([[]]);
    await sink(sql).aggregate({ ...query, properties: {} });
    expect(sql.calls[0].sql).not.toMatch(/@>/u);
  });

  it("reports an empty window as zero rather than as nothing", async () => {
    expect(await sink(fakeSql([[]])).aggregate(query)).toEqual({
      eventCount: 0,
      firstOccurredAt: null,
      lastOccurredAt: null,
      total: 0,
    });
  });
});

describe("listEvents", () => {
  const query = {
    from: new Date("2026-08-01T00:00:00.000Z"),
    limit: 2,
    meter: "api_request",
    to: new Date("2026-09-01T00:00:00.000Z"),
  };

  const row = (id: string, occurredAt: string) => ({
    created_at: "2026-08-18T09:16:00.000Z",
    id,
    meter: "api_request",
    occurred_at: occurredAt,
    properties: null,
    quantity: "3",
    source: null,
    subject: "cus_01",
  });

  it("orders by the pair it pages on", async () => {
    const sql = fakeSql([[row("uev_1", "2026-08-18T09:15:00.000Z")]]);
    await sink(sql).listEvents(query);
    expect(sql.calls[0].sql).toMatch(/order by "occurred_at" asc, "id" asc/u);
  });

  it("returns the stored event with the time the sink accepted it", async () => {
    const sql = fakeSql([[row("uev_1", "2026-08-18T09:15:00.000Z")]]);
    const page = await sink(sql).listEvents(query);
    expect(page.events[0]).toEqual({
      key: "uev_1",
      meter: "api_request",
      occurredAt: new Date("2026-08-18T09:15:00.000Z"),
      properties: null,
      quantity: 3,
      recordedAt: new Date("2026-08-18T09:16:00.000Z"),
      source: null,
      subject: "cus_01",
    });
  });

  it("offers a cursor only when the page was full", async () => {
    const partial = await sink(fakeSql([[row("uev_1", "2026-08-18T09:15:00.000Z")]])).listEvents(
      query,
    );
    expect(partial.nextCursor).toBeNull();

    const full = await sink(
      fakeSql([[row("uev_1", "2026-08-18T09:15:00.000Z"), row("uev_2", "2026-08-19T09:15:00.000Z")]]),
    ).listEvents(query);
    expect(full.nextCursor).not.toBeNull();
  });

  it("resumes exactly where the previous page ended", async () => {
    const first = await sink(
      fakeSql([[row("uev_1", "2026-08-18T09:15:00.000Z"), row("uev_2", "2026-08-19T09:15:00.000Z")]]),
    ).listEvents(query);

    const sql = fakeSql([[]]);
    await sink(sql).listEvents({ ...query, cursor: first.nextCursor });
    expect(sql.calls[0].sql).toMatch(/\("occurred_at", "id"\) > \(\?, \?\)/u);
    expect(sql.calls[0].bindings).toContain("uev_2");
  });

  it("refuses a cursor it did not issue", async () => {
    await expect(
      sink(fakeSql([[]])).listEvents({ ...query, cursor: "not-a-cursor" }),
    ).rejects.toThrow(/not one this sink issued/u);
  });

  it("caps the page size whatever is asked for", async () => {
    const sql = fakeSql([[]]);
    await sink(sql).listEvents({ ...query, limit: 10_000 });
    expect(sql.calls[0].bindings.at(-1)).toBe(1000);
  });
});
