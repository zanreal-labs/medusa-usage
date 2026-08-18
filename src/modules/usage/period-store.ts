import { MedusaError } from "@medusajs/framework/utils";
import type { BillingPeriod } from "../../lib/billing/period";
import type { PeriodResult } from "../../lib/billing/result";
import type { ManagerLike, RawSqlRunner } from "../../lib/sql/raw";
import { dateOrNull, knexFor, rowsOf } from "../../lib/sql/raw";

/**
 * Where periods and their frozen results are read and written.
 *
 * Raw SQL, for the same two reasons the usage sink is raw SQL, and they are the
 * only reasons that would justify it:
 *
 * - **Both writes have to be `insert ... on conflict do nothing`.** Opening a
 *   period twice must open one period, and closing it twice must write one result
 *   and bill once. An ORM would read first and then write, which is not the same
 *   thing: between the read and the write there is a window, and a retried job is
 *   exactly the thing that fits through it. Pushing both into the primary key
 *   makes the duplicate the database's problem, and the database is very good at
 *   it.
 * - **"Closed" is a join, not a column.** A period is closed when a result row
 *   exists for it, so every read of a period is a left join onto the result. Two
 *   sources of truth for the same fact is how a billing system ends up unable to
 *   say whether it charged someone.
 *
 * Everything here goes through the module's own connection, which is the Medusa
 * database, whatever sink the event log is configured to use.
 */

/** Must match `model.define("usage_billing_period", ...)`. */
const PERIOD_TABLE = "usage_billing_period";

/** Must match `model.define("usage_period_result", ...)`. */
const RESULT_TABLE = "usage_period_result";

/**
 * `total_amount` is a `bigNumber`, which Medusa stores as a `numeric` column plus
 * a `raw_total_amount` json column carrying the value and its precision. Writes
 * here go around the ORM, so both are written explicitly.
 */
const RAW_AMOUNT_PRECISION = 20;

/** Hard ceiling on one listing, whatever a caller asks for. */
const MAX_PERIOD_PAGE = 1000;

/** Which periods to list. Every filter is optional; the default is all of them. */
export interface PeriodQuery {
  subject?: string | null;
  /** "open" has no result row yet, "closed" has one. Omitted means both. */
  status?: "open" | "closed" | null;
  /** Only periods whose window has already ended by this instant. */
  endedBefore?: Date | null;
  limit?: number;
}

interface PeriodRow {
  id: string;
  subject: string;
  starts_at: Date | string;
  ends_at: Date | string;
  created_at: Date | string;
  closed_at: Date | string | null;
}

const toPeriod = (row: PeriodRow): BillingPeriod => ({
  closedAt: dateOrNull(row.closed_at),
  createdAt: new Date(row.created_at),
  endsAt: new Date(row.ends_at),
  id: row.id,
  startsAt: new Date(row.starts_at),
  subject: row.subject,
});

const SELECT_PERIOD =
  `select p."id", p."subject", p."starts_at", p."ends_at", p."created_at", r."closed_at" ` +
  `from "${PERIOD_TABLE}" p ` +
  `left join "${RESULT_TABLE}" r on r."id" = p."id" and r."deleted_at" is null`;

export class PeriodStore {
  private readonly cradle: { manager?: ManagerLike };

  /**
   * Holds the container rather than the connection, so nothing is resolved until
   * a period is actually read or written. The same reason the usage sink does it.
   */
  constructor(cradle: { manager?: ManagerLike }) {
    this.cradle = cradle;
  }

  /**
   * Append a period, or leave the one that is already there alone.
   *
   * `opened` says which happened. It is not an error to open a period twice - a
   * scheduled job that runs again after a redeploy should be able to say "this
   * period exists" without caring whether it is the one that said so first.
   */
  async openPeriod(period: {
    id: string;
    subject: string;
    startsAt: Date;
    endsAt: Date;
  }): Promise<{ period: BillingPeriod; opened: boolean }> {
    const sql =
      `insert into "${PERIOD_TABLE}" ("id", "subject", "starts_at", "ends_at", "created_at", "updated_at") ` +
      `values (?, ?, ?, ?, now(), now()) on conflict ("id") do nothing returning "id"`;

    const appended = rowsOf<{ id: string }>(
      await this.sql().raw(sql, [period.id, period.subject, period.startsAt, period.endsAt]),
    ).length;

    const stored = await this.getPeriod(period.id);
    if (!stored) {
      // The insert either appended a row or found one already there, so the read
      // that follows it cannot come back empty unless something outside this
      // plugin removed the row between the two statements.
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `medusa-usage: the period ${period.id} was written but could not be read back.`,
      );
    }
    return { opened: appended === 1, period: stored };
  }

  async getPeriod(id: string): Promise<BillingPeriod | null> {
    const rows = rowsOf<PeriodRow>(
      await this.sql().raw(`${SELECT_PERIOD} where p."deleted_at" is null and p."id" = ?`, [id]),
    );
    return rows[0] ? toPeriod(rows[0]) : null;
  }

  /** Periods, newest window first. */
  async listPeriods(query: PeriodQuery = {}): Promise<BillingPeriod[]> {
    const clauses = [`p."deleted_at" is null`];
    const bindings: unknown[] = [];

    if (query.subject) {
      clauses.push(`p."subject" = ?`);
      bindings.push(query.subject);
    }
    if (query.status === "open") {
      clauses.push(`r."id" is null`);
    }
    if (query.status === "closed") {
      clauses.push(`r."id" is not null`);
    }
    if (query.endedBefore) {
      // Half-open to the end: a period ending exactly now is over, because its
      // upper bound is exclusive.
      clauses.push(`p."ends_at" <= ?`);
      bindings.push(query.endedBefore);
    }

    const limit = Math.min(Math.max(1, Math.trunc(query.limit ?? 50)), MAX_PERIOD_PAGE);
    bindings.push(limit);

    const rows = rowsOf<PeriodRow>(
      await this.sql().raw(
        `${SELECT_PERIOD} where ${clauses.join(" and ")} order by p."starts_at" desc, p."id" asc limit ?`,
        bindings,
      ),
    );
    return rows.map(toPeriod);
  }

  /**
   * Freeze a period's result, unless it is already frozen.
   *
   * Returns true when this call appended the row and therefore closed the period,
   * false when a result was already there. That boolean is the whole idempotency
   * guarantee, and it comes from the primary key rather than from a check: two
   * processes closing the same period both run this statement, one of them gets
   * true, and the loser reads the winner's result instead of writing its own.
   */
  async appendResult(result: PeriodResult): Promise<boolean> {
    const sql =
      `insert into "${RESULT_TABLE}" ` +
      `("id", "subject", "starts_at", "ends_at", "currency", "total_amount", "raw_total_amount", "digest", "result", "closed_at", "created_at", "updated_at") ` +
      `values (?, ?, ?, ?, ?, ?::numeric, ?::jsonb, ?, ?::jsonb, ?, now(), now()) ` +
      `on conflict ("id") do nothing returning "id"`;

    const appended = rowsOf<{ id: string }>(
      await this.sql().raw(sql, [
        result.periodId,
        result.subject,
        new Date(result.from),
        new Date(result.to),
        result.currency,
        String(result.total),
        JSON.stringify({ precision: RAW_AMOUNT_PRECISION, value: String(result.total) }),
        result.digest,
        JSON.stringify(result),
        new Date(result.closedAt),
      ]),
    ).length;

    return appended === 1;
  }

  /** The frozen result, verbatim, or null while the period is still open. */
  async getResult(periodId: string): Promise<PeriodResult | null> {
    const rows = rowsOf<{ result: PeriodResult | string }>(
      await this.sql().raw(
        `select "result" from "${RESULT_TABLE}" where "deleted_at" is null and "id" = ?`,
        [periodId],
      ),
    );
    const stored = rows[0]?.result;
    if (stored === undefined || stored === null) {
      return null;
    }
    // jsonb comes back parsed on pg, but a driver that hands back text should not
    // silently produce a string where a result is expected.
    return Object.freeze(
      typeof stored === "string" ? (JSON.parse(stored) as PeriodResult) : stored,
    );
  }

  private sql(): RawSqlRunner {
    return knexFor(this.cradle.manager, "the billing period store");
  }
}
