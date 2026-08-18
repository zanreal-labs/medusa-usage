import type { MedusaRequest } from "@medusajs/framework/http";
import { describe, expect, it, vi } from "vitest";
import { mockResponse } from "../../../__tests__/mock-response";
import { GET } from "./route";

const snapshot = {
  computedAt: "2026-09-02T10:00:00.000Z",
  digest: "usnap_abc",
  eventCount: 2,
  firstOccurredAt: "2026-08-02T00:00:00.000Z",
  from: "2026-08-01T00:00:00.000Z",
  lastOccurredAt: "2026-08-30T00:00:00.000Z",
  meter: "api_request",
  properties: null,
  sink: "postgres",
  subject: "cus_01",
  to: "2026-09-01T00:00:00.000Z",
  total: 8,
  version: 1,
};

const request = (query: Record<string, unknown>, service: unknown): MedusaRequest =>
  ({
    body: {},
    params: {},
    query,
    scope: { resolve: vi.fn().mockReturnValue(service) },
  }) as unknown as MedusaRequest;

const query = {
  from: "2026-08-01T00:00:00Z",
  meter: "api_request",
  subject: "cus_01",
  to: "2026-09-01T00:00:00Z",
};

describe("GET /admin/usage/aggregate", () => {
  it("returns the snapshot verbatim, so a host can store the body as it stands", async () => {
    const usage = { aggregate: vi.fn().mockResolvedValue(snapshot) };
    const res = mockResponse();

    await GET(request(query, usage), res);

    expect(usage.aggregate).toHaveBeenCalledWith({
      from: new Date("2026-08-01T00:00:00Z"),
      meter: "api_request",
      properties: null,
      subject: "cus_01",
      to: new Date("2026-09-01T00:00:00Z"),
    });
    expect(res.json).toHaveBeenCalledWith(snapshot);
  });

  it("passes a dimension filter through", async () => {
    const usage = { aggregate: vi.fn().mockResolvedValue(snapshot) };
    await GET(request({ ...query, properties: '{"region":"eu"}' }, usage), mockResponse());
    expect(usage.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({ properties: { region: "eu" } }),
    );
  });

  it("refuses an incomplete window before touching the module", async () => {
    const usage = { aggregate: vi.fn() };
    await expect(
      GET(request({ meter: "api_request" }, usage), mockResponse()),
    ).rejects.toThrow(/`from` is required/u);
    expect(usage.aggregate).not.toHaveBeenCalled();
  });
});
