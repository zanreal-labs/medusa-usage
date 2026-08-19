// Type-only, and it has to stay that way: these modules are server code and pull
// in `node:crypto` and `@medusajs/framework/utils`. `import type` erases before
// Vite sees them, and importing a VALUE from either would put the server's
// dependencies into the admin bundle. Nothing enforces this beyond the reading.
import type { PeriodResult, PeriodVerification } from "../../lib/billing/result";
import type { UsageSnapshot } from "../../lib/usage/snapshot";
import { sdk } from "./sdk";

/**
 * The admin API, as the screen sees it.
 *
 * Every call below goes to a route that already exists. The screen adds no
 * endpoint of its own and derives nothing the API does not say, because a number
 * an operator reads here has to be the same number a billing run reads, and the
 * cheapest way to guarantee that is to have one place produce it.
 *
 * Two conventions collide on the wire and it is worth naming rather than hiding.
 * The routes that build their own body speak snake_case; the ones that serve a
 * module object verbatim - the aggregate snapshot, a frozen period result, a
 * verification - keep the module's camelCase, deliberately, so a host can store
 * the body as it stands. The types here follow whichever the route actually
 * sends, and the verbatim ones are imported from the server so a change to a
 * frozen result cannot quietly stop matching what the screen renders.
 */

/** Whatever JSON a producer put in `properties`. Nested, because the log allows it. */
export type UsageJson = boolean | number | string | null | UsageJson[] | { [key: string]: UsageJson };

/** A dimension bag, as the log stores it and the events route serves it. */
export type UsageProperties = Record<string, UsageJson>;

/** `GET /admin/usage`. What the plugin is doing right now. */
export interface UsageStatusResponse {
  batch_size: number;
  buffered: number;
  flush_interval_ms: number;
  flush_mode: "buffered" | "immediate";
  last_flush_at: string | null;
  last_flush_error: string | null;
  oldest_buffered_ms: number;
  /** Served verbatim from the module, hence camelCase. Null when only metering. */
  rates: {
    closeDelayMs: number;
    currency: string;
    meters: { includedUnits: number; meter: string; perUnits: number; unitAmount: number }[];
  } | null;
  sink: string;
  sinks: string[];
}

/** One row of `GET /admin/usage/events`. */
export interface UsageEventRow {
  key: string;
  meter: string;
  occurred_at: string;
  properties: UsageProperties | null;
  quantity: number;
  recorded_at: string;
  source: string | null;
  subject: string;
}

export interface UsageEventPage {
  events: UsageEventRow[];
  next_cursor: string | null;
}

/** One row of `GET /admin/usage/periods`, as `serializePeriod` writes it. */
export interface PeriodRow {
  closed_at: string | null;
  created_at: string;
  ends_at: string;
  id: string;
  starts_at: string;
  subject: string;
}

/** `GET /admin/usage/periods/:id`. `result` is null while the period is open. */
export interface PeriodDetailResponse {
  period: PeriodRow;
  result: PeriodResult | null;
}

/** `POST /admin/usage/periods/:id/close`. */
export interface ClosePeriodResponse {
  already_closed: boolean;
  result: PeriodResult;
}

/** A half-open window `[from, to)`, both ISO 8601 instants. */
export interface UsageWindow {
  from: string;
  to: string;
}

export const getStatus = (): Promise<UsageStatusResponse> =>
  sdk.client.fetch<UsageStatusResponse>("/admin/usage");

export const getAggregate = (
  query: UsageWindow & { meter: string; subject: string | null },
): Promise<UsageSnapshot> =>
  sdk.client.fetch<UsageSnapshot>("/admin/usage/aggregate", { query: compact(query) });

export const listEvents = (
  query: UsageWindow & { cursor?: string | null; limit: number; meter: string; subject: string | null },
): Promise<UsageEventPage> =>
  sdk.client.fetch<UsageEventPage>("/admin/usage/events", { query: compact(query) });

export const listPeriods = (query: {
  limit: number;
  status: "" | "closed" | "open";
  subject: string | null;
}): Promise<{ periods: PeriodRow[] }> =>
  sdk.client.fetch<{ periods: PeriodRow[] }>("/admin/usage/periods", { query: compact(query) });

export const getPeriod = (id: string): Promise<PeriodDetailResponse> =>
  sdk.client.fetch<PeriodDetailResponse>(`/admin/usage/periods/${encodeURIComponent(id)}`);

export const closePeriod = (id: string): Promise<ClosePeriodResponse> =>
  sdk.client.fetch<ClosePeriodResponse>(`/admin/usage/periods/${encodeURIComponent(id)}/close`, {
    method: "POST",
  });

export const verifyPeriod = (id: string): Promise<PeriodVerification> =>
  sdk.client.fetch<PeriodVerification>(`/admin/usage/periods/${encodeURIComponent(id)}/verify`);

/**
 * Drop the parameters the caller left empty.
 *
 * The routes already coerce a blank exactly as they coerce an absent one, so this
 * changes no answer. It is here so the request an operator can see in their network
 * tab is the question that was asked: `?meter=api_request` rather than
 * `?meter=api_request&subject=&cursor=`, which reads like a filter that was applied
 * and came to nothing.
 */
function compact(query: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(query).filter(([, value]) => value !== null && value !== undefined && value !== ""),
  );
}
