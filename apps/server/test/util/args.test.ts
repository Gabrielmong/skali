import { describe, expect, it } from "vitest";
import { splitArgs } from "../../src/util/args.js";

describe("splitArgs", () => {
  it("splits on whitespace, groups quotes, unescapes \\\"", () => {
    expect(splitArgs('-a "b c" -d\\"e')).toEqual(["-a", "b c", "-d\"e"]);
  });
  it("handles empty input and extra spaces", () => {
    expect(splitArgs("")).toEqual([]);
    expect(splitArgs("  a   b ")).toEqual(["a", "b"]);
  });
});
