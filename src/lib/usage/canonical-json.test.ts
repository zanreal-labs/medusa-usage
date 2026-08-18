import { describe, expect, it } from "vitest";
import { canonicalJson, CanonicalJsonError, isJsonValue } from "./canonical-json";

describe("canonicalJson", () => {
  it("sorts object keys so insertion order cannot change the output", () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it("sorts nested keys too", () => {
    expect(canonicalJson({ outer: { z: 1, a: { y: 2, b: 3 } } })).toBe(
      '{"outer":{"a":{"b":3,"y":2},"z":1}}',
    );
  });

  it("keeps array order, because an array is a sequence", () => {
    expect(canonicalJson([1, 2, 3])).toBe("[1,2,3]");
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
  });

  it("escapes strings exactly as JSON does", () => {
    expect(canonicalJson({ 'quote"': "line\nbreak" })).toBe('{"quote\\"":"line\\nbreak"}');
  });

  it("treats 1 and 1.0 as the same number, because JSON has one number type", () => {
    expect(canonicalJson({ n: 1 })).toBe(canonicalJson({ n: 1.0 }));
  });

  it("rejects non-finite numbers rather than emitting null", () => {
    expect(() => canonicalJson({ n: Number.NaN } as never)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ n: Number.POSITIVE_INFINITY } as never)).toThrow(/finite/u);
  });

  it("rejects undefined rather than dropping the key", () => {
    expect(() => canonicalJson({ a: undefined } as never)).toThrow(/undefined/u);
  });

  it("rejects values with a toJSON of their own, such as Date", () => {
    expect(() => canonicalJson({ at: new Date() } as never)).toThrow(/Date/u);
  });

  it("rejects bigint, symbol and function", () => {
    expect(() => canonicalJson({ n: 1n } as never)).toThrow(/bigint/u);
    expect(() => canonicalJson({ s: Symbol("s") } as never)).toThrow(/symbol/u);
    expect(() => canonicalJson({ f: () => 1 } as never)).toThrow(/function/u);
  });

  it("rejects cycles", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => canonicalJson(cycle as never)).toThrow(/circular/u);
  });

  it("names the offending path", () => {
    expect(() => canonicalJson({ a: { b: [1, undefined] } } as never)).toThrow(/\$\.a\.b\[1\]/u);
  });

  it("allows the same object to appear twice side by side", () => {
    const shared = { a: 1 };
    expect(canonicalJson({ left: shared, right: shared })).toBe(
      '{"left":{"a":1},"right":{"a":1}}',
    );
  });
});

describe("isJsonValue", () => {
  it("accepts the JSON value space", () => {
    expect(isJsonValue({ a: [1, "two", true, null] })).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isJsonValue({ at: new Date() })).toBe(false);
    expect(isJsonValue(undefined)).toBe(false);
  });
});
