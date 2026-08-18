import { Module } from "@medusajs/framework/utils";
import loadUsageSinks from "./loaders/providers";
import validateUsageOptions from "./loaders/validate-options";
import { USAGE_MODULE } from "./module-name";
import UsageModuleService from "./service";

/**
 * The usage module: an append-only event log, a batched way in, and one
 * deterministic way to ask what it adds up to.
 *
 * Two loaders, in order. `validateUsageOptions` fails the boot on a
 * configuration that cannot work, so the error reaches the person who wrote it.
 * `loadUsageSinks` then registers the configured sinks into the module's
 * container, the same way Medusa's own notification and fulfillment modules load
 * theirs.
 */
export default Module(USAGE_MODULE, {
  loaders: [validateUsageOptions, loadUsageSinks],
  service: UsageModuleService,
});

export { USAGE_MODULE } from "./module-name";
export { default as UsageModuleService } from "./service";
export type { FlushSummary, RecordUsageResult, UsageStatus } from "./service";
