import { describe, expect, it } from "vitest";
import raw from "../../src/games/catalog.json" with { type: "json" };
import { catalog } from "../../src/games/catalog.js";

describe("catalog", () => {
  it("lists the starred games first, in order", () => {
    const c = catalog();
    expect(c.slice(0, 3).map((e) => [e.game, e.appId, e.star])).toEqual([
      ["palworld", 2394010, true],
      ["valheim", 896660, true],
      ["minecraft", null, true],
    ]);
  });

  it("follows with the generated entries sorted by name, as basic games", () => {
    const rest = catalog().slice(3);
    expect(rest.length).toBe(raw.entries.length);
    expect(rest.length).toBeGreaterThan(0);
    for (const e of rest) {
      expect(e.game).toBe("basic");
      expect(e.star).toBe(false);
      expect(Number.isInteger(e.appId) && (e.appId as number) > 0).toBe(true);
    }
    const names = rest.map((e) => e.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it("has no duplicate app ids", () => {
    const ids = catalog().map((e) => e.appId).filter((a) => a !== null);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("credits LinuxGSM", () => {
    expect(raw.source).toMatch(/LinuxGSM/);
  });
});
