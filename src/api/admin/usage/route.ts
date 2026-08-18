import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { USAGE_MODULE } from "../../../modules/usage/module-name";
import type UsageModuleService from "../../../modules/usage/service";

/**
 * GET /admin/usage
 *
 * What the plugin is doing right now: which sink it writes to, which sinks are
 * registered, how ingestion is configured, how much is waiting in this process's
 * buffer and whether the last flush worked.
 *
 * Read-only, and the thing to check first when a meter looks wrong. A rising
 * `buffered` with a `last_flush_error` is a sink problem; a `buffered` of zero
 * with no usage arriving is a producer problem.
 *
 * Note "this process's buffer": in a deployment with several instances, this
 * answers for whichever one served the request.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const usage = req.scope.resolve<UsageModuleService>(USAGE_MODULE);
  const status = await usage.getStatus();

  res.json({
    batch_size: status.batchSize,
    buffered: status.buffered,
    flush_interval_ms: status.flushIntervalMs,
    flush_mode: status.flushMode,
    last_flush_at: status.lastFlushAt,
    last_flush_error: status.lastFlushError,
    oldest_buffered_ms: status.oldestBufferedMs,
    sink: status.sink,
    sinks: status.sinks,
  });
}
