import type { MedusaRequest } from "@medusajs/framework/http";
import { describe, expect, it, vi } from "vitest";
import { mockResponse } from "../../../../__tests__/mock-response";
import { GET } from "./route";

const period = (closedAt: Date | null = null) => ({
  closedAt,
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
  endsAt: new Date("2026-09-01T00:00:00.000Z"),
  id: "ubp_01",
  startsAt: new Date("2026-08-01T00:00:00.000Z"),
  subject: "cus_01",
});

const request = (service: unknown): MedusaRequest =>
  ({
    body: {},
    params: { id: "ubp_01" },
    query: {},
    scope: { resolve: vi.fn().mockReturnValue(service) },
  }) as unknown as MedusaRequest;

describe("GET /admin/usage/periods/:id", () => {
  it("serves a null result while the period is open", async () => {
    const usage = {
      getPeriod: vi.fn().mockResolvedValue(period()),
      getPeriodResult: vi.fn().mockResolvedValue(null),
    };
    const res = mockResponse();

    await GET(request(usage), res);

    expect(res.json).toHaveBeenCalledWith({
      period: expect.objectContaining({ closed_at: null, id: "ubp_01" }),
      result: null,
    });
  });

  it("serves the frozen result verbatim once it exists", async () => {
    const result = { digest: "uper_abc", periodId: "ubp_01", total: 0, version: 1 };
    const usage = {
      getPeriod: vi.fn().mockResolvedValue(period(new Date("2026-09-01T02:00:00.000Z"))),
      getPeriodResult: vi.fn().mockResolvedValue(result),
    };
    const res = mockResponse();

    await GET(request(usage), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ result }));
  });

  it("says so when there is no such period", async () => {
    const usage = { getPeriod: vi.fn().mockResolvedValue(null), getPeriodResult: vi.fn() };
    await expect(GET(request(usage), mockResponse())).rejects.toThrow(/there is no period/u);
  });
});
