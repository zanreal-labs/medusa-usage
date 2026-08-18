import { MedusaError } from "@medusajs/framework/utils";

/**
 * Options accepted by the usage plugin.
 *
 * Everything comes from `medusa-config.ts`; Medusa hands the plugin's `options`
 * object to every module inside the plugin unchanged. There are no credentials
 * here, because this plugin talks to nothing: whatever a sink needs goes in that
 * sink's own `options`, where the sink can validate it at boot.
 *
 * The one setting that cannot live here is the flush job's cron schedule. See
 * `USAGE_FLUSH_CRON` in the README.
 */

/** One entry of the standard Medusa module-provider list. */
export interface UsageSinkProviderConfig {
  /**
   * Package path exporting the provider, e.g.
   * `@zanreal/medusa-usage/providers/postgres`.
   */
  resolve: string;
  /**
   * The host's name for this sink. It is what the `sink` option refers to, what
   * appears in every snapshot, and what a log line names - so it should say where
   * the events go ("postgres", "warehouse"), not which package sends them.
   */
  id: string;
  /** Passed to the provider untouched. */
  options?: Record<string, unknown>;
}

export interface UsagePluginOptions {
  /**
   * Which sinks to register. Leave it unset and the built-in Postgres sink is
   * registered under the id "postgres", so the plugin works on a plain Medusa
   * install with no external service.
   */
  providers?: UsageSinkProviderConfig[];
  /**
   * Which registered sink to write to, by `id`. Only needed when more than one is
   * registered - with a single sink there is nothing to disambiguate, and with
   * several the plugin refuses to guess.
   */
  sink?: string;
  /**
   * How ingestion reaches the sink.
   *
   * - `buffered` (default): events are held in memory and written in batches.
   *   One round trip per batch instead of one per event, which is the difference
   *   between metering and not metering when the database is across the internet.
   *   The cost is bounded and stated: events waiting in the buffer are lost if the
   *   process is killed outright.
   * - `immediate`: every call writes before it returns. Slower by a full round
   *   trip per call, and the right choice when losing a few seconds of usage is
   *   worse than the latency.
   */
  flushMode?: "buffered" | "immediate";
  /** Events per write. Also the flush trigger: a full buffer flushes at once. */
  batchSize?: number;
  /** How long a partly-filled buffer waits before it is written anyway. */
  flushIntervalMs?: number;
  /**
   * Hard ceiling on buffered events. Reaching it makes `record` wait for a flush
   * rather than growing without bound; if that flush fails, `record` throws and
   * the caller can retry safely, because the keys are derived.
   */
  maxBufferedEvents?: number;
  /** Most events one `recordUsage` call may carry. Bounds a single request. */
  maxEventsPerCall?: number;
}

/** Options after defaults and validation. Every field is present. */
export interface ResolvedUsageOptions {
  providers: UsageSinkProviderConfig[];
  sink: string | null;
  flushMode: "buffered" | "immediate";
  batchSize: number;
  flushIntervalMs: number;
  maxBufferedEvents: number;
  maxEventsPerCall: number;
}

/** Registered when the host names no providers of its own. */
export const DEFAULT_SINK_ID = "postgres";
export const DEFAULT_SINK_RESOLVE = "@zanreal/medusa-usage/providers/postgres";

/**
 * 500 rows per statement.
 *
 * Large enough that a busy meter costs one round trip per few hundred events
 * rather than per event, small enough that a single INSERT stays well inside
 * Postgres's parameter limit with room for the columns each row carries, and
 * small enough that a failed batch is a small retry.
 */
export const DEFAULT_BATCH_SIZE = 500;

/**
 * Five seconds.
 *
 * The upper bound on how long a quiet meter's events sit in memory, and therefore
 * the size of the window a hard kill can lose. Short enough to be an acceptable
 * loss, long enough that a busy meter fills a batch first and the timer never
 * fires.
 */
export const DEFAULT_FLUSH_INTERVAL_MS = 5000;

/** 20 batches' worth. Past this, ingestion waits for the writer to catch up. */
export const DEFAULT_MAX_BUFFERED_EVENTS = 10_000;

/** One request may not queue more than this. */
export const DEFAULT_MAX_EVENTS_PER_CALL = 1000;

const fail = (message: string): never => {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, `medusa-usage: ${message}`);
};

const positiveInteger = (value: unknown, field: string, fallback: number, minimum: number): number => {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    return fail(`\`${field}\` must be a whole number of at least ${minimum} (received ${String(value)}).`);
  }
  return value;
};

const resolveProviders = (providers: UsageSinkProviderConfig[] | undefined): UsageSinkProviderConfig[] => {
  if (providers === undefined || providers === null) {
    return [{ id: DEFAULT_SINK_ID, resolve: DEFAULT_SINK_RESOLVE }];
  }
  if (!Array.isArray(providers)) {
    return fail("`providers` must be an array of sink providers.");
  }
  if (providers.length === 0) {
    return fail(
      "`providers` is an empty array, which would leave nowhere to put usage events. Remove the option entirely to get the built-in Postgres sink.",
    );
  }
  const ids = new Set<string>();
  for (const provider of providers) {
    if (!provider?.resolve || typeof provider.resolve !== "string") {
      fail("every entry in `providers` needs a `resolve` naming the package that exports it.");
    }
    if (!provider?.id || typeof provider.id !== "string") {
      fail(`the provider "${provider?.resolve}" needs an \`id\`; it is how the sink is named everywhere else.`);
    }
    if (ids.has(provider.id)) {
      fail(`two providers share the id "${provider.id}". Ids have to be unique - they are what the \`sink\` option selects on.`);
    }
    ids.add(provider.id);
  }
  return providers;
};

/** Apply defaults and reject anything that cannot mean what it says. */
export function resolveUsageOptions(options?: Partial<UsagePluginOptions>): ResolvedUsageOptions {
  const flushMode = options?.flushMode ?? "buffered";
  if (flushMode !== "buffered" && flushMode !== "immediate") {
    fail(`\`flushMode\` must be "buffered" or "immediate" (received "${String(flushMode)}").`);
  }

  const batchSize = positiveInteger(options?.batchSize, "batchSize", DEFAULT_BATCH_SIZE, 1);
  const maxBufferedEvents = positiveInteger(
    options?.maxBufferedEvents,
    "maxBufferedEvents",
    DEFAULT_MAX_BUFFERED_EVENTS,
    1,
  );
  if (maxBufferedEvents < batchSize) {
    fail(
      `\`maxBufferedEvents\` (${maxBufferedEvents}) is below \`batchSize\` (${batchSize}), so the buffer would apply back pressure before it could ever fill a batch.`,
    );
  }

  const sink = options?.sink ?? null;
  if (sink !== null && (typeof sink !== "string" || !sink.trim())) {
    fail("`sink` must be the id of one of the configured providers.");
  }

  return {
    batchSize,
    flushIntervalMs: positiveInteger(
      options?.flushIntervalMs,
      "flushIntervalMs",
      DEFAULT_FLUSH_INTERVAL_MS,
      100,
    ),
    flushMode,
    maxBufferedEvents,
    maxEventsPerCall: positiveInteger(
      options?.maxEventsPerCall,
      "maxEventsPerCall",
      DEFAULT_MAX_EVENTS_PER_CALL,
      1,
    ),
    providers: resolveProviders(options?.providers),
    sink: sink === null ? null : sink.trim(),
  };
}
