import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import type { UsageEventInput } from "../../../../lib/usage/event";
import { parseListQuery } from "../../../../lib/usage/query";
import { USAGE_MODULE } from "../../../../modules/usage/module-name";
import type UsageModuleService from "../../../../modules/usage/service";
import { recordUsageWorkflow } from "../../../../workflows/record-usage";

/** Events per page when the caller does not ask for a size. */
const DEFAULT_PAGE_SIZE = 50;

/**
 * POST /admin/usage/events
 *
 *   { "events": [{ "meter": "api_request", "subject": "cus_01", "quantity": 1 }] }
 *   { "meter": "api_request", "subject": "cus_01", "quantity": 1 }
 *
 * The HTTP way in, for a producer that is not inside this Medusa - the metered
 * service itself, a gateway, an importer. Code running inside the application
 * should call the workflow or the module directly and skip the round trip.
 *
 * Safe to retry. The response carries the deduplication key of every event, and
 * those keys are derived from the events themselves, so a client that retries
 * after a timeout gets the same keys back and the log gains nothing the second
 * time. That is the whole reason a client is allowed to retry at all.
 *
 * 202, not 201: in the default buffered mode the events are accepted and queued,
 * not yet written. `written` says which happened.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const body = (req.body ?? {}) as { events?: unknown } & Record<string, unknown>;
  const events = normalizeBody(body);

  const { result } = await recordUsageWorkflow(req.scope).run({ input: { events } });

  res.status(202).json({
    accepted: result.accepted,
    buffered: result.buffered,
    deduplicated: result.deduplicated,
    keys: result.keys,
    written: result.written,
  });
}

/**
 * GET /admin/usage/events?meter=&subject=&from=&to=&properties=&limit=&cursor=
 *
 * The events behind a number, oldest first, keyset-paginated.
 *
 * This is the audit path. When someone disputes what they were billed, this is
 * what shows them the individual facts the total was computed from, rather than
 * another total computed the same way.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const usage = req.scope.resolve<UsageModuleService>(USAGE_MODULE);
  const query = parseListQuery(req.query as Record<string, unknown>, DEFAULT_PAGE_SIZE);
  const page = await usage.listEvents(query);

  res.json({
    events: page.events.map((event) => ({
      key: event.key,
      meter: event.meter,
      occurred_at: event.occurredAt.toISOString(),
      properties: event.properties,
      quantity: event.quantity,
      recorded_at: event.recordedAt.toISOString(),
      source: event.source,
      subject: event.subject,
    })),
    next_cursor: page.nextCursor,
  });
}

/**
 * Accept either a batch or a single event.
 *
 * A producer metering one thing per request should not have to wrap it in an
 * array, and a producer batching should not have to send one request per event -
 * batching is the entire point of the ingestion path.
 */
function normalizeBody(body: { events?: unknown } & Record<string, unknown>): UsageEventInput[] {
  if (Array.isArray(body.events)) {
    return body.events as UsageEventInput[];
  }
  if (body.events !== undefined) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "medusa-usage: `events` must be an array. Send a single event as the body on its own, or a batch under `events`.",
    );
  }
  if (typeof body.meter === "string") {
    return [body as unknown as UsageEventInput];
  }
  throw new MedusaError(
    MedusaError.Types.INVALID_DATA,
    "medusa-usage: send one usage event as the body, or a batch under `events`.",
  );
}
