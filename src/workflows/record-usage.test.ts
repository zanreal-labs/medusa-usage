import { describe, expect, it, vi } from "vitest";
import { runRecordUsage } from "./record-usage";

const service = (overrides: Record<string, unknown> = {}) => ({
  record: vi.fn().mockResolvedValue({
    accepted: 1,
    buffered: 1,
    deduplicated: 0,
    keys: ["uev_1"],
    written: null,
  }),
  ...overrides,
});

describe("runRecordUsage", () => {
  it("hands the events to the module", async () => {
    const usage = service();
    const events = [{ meter: "api_request", quantity: 1, subject: "cus_01" }];

    const result = await runRecordUsage({ events }, usage);

    expect(usage.record).toHaveBeenCalledWith(events);
    expect(result.keys).toEqual(["uev_1"]);
  });

  it("treats a missing list as an empty one rather than throwing", async () => {
    const usage = service();
    await runRecordUsage({} as never, usage);
    expect(usage.record).toHaveBeenCalledWith([]);
  });

  it("lets a validation failure out, so the caller learns nothing was recorded", async () => {
    const usage = service({
      record: vi.fn().mockRejectedValue(new Error("`quantity` must be a whole number")),
    });
    await expect(
      runRecordUsage({ events: [{ meter: "m", quantity: 1.5, subject: "s" }] }, usage),
    ).rejects.toThrow(/whole number/u);
  });
});
