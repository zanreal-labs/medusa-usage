import type { PeriodRow, UsageWindow } from "./api";

/**
 * The window the screen asks its questions about.
 *
 * Every read endpoint in this plugin takes a half-open `[from, to)` and refuses to
 * guess one, which is correct for an API and unhelpful for a screen someone just
 * opened. So the screen picks a defensible default and then says, in the field
 * labels, exactly what it picked - the alternative is an operator who reads a
 * total without knowing what it is a total of.
 *
 * The two fields are dates rather than instants on purpose. A date maps to a UTC
 * midnight, consecutive dates tile without overlapping, and `to` being exclusive
 * is a fact about the plugin the screen has to teach rather than paper over: a
 * window ending on the 1st does not contain the 1st.
 *
 * A period never goes through here. Its boundaries are exact to the millisecond
 * and are what it was, or will be, billed on, so `periodWindow` hands them
 * straight to the aggregate rather than rounding them to a day and reporting a
 * number the invoice will not agree with.
 */

/** How far back the screen looks before anyone has chosen anything. */
export const DEFAULT_WINDOW_DAYS = 30;

const DAY_MS = 86_400_000;

/** A `Date` as the `YYYY-MM-DD` a date input wants, in UTC. */
export function toDateInput(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The window the screen opens with: the last 30 days, up to and including today.
 *
 * `to` is tomorrow, not today, because the bound is exclusive - a `to` of today
 * would silently drop everything recorded since midnight, which on a quiet meter
 * is everything there is.
 */
export function defaultWindow(now: Date): { from: string; to: string } {
  return {
    from: toDateInput(new Date(now.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS)),
    to: toDateInput(new Date(now.getTime() + DAY_MS)),
  };
}

/** What `resolveWindow` decided. Exactly one side is populated. */
export interface ResolvedWindow {
  error: string | null;
  window: UsageWindow | null;
}

/**
 * Two date inputs into the half-open window the API takes.
 *
 * Failures are caught here rather than left to the route because the route's
 * message is written for a machine producer sending a malformed query, and an
 * operator who mistyped a date deserves to be told that instead of watching a
 * request fail.
 */
export function resolveWindow(from: string, to: string): ResolvedWindow {
  const start = instant(from);
  const end = instant(to);

  if (!start || !end) {
    return { error: "Both dates are required, as YYYY-MM-DD.", window: null };
  }
  if (start >= end) {
    return {
      error: "The window ends before it starts. `To` is exclusive, so it must be the day after the last one you want.",
      window: null,
    };
  }
  return { error: null, window: { from: start, to: end } };
}

/** A period's own boundaries, unrounded, as the aggregate endpoint takes them. */
export function periodWindow(period: PeriodRow): UsageWindow {
  return { from: period.starts_at, to: period.ends_at };
}

const instant = (value: string): string | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return null;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};
