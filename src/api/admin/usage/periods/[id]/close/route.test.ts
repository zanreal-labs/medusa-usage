import type { MedusaRequest } from "@medusajs/framework/http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockResponse } from "../../../../../__tests__/mock-response";

/**
 * The route runs the workflow rather than the module, because the workflow is
 * what announces the close to a host's subscribers. So the workflow is what gets
 * faked here.
 */
const { run } = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock("../../../../../../workflows/close-billing-period", () => ({
  closeBillingPeriodWorkflow: () => ({ run }),
}));

import { POST } from "./route";

const result = { digest: "uper_abc", periodId: "ubp_01", total: 1730, version: 1 };

const request = (): MedusaRequest =>
  ({
    body: {},
    params: { id: "ubp_01" },
    query: {},
    scope: { resolve: vi.fn() },
  }) as unknown as MedusaRequest;

beforeEach(() => {
  run.mockReset();
  run.mockResolvedValue({ result: { alreadyClosed: false, result } });
});

describe("POST /admin/usage/periods/:id/close", () => {
  it("closes the period named in the path", async () => {
    const res = mockResponse();

    await POST(request(), res);

    expect(run).toHaveBeenCalledWith({ input: { periodId: "ubp_01" } });
    expect(res.json).toHaveBeenCalledWith({ already_closed: false, result });
  });

  /** The flag a caller keys an invoice off, carried through unchanged. */
  it("says when the period was already closed, and hands back what it was rated to", async () => {
    run.mockResolvedValue({ result: { alreadyClosed: true, result } });
    const res = mockResponse();

    await POST(request(), res);

    expect(res.json).toHaveBeenCalledWith({ already_closed: true, result });
  });
});
