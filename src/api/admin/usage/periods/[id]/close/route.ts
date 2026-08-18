import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { closeBillingPeriodWorkflow } from "../../../../../../workflows/close-billing-period";

/**
 * POST /admin/usage/periods/:id/close
 *
 * Rate the period against the configured rate card and freeze the answer.
 *
 * Safe to retry, and that is the point rather than a nicety: the frozen result is
 * written under the period's own id and the insert ignores a conflict, so a second
 * call bills nothing and returns what the first one rated. `already_closed` says
 * which call this was, and it is the flag a caller must key an invoice off.
 *
 * It runs the workflow rather than the module service directly, so the
 * `usage_period.closed` event reaches a host's subscribers - which fires only on
 * the call that actually closed the period.
 *
 * There is deliberately no GET here. Closing is the moment money starts existing,
 * and a GET is something a crawler, a link preview or a browser prefetch can
 * perform without anyone having decided to.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const { result } = await closeBillingPeriodWorkflow(req.scope).run({
    input: { periodId: req.params.id },
  });

  res.json({ already_closed: result.alreadyClosed, result: result.result });
}
