import type { LoaderOptions } from "@medusajs/framework/types";
import type { UsagePluginOptions } from "../../../lib/options";
import { DEFAULT_SINK_ID, resolveUsageOptions } from "../../../lib/options";

/**
 * Fail fast on a misconfigured plugin, and say once at boot where usage is going.
 *
 * Loaders run at application startup, before any request is served, which is the
 * only place a configuration error reaches the person who can fix it. Left to the
 * service, the same mistake would surface on the first `record` call - in the
 * middle of whatever the host was metering, wrapped in an unrelated stack.
 *
 * Unlike an integration plugin, there is no credential here and therefore no
 * "configured or inert" state: a usage plugin with nowhere to put events is not a
 * quiet no-op, it is silent data loss. So every option problem throws, and the
 * absence of options is a working default rather than an off switch.
 */
export default async function validateUsageOptions({
  options,
  logger,
}: LoaderOptions<UsagePluginOptions>): Promise<void> {
  const resolved = resolveUsageOptions(options);
  const sinks = resolved.providers.map((provider) => provider.id).join(", ");
  const usingDefault =
    resolved.providers.length === 1 && resolved.providers[0].id === DEFAULT_SINK_ID && !options?.providers;

  logger?.info(
    `[medusa-usage] sinks: ${sinks}${usingDefault ? " (built in; no `providers` configured)" : ""}. ` +
      `Ingestion is ${resolved.flushMode}` +
      (resolved.flushMode === "buffered"
        ? `, in batches of up to ${resolved.batchSize} or every ${resolved.flushIntervalMs}ms, whichever comes first.`
        : ", writing on every call."),
  );

  if (resolved.flushMode === "buffered") {
    logger?.debug?.(
      `[medusa-usage] up to ${resolved.maxBufferedEvents} events may be held in memory before ingestion applies back pressure. ` +
        "Events still buffered when a process is killed outright are lost; the flush job and the shutdown flush bound that window.",
    );
  }
}
