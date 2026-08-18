import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { parseAggregateQuery } from "../../../../lib/usage/query";
import { USAGE_MODULE } from "../../../../modules/usage/module-name";
import type UsageModuleService from "../../../../modules/usage/service";

/**
 * GET /admin/usage/aggregate?meter=&subject=&from=&to=&properties=
 *
 * How much of a meter a subject consumed in a half-open window `[from, to)`, as
 * an immutable snapshot.
 *
 * This is the plugin's last word. It says what was consumed and gives a digest
 * that proves the answer can be re-derived; it says nothing about what that is
 * worth, because that is not something a metering plugin can know. Keep the
 * snapshot next to whatever you billed from it, ask this endpoint the same
 * question in a year, and compare the two digests.
 *
 * The response is deliberately the snapshot itself, unwrapped and in the same
 * shape the module produces, so a host can store the body verbatim.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const usage = req.scope.resolve<UsageModuleService>(USAGE_MODULE);
  const query = parseAggregateQuery(req.query as Record<string, unknown>);
  res.json(await usage.aggregate(query));
}
