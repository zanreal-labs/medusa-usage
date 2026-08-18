import { MedusaError } from "@medusajs/framework/utils";
import { AbstractUsageSinkProviderService } from "../../lib/sink/abstract-sink";
import type { ManagerLike, RawSqlRunner } from "../../lib/sql/raw";
import { dateOrNull, knexFor, rowsOf } from "../../lib/sql/raw";
import type {
  StoredUsageEvent,
  UsageAggregateQuery,
  UsageAggregateResult,
  UsageEventPage,
  UsageListQuery,
  UsageSinkWriteResult,
} from "../../lib/sink/types";
import type { JsonValue } from "../../lib/usage/canonical-json";
import type { UsageEvent } from "../../lib/usage/event";

/**
 * The built-in usage sink: the Postgres the Medusa application already has.
 *
 * It exists so the plugin works on a plain install, with no account to open and
 * no second system to operate. A store metering thousands or millions of events a
 * month is well served by it. A store metering billions will want a column store,
 * and that is a different provider - which is the entire reason the sink is a
 * provider.
 *
 * ## Three statements, no ORM
 *
 * Every query here is raw SQL, deliberately.
 *
 * - The append is one multi-row `INSERT ... ON CONFLICT DO NOTHING`, which is a
 *   single round trip for the whole batch and pushes deduplication into the
 *   primary key. An ORM would do a read-then-write per row: slower, and racy in a
 *   way that a unique index simply is not.
 * - The aggregate is one `SUM` over a `numeric` column, which Postgres computes
 *   exactly at any size. Reading rows and adding them in JavaScript would be both
 *   slower and, past 2^53, wrong.
 * - The listing is keyset-paginated on `(occurred_at, id)`, which is a total
 *   order over an append-only log, so a page boundary cannot skip or repeat a row
 *   even while new events are arriving.
 *
 * ## Every read excludes soft-deleted rows
 *
 * Nothing in this plugin deletes a usage event, and nothing should. The filter is
 * there because Medusa's models carry `deleted_at` regardless, and an aggregate
 * that ignored it could be changed after the fact by something outside this
 * plugin touching the table. An aggregate that can change is not a re-derivable
 * one.
 */

/** Must match `model.define("usage_event", ...)`. */
const TABLE = "usage_event";

/**
 * `quantity` is a `bigNumber`, which Medusa stores as a `numeric` column plus a
 * `raw_quantity` json column carrying the value and its precision. Writes here go
 * around the ORM, so both are written explicitly.
 */
const RAW_QUANTITY_PRECISION = 20;

/** Hard ceiling on one page, whatever a caller asks for. */
const MAX_PAGE_SIZE = 1000;

interface AggregateRow {
  total: string;
  event_count: string;
  first_occurred_at: Date | string | null;
  last_occurred_at: Date | string | null;
}

interface EventRow {
  id: string;
  meter: string;
  subject: string;
  quantity: string;
  occurred_at: Date | string;
  source: string | null;
  properties: Record<string, JsonValue> | null;
  created_at: Date | string;
}

export const POSTGRES_USAGE_SINK = "postgres";

export default class PostgresUsageSinkService extends AbstractUsageSinkProviderService {
  static identifier = POSTGRES_USAGE_SINK;

  /**
   * This sink is configured by having a database, and takes no options of its
   * own. Saying so at boot beats letting a hopeful `{ table: "my_usage" }` sit in
   * a config file looking like it does something.
   */
  static validateOptions(options: Record<string, unknown>): void {
    const keys = Object.keys(options ?? {});
    if (keys.length > 0) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `medusa-usage: the built-in Postgres sink takes no options, but was given ${keys.join(", ")}. It writes to the application's own database through the module's connection.`,
      );
    }
  }

  private readonly cradle: { manager?: ManagerLike };

  constructor(cradle: { manager?: ManagerLike }) {
    super();
    this.cradle = cradle;
  }

  async write(events: readonly UsageEvent[]): Promise<UsageSinkWriteResult> {
    if (events.length === 0) {
      return { appended: 0, duplicates: 0, received: 0 };
    }

    const bindings: unknown[] = [];
    const tuples = events.map((event) => {
      bindings.push(
        event.key,
        event.meter,
        event.subject,
        String(event.quantity),
        JSON.stringify({ precision: RAW_QUANTITY_PRECISION, value: String(event.quantity) }),
        event.occurredAt,
        event.source,
        event.properties === null ? null : JSON.stringify(event.properties),
      );
      return "(?, ?, ?, ?::numeric, ?::jsonb, ?, ?, ?::jsonb, now(), now())";
    });

    // `do nothing` rather than `do update`: a row that is already here describes
    // the same event by definition, so there is nothing to update, and updating
    // would make the log mutable.
    const sql =
      `insert into "${TABLE}" ` +
      `("id", "meter", "subject", "quantity", "raw_quantity", "occurred_at", "source", "properties", "created_at", "updated_at") ` +
      `values ${tuples.join(", ")} ` +
      `on conflict ("id") do nothing returning "id"`;

    const appended = rowsOf<{ id: string }>(await this.sql().raw(sql, bindings)).length;
    return { appended, duplicates: events.length - appended, received: events.length };
  }

  async aggregate(query: UsageAggregateQuery): Promise<UsageAggregateResult> {
    const filter = this.filterFor(query);
    const sql =
      `select coalesce(sum("quantity"), 0)::text as total, count(*)::text as event_count, ` +
      `min("occurred_at") as first_occurred_at, max("occurred_at") as last_occurred_at ` +
      `from "${TABLE}" where ${filter.sql}`;

    const [row] = rowsOf<AggregateRow>(await this.sql().raw(sql, filter.bindings));
    if (!row) {
      return { eventCount: 0, firstOccurredAt: null, lastOccurredAt: null, total: 0 };
    }
    return {
      eventCount: Number(row.event_count),
      firstOccurredAt: dateOrNull(row.first_occurred_at),
      lastOccurredAt: dateOrNull(row.last_occurred_at),
      total: Number(row.total),
    };
  }

  async listEvents(query: UsageListQuery): Promise<UsageEventPage> {
    const limit = Math.min(Math.max(1, Math.trunc(query.limit)), MAX_PAGE_SIZE);
    const filter = this.filterFor(query);
    const bindings = [...filter.bindings];
    let where = filter.sql;

    const after = decodeCursor(query.cursor);
    if (after) {
      // Row-value comparison on the same columns the ordering uses, which is what
      // makes the page boundary exact rather than an offset that shifts.
      where += ` and ("occurred_at", "id") > (?, ?)`;
      bindings.push(after.occurredAt, after.id);
    }
    bindings.push(limit);

    const sql =
      `select "id", "meter", "subject", "quantity"::text as quantity, "occurred_at", "source", "properties", "created_at" ` +
      `from "${TABLE}" where ${where} order by "occurred_at" asc, "id" asc limit ?`;

    const rows = rowsOf<EventRow>(await this.sql().raw(sql, bindings));
    const events = rows.map(toStoredEvent);
    const last = rows.at(-1);

    return {
      events,
      nextCursor:
        rows.length === limit && last
          ? encodeCursor(new Date(last.occurred_at), last.id)
          : null,
    };
  }

  /**
   * The shared `where` clause.
   *
   * `occurred_at` is compared half-open, `[from, to)`, so consecutive periods tile
   * without an event on the boundary being counted in both. `properties` uses
   * containment, which is exactly the equality-on-every-entry the interface
   * promises, and is index-supportable by a GIN index a host can add if it needs
   * one.
   */
  private filterFor(query: UsageAggregateQuery): { sql: string; bindings: unknown[] } {
    const clauses = [`"deleted_at" is null`, `"meter" = ?`, `"occurred_at" >= ?`, `"occurred_at" < ?`];
    const bindings: unknown[] = [query.meter, query.from, query.to];

    if (query.subject) {
      clauses.push(`"subject" = ?`);
      bindings.push(query.subject);
    }
    if (query.properties && Object.keys(query.properties).length > 0) {
      clauses.push(`"properties" @> ?::jsonb`);
      bindings.push(JSON.stringify(query.properties));
    }

    return { bindings, sql: clauses.join(" and ") };
  }

  /** The module's own database connection. Resolved on use, not at construction. */
  private sql(): RawSqlRunner {
    return knexFor(this.cradle.manager, "the Postgres usage sink");
  }
}

const toStoredEvent = (row: EventRow): StoredUsageEvent => ({
  key: row.id,
  meter: row.meter,
  occurredAt: new Date(row.occurred_at),
  properties: row.properties,
  quantity: Number(row.quantity),
  recordedAt: new Date(row.created_at),
  source: row.source,
  subject: row.subject,
});

/** `<iso>|<id>`, base64url. Opaque to callers, and stable across pages. */
const encodeCursor = (occurredAt: Date, id: string): string =>
  Buffer.from(`${occurredAt.toISOString()}|${id}`, "utf8").toString("base64url");

const decodeCursor = (cursor: string | null | undefined): { occurredAt: Date; id: string } | null => {
  if (!cursor) {
    return null;
  }
  const text = Buffer.from(cursor, "base64url").toString("utf8");
  const separator = text.indexOf("|");
  const occurredAt = new Date(text.slice(0, separator));
  const id = text.slice(separator + 1);
  if (separator < 0 || Number.isNaN(occurredAt.getTime()) || !id) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "medusa-usage: the paging cursor is not one this sink issued.",
    );
  }
  return { id, occurredAt };
};
