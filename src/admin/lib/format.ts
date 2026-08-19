/**
 * Rendering the plugin's numbers without changing them.
 *
 * Everything here is a display concern and none of it is arithmetic the API has
 * not already done. That distinction is the point: an amount is stored in whole
 * minor currency units because that is the only representation that adds up
 * exactly, and a screen that divided it into a float on the way to the operator
 * would be the one place in this package where a total could drift from the total
 * that was billed. So the conversion below is done on the digits of the integer,
 * not on the integer.
 *
 * Instants are rendered in UTC, always and without an option. Every window in this
 * package is half-open and UTC, a period boundary is exact to the millisecond, and
 * an operator comparing a period's `ends_at` against the instant an event occurred
 * must not be doing that comparison across two timezones.
 */

/** Everything that is absent renders as this, so a null is never mistaken for a zero. */
export const ABSENT = "-";

const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });

/**
 * A quantity, grouped.
 *
 * The log rejects a non-integer quantity outright - a sum of decimals depends on
 * the order the terms are added, which would let one log produce two different
 * totals - so the fraction digits below never fire against real data. They are
 * here so that if one ever arrives it is shown rather than silently rounded into
 * a number that looks exact and is not.
 */
export function formatQuantity(value: number): string {
  return Number.isFinite(value) ? NUMBER.format(value) : ABSENT;
}

/** The same, signed, for a delta where the sign is the whole message. */
export function formatDelta(value: number): string {
  if (!Number.isFinite(value)) {
    return ABSENT;
  }
  return value > 0 ? `+${formatQuantity(value)}` : formatQuantity(value);
}

/**
 * Whole minor currency units as major units, exactly.
 *
 * The exponent comes from `Intl`, which knows that a yen has none and a dinar has
 * three, and falls back to two for a code it does not recognise. The division is
 * then done by moving the decimal point through the digit string rather than by
 * dividing, so a large total cannot come out a unit short of what was charged.
 */
export function formatAmount(minor: number, currency: string): string {
  if (!Number.isFinite(minor)) {
    return ABSENT;
  }
  const code = currency.trim().toUpperCase();
  const digits = currencyDigits(code);
  const sign = minor < 0 ? "-" : "";
  const rounded = String(Math.abs(Math.trunc(minor))).padStart(digits + 1, "0");
  const whole = digits === 0 ? rounded : rounded.slice(0, -digits);
  const fraction = digits === 0 ? "" : `.${rounded.slice(-digits)}`;
  return `${sign}${group(whole)}${fraction} ${code}`;
}

/** The same, signed. */
export function formatAmountDelta(minor: number, currency: string): string {
  return minor > 0 ? `+${formatAmount(minor, currency)}` : formatAmount(minor, currency);
}

/** An ISO instant as `YYYY-MM-DD HH:MM:SS UTC`, or `-` when there is not one. */
export function formatInstant(value: string | null | undefined): string {
  if (!value) {
    return ABSENT;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return ABSENT;
  }
  return `${parsed.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

const DURATIONS = [
  ["d", 86_400_000],
  ["h", 3_600_000],
  ["m", 60_000],
  ["s", 1000],
] as const;

/** A duration in the largest unit that leaves a number worth reading. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) {
    return ABSENT;
  }
  if (ms < 0) {
    return `-${formatDuration(-ms)}`;
  }
  for (const [suffix, size] of DURATIONS) {
    if (ms >= size) {
      return `${trimZero(ms / size)}${suffix}`;
    }
  }
  return `${Math.round(ms)}ms`;
}

/**
 * A digest or a key, short enough for a table cell.
 *
 * Only ever beside the full value, never instead of it: a digest is the thing an
 * operator is meant to compare against what they stored, and a screen that only
 * showed the first few characters of one would be inviting a false match.
 */
export function abbreviate(text: string, keep = 14): string {
  return text.length > keep + 3 ? `${text.slice(0, keep)}...` : text;
}

const currencyDigits = (code: string): number => {
  try {
    return (
      new Intl.NumberFormat("en-US", { currency: code, style: "currency" }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
};

const group = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");

const trimZero = (value: number): string => String(Math.round(value * 10) / 10);
