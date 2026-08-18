import type { MedusaContainer } from "@medusajs/framework/types";
import { Modules } from "@medusajs/framework/utils";
import {
  createStep,
  createWorkflow,
  StepResponse,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";
import type { PeriodTarget } from "../lib/billing/period";
import type { ClosedPeriod } from "../lib/billing/result";
import { USAGE_MODULE } from "../modules/usage/module-name";
import type UsageModuleService from "../modules/usage/service";

/**
 * Close a billing period, and say so once.
 *
 * The workflow exists for the same reason the recording one does: so a host can
 * wire closing into a scheduled job, a route or a flow of its own without
 * importing this plugin's service. It is also the seam where this package hands
 * over. Closing emits an event; a subscriber in the host turns that into an
 * invoice, a payment, a document, a dunning schedule - none of which is any of
 * this package's business, and all of which is one subscriber away.
 *
 * ## The event fires once per period, ever
 *
 * `closePeriod` reports whether this call was the one that closed the period, and
 * the event is emitted only when it was. A retried job, a duplicated message or
 * two workers racing all reach a period that is already closed, get the stored
 * result back, and emit nothing - so a host subscriber that creates an invoice
 * does not need to deduplicate, because it is not called twice.
 *
 * That is the whole reason the emit is a separate step from the close, rather than
 * something the module service does: the module owns the frozen result, and the
 * question of who to tell about it belongs out here, with the application.
 *
 * ## There is no compensation
 *
 * A closed period is frozen, and there is no operation that unfreezes one - the
 * same reason recording usage has no compensation. If a later step in a host's
 * workflow fails, the period stays closed and the result stays as it was rated;
 * that is the point of freezing it. Rerunning the workflow is safe and returns the
 * same result, which is what a compensation would have had to guarantee anyway.
 */

/** The event a host subscribes to in order to bill a period. */
export const PERIOD_CLOSED_EVENT = "usage_period.closed";

/** What the event carries. Enough to fetch the result; never the result itself. */
export interface PeriodClosedEventData {
  id: string;
  subject: string;
  currency: string;
  /** Minor currency units. Zero means a closed period with nothing to charge for. */
  total: number;
  digest: string;
  from: string;
  to: string;
}

/** The slice of the module service these steps use. */
export interface UsagePeriodClosingService {
  closePeriod: (input: PeriodTarget) => Promise<ClosedPeriod>;
}

/** The step body, as a plain function, so it can be tested against a fake. */
export async function runCloseBillingPeriod(
  input: PeriodTarget,
  usage: UsagePeriodClosingService,
): Promise<ClosedPeriod> {
  return usage.closePeriod(input);
}

/**
 * The event bus, if this application has one.
 *
 * Optional on purpose: the module is usable from a script, a test or a CLI where
 * nothing has registered an event bus, and a period that closed correctly must not
 * be reported as a failure because there was nobody to tell.
 */
const eventBusOf = (
  container: MedusaContainer,
): { emit: (event: { name: string; data: unknown }) => Promise<unknown> } | null => {
  try {
    return container.resolve(Modules.EVENT_BUS);
  } catch {
    return null;
  }
};

/** What the emit step decided to do, so a caller can see it in the workflow result. */
export async function runEmitPeriodClosed(
  closed: ClosedPeriod,
  container: MedusaContainer,
): Promise<boolean> {
  if (closed.alreadyClosed) {
    // The period was closed by an earlier call, which already emitted. Emitting
    // again is how a customer gets two invoices for one month.
    return false;
  }
  const eventBus = eventBusOf(container);
  if (!eventBus) {
    return false;
  }

  const data: PeriodClosedEventData = {
    currency: closed.result.currency,
    digest: closed.result.digest,
    from: closed.result.from,
    id: closed.result.periodId,
    subject: closed.result.subject,
    to: closed.result.to,
    total: closed.result.total,
  };
  await eventBus.emit({ data, name: PERIOD_CLOSED_EVENT });
  return true;
}

export const closeBillingPeriodStep = createStep(
  "close-billing-period",
  async (input: PeriodTarget, { container }) => {
    const usage = container.resolve<UsageModuleService>(USAGE_MODULE);
    return new StepResponse(await runCloseBillingPeriod(input, usage));
  },
);

export const emitPeriodClosedStep = createStep(
  "emit-period-closed",
  async (closed: ClosedPeriod, { container }) =>
    new StepResponse(await runEmitPeriodClosed(closed, container)),
);

export const closeBillingPeriodWorkflow = createWorkflow(
  "close-billing-period",
  (input: PeriodTarget) => {
    const closed = closeBillingPeriodStep(input);
    emitPeriodClosedStep(closed);
    return new WorkflowResponse(closed);
  },
);
