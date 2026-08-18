import type { MedusaContainer } from "@medusajs/framework/types";
import { describe, expect, it, vi } from "vitest";
import usageFlushJob, { config } from "./usage-flush";

const logger = () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() });

const container = (usage: unknown, log: ReturnType<typeof logger>): MedusaContainer =>
  ({
    resolve: vi.fn((key: string) => (key === "usage" ? usage : log)),
  }) as unknown as MedusaContainer;

const summary = (overrides: Record<string, number> = {}) => ({
  appended: 3,
  batches: 1,
  duplicates: 0,
  submitted: 3,
  ...overrides,
});

describe("usageFlushJob", () => {
  it("flushes the buffer", async () => {
    const usage = { flush: vi.fn().mockResolvedValue(summary()) };
    await usageFlushJob(container(usage, logger()));
    expect(usage.flush).toHaveBeenCalledTimes(1);
  });

  it("says nothing when there was nothing to write", async () => {
    const log = logger();
    const usage = { flush: vi.fn().mockResolvedValue(summary({ batches: 0, submitted: 0 })) };
    await usageFlushJob(container(usage, log));
    expect(log.info).not.toHaveBeenCalled();
  });

  it("reports what it wrote", async () => {
    const log = logger();
    const usage = { flush: vi.fn().mockResolvedValue(summary({ appended: 2, duplicates: 1 })) };
    await usageFlushJob(container(usage, log));
    expect(log.info).toHaveBeenCalledWith(expect.stringMatching(/wrote 3 buffered events/u));
  });

  it("warns rather than failing the run, because the events are still queued", async () => {
    const log = logger();
    const usage = { flush: vi.fn().mockRejectedValue(new Error("connection refused")) };

    await expect(usageFlushJob(container(usage, log))).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/still queued/u));
  });
});

describe("config", () => {
  it("runs every minute by default", () => {
    expect(config.schedule).toBe("* * * * *");
  });

  it("is named after the file", () => {
    expect(config.name).toBe("usage-flush");
  });
});
