import type { TFunction } from "i18next";
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
 *
 * Every function takes `t` rather than building a sentence, because the sentence
 * has to exist in English and in Polish and those are two pieces of copy, not one
 * string and a lookup table. `t` is a parameter rather than a hook so these stay
 * pure functions that a test can call directly. Counts are passed as `count` so
 * i18next picks the plural form: English needs two, Polish needs four, and the
 * `n === 1 ? "" : "s"` this used to do can only ever produce the English pair.
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
export function readIngestion(t: TFunction, status: UsageStatusResponse): Verdict {
  const key = (name: string): string => `usage.verdicts.ingestion.${name}`;

  if (status.last_flush_error) {
    return {
      detail: t(key("flushFailed"), {
        count: status.buffered,
        error: status.last_flush_error,
        sink: status.sink,
      }),
      headline: t(key("flushFailedHeadline")),
      tone: "red",
    };
  }
  if (status.flush_mode === "immediate") {
    return {
      detail: t(key("immediateDetail"), { sink: status.sink }),
      headline: t(key("immediateHeadline")),
      tone: "green",
    };
  }
  if (status.buffered > 0 && !status.last_flush_at) {
    return {
      detail: t(key("neverFlushed"), {
        batchSize: status.batch_size,
        count: status.buffered,
        interval: formatDuration(status.flush_interval_ms),
        oldest: formatDuration(status.oldest_buffered_ms),
        sink: status.sink,
      }),
      headline: t(key("neverFlushedHeadline")),
      tone: "orange",
    };
  }
  if (status.buffered > 0) {
    return {
      detail: t(key("recordingBuffered"), {
        count: status.buffered,
        lastFlush: formatInstant(status.last_flush_at),
        oldest: formatDuration(status.oldest_buffered_ms),
        sink: status.sink,
      }),
      headline: t(key("recordingHeadline")),
      tone: "green",
    };
  }
  if (status.last_flush_at) {
    return {
      detail: t(key("recordingIdleDetail"), {
        lastFlush: formatInstant(status.last_flush_at),
        sink: status.sink,
      }),
      headline: t(key("recordingHeadline")),
      tone: "green",
    };
  }
  return {
    detail: t(key("idleDetail")),
    headline: t(key("idleHeadline")),
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
export function readRateCard(t: TFunction, status: UsageStatusResponse): Verdict {
  if (!status.rates) {
    return {
      detail: t("usage.verdicts.rateCard.meteringOnlyDetail"),
      headline: t("usage.verdicts.rateCard.meteringOnlyHeadline"),
      tone: "grey",
    };
  }
  const { closeDelayMs, currency, meters } = status.rates;
  return {
    detail: t("usage.verdicts.rateCard.rated", {
      count: meters.length,
      currency,
      delay: formatDuration(closeDelayMs),
    }),
    headline: t("usage.verdicts.rateCard.ratedHeadline"),
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
 *
 * `now` is the browser's clock, and the server will use its own. A period that
 * crosses its closable instant therefore stays "still accruing" here until
 * something re-renders, and a badly skewed clock can offer a button the server
 * will refuse. Both are recoverable - the server's answer is the one that counts,
 * and it arrives in the operator's own words - which is why this reproduces the
 * rule rather than replacing it.
 */
export function readClosability(
  t: TFunction,
  period: PeriodRow,
  /** `undefined` while the status is still being read; `null` when there is none. */
  rates: UsageStatusResponse["rates"] | undefined,
  now: Date,
): Closability {
  if (period.closed_at) {
    return {
      closableAt: null,
      reason: t("usage.verdicts.closability.closed", {
        closedAt: formatInstant(period.closed_at),
      }),
      state: "closed",
    };
  }
  if (rates === undefined) {
    return {
      closableAt: null,
      reason: t("usage.verdicts.closability.unknown"),
      state: "unknown",
    };
  }
  if (!rates) {
    return {
      closableAt: null,
      reason: t("usage.verdicts.closability.noRateCard"),
      state: "no-rate-card",
    };
  }

  const closableAt = new Date(new Date(period.ends_at).getTime() + rates.closeDelayMs);
  if (now.getTime() < closableAt.getTime()) {
    // Two whole sentences rather than one with an optional clause spliced into
    // it: a hold of zero is a different statement, and in Polish the clause
    // cannot be appended to the first one unchanged.
    return {
      closableAt: closableAt.toISOString(),
      reason: t(
        rates.closeDelayMs > 0
          ? "usage.verdicts.closability.tooEarlyWithHold"
          : "usage.verdicts.closability.tooEarly",
        {
          closableAt: formatInstant(closableAt.toISOString()),
          delay: formatDuration(rates.closeDelayMs),
          endsAt: formatInstant(period.ends_at),
        },
      ),
      state: "too-early",
    };
  }
  return {
    closableAt: closableAt.toISOString(),
    reason: t("usage.verdicts.closability.closable"),
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
  t: TFunction,
  verification: PeriodVerification,
  result: PeriodResult,
): Verdict {
  if (verification.matches) {
    return {
      detail: t("usage.verdicts.verification.matchesDetail", {
        total: formatAmount(verification.storedTotal, result.currency),
      }),
      headline: t("usage.verdicts.verification.matchesHeadline"),
      tone: "green",
    };
  }
  const moved = verification.lines.filter(
    (line) => line.quantityDelta !== 0 || line.amountDelta !== 0,
  );

  // A digest covers the evidence, not just the money: the first and last instants
  // on each line and the digest of the snapshot it was rated from are inside it.
  // So a window can gain an event that cancels another, or one of quantity zero,
  // and fail to verify with every delta reading zero. Reporting "0 of N meters
  // differ" and stopping there would look like a bug in this screen.
  if (moved.length === 0) {
    return {
      detail: t("usage.verdicts.verification.noneMovedDetail"),
      headline: t("usage.verdicts.verification.differsHeadline"),
      tone: "orange",
    };
  }
  return {
    // `count` is the number of lines, because that is the noun the plural agrees
    // with; `moved` rides along as plain interpolation.
    detail: t("usage.verdicts.verification.differ", {
      count: verification.lines.length,
      delta: formatAmountDelta(verification.totalDelta, result.currency),
      moved: moved.length,
      recomputed: formatAmount(verification.recomputedTotal, result.currency),
      stored: formatAmount(verification.storedTotal, result.currency),
    }),
    headline: t("usage.verdicts.verification.differsHeadline"),
    tone: "orange",
  };
}
