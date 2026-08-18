import { MedusaError } from "@medusajs/framework/utils";
import type { UsageEvent } from "../usage/event";
import type {
  UsageAggregateQuery,
  UsageAggregateResult,
  UsageEventPage,
  UsageListQuery,
  UsageSinkProvider,
  UsageSinkWriteResult,
} from "./types";

/**
 * Base class for a usage sink.
 *
 * Deliberately thin. It carries the identifier plumbing so every implementation
 * declares itself the same way, and it leaves the three real methods abstract so
 * the contract in `./types.ts` is the only thing an implementer has to satisfy.
 * This is the same bargain `AbstractFulfillmentProviderService` and
 * `AbstractNotificationProviderService` make in Medusa core.
 *
 * A third-party sink is a package that exports:
 *
 *     import { ModuleProvider } from "@medusajs/framework/utils"
 *     export default ModuleProvider(USAGE_MODULE, { services: [MySinkService] })
 *
 * and is named in the plugin's `providers` option. Nothing in this package needs
 * to change for it to work.
 */
export abstract class AbstractUsageSinkProviderService implements UsageSinkProvider {
  /**
   * Set by every implementation. The host pairs it with its own `id` in
   * `medusa-config.ts`, and the pair is what identifies a sink in logs, in
   * snapshots and in the `sink` option.
   */
  static identifier: string;

  /**
   * Optional boot-time validation of the provider's own options. Medusa's module
   * provider loader awaits it before constructing the service, so a bad option is
   * a failed boot rather than a failed write later.
   */
  static validateOptions?: (options: Record<string, unknown>) => void | Promise<void>;

  getIdentifier(): string {
    const { identifier } = this.constructor as typeof AbstractUsageSinkProviderService;
    if (!identifier) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `medusa-usage: the usage sink ${this.constructor.name} has no static \`identifier\`. Give it one - it is how the sink is named in configuration, in logs and in every snapshot it produces.`,
      );
    }
    return identifier;
  }

  abstract write(events: readonly UsageEvent[]): Promise<UsageSinkWriteResult>;

  abstract aggregate(query: UsageAggregateQuery): Promise<UsageAggregateResult>;

  abstract listEvents(query: UsageListQuery): Promise<UsageEventPage>;
}
