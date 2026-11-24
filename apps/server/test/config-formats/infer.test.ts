import { describe, expect, it } from "vitest";
import { inferType } from "../../src/config-formats/infer.js";

describe("inferType", () => {
  it.each([
    [true, "switch"], [false, "switch"], ["true", "switch"], ["false", "switch"], ["True", "switch"], ["False", "switch"],
    [5, "number"], [-1.5, "number"], ["42", "number"], ["-3", "number"], ["1.000000", "number"],
    ["None", "text"], ["TRUE", "text"], ["abc", "text"], ["1.", "text"], ["", "text"],
  ] as const)("%j -> %s", (v, t) => expect(inferType(v)).toBe(t));
});
