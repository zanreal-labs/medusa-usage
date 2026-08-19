import type { PeriodResult, PeriodVerification } from "../../lib/billing/result";
import type { PeriodRow, UsageStatusResponse } from "./api";
import { formatAmount, formatAmountDelta, formatDuration, formatInstant } from "./format";

/**
 * Turning an API response into the sentence an operator arrived for.
 *
 * This is the whole reason the screen exists rather than a link to the JSON. The
 * endpoints already say everything; what they do not say is which of the things
 * they said is the one that matters right now. A `buffered` of 40 is healthy next
 * to a recent flush and is an outage next to a flush error, and an operator should
 * not have to know that.
 *
 * Kept out of the components, and out of the routes, so the judgements are
 * testable without a browser and so none of them can quietly disagree with each
 * other. Nothing here fetches, and nothing here decides anything the API has not
 * already decided - `readClosability` in particular reproduces the rule
 * `assertClosable` enforces on the server, so the screen can explain why a period
 * cannot be closed yet instead of offering a button that returns an error.
 */

/** How loudly to say it. Maps onto the `StatusBadge` colours. */
export type Tone = "green" | "grey" | "orange" | "red";

/** A headline an operator can act on, and the detail behind it. */
export interface Verdict {
  detail: string;
  headline: string;
  tone: Tone;
}

/**
 * Is anything being recorded at all?
 *
 * The honest answer this endpoint can give is about the pipe, not the traffic:
 * whether events are reaching a sink, and whether the last attempt to write them
 * worked. Whether a meter has any usage in it is a different question, and the
 * meters section answers that one by asking the aggregate.
 *
 * Both caveats in the route's own documentation survive into the text, because an
 * operator acting on a wrong reading of them is exactly the failure this screen is
 * meant to prevent: the numbers describe the process that served the request, not
 * the deployment, and an empty buffer means nothing is waiting rather than that
 * nothing was recorded.
 */
export function readIngestion(status: UsageStatusResponse): Verdict {
  const waiting = `${status.buffered} event${status.buffered === 1 ? "" : "s"} waiting`;
  const oldest = `oldest ${formatDuration(status.oldest_buffered_ms)}`;
  const instance = "These counts are for the instance that served this request, not the deployment.";

  if (status.last_flush_error) {
    return {
      detail: `The "${status.sink}" sink said: ${status.last_flush_error}. ${waiting}. Until a flush succeeds, usage is only in memory.`,
      headline: "The last flush failed",
      tone: "red",
    };
  }
  if (status.flush_mode === "immediate") {
    return {
      detail: `Every event is written to the "${status.sink}" sink as it arrives, so nothing buffers and there is no flush to be behind on.`,
      headline: "Writing each event as it arrives",
      tone: "green",
    };
  }
  if (status.buffered > 0 && !status.last_flush_at) {
    return {
      detail: `${waiting}, ${oldest}, and nothing has been flushed to "${status.sink}" yet. Flushes run every ${formatDuration(status.flush_interval_ms)}, or sooner at ${status.batch_size} events. ${instance}`,
      headline: "Buffering, nothing written yet",
      tone: "orange",
    };
  }
  if (status.buffered > 0) {
    return {
      detail: `${waiting}, ${oldest}. Last flush to "${status.sink}" at ${formatInstant(status.last_flush_at)}. ${instance}`,
      headline: "Recording",
      tone: "green",
    };
  }
  if (status.last_flush_at) {
    return {
      detail: `Nothing waiting. The last flush to "${status.sink}" was at ${formatInstant(status.last_flush_at)}. ${instance}`,
      headline: "Recording",
      tone: "green",
    };
  }
  return {
    detail: `Nothing is buffered and this instance has not flushed anything. That is what a healthy plugin with no producer looks like, and also what a broken producer looks like. ${instance}`,
    headline: "Nothing has arrived yet",
    tone: "grey",
  };
}

/**
 * Whether this installation can put a price on anything.
 *
 * Separated from ingestion because it is a configuration fact rather than a health
 * one, and because it is the first thing to check when a period refuses to close.
 * A missing rate card is not a fault: metering without pricing is a supported way
 * to run this plugin.
 */
export function readRateCard(status: UsageStatusResponse): Verdict {
  if (!status.rates) {
    return {
      detail:
        "No rate card is configured, so this installation meters without pricing. Periods can be opened and read, but not closed.",
      headline: "Metering only",
      tone: "grey",
    };
  }
  const { closeDelayMs, currency, meters } = status.rates;
  return {
    detail: `${meters.length} meter${meters.length === 1 ? "" : "s"} priced in ${currency}. A period is held open for ${formatDuration(closeDelayMs)} after it ends before it can be closed.`,
    headline: "Rated",
    tone: "green",
  };
}

/**
 * Why a period can or cannot be closed right now.
 *
 * `unknown` is a state and not an oversight: until the rate card has been read,
 * "cannot be closed, there is no rate card" and "can be closed" are the same
 * silence, and reporting either of them would be a guess.
 */
export type CloseState = "closable" | "closed" | "no-rate-card" | "too-early" | "unknown";

export interface Closability {
  /** The instant the period becomes closable, when that is what is in the way. */
  closableAt: string | null;
  reason: string;
  state: CloseState;
}

/**
 * The same rule the server enforces, evaluated here so the screen can say why.
 *
 * A period cannot be closed before its window has ended plus `closeDelayMs`,
 * because a period that is still accruing would freeze at a number it has not
 * reached. The server refuses either way; this exists so an operator reads the
 * reason before pressing the button rather than after.
 */
export function readClosability(
  period: PeriodRow,
  /** `undefined` while the status is still being read; `null` when there is none. */
  rates: UsageStatusResponse["rates"] | undefined,
  now: Date,
): Closability {
  if (period.closed_at) {
    return {
      closableAt: null,
      reason: `Closed at ${formatInstant(period.closed_at)}. The frozen result is what was billed, and closing again would return it unchanged rather than bill twice.`,
      state: "closed",
    };
  }
  if (rates === undefined) {
    return {
      closableAt: null,
      reason: "Still reading the rate card, so whether this period can be closed is not known yet.",
      state: "unknown",
    };
  }
  if (!rates) {
    return {
      closableAt: null,
      reason:
        "There is no rate card, so there is nothing to rate this period against. Configure `billing` in the plugin options before closing it.",
      state: "no-rate-card",
    };
  }

  const closableAt = new Date(new Date(period.ends_at).getTime() + rates.closeDelayMs);
  if (now.getTime() < closableAt.getTime()) {
    return {
      closableAt: closableAt.toISOString(),
      reason: `Not closable until ${formatInstant(closableAt.toISOString())}. The window ends at ${formatInstant(period.ends_at)}${rates.closeDelayMs > 0 ? `, and it is held open for a further ${formatDuration(rates.closeDelayMs)} so events still in a buffer can land` : ""}.`,
      state: "too-early",
    };
  }
  return {
    closableAt: closableAt.toISOString(),
    reason:
      "The window is over. Closing rates it against the rate card and freezes the answer; it is safe to retry and cannot bill twice.",
    state: "closable",
  };
}

/**
 * What a re-derivation found.
 *
 * A mismatch is not an error and is not phrased as one. It is the one honest thing
 * that can be said about a period whose window has gained events since it was
 * frozen, and the frozen result stays exactly as it was either way.
 */
export function readVerification(
  verification: PeriodVerification,
  result: PeriodResult,
): Verdict {
  if (verification.matches) {
    return {
      detail: `Rated again from the log, this period still comes to ${formatAmount(verification.storedTotal, result.currency)} and the same digest. The evidence behind the invoice has not moved.`,
      headline: "Verifies",
      tone: "green",
    };
  }
  const moved = verification.lines.filter(
    (line) => line.quantityDelta !== 0 || line.amountDelta !== 0,
  );
  return {
    detail: `${moved.length} of ${verification.lines.length} meter${verification.lines.length === 1 ? "" : "s"} differ. The log now totals ${formatAmount(verification.recomputedTotal, result.currency)} against the ${formatAmount(verification.storedTotal, result.currency)} that was billed, a difference of ${formatAmountDelta(verification.totalDelta, result.currency)}. The frozen result has not been rewritten, and will not be.`,
    headline: "Does not verify",
    tone: "orange",
  };
}
