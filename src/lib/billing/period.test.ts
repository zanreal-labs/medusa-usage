import { describe, expect, it } from "vitest";
import type { BillingPeriod } from "./period";
import {
  assertClosable,
  assertPeriodWindow,
  parsePeriodTarget,
  parsePeriodWindow,
  periodIdFor,
  serializePeriod,
} from "./period";

const AUGUST = {
  from: new Date("2026-08-01T00:00:00.000Z"),
  to: new Date("2026-09-01T00:00:00.000Z"),
};

const period = (overrides: Partial<BillingPeriod> = {}): BillingPeriod => ({
  closedAt: null,
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
  endsAt: AUGUST.to,
  id: periodIdFor("cus_01", AUGUST.from, AUGUST.to),
  startsAt: AUGUST.from,
  subject: "cus_01",
  ...overrides,
});

describe("periodIdFor", () => {
  /**
   * The pinned vector, for the same reason the deduplication key has one. Moving
   * it would mean every period already opened stops matching the id the same
   * period derives today, so a closed period would look open and could be billed
   * a second time.
   */
  it("derives the documented id", () => {
    expect(periodIdFor("cus_01", AUGUST.from, AUGUST.to)).toBe(
      "ubp_4ddb0a0076cf06a767a38993edf3527b2eba31376d58f60bf4af6e50ba2bca9d",
    );
  });

  it("is the same id whenever and wherever it is derived", () => {
    expect(periodIdFor("cus_01", AUGUST.from, AUGUST.to)).toBe(
      periodIdFor("cus_01", new Date(AUGUST.from.getTime()), new Date(AUGUST.to.getTime())),
    );
  });

  it("gives two subjects two periods over the same window", () => {
    expect(periodIdFor("cus_01", AUGUST.from, AUGUST.to)).not.toBe(
      periodIdFor("cus_02", AUGUST.from, AUGUST.to),
    );
  });

  it("makes a boundary that moved by a millisecond a different period", () => {
    expect(periodIdFor("cus_01", AUGUST.from, AUGUST.to)).not.toBe(
      periodIdFor("cus_01", AUGUST.from, new Date(AUGUST.to.getTime() + 1)),
    );
  });

  /** The join is a unit separator, so no subject can fake a different window. */
  it("cannot be confused by a subject that looks like the rest of the material", () => {
    expect(periodIdFor("cus_01\u001F2026-08-01T00:00:00.000Z", AUGUST.from, AUGUST.to)).not.toBe(
      periodIdFor("cus_01", AUGUST.from, AUGUST.to),
    );
  });
});

describe("assertPeriodWindow", () => {
  it("accepts a window with room in it", () => {
    expect(() => assertPeriodWindow(AUGUST.from, AUGUST.to)).not.toThrow();
  });

  it("refuses an inverted or empty window, exactly as an aggregate does", () => {
    expect(() => assertPeriodWindow(AUGUST.to, AUGUST.from)).toThrow(/empty or inverted/u);
    expect(() => assertPeriodWindow(AUGUST.from, AUGUST.from)).toThrow(/empty or inverted/u);
  });
});

describe("assertClosable", () => {
  it("allows closing the instant the window is over", () => {
    expect(() => assertClosable(period(), AUGUST.to, 0)).not.toThrow();
  });

  it("refuses to freeze a period that is still accruing", () => {
    expect(() =>
      assertClosable(period(), new Date("2026-08-31T23:59:59.999Z"), 0),
    ).toThrow(/cannot be closed until/u);
  });

  it("holds a period open for the configured settling delay", () => {
    const hour = 60 * 60 * 1000;
    expect(() => assertClosable(period(), AUGUST.to, hour)).toThrow(/closeDelayMs/u);
    expect(() =>
      assertClosable(period(), new Date(AUGUST.to.getTime() + hour), hour),
    ).not.toThrow();
  });
});

describe("parsePeriodWindow", () => {
  it("takes the admin API's spelling", () => {
    expect(
      parsePeriodWindow({
        ends_at: "2026-09-01T00:00:00Z",
        starts_at: "2026-08-01T00:00:00Z",
        subject: "cus_01",
      }),
    ).toEqual({ endsAt: AUGUST.to, startsAt: AUGUST.from, subject: "cus_01" });
  });

  it("takes the module's spelling too, so a caller cannot get it subtly wrong", () => {
    expect(
      parsePeriodWindow({ endsAt: AUGUST.to, startsAt: AUGUST.from, subject: "cus_01" }),
    ).toEqual({ endsAt: AUGUST.to, startsAt: AUGUST.from, subject: "cus_01" });
  });

  it("refuses a period with no subject", () => {
    expect(() =>
      parsePeriodWindow({ ends_at: "2026-09-01T00:00:00Z", starts_at: "2026-08-01T00:00:00Z" }),
    ).toThrow(/`subject` is required/u);
  });

  it("refuses a bare number, which is a seconds-or-milliseconds guess", () => {
    expect(() =>
      parsePeriodWindow({ ends_at: 1_788_000_000, starts_at: 1_785_000_000, subject: "cus_01" }),
    ).toThrow(/ambiguous between seconds and milliseconds/u);
  });

  it("refuses an instant that is not one", () => {
    expect(() =>
      parsePeriodWindow({ ends_at: "next tuesday", starts_at: "2026-08-01T00:00:00Z", subject: "c" }),
    ).toThrow(/not an ISO 8601 instant/u);
  });

  it("refuses an inverted window before anything is derived from it", () => {
    expect(() =>
      parsePeriodWindow({
        ends_at: "2026-08-01T00:00:00Z",
        starts_at: "2026-09-01T00:00:00Z",
        subject: "cus_01",
      }),
    ).toThrow(/empty or inverted/u);
  });
});

describe("parsePeriodTarget", () => {
  it("takes an id on its own", () => {
    expect(parsePeriodTarget({ period_id: "ubp_1" })).toEqual({ periodId: "ubp_1" });
    expect(parsePeriodTarget({ id: "ubp_1" })).toEqual({ periodId: "ubp_1" });
  });

  it("falls back to a period described in full", () => {
    expect(
      parsePeriodTarget({
        ends_at: "2026-09-01T00:00:00Z",
        starts_at: "2026-08-01T00:00:00Z",
        subject: "cus_01",
      }),
    ).toEqual({ endsAt: AUGUST.to, startsAt: AUGUST.from, subject: "cus_01" });
  });
});

describe("serializePeriod", () => {
  it("says a period is open by saying nothing closed it", () => {
    expect(serializePeriod(period())).toEqual({
      closed_at: null,
      created_at: "2026-08-01T00:00:00.000Z",
      ends_at: "2026-09-01T00:00:00.000Z",
      id: periodIdFor("cus_01", AUGUST.from, AUGUST.to),
      starts_at: "2026-08-01T00:00:00.000Z",
      subject: "cus_01",
    });
  });

  it("reads closedAt through from the result", () => {
    expect(serializePeriod(period({ closedAt: new Date("2026-09-01T02:00:00.000Z") })).closed_at).toBe(
      "2026-09-01T02:00:00.000Z",
    );
  });
});
