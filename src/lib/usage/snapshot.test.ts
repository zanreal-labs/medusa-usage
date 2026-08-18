import { describe, expect, it } from "vitest";
import type { UsageAggregateQuery, UsageAggregateResult } from "../sink/types";
import { assertUsageWindow, buildUsageSnapshot, SNAPSHOT_VERSION } from "./snapshot";

const query = (overrides: Partial<UsageAggregateQuery> = {}): UsageAggregateQuery => ({
  from: new Date("2026-08-01T00:00:00.000Z"),
  meter: "api_request",
  subject: "cus_01",
  to: new Date("2026-09-01T00:00:00.000Z"),
  ...overrides,
});

const result = (overrides: Partial<UsageAggregateResult> = {}): UsageAggregateResult => ({
  eventCount: 2,
  firstOccurredAt: new Date("2026-08-01T00:00:00.000Z"),
  lastOccurredAt: new Date("2026-08-31T23:59:59.000Z"),
  total: 1500,
  ...overrides,
});

const COMPUTED_AT = new Date("2026-09-02T10:00:00.000Z");

describe("assertUsageWindow", () => {
  it("accepts a window with room in it", () => {
    expect(() =>
      assertUsageWindow(new Date("2026-08-01T00:00:00Z"), new Date("2026-09-01T00:00:00Z")),
    ).not.toThrow();
  });

  it("refuses an inverted window instead of quietly returning zero", () => {
    expect(() =>
      assertUsageWindow(new Date("2026-09-01T00:00:00Z"), new Date("2026-08-01T00:00:00Z")),
    ).toThrow(/empty or inverted/u);
  });

  it("refuses a zero-length window", () => {
    const at = new Date("2026-08-01T00:00:00Z");
    expect(() => assertUsageWindow(at, at)).toThrow(/empty or inverted/u);
  });

  it("refuses a non-date", () => {
    expect(() => assertUsageWindow(new Date("nope"), new Date())).toThrow(/`from` is not a date/u);
    expect(() => assertUsageWindow(new Date(), "soon" as never)).toThrow(/`to` is not a date/u);
  });
});

describe("buildUsageSnapshot", () => {
  it("carries the question and the answer, both", () => {
    const snapshot = buildUsageSnapshot(query(), result(), "postgres", COMPUTED_AT);
    expect(snapshot).toMatchObject({
      eventCount: 2,
      from: "2026-08-01T00:00:00.000Z",
      meter: "api_request",
      sink: "postgres",
      subject: "cus_01",
      to: "2026-09-01T00:00:00.000Z",
      total: 1500,
      version: SNAPSHOT_VERSION,
    });
  });

  it("is frozen, because a snapshot that can be edited proves nothing", () => {
    expect(Object.isFrozen(buildUsageSnapshot(query(), result(), "postgres", COMPUTED_AT))).toBe(
      true,
    );
  });

  /**
   * The pinned digest. It is what a host compares months later to prove the
   * number it billed still comes out of the log. Moving it invalidates every
   * snapshot ever taken, so it changes only alongside `SNAPSHOT_VERSION`.
   */
  it("digests the documented value", () => {
    expect(buildUsageSnapshot(query(), result(), "postgres", COMPUTED_AT).digest).toBe(
      "usnap_c3a62d6318b5bcf22ab541854a901f5dd58594c66d4b055f4475735b5873fdcc",
    );
  });

  it("re-derives the same digest whenever it is recomputed", () => {
    const later = buildUsageSnapshot(
      query(),
      result(),
      "postgres",
      new Date("2027-03-04T00:00:00.000Z"),
    );
    expect(later.digest).toBe(
      buildUsageSnapshot(query(), result(), "postgres", COMPUTED_AT).digest,
    );
  });

  it("re-derives the same digest from a different sink, so a migration stays checkable", () => {
    expect(buildUsageSnapshot(query(), result(), "warehouse", COMPUTED_AT).digest).toBe(
      buildUsageSnapshot(query(), result(), "postgres", COMPUTED_AT).digest,
    );
  });

  it("changes the digest when the total changes", () => {
    expect(buildUsageSnapshot(query(), result({ total: 1501 }), "postgres", COMPUTED_AT).digest,
    ).not.toBe(buildUsageSnapshot(query(), result(), "postgres", COMPUTED_AT).digest);
  });

  it("changes the digest when the same total comes from a different number of events", () => {
    expect(
      buildUsageSnapshot(query(), result({ eventCount: 3 }), "postgres", COMPUTED_AT).digest,
    ).not.toBe(buildUsageSnapshot(query(), result(), "postgres", COMPUTED_AT).digest);
  });

  it("changes the digest when the window moves", () => {
    expect(
      buildUsageSnapshot(
        query({ to: new Date("2026-09-01T00:00:01.000Z") }),
        result(),
        "postgres",
        COMPUTED_AT,
      ).digest,
    ).not.toBe(buildUsageSnapshot(query(), result(), "postgres", COMPUTED_AT).digest);
  });

  it("ignores the order of keys in the dimension filter", () => {
    const left = buildUsageSnapshot(
      query({ properties: { model: "m", region: "eu" } }),
      result(),
      "postgres",
      COMPUTED_AT,
    );
    const right = buildUsageSnapshot(
      query({ properties: { region: "eu", model: "m" } }),
      result(),
      "postgres",
      COMPUTED_AT,
    );
    expect(left.digest).toBe(right.digest);
  });

  it("normalizes an omitted subject to null", () => {
    const snapshot = buildUsageSnapshot(
      query({ subject: undefined }),
      result(),
      "postgres",
      COMPUTED_AT,
    );
    expect(snapshot.subject).toBeNull();
  });

  it("reports an empty window as a zero with no events", () => {
    const snapshot = buildUsageSnapshot(
      query(),
      { eventCount: 0, firstOccurredAt: null, lastOccurredAt: null, total: 0 },
      "postgres",
      COMPUTED_AT,
    );
    expect(snapshot.total).toBe(0);
    expect(snapshot.firstOccurredAt).toBeNull();
  });

  it("refuses a total beyond exact integer arithmetic rather than rounding it", () => {
    expect(() =>
      buildUsageSnapshot(query(), result({ total: 2 ** 53 }), "postgres", COMPUTED_AT),
    ).toThrow(/exact integer arithmetic/u);
  });
});
