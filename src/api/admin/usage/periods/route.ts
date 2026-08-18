import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { parsePeriodWindow, serializePeriod } from "../../../../lib/billing/period";
import { USAGE_MODULE } from "../../../../modules/usage/module-name";
import type UsageModuleService from "../../../../modules/usage/service";

/** Periods per page when the caller does not ask for a size. */
const DEFAULT_PAGE_SIZE = 50;

/**
 * GET /admin/usage/periods?subject=&status=&ended_before=&limit=
 *
 * Periods, newest window first. `status=open` is the useful one: it is exactly
 * the list of periods that have not been billed, because a period is closed when
 * and only when it has a frozen result.
 *
 * Combined with `ended_before=<now>`, it is the query a billing run makes: every
 * period that is over and has not been closed yet.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const usage = req.scope.resolve<UsageModuleService>(USAGE_MODULE);
  const query = req.query as Record<string, unknown>;

  const status = typeof query.status === "string" ? query.status.trim() : "";
  if (status && status !== "open" && status !== "closed") {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `medusa-usage: \`status\` must be "open" or "closed" (received "${status}").`,
    );
  }

  const periods = await usage.listPeriods({
    endedBefore: instantOrNull(query.ended_before, "ended_before"),
    limit: pageSize(query.limit),
    status: status === "" ? null : (status as "open" | "closed"),
    subject: typeof query.subject === "string" && query.subject.trim() ? query.subject.trim() : null,
  });

  res.json({ periods: periods.map(serializePeriod) });
}

/**
 * POST /admin/usage/periods
 *
 *   { "subject": "cus_01", "starts_at": "2026-08-01T00:00:00Z", "ends_at": "2026-09-01T00:00:00Z" }
 *
 * Open a period. Safe to retry, and safe to call on a period that already exists:
 * the id is derived from the subject and the two instants, so the same body always
 * names the same period and a second call opens nothing.
 *
 * 200 rather than 201 for exactly that reason - this is not reliably a creation,
 * and a caller cannot tell from the status code whether it was, on purpose. If
 * that matters, `created_at` says when the period was really opened.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const usage = req.scope.resolve<UsageModuleService>(USAGE_MODULE);
  const period = await usage.openPeriod(parsePeriodWindow((req.body ?? {}) as Record<string, unknown>));
  res.json(serializePeriod(period));
}

const pageSize = (value: unknown): number => {
  if (value === undefined || value === "") {
    return DEFAULT_PAGE_SIZE;
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `medusa-usage: \`limit\` must be a whole number of at least 1 (received ${String(value)}).`,
    );
  }
  return limit;
};

const instantOrNull = (value: unknown, field: string): Date | null => {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `medusa-usage: \`${field}\` is not an ISO 8601 instant: ${String(value)}`,
    );
  }
  return parsed;
};
