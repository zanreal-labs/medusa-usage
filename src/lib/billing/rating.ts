import { MedusaError } from "@medusajs/framework/utils";
import type { UsageSnapshot } from "../usage/snapshot";
import type { MeterRate } from "./rates";

/**
 * Rating: one aggregate, one rate, one amount.
 *
 * This is the only file in the package that produces money, and it is fifty lines
 * of integer arithmetic because that is all rating a usage-only period is. There
 * is no fee to add, no plan to look up, no proration to compute and no discount to
 * apply. A meter's charge is what was consumed, less what was included, at the
 * configured rate.
 *
 * ## The arithmetic, exactly
 *
 *     chargeable = total <= 0 ? total : max(total - includedUnits, 0)
 *     amount     = trunc(chargeable * unitAmount / perUnits)
 *
 * Three properties fall out of writing it that way, and each is pinned by a test.
 *
 * **Nothing is ever a float.** The multiplication and the division are done in
 * `BigInt`, so `chargeable * unitAmount` cannot overflow into an approximation on
 * the way to a division that would have made it exact again. The result is checked
 * against `Number.MAX_SAFE_INTEGER` before it is handed back as a number, and
 * refused rather than rounded if it does not fit - the same rule the event log
 * applies to a total, for the same reason.
 *
 * **The division truncates toward zero**, so a credit exactly cancels the charge
 * it reverses: rating -N is always the negation of rating +N. Rounding half up, or
 * flooring, would break that, and a correction that does not undo the thing it
 * corrects is worse than no correction. The cost is that a fraction of a minor
 * unit is dropped once per meter per period, in the customer's favour on a charge.
 * A fraction of a grosz cannot be invoiced anyway.
 *
 * **An allowance forgives consumption; it does not create it.** A period whose net
 * total is negative - a correction landed for usage recorded in error - passes
 * through untouched rather than being clamped to zero by an allowance it never
 * used. Clamping there would silently swallow a credit.
 */

/** One meter's line on a rated period. Everything needed to justify the amount. */
export interface RatedLine {
  meter: string;
  /** Net usage in the window. The aggregate, unmodified. */
  quantity: number;
  /** How many events it was summed from. The tamper-evidence beside the number. */
  eventCount: number;
  firstOccurredAt: string | null;
  lastOccurredAt: string | null;
  /**
   * The digest of the usage snapshot this line was rated from, so the line points
   * at the evidence it came from and a re-derivation can be checked one field at
   * a time rather than all at once.
   */
  usageDigest: string;
  /** The rate as it stood when the period closed. Never read from config again. */
  includedUnits: number;
  unitAmount: number;
  perUnits: number;
  /** What was left to charge for after the allowance. */
  chargeableQuantity: number;
  /** Minor currency units. `trunc(chargeableQuantity * unitAmount / perUnits)`. */
  amount: number;
}

/**
 * What is left to charge for.
 *
 * Exported because a host reading a line should be able to check it by hand, and
 * because the negative case is a decision rather than an accident.
 */
export function chargeableQuantity(total: number, includedUnits: number): number {
  if (!Number.isSafeInteger(total)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `medusa-usage: cannot rate a total of ${String(total)}, which is not a whole number.`,
    );
  }
  if (total <= 0) {
    return total;
  }
  return Math.max(total - includedUnits, 0);
}

/**
 * The amount for a chargeable quantity at a rate, in minor currency units.
 *
 * `BigInt` throughout, so the intermediate product is exact however large it gets,
 * and one truncating division at the end. The only way out of here is a whole
 * number of minor units or a thrown error.
 */
export function amountFor(chargeable: number, rate: MeterRate): number {
  const product = BigInt(chargeable) * BigInt(rate.unitAmount);
  const amount = product / BigInt(rate.perUnits);

  if (amount > BigInt(Number.MAX_SAFE_INTEGER) || amount < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      `medusa-usage: the amount for "${rate.meter}" (${amount.toString()} minor units) is beyond exact integer arithmetic. An amount this size can no longer be summed without rounding, and a rounded amount must not reach an invoice.`,
    );
  }
  return Number(amount);
}

/**
 * Rate one meter's snapshot.
 *
 * Takes the snapshot rather than a bare total on purpose: the line carries the
 * event count, the first and last instants and the snapshot's own digest, so an
 * amount can be justified without going back to the log first, and can be checked
 * against the log when someone insists.
 */
export function rateSnapshot(rate: MeterRate, snapshot: UsageSnapshot): RatedLine {
  if (snapshot.meter !== rate.meter) {
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      `medusa-usage: a snapshot of "${snapshot.meter}" was handed to the rate for "${rate.meter}".`,
    );
  }

  const chargeable = chargeableQuantity(snapshot.total, rate.includedUnits);

  return Object.freeze({
    amount: amountFor(chargeable, rate),
    chargeableQuantity: chargeable,
    eventCount: snapshot.eventCount,
    firstOccurredAt: snapshot.firstOccurredAt,
    includedUnits: rate.includedUnits,
    lastOccurredAt: snapshot.lastOccurredAt,
    meter: rate.meter,
    perUnits: rate.perUnits,
    quantity: snapshot.total,
    unitAmount: rate.unitAmount,
    usageDigest: snapshot.digest,
  });
}

/**
 * Re-rate a line from the rate recorded on it, against a snapshot taken now.
 *
 * The rate comes off the stored line and never out of the current configuration,
 * which is what makes a re-derivation a check of the log rather than a check of
 * the config file. A price change must not be able to restate an amount that was
 * already billed.
 */
export function rerateLine(line: RatedLine, snapshot: UsageSnapshot): RatedLine {
  return rateSnapshot(
    {
      includedUnits: line.includedUnits,
      meter: line.meter,
      perUnits: line.perUnits,
      unitAmount: line.unitAmount,
    },
    snapshot,
  );
}
