import { describe, expect, it } from "vitest";
import { selectSinkId, sinkRegistrationKey } from "./registry";

describe("sinkRegistrationKey", () => {
  it("namespaces the id", () => {
    expect(sinkRegistrationKey("postgres")).toBe("usage_sink_postgres");
  });
});

describe("selectSinkId", () => {
  it("uses the only registered sink", () => {
    expect(selectSinkId(["postgres"])).toBe("postgres");
  });

  it("uses the named sink", () => {
    expect(selectSinkId(["postgres", "warehouse"], "warehouse")).toBe("warehouse");
  });

  it("refuses to accept usage when nothing is registered", () => {
    expect(() => selectSinkId([])).toThrow(/no usage sink is registered/u);
  });

  it("refuses a name that is not registered, rather than falling back", () => {
    expect(() => selectSinkId(["postgres"], "warehouse")).toThrow(/not registered/u);
    expect(() => selectSinkId(["postgres"], "warehouse")).toThrow(/postgres/u);
  });

  it("refuses to guess between two registered sinks", () => {
    expect(() => selectSinkId(["postgres", "warehouse"])).toThrow(/does not say which one/u);
  });
});
