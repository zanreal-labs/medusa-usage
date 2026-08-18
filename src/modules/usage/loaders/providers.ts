import { asFunction, asValue, Lifetime } from "@medusajs/framework/awilix";
import { moduleProviderLoader } from "@medusajs/framework/modules-sdk";
import type { LoaderOptions } from "@medusajs/framework/types";
import type { UsagePluginOptions, UsageSinkProviderConfig } from "../../../lib/options";
import { DEFAULT_SINK_RESOLVE, resolveUsageOptions } from "../../../lib/options";
import { sinkRegistrationKey } from "../../../lib/sink/registry";
import { USAGE_SINK_IDENTIFIERS } from "../../../lib/sink/types";
import postgresSinkProvider from "../../../providers/postgres";

/**
 * Register the configured sinks into the module's container.
 *
 * The same loader shape Medusa's notification and fulfillment modules use, and
 * for the same reason: the module owns the contract and the lifecycle, the host
 * owns the choice of implementation, and the container is where the two meet.
 * `moduleProviderLoader` does the importing, calls the provider's static
 * `validateOptions` before constructing anything, and hands each service the
 * module container as its cradle.
 *
 * Two registrations per sink:
 *
 * - `usage_sink_<id>`, the service itself, as a singleton. Singleton rather than
 *   scoped because a sink holds no request state, and may hold a connection pool
 *   or an outbound client that should not be rebuilt per request.
 * - the id, appended to `usage_sink_ids`, so the module service can say what is
 *   registered and refuse clearly when the `sink` option names something else.
 *
 * A sink is registered under the id the HOST chose, not under the provider's own
 * `identifier`. Deliberate, and the same as core: two instances of one provider
 * package - a primary and a mirror, say - are two sinks and need two names.
 */
export default async function loadUsageSinks({
  container,
  options,
}: LoaderOptions<UsagePluginOptions>): Promise<void> {
  const { providers } = resolveUsageOptions(options);

  await moduleProviderLoader({
    container,
    providers: providers.map(withBuiltInSink) as never,
    registerServiceFn: async (klass, providerContainer, details) => {
      providerContainer.register({
        [sinkRegistrationKey(details.id)]: asFunction(
          (cradle: Record<string, unknown>) => new klass(cradle, details.options ?? {}),
          { lifetime: klass.LIFE_TIME ?? Lifetime.SINGLETON },
        ),
      });
      // `registerAdd` creates the list on first use, so nothing seeds it here.
      // The module service treats an unregistered key as "no sinks", which is
      // also what a container looks like when every provider failed to load.
      providerContainer.registerAdd(USAGE_SINK_IDENTIFIERS, asValue(details.id));
    },
  });
}

/**
 * Hand the built-in sink to the loader as an already-imported module rather than
 * as a package path.
 *
 * `moduleProviderLoader` accepts either, and passing the import means the default
 * configuration does not depend on this package being resolvable by its own name
 * from wherever the host happens to have installed it. A sink the host named
 * itself is left exactly as written, and is imported by path as usual.
 */
const withBuiltInSink = (
  provider: UsageSinkProviderConfig,
): UsageSinkProviderConfig | { id: string; resolve: unknown; options?: Record<string, unknown> } =>
  provider.resolve === DEFAULT_SINK_RESOLVE
    ? { ...provider, resolve: postgresSinkProvider }
    : provider;
