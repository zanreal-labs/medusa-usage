import type { MedusaResponse } from "@medusajs/framework/http";
import { vi } from "vitest";

/**
 * A `MedusaResponse` double for route unit tests. `status()` returns the same
 * object so a `res.status(202).json(...)` chain works and both calls stay
 * assertable.
 */
export const mockResponse = () => {
  const res = { json: vi.fn(), send: vi.fn(), setHeader: vi.fn(), status: vi.fn() };
  res.status.mockReturnValue(res);
  res.send.mockReturnValue(res);
  return res as unknown as MedusaResponse & {
    json: ReturnType<typeof vi.fn>;
    status: ReturnType<typeof vi.fn>;
  };
};
