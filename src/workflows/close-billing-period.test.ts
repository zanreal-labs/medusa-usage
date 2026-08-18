import type { MedusaContainer } from "@medusajs/framework/types";
import { describe, expect, it, vi } from "vitest";
import type { ClosedPeriod, PeriodResult } from "../lib/billing/result";
import {
  PERIOD_CLOSED_EVENT,
  runCloseBillingPeriod,
  runEmitPeriodClosed,
} from "./close-billing-period";

const result = (overrides: Partial<PeriodResult> = {}): PeriodResult =>
  ({
    closedAt: "2026-09-01T02:00:00.000Z",
    currency: "PLN",
    digest: "uper_abc",
    eventCount: 3,
    from: "2026-08-01T00:00:00.000Z",
    lines: [],
    periodId: "ubp_01",
    sink: "postgres",
    subject: "cus_01",
    to: "2026-09-01T00:00:00.000Z",
    total: 1730,
    version: 1,
    ...overrides,
  }) as PeriodResult;

const closed = (alreadyClosed: boolean, overrides: Partial<PeriodResult> = {}): ClosedPeriod => ({
  alreadyClosed,
  result: result(overrides),
});

const containerWith = (eventBus: unknown) =>
  ({
    resolve: vi.fn((key: string) => {
      if (key === "event_bus" && eventBus) {
        return eventBus;
      }
      throw new Error(`nothing registered for ${key}`);
    }),
  }) as unknown as MedusaContainer;

describe("runCloseBillingPeriod", () => {
  it("hands the target straight to the module", async () => {
    const usage = { closePeriod: vi.fn(async () => closed(false)) };
    await runCloseBillingPeriod({ periodId: "ubp_01" }, usage);

    expect(usage.closePeriod).toHaveBeenCalledWith({ periodId: "ubp_01" });
  });
});

describe("runEmitPeriodClosed", () => {
  it("announces a period that this call closed", async () => {
    const eventBus = { emit: vi.fn(async () => undefined) };
    const emitted = await runEmitPeriodClosed(closed(false), containerWith(eventBus));

    expect(emitted).toBe(true);
    expect(eventBus.emit).toHaveBeenCalledWith({
      data: {
        currency: "PLN",
        digest: "uper_abc",
        from: "2026-08-01T00:00:00.000Z",
        id: "ubp_01",
        subject: "cus_01",
        to: "2026-09-01T00:00:00.000Z",
        total: 1730,
      },
      name: PERIOD_CLOSED_EVENT,
    });
  });

  /**
   * The reason a host's subscriber does not have to deduplicate: it is not called
   * twice. A retried job reaches a period that is already closed and says nothing.
   */
  it("says nothing about a period that was already closed", async () => {
    const eventBus = { emit: vi.fn(async () => undefined) };
    const emitted = await runEmitPeriodClosed(closed(true), containerWith(eventBus));

    expect(emitted).toBe(false);
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it("carries the period's identity and total, and never the whole result", async () => {
    const eventBus = { emit: vi.fn(async () => undefined) };
    await runEmitPeriodClosed(closed(false), containerWith(eventBus));

    const [event] = eventBus.emit.mock.calls[0] as unknown as [{ data: Record<string, unknown> }];
    expect(event.data).not.toHaveProperty("lines");
  });

  it("announces an empty period too, so a host can decide not to bill it", async () => {
    const eventBus = { emit: vi.fn(async () => undefined) };
    await runEmitPeriodClosed(closed(false, { eventCount: 0, total: 0 }), containerWith(eventBus));

    const [event] = eventBus.emit.mock.calls[0] as unknown as [{ data: { total: number } }];
    expect(event.data.total).toBe(0);
  });

  /**
   * A period that closed correctly must not be reported as a failure because
   * there was nobody to tell - the module is usable from a script or a test.
   */
  it("closes cleanly in an application with no event bus", async () => {
    await expect(runEmitPeriodClosed(closed(false), containerWith(null))).resolves.toBe(false);
  });
});
