import {
  createStep,
  createWorkflow,
  StepResponse,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";
import type { UsageEventInput } from "../lib/usage/event";
import { USAGE_MODULE } from "../modules/usage/module-name";
import type { RecordUsageResult } from "../modules/usage/service";
import type UsageModuleService from "../modules/usage/service";

/**
 * Record usage.
 *
 * The workflow exists so that recording usage is callable the same way from a
 * route, a subscriber, a scheduled job or another workflow, and so that a host
 * that wants to meter something can wire it into its own flows without importing
 * this plugin's service. It is the house convention: an event happens, this
 * records the fact, and money follows later somewhere else entirely.
 *
 * ## There is no compensation, and that is the design
 *
 * A workflow step normally undoes itself when a later step fails. This one
 * cannot, because the log is append-only: there is no operation that removes a
 * usage event, and adding one would break the property the whole plugin is built
 * to provide - that a number computed from these events is the same number when
 * it is recomputed a year later.
 *
 * Nothing is lost by that. The step is safe to re-run, because keys are derived
 * and the sink keeps one row per key, so a workflow retried from the start
 * records the same usage once. And if the usage turns out to have been wrong,
 * the correction is a second event with a negative `quantity`, which is what a
 * ledger does and what an auditor expects to see.
 */

export interface RecordUsageInput {
  events: UsageEventInput[];
}

/** The slice of the module service this step uses. */
export interface UsageRecordingService {
  record: (input: UsageEventInput | UsageEventInput[]) => Promise<RecordUsageResult>;
}

/**
 * The step's body, as a plain function.
 *
 * `createStep` returns an opaque callable whose handler is not reachable from
 * outside, so the logic lives here where it can be tested against a fake service.
 * The step below is a thin binding.
 */
export async function runRecordUsage(
  input: RecordUsageInput,
  usage: UsageRecordingService,
): Promise<RecordUsageResult> {
  return usage.record(input.events ?? []);
}

export const recordUsageStep = createStep(
  "record-usage",
  async (input: RecordUsageInput, { container }) => {
    const usage = container.resolve<UsageModuleService>(USAGE_MODULE);
    return new StepResponse(await runRecordUsage(input, usage));
  },
);

export const recordUsageWorkflow = createWorkflow(
  "record-usage",
  (input: RecordUsageInput) => new WorkflowResponse(recordUsageStep(input)),
);
