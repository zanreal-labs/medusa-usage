import { MedusaError } from "@medusajs/framework/utils";

/**
 * The rate card.
 *
 * A rate is configuration, never code. This package is published and the products
 * it will be used to bill do not exist yet, so nothing here may know what a meter
 * is called, what it counts, or what a unit of it is worth. What it does know is
 * the shape of the answer: for each meter, a whole number of minor currency units
 * per some whole number of metered units, and an optional allowance that is not
 * charged for.
 *
 * ## There is no recurring price here, and there will not be one
 *
 * No base fee, no plan price, no minimum commitment, no proration. A period's
 * charge is the usage in it, rated and summed, and nothing else. A subscription
 * in this model exists only to say when a period ends; it is not a thing that
 * costs money, so there is nowhere in this file to express one. A customer who
 * consumed nothing owes nothing, and that comes out of the arithmetic rather than
 * out of a special case.
 *
 * ## Money is integers, for the same reason quantities are
 *
 * `unitAmount` is a whole number of the currency's smallest indivisible unit -
 * grosze, cents, pence - exactly as every payment API on earth takes it. A sum of
 * doubles depends on the order the terms are added, so the same period could be
 * rated to two different amounts on two different days and both would be
 * defensible. One of them would be on an invoice.
 *
 * ## Why a rate has a denominator
 *
 * `perUnits` is how many metered units one `unitAmount` buys, and it defaults to
 * 1, which is the plain "so much per unit" that most rates are.
 *
 * It exists because without it this package would quietly bake in an assumption
 * about prices: that every meter is worth at least one minor unit per unit
 * consumed. A meter counting API requests is not. Priced at a hundredth of a
 * grosz per request, the only ways to express it would be to invent a meter that
 * counts thousands of requests - losing the raw count that the audit path exists
 * to show - or to price in fractions, which is the thing this package refuses to
 * do. So the rate carries its denominator and the arithmetic stays exact: see
 * `./rating.ts`, where the multiplication happens before the single division.
 *
 * ## What is deliberately not here
 *
 * Tiers, volume breaks, per-subject or per-plan overrides, dimension-priced rates,
 * currency conversion. Each is a real pricing model and none of them can be
 * designed against products that do not exist. A rate card keyed by anything
 * other than the meter would also have to be a query language, and every host
 * would then be configuring a slightly different one.
 */

/** One meter's price, as a host writes it in `medusa-config.ts`. */
export interface MeterRateConfig {
  /** The meter this prices. Matched byte for byte against the recorded meter. */
  meter: string;
  /**
   * Whole minor currency units charged per `perUnits` of the meter. May be 0,
   * which is a meter that is metered and reported but never charged for.
   */
  unitAmount: number;
  /** How many metered units `unitAmount` covers. Defaults to 1. */
  perUnits?: number;
  /**
   * Units forgiven before anything is charged, per period. This is the "first N
   * free, then so much per unit" shape, expressed where it belongs: on the
   * meter's rate, not on the subscription. The subscription has no price to hang
   * it from.
   */
  includedUnits?: number;
}

/** The `billing` plugin option. Absent means the plugin does not rate anything. */
export interface UsageBillingOptions {
  /**
   * The currency every amount in this card is denominated in. ISO 4217, upper
   * case, by convention rather than by validation - this package never resolves
   * it against anything, it only carries it onto the result so an amount is not a
   * bare number.
   *
   * One currency for the whole card, because a period rates to one total and a
   * total in two currencies is not a number.
   */
  currency: string;
  /** One entry per meter that is charged for. */
  rates: MeterRateConfig[];
  /**
   * How long after a period ends before it may be closed.
   *
   * Zero, the default, allows closing the moment the window is over. Raise it
   * when the log behind it settles slowly - a sink that accepts events days late
   * will otherwise have a period frozen before its last events arrive. See the
   * README on late events for what happens when one arrives anyway.
   */
  closeDelayMs?: number;
}

/** One meter's price after defaults and validation. Every field is present. */
export interface MeterRate {
  meter: string;
  unitAmount: number;
  perUnits: number;
  includedUnits: number;
}

/** The rate card after defaults and validation. */
export interface RateCard {
  currency: string;
  rates: MeterRate[];
  closeDelayMs: number;
}

/** Longest accepted currency code. Long enough for anything anyone actually uses. */
export const MAX_CURRENCY_LENGTH = 12;

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/u;

const fail = (message: string): never => {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, `medusa-usage: ${message}`);
};

const wholeNumber = (
  value: unknown,
  field: string,
  fallback: number,
  minimum: number,
): number => {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    return fail(
      `\`${field}\` must be a whole number of at least ${minimum} (received ${String(value)}). Money and allowances are counted in whole units here, never in fractions.`,
    );
  }
  return value;
};

/**
 * Apply defaults and reject anything that cannot mean what it says.
 *
 * Returns null when the host configured no `billing` block at all, which is a
 * plugin that meters and does not rate - exactly what it did before periods
 * existed. Every path that needs a rate says so by name rather than rating
 * everything to zero, because a period rated to zero because nobody configured a
 * price looks identical to a period in which nothing was consumed.
 */
export function resolveRateCard(options?: UsageBillingOptions | null): RateCard | null {
  if (options === undefined || options === null) {
    return null;
  }
  if (typeof options !== "object" || Array.isArray(options)) {
    return fail("`billing` must be an object with a `currency` and a list of `rates`.");
  }

  const currency = typeof options.currency === "string" ? options.currency.trim() : "";
  if (!currency) {
    return fail(
      "`billing.currency` is required. An amount without a currency is not a price, and this package will not guess one.",
    );
  }
  if (currency.length > MAX_CURRENCY_LENGTH || CONTROL_CHARACTERS.test(currency)) {
    fail(`\`billing.currency\` ("${currency}") is not a currency code. ISO 4217, upper case.`);
  }

  if (!Array.isArray(options.rates) || options.rates.length === 0) {
    return fail(
      "`billing.rates` must list at least one meter. A rate card with no rates would close every period at zero, which is indistinguishable from a customer who used nothing.",
    );
  }

  const seen = new Set<string>();
  const rates = options.rates.map((entry) => {
    if (typeof entry !== "object" || entry === null) {
      fail("every entry in `billing.rates` must be an object.");
    }
    const meter = typeof entry.meter === "string" ? entry.meter.trim() : "";
    if (!meter) {
      fail("every entry in `billing.rates` needs a `meter`.");
    }
    if (CONTROL_CHARACTERS.test(meter)) {
      fail(`the rate for "${meter}" names a meter containing a control character.`);
    }
    if (seen.has(meter)) {
      fail(
        `two rates are configured for the meter "${meter}". One meter has one price; a second one would make the total depend on which was applied.`,
      );
    }
    seen.add(meter);

    return Object.freeze({
      includedUnits: wholeNumber(entry.includedUnits, `billing.rates[${meter}].includedUnits`, 0, 0),
      meter,
      perUnits: wholeNumber(entry.perUnits, `billing.rates[${meter}].perUnits`, 1, 1),
      unitAmount: wholeNumber(entry.unitAmount, `billing.rates[${meter}].unitAmount`, 0, 0),
    });
  });

  return Object.freeze({
    closeDelayMs: wholeNumber(options.closeDelayMs, "billing.closeDelayMs", 0, 0),
    currency,
    rates: Object.freeze(rates) as MeterRate[],
  });
}

/** The rate for one meter, or null when the card does not price it. */
export function rateFor(card: RateCard, meter: string): MeterRate | null {
  return card.rates.find((rate) => rate.meter === meter) ?? null;
}
