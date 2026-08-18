import { MedusaError } from "@medusajs/framework/utils";
import { USAGE_SINK_REGISTRATION_PREFIX } from "./types";

/**
 * Choosing which registered sink writes the log.
 *
 * Pure, so the reasoning is testable without a container. The rules are the
 * boring ones, and the point of writing them down is that every failure says what
 * to do rather than what went wrong.
 */

/** The container key a sink with this id is registered under. */
export function sinkRegistrationKey(id: string): string {
  return `${USAGE_SINK_REGISTRATION_PREFIX}${id}`;
}

/**
 * Pick the sink to use.
 *
 * - Nothing registered is a configuration failure, not an empty default. Silently
 *   accepting usage that goes nowhere is the one outcome worse than refusing it.
 * - A named `sink` must exist. A typo must not fall through to some other sink,
 *   because "the events went to the wrong place" is discovered a month later.
 * - One registered sink and no `sink` option is unambiguous, so it is used.
 * - Several registered and no `sink` option is ambiguous, and guessing would mean
 *   picking which of two logs is the real one.
 */
export function selectSinkId(available: readonly string[], configured?: string | null): string {
  const ids = [...available];

  if (ids.length === 0) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      "medusa-usage: no usage sink is registered, so there is nowhere to put usage events. Leave the plugin's `providers` option unset to get the built-in Postgres sink, or name a sink provider there.",
    );
  }

  if (configured) {
    if (!ids.includes(configured)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `medusa-usage: the \`sink\` option names "${configured}", which is not registered. Registered sinks: ${ids.join(", ")}. The \`sink\` option holds the \`id\` you gave a provider in \`providers\`, not the provider's package name.`,
      );
    }
    return configured;
  }

  if (ids.length === 1) {
    return ids[0];
  }

  throw new MedusaError(
    MedusaError.Types.INVALID_DATA,
    `medusa-usage: ${ids.length} usage sinks are registered (${ids.join(", ")}) and the \`sink\` option does not say which one to write to. Set it, rather than having the plugin choose which log is the real one.`,
  );
}
