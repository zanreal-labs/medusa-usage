import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { USAGE_MODULE } from "../../../../../../modules/usage/module-name";
import type UsageModuleService from "../../../../../../modules/usage/service";

/**
 * GET /admin/usage/periods/:id/verify
 *
 * Rate the closed period again from the log and report whether it still comes out
 * the same, meter by meter.
 *
 * This is the answer to "prove the invoice". `matches: true` means the log behind
 * the number is byte-for-byte the log it was billed from. `matches: false` means
 * the window has gained or lost events since - which is what a late event looks
 * like from here - and the deltas say by how much, per meter. Nothing is written
 * either way: the frozen result is what was charged and it does not move.
 *
 * The rates used are the ones recorded on the stored lines, never the ones in the
 * configuration today, so changing a price cannot make an old period fail to
 * verify.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const usage = req.scope.resolve<UsageModuleService>(USAGE_MODULE);
  res.json(await usage.verifyPeriod(req.params.id));
}
