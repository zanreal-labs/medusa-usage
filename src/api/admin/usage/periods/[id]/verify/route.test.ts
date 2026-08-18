import type { MedusaRequest } from "@medusajs/framework/http";
import { describe, expect, it, vi } from "vitest";
import { mockResponse } from "../../../../../__tests__/mock-response";
import { GET } from "./route";

const request = (service: unknown): MedusaRequest =>
  ({
    body: {},
    params: { id: "ubp_01" },
    query: {},
    scope: { resolve: vi.fn().mockReturnValue(service) },
  }) as unknown as MedusaRequest;

describe("GET /admin/usage/periods/:id/verify", () => {
  it("serves the re-derivation, whatever it says", async () => {
    const verification = { matches: false, periodId: "ubp_01", totalDelta: 1200 };
    const usage = { verifyPeriod: vi.fn().mockResolvedValue(verification) };
    const res = mockResponse();

    await GET(request(usage), res);

    expect(usage.verifyPeriod).toHaveBeenCalledWith("ubp_01");
    expect(res.json).toHaveBeenCalledWith(verification);
  });
});
