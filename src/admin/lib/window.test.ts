import { describe, expect, it } from "vitest";
import type { PeriodRow } from "./api";
import { defaultWindow, periodWindow, resolveWindow, toDateInput } from "./window";

const NOW = new Date("2026-08-19T11:39:00.000Z");

describe("defaultWindow", () => {
  it("looks back thirty days and ends tomorrow, because the bound is exclusive", () => {
    // A `to` of today would drop everything recorded since midnight, which on a
    // quiet meter is everything there is.
    expect(defaultWindow(NOW)).toEqual({ from: "2026-07-20", to: "2026-08-20" });
  });
});

describe("toDateInput", () => {
  it("reads the date in UTC, not in whatever zone the browser is in", () => {
    expect(toDateInput(new Date("2026-08-19T23:59:59.999Z"))).toBe("2026-08-19");
  });
});

describe("resolveWindow", () => {
  it("turns two dates into the half-open window the API takes", () => {
    expect(resolveWindow("2026-08-01", "2026-09-01")).toEqual({
      error: null,
      window: { from: "2026-08-01T00:00:00.000Z", to: "2026-09-01T00:00:00.000Z" },
    });
  });

  it("refuses a window that ends before it starts, and says why `to` is exclusive", () => {
    const resolved = resolveWindow("2026-09-01", "2026-08-01");
    expect(resolved.window).toBeNull();
    expect(resolved.error).toMatch(/exclusive/u);
  });

  it("refuses a window of no width, which would always total nothing", () => {
    expect(resolveWindow("2026-08-01", "2026-08-01").window).toBeNull();
  });

  it("refuses anything that is not a date, rather than sending it and failing", () => {
    expect(resolveWindow("", "2026-08-01").error).toMatch(/required/u);
    expect(resolveWindow("01-08-2026", "2026-08-01").window).toBeNull();
  });
});

describe("periodWindow", () => {
  it("uses the period's own instants, unrounded", () => {
    // A period is billed on these to the millisecond. Rounding them to a day here
    // would report a number the invoice does not agree with.
    const period = {
      closed_at: null,
      created_at: "2026-08-01T00:00:00.000Z",
      ends_at: "2026-09-01T00:00:00.000Z",
      id: "ubp_1",
      starts_at: "2026-08-01T09:30:15.250Z",
      subject: "cus_01",
    } satisfies PeriodRow;

    expect(periodWindow(period)).toEqual({
      from: "2026-08-01T09:30:15.250Z",
      to: "2026-09-01T00:00:00.000Z",
    });
  });
});
