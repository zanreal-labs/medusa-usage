import type { Logger, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { USAGE_MODULE } from "../modules/usage/module-name";
import type UsageModuleService from "../modules/usage/service";

const JOB_NAME = "usage-flush";

/**
 * The floor under the buffer.
 *
 * Ingestion already flushes on two triggers of its own - a full batch, and an
 * interval timer started by the first `record` call. This job exists for the
 * cases neither covers:
 *
 * - A process that has recorded usage and then gone quiet. Its timer is
 *   unreferenced and its buffer is small, so nothing else is in a hurry to write
 *   the last few events. Here they leave within a minute.
 * - A worker process that has never called `record` at all, where no timer was
 *   ever started. Flushing an empty buffer costs nothing, which is why this is
 *   safe to run everywhere.
 *
 * It is deliberately not the primary mechanism. A minute of latency on a usage
 * event is fine; a minute of events held in memory is not, which is what the
 * in-process triggers are for.
 *
 * Each process flushes its own buffer. In a multi-instance deployment that means
 * this job does its work on whichever instance runs it, and the others rely on
 * their own timers - which is exactly what a snapshot taken over a window that
 * has not settled yet would miss. Close the window before you bill it.
 */
export default async function usageFlushJob(container: MedusaContainer): Promise<void> {
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER);
  const usage = container.resolve<UsageModuleService>(USAGE_MODULE);

  try {
    const summary = await usage.flush();
    if (summary.submitted > 0) {
      logger.info(
        `[${JOB_NAME}] wrote ${summary.submitted} buffered events in ${summary.batches} batches ` +
          `(${summary.appended} appended, ${summary.duplicates} already present).`,
      );
    }
  } catch (error) {
    // The events are back in the buffer and will be retried by the next trigger,
    // so this is a warning about the sink rather than a lost write. Rethrowing
    // would mark the scheduled job failed for something that recovers by itself.
    logger.warn(
      `[${JOB_NAME}] could not write the buffered usage events; they are still queued and will be retried: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export const config = {
  name: JOB_NAME,
  /**
   * NOTE ON "why is this not a plugin option": Medusa evaluates a scheduled job's
   * `config.schedule` at plugin-load time, before the DI container - and therefore
   * this plugin's options - exists. There is no supported way for a static config
   * export to read a resolved module's options, so the cron is controlled by the
   * `USAGE_FLUSH_CRON` environment variable instead. Documented in the README
   * where someone would look for the option.
   *
   * Every minute: short enough that a quiet process does not sit on its last few
   * events, long enough to be irrelevant to a busy one, which will have flushed on
   * batch size dozens of times between ticks.
   */
  schedule: process.env.USAGE_FLUSH_CRON ?? "* * * * *",
};
