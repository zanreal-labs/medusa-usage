import type { MedusaRequest } from "@medusajs/framework/http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockResponse } from "../../../__tests__/mock-response";

/**
 * The route runs the workflow rather than touching the module, so the workflow is
 * what gets faked here. `vi.hoisted` because `vi.mock` is lifted above the
 * imports, and the factory has to be able to see the double it returns.
 */
const { run } = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock("../../../../workflows/record-usage", () => ({
  recordUsageWorkflow: () => ({ run }),
}));

import { GET, POST } from "./route";

const request = (options: {
  body?: Record<string, unknown>;
  query?: Record<string, unknown>;
  service?: unknown;
}): MedusaRequest =>
  ({
    body: options.body ?? {},
    params: {},
    query: options.query ?? {},
    scope: { resolve: vi.fn().mockReturnValue(options.service) },
  }) as unknown as MedusaRequest;

beforeEach(() => {
  run.mockReset();
  run.mockResolvedValue({
    result: { accepted: 1, buffered: 1, deduplicated: 0, keys: ["uev_1"], written: null },
  });
});

describe("POST /admin/usage/events", () => {
  it("accepts a batch under `events`", async () => {
    const events = [{ meter: "api_request", quantity: 1, subject: "cus_01" }];
    const res = mockResponse();

    await POST(request({ body: { events } }), res);

    expect(run).toHaveBeenCalledWith({ input: { events } });
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ keys: ["uev_1"] }));
  });

  it("accepts a single event as the body", async () => {
    const event = { meter: "api_request", quantity: 1, subject: "cus_01" };
    await POST(request({ body: event }), mockResponse());
    expect(run).toHaveBeenCalledWith({ input: { events: [event] } });
  });

  it("returns the derived keys, so a client can retry without double counting", async () => {
    const res = mockResponse();
    await POST(request({ body: { meter: "m", quantity: 1, subject: "s" } }), res);
    expect(res.json.mock.calls[0][0].keys).toEqual(["uev_1"]);
  });

  it("refuses an `events` that is not an array", async () => {
    await expect(POST(request({ body: { events: "one" } }), mockResponse())).rejects.toThrow(
      /must be an array/u,
    );
  });

  it("refuses a body that is neither", async () => {
    await expect(POST(request({ body: {} }), mockResponse())).rejects.toThrow(
      /send one usage event/u,
    );
  });
});

describe("GET /admin/usage/events", () => {
  const service = () => ({
    listEvents: vi.fn().mockResolvedValue({
      events: [
        {
          key: "uev_1",
          meter: "api_request",
          occurredAt: new Date("2026-08-18T09:15:00.000Z"),
          properties: null,
          quantity: 3,
          recordedAt: new Date("2026-08-18T09:16:00.000Z"),
          source: null,
          subject: "cus_01",
        },
      ],
      nextCursor: "abc",
    }),
  });

  const query = {
    from: "2026-08-01T00:00:00Z",
    meter: "api_request",
    to: "2026-09-01T00:00:00Z",
  };

  it("returns the events behind an aggregate", async () => {
    const usage = service();
    const res = mockResponse();

    await GET(request({ query, service: usage }), res);

    expect(usage.listEvents).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50, meter: "api_request" }),
    );
    expect(res.json).toHaveBeenCalledWith({
      events: [
        {
          key: "uev_1",
          meter: "api_request",
          occurred_at: "2026-08-18T09:15:00.000Z",
          properties: null,
          quantity: 3,
          recorded_at: "2026-08-18T09:16:00.000Z",
          source: null,
          subject: "cus_01",
        },
      ],
      next_cursor: "abc",
    });
  });

  it("refuses a query that is missing a bound", async () => {
    await expect(
      GET(request({ query: { meter: "api_request" }, service: service() }), mockResponse()),
    ).rejects.toThrow(/`from` is required/u);
  });
});
