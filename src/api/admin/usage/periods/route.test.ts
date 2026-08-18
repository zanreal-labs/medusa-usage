import type { MedusaRequest } from "@medusajs/framework/http";
import { describe, expect, it, vi } from "vitest";
import { periodIdFor } from "../../../../lib/billing/period";
import { mockResponse } from "../../../__tests__/mock-response";
import { GET, POST } from "./route";

const FROM = new Date("2026-08-01T00:00:00.000Z");
const TO = new Date("2026-09-01T00:00:00.000Z");

const period = (closedAt: Date | null = null) => ({
  closedAt,
  createdAt: FROM,
  endsAt: TO,
  id: periodIdFor("cus_01", FROM, TO),
  startsAt: FROM,
  subject: "cus_01",
});

const request = (
  parts: { query?: Record<string, unknown>; body?: Record<string, unknown> },
  service: unknown,
): MedusaRequest =>
  ({
    body: parts.body ?? {},
    params: {},
    query: parts.query ?? {},
    scope: { resolve: vi.fn().mockReturnValue(service) },
  }) as unknown as MedusaRequest;

describe("GET /admin/usage/periods", () => {
  it("lists the periods that have not been billed", async () => {
    const usage = { listPeriods: vi.fn().mockResolvedValue([period()]) };
    const res = mockResponse();

    await GET(request({ query: { status: "open", subject: "cus_01" } }, usage), res);

    expect(usage.listPeriods).toHaveBeenCalledWith({
      endedBefore: null,
      limit: 50,
      status: "open",
      subject: "cus_01",
    });
    expect(res.json).toHaveBeenCalledWith({
      periods: [
        {
          closed_at: null,
          created_at: "2026-08-01T00:00:00.000Z",
          ends_at: "2026-09-01T00:00:00.000Z",
          id: periodIdFor("cus_01", FROM, TO),
          starts_at: "2026-08-01T00:00:00.000Z",
          subject: "cus_01",
        },
      ],
    });
  });

  it("takes the billing run's query: over, and not closed", async () => {
    const usage = { listPeriods: vi.fn().mockResolvedValue([]) };

    await GET(
      request({ query: { ended_before: "2026-09-01T00:00:00Z", status: "open" } }, usage),
      mockResponse(),
    );

    expect(usage.listPeriods).toHaveBeenCalledWith(
      expect.objectContaining({ endedBefore: TO, status: "open" }),
    );
  });

  it("refuses a status that is not one", async () => {
    const usage = { listPeriods: vi.fn() };
    await expect(
      GET(request({ query: { status: "billed" } }, usage), mockResponse()),
    ).rejects.toThrow(/must be "open" or "closed"/u);
  });

  it("refuses a limit that is not a whole number", async () => {
    await expect(
      GET(request({ query: { limit: "lots" } }, { listPeriods: vi.fn() }), mockResponse()),
    ).rejects.toThrow(/whole number/u);
  });

  it("refuses an instant that is not one", async () => {
    await expect(
      GET(request({ query: { ended_before: "soon" } }, { listPeriods: vi.fn() }), mockResponse()),
    ).rejects.toThrow(/not an ISO 8601 instant/u);
  });
});

describe("POST /admin/usage/periods", () => {
  it("opens a period from the admin API's spelling of a window", async () => {
    const usage = { openPeriod: vi.fn().mockResolvedValue(period()) };
    const res = mockResponse();

    await POST(
      request(
        {
          body: {
            ends_at: "2026-09-01T00:00:00Z",
            starts_at: "2026-08-01T00:00:00Z",
            subject: "cus_01",
          },
        },
        usage,
      ),
      res,
    );

    expect(usage.openPeriod).toHaveBeenCalledWith({
      endsAt: TO,
      startsAt: FROM,
      subject: "cus_01",
    });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ closed_at: null }));
  });

  it("refuses a body with no subject", async () => {
    await expect(
      POST(
        request({ body: { ends_at: "2026-09-01T00:00:00Z", starts_at: "2026-08-01T00:00:00Z" } }, {
          openPeriod: vi.fn(),
        }),
        mockResponse(),
      ),
    ).rejects.toThrow(/`subject` is required/u);
  });
});
