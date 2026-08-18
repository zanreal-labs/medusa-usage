import { describe, expect, it } from "vitest";
import { parseAggregateQuery, parseListQuery } from "./query";

const base = {
  from: "2026-08-01T00:00:00Z",
  meter: "api_request",
  to: "2026-09-01T00:00:00Z",
};

describe("parseAggregateQuery", () => {
  it("parses the window and the meter", () => {
    expect(parseAggregateQuery(base)).toEqual({
      from: new Date("2026-08-01T00:00:00Z"),
      meter: "api_request",
      properties: null,
      subject: null,
      to: new Date("2026-09-01T00:00:00Z"),
    });
  });

  it("requires a meter and both bounds", () => {
    expect(() => parseAggregateQuery({ ...base, meter: "" })).toThrow(/`meter` is required/u);
    expect(() => parseAggregateQuery({ from: base.from, meter: base.meter })).toThrow(
      /`to` is required/u,
    );
  });

  it("names the parameter that failed to parse", () => {
    expect(() => parseAggregateQuery({ ...base, from: "last tuesday" })).toThrow(
      /`from` is not an ISO 8601 instant/u,
    );
  });

  it("treats a blank subject as every subject", () => {
    expect(parseAggregateQuery({ ...base, subject: "  " }).subject).toBeNull();
  });

  it("parses dimensions from JSON", () => {
    expect(parseAggregateQuery({ ...base, properties: '{"region":"eu"}' }).properties).toEqual({
      region: "eu",
    });
  });

  it("accepts dimensions already parsed by the framework", () => {
    expect(parseAggregateQuery({ ...base, properties: { region: "eu" } }).properties).toEqual({
      region: "eu",
    });
  });

  it("collapses an empty dimension filter", () => {
    expect(parseAggregateQuery({ ...base, properties: "{}" }).properties).toBeNull();
  });

  it("refuses a dimension filter that is not a flat bag of scalars", () => {
    expect(() => parseAggregateQuery({ ...base, properties: '{"a":{"b":1}}' })).toThrow(
      /not a query language/u,
    );
    expect(() => parseAggregateQuery({ ...base, properties: "[1]" })).toThrow(/JSON object/u);
    expect(() => parseAggregateQuery({ ...base, properties: "{oops" })).toThrow(/JSON object/u);
  });
});

describe("parseListQuery", () => {
  it("defaults the page size", () => {
    expect(parseListQuery(base, 50).limit).toBe(50);
  });

  it("takes a limit from the query string", () => {
    expect(parseListQuery({ ...base, limit: "10" }, 50).limit).toBe(10);
  });

  it("refuses a limit that is not a whole positive number", () => {
    expect(() => parseListQuery({ ...base, limit: "0" }, 50)).toThrow(/`limit`/u);
    expect(() => parseListQuery({ ...base, limit: "many" }, 50)).toThrow(/`limit`/u);
  });

  it("passes a cursor through", () => {
    expect(parseListQuery({ ...base, cursor: "abc" }, 50).cursor).toBe("abc");
  });
});
