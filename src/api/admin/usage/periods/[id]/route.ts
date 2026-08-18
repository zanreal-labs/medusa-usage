import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { serializePeriod } from "../../../../../lib/billing/period";
import { USAGE_MODULE } from "../../../../../modules/usage/module-name";
import type UsageModuleService from "../../../../../modules/usage/service";

/**
 * GET /admin/usage/periods/:id
 *
 * One period and, if it has been closed, the frozen result that was rated for it.
 *
 * `result` is null while the period is open, and that is the distinction a host
 * has to read: null means "not closed, do not bill this yet", while a result whose
 * `total` is 0 means "closed, and provably came to nothing". A free subscription
 * produces the second one routinely, and the right response to it is no invoice
 * rather than an invoice for zero.
 *
 * The result is served verbatim, in the shape the module froze it in, so a host
 * can store the body as it stands and compare digests against it later.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const usage = req.scope.resolve<UsageModuleService>(USAGE_MODULE);
  const id = req.params.id;

  const period = await usage.getPeriod(id);
  if (!period) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, `medusa-usage: there is no period ${id}.`);
  }

  res.json({
    period: serializePeriod(period),
    result: await usage.getPeriodResult(id),
  });
}
