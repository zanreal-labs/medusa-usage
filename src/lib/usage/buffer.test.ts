import { describe, expect, it } from "vitest";
import { shouldFlush, UsageBuffer } from "./buffer";
import type { UsageEvent } from "./event";
import { normalizeUsageEvent } from "./event";

const NOW = new Date("2026-08-18T09:15:00.000Z");

const event = (overrides: Record<string, unknown> = {}): UsageEvent =>
  normalizeUsageEvent(
    { meter: "api_request", quantity: 1, subject: "cus_01", ...overrides },
    NOW,
  );

describe("UsageBuffer.add", () => {
  it("queues events", () => {
    const buffer = new UsageBuffer();
    expect(buffer.add([event({ quantity: 1 }), event({ quantity: 2 })], 0)).toEqual({
      deduplicated: 0,
      queued: 2,
    });
    expect(buffer.size).toBe(2);
  });

  it("drops a duplicate key without a database round trip", () => {
    const buffer = new UsageBuffer();
    buffer.add([event()], 0);
    expect(buffer.add([event()], 5)).toEqual({ deduplicated: 1, queued: 1 });
  });

  it("keeps the first copy, so its place in the queue is not lost", () => {
    const buffer = new UsageBuffer();
    const first = event({ quantity: 1 });
    const second = event({ quantity: 2 });
    buffer.add([first, second], 0);
    buffer.add([first], 10);
    expect(buffer.takeBatch(10)).toEqual([first, second]);
  });

  it("starts the age clock at the first admission, not the last", () => {
    const buffer = new UsageBuffer();
    buffer.add([event({ quantity: 1 })], 1000);
    buffer.add([event({ quantity: 2 })], 4000);
    expect(buffer.ageMs(5000)).toBe(4000);
  });

  it("reports no age when empty", () => {
    expect(new UsageBuffer().ageMs(5000)).toBe(0);
  });
});

describe("UsageBuffer.takeBatch", () => {
  it("takes the oldest events first", () => {
    const buffer = new UsageBuffer();
    const events = [1, 2, 3].map((quantity) => event({ quantity }));
    buffer.add(events, 0);
    expect(buffer.takeBatch(2)).toEqual([events[0], events[1]]);
    expect(buffer.size).toBe(1);
  });

  it("removes what it takes, so an in-flight write is not written twice", () => {
    const buffer = new UsageBuffer();
    buffer.add([event()], 0);
    buffer.takeBatch(10);
    expect(buffer.size).toBe(0);
    expect(buffer.takeBatch(10)).toEqual([]);
  });

  it("clears the age clock when it empties the buffer", () => {
    const buffer = new UsageBuffer();
    buffer.add([event()], 1000);
    buffer.takeBatch(10);
    expect(buffer.ageMs(9000)).toBe(0);
  });
});

describe("UsageBuffer.requeue", () => {
  it("puts a failed batch back in front of newer events", () => {
    const buffer = new UsageBuffer();
    const older = [1, 2].map((quantity) => event({ quantity }));
    buffer.add(older, 0);
    const batch = buffer.takeBatch(10);
    const newer = event({ quantity: 3 });
    buffer.add([newer], 10);
    buffer.requeue(batch, 20);
    expect(buffer.takeBatch(10)).toEqual([older[0], older[1], newer]);
  });

  it("does not restore an event that arrived again while the write was in flight", () => {
    const buffer = new UsageBuffer();
    const original = event();
    buffer.add([original], 0);
    const batch = buffer.takeBatch(10);
    buffer.add([event()], 10);
    buffer.requeue(batch, 20);
    expect(buffer.size).toBe(1);
  });

  it("does not let a repeatedly failing batch push its own deadline out", () => {
    const buffer = new UsageBuffer();
    buffer.add([event()], 1000);
    const batch = buffer.takeBatch(10);
    buffer.requeue(batch, 9000);
    expect(buffer.ageMs(9000)).toBe(8000);
  });

  it("ignores an empty requeue", () => {
    const buffer = new UsageBuffer();
    buffer.requeue([], 0);
    expect(buffer.size).toBe(0);
  });
});

describe("shouldFlush", () => {
  const policy = { batchSize: 100, flushIntervalMs: 5000 };

  it("never flushes an empty buffer", () => {
    expect(shouldFlush({ ageMs: 60_000, size: 0 }, policy)).toBe(false);
  });

  it("flushes on batch size", () => {
    expect(shouldFlush({ ageMs: 0, size: 100 }, policy)).toBe(true);
  });

  it("flushes on age, however few events are waiting", () => {
    expect(shouldFlush({ ageMs: 5000, size: 1 }, policy)).toBe(true);
  });

  it("waits when neither trigger is met", () => {
    expect(shouldFlush({ ageMs: 4999, size: 99 }, policy)).toBe(false);
  });
});
