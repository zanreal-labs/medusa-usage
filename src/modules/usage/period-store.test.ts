import { describe, expect, it, vi } from "vitest";
import { periodIdFor } from "../../lib/billing/period";
import type { PeriodResult } from "../../lib/billing/result";
import { PeriodStore } from "./period-store";

/**
 * A knex double that records what was asked and answers with what is queued.
 *
 * What these tests pin is the shape of the two statements the idempotency rests
 * on - the conflict no-op on both writes, and the left join that decides whether
 * a period is closed. Both were run against a real Postgres 16 while the migration
 * was generated.
 */
const fakeSql = (results: unknown[][] = []) => {
  const calls: { sql: string; bindings: readonly unknown[] }[] = [];
  const raw = vi.fn(async (sql: string, bindings: readonly unknown[]) => {
    calls.push({ bindings, sql });
    return { rows: results.shift() ?? [] };
  });
  return { calls, raw };
};

const store = (sql: ReturnType<typeof fakeSql>) =>
  // The double answers with rows the caller queued, which cannot be typed against
  // knex's generic `raw` without restating it; the cast keeps the double simple.
  new PeriodStore({ manager: { getKnex: () => sql as never } });

const FROM = new Date("2026-08-01T00:00:00.000Z");
const TO = new Date("2026-09-01T00:00:00.000Z");
const PERIOD_ID = periodIdFor("cus_01", FROM, TO);

const periodRow = (closedAt: string | null = null) => ({
  closed_at: closedAt,
  created_at: "2026-08-01T00:00:00.000Z",
  ends_at: "2026-09-01T00:00:00.000Z",
  id: PERIOD_ID,
  starts_at: "2026-08-01T00:00:00.000Z",
  subject: "cus_01",
});

const result = (overrides: Partial<PeriodResult> = {}): PeriodResult =>
  ({
    closedAt: "2026-09-01T02:00:00.000Z",
    currency: "PLN",
    digest: "uper_abc",
    eventCount: 3,
    from: "2026-08-01T00:00:00.000Z",
    lines: [],
    periodId: PERIOD_ID,
    sink: "postgres",
    subject: "cus_01",
    to: "2026-09-01T00:00:00.000Z",
    total: 12_000,
    version: 1,
    ...overrides,
  }) as PeriodResult;

describe("openPeriod", () => {
  it("appends a period and reads it back", async () => {
    const sql = fakeSql([[{ id: PERIOD_ID }], [periodRow()]]);
    const opened = await store(sql).openPeriod({
      endsAt: TO,
      id: PERIOD_ID,
      startsAt: FROM,
      subject: "cus_01",
    });

    expect(sql.calls[0].sql).toMatch(/insert into "usage_billing_period"/u);
    expect(sql.calls[0].bindings[0]).toBe(PERIOD_ID);
    expect(opened.opened).toBe(true);
    expect(opened.period.startsAt).toEqual(FROM);
    expect(opened.period.closedAt).toBeNull();
  });

  it("leaves a period that is already there alone", async () => {
    const sql = fakeSql([[], [periodRow()]]);
    const opened = await store(sql).openPeriod({
      endsAt: TO,
      id: PERIOD_ID,
      startsAt: FROM,
      subject: "cus_01",
    });

    expect(sql.calls[0].sql).toMatch(/on conflict \("id"\) do nothing/u);
    expect(opened.opened).toBe(false);
    expect(opened.period.id).toBe(PERIOD_ID);
  });

  it("never updates an existing period, because a window is not editable", async () => {
    const sql = fakeSql([[], [periodRow()]]);
    await store(sql).openPeriod({ endsAt: TO, id: PERIOD_ID, startsAt: FROM, subject: "cus_01" });
    expect(sql.calls[0].sql).not.toMatch(/do update/u);
  });
});

describe("reading a period", () => {
  it("decides closed by joining the result rather than reading a status", async () => {
    const sql = fakeSql([[periodRow("2026-09-01T02:00:00.000Z")]]);
    const period = await store(sql).getPeriod(PERIOD_ID);

    expect(sql.calls[0].sql).toMatch(/left join "usage_period_result"/u);
    expect(sql.calls[0].sql).not.toMatch(/status/u);
    expect(period?.closedAt).toEqual(new Date("2026-09-01T02:00:00.000Z"));
  });

  it("returns null for a period nobody opened", async () => {
    expect(await store(fakeSql([[]])).getPeriod("ubp_nope")).toBeNull();
  });

  it("excludes soft-deleted rows, so an aggregate cannot be changed from outside", async () => {
    const sql = fakeSql([[]]);
    await store(sql).getPeriod(PERIOD_ID);
    expect(sql.calls[0].sql).toMatch(/p\."deleted_at" is null/u);
  });
});

describe("listPeriods", () => {
  it("selects the unbilled ones by the absence of a result", async () => {
    const sql = fakeSql([[periodRow()]]);
    await store(sql).listPeriods({ status: "open", subject: "cus_01" });

    expect(sql.calls[0].sql).toMatch(/r\."id" is null/u);
    expect(sql.calls[0].bindings[0]).toBe("cus_01");
  });

  it("selects the closed ones by the presence of one", async () => {
    const sql = fakeSql([[]]);
    await store(sql).listPeriods({ status: "closed" });
    expect(sql.calls[0].sql).toMatch(/r\."id" is not null/u);
  });

  it("treats a period ending exactly now as over, because the bound is exclusive", async () => {
    const sql = fakeSql([[]]);
    await store(sql).listPeriods({ endedBefore: TO });

    expect(sql.calls[0].sql).toMatch(/p\."ends_at" <= \?/u);
    expect(sql.calls[0].bindings[0]).toBe(TO);
  });

  it("caps a page however much a caller asks for", async () => {
    const sql = fakeSql([[]]);
    await store(sql).listPeriods({ limit: 10_000 });
    expect(sql.calls[0].bindings.at(-1)).toBe(1000);
  });

  it("orders by the window, newest first, with the id breaking ties", async () => {
    const sql = fakeSql([[]]);
    await store(sql).listPeriods();
    expect(sql.calls[0].sql).toMatch(/order by p\."starts_at" desc, p\."id" asc/u);
  });
});

describe("appendResult", () => {
  it("closes a period by appending its result under the period's own id", async () => {
    const sql = fakeSql([[{ id: PERIOD_ID }]]);

    expect(await store(sql).appendResult(result())).toBe(true);
    expect(sql.calls[0].sql).toMatch(/insert into "usage_period_result"/u);
    expect(sql.calls[0].bindings[0]).toBe(PERIOD_ID);
  });

  /**
   * The whole idempotency guarantee, in one statement. A second close appends
   * nothing, and the caller finds out from the row count rather than from a read
   * it did first.
   */
  it("appends nothing when the period is already closed", async () => {
    const sql = fakeSql([[]]);

    expect(await store(sql).appendResult(result())).toBe(false);
    expect(sql.calls[0].sql).toMatch(/on conflict \("id"\) do nothing/u);
  });

  it("never updates a result that is already frozen", async () => {
    const sql = fakeSql([[]]);
    await store(sql).appendResult(result());
    expect(sql.calls[0].sql).not.toMatch(/do update/u);
  });

  it("checks nothing before it writes, so no window is left for a second close", async () => {
    const sql = fakeSql([[{ id: PERIOD_ID }]]);
    await store(sql).appendResult(result());
    expect(sql.raw).toHaveBeenCalledTimes(1);
  });

  it("stores the total as an exact numeric beside the result it came from", async () => {
    const sql = fakeSql([[{ id: PERIOD_ID }]]);
    await store(sql).appendResult(result({ total: -120 }));

    expect(sql.calls[0].sql).toMatch(/\?::numeric/u);
    expect(sql.calls[0].bindings[5]).toBe("-120");
    expect(JSON.parse(String(sql.calls[0].bindings[6])).value).toBe("-120");
  });
});

describe("getResult", () => {
  it("returns the frozen result verbatim", async () => {
    const stored = result();
    const sql = fakeSql([[{ result: stored }]]);

    expect(await store(sql).getResult(PERIOD_ID)).toEqual(stored);
  });

  it("parses a driver that hands json back as text rather than returning a string", async () => {
    const sql = fakeSql([[{ result: JSON.stringify(result()) }]]);
    expect((await store(sql).getResult(PERIOD_ID))?.total).toBe(12_000);
  });

  it("returns null while the period is still open", async () => {
    expect(await store(fakeSql([[]])).getResult(PERIOD_ID)).toBeNull();
  });

  it("hands back something that cannot be edited in place", async () => {
    const sql = fakeSql([[{ result: result() }]]);
    expect(Object.isFrozen(await store(sql).getResult(PERIOD_ID))).toBe(true);
  });
});

describe("without a database", () => {
  it("says the module was constructed without a connection", async () => {
    await expect(new PeriodStore({}).getPeriod(PERIOD_ID)).rejects.toThrow(
      /no database connection/u,
    );
  });
});
