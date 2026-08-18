import type { MedusaRequest } from "@medusajs/framework/http";
import { describe, expect, it, vi } from "vitest";
import { mockResponse } from "../../__tests__/mock-response";
import { GET } from "./route";

const request = (service: unknown): MedusaRequest =>
  ({
    body: {},
    params: {},
    query: {},
    scope: { resolve: vi.fn().mockReturnValue(service) },
  }) as unknown as MedusaRequest;

describe("GET /admin/usage", () => {
  it("reports what an operator needs to diagnose a wrong-looking meter", async () => {
    const usage = {
      getStatus: vi.fn().mockResolvedValue({
        batchSize: 500,
        buffered: 12,
        flushIntervalMs: 5000,
        flushMode: "buffered",
        lastFlushAt: "2026-08-18T09:15:00.000Z",
        lastFlushError: "connection refused",
        oldestBufferedMs: 900,
        sink: "postgres",
        sinks: ["postgres"],
      }),
    };
    const res = mockResponse();

    await GET(request(usage), res);

    expect(res.json).toHaveBeenCalledWith({
      batch_size: 500,
      buffered: 12,
      flush_interval_ms: 5000,
      flush_mode: "buffered",
      last_flush_at: "2026-08-18T09:15:00.000Z",
      last_flush_error: "connection refused",
      oldest_buffered_ms: 900,
      sink: "postgres",
      sinks: ["postgres"],
    });
  });
});
