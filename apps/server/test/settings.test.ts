import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { BadRequestError } from "../src/errors.js";
import { isValidAllowEntry } from "../src/http/allowlist.js";
import { defaultGamesRoot, SettingsStore } from "../src/settings.js";

describe("SettingsStore", () => {
  it("returns defaults and persists updates", () => {
    const db = openDb(":memory:");
    const s = new SettingsStore(db, ["192.168.0.0/24"]);
    expect(s.get()).toEqual({ allowlist: ["192.168.0.0/24"], connectHost: "192.168.0.100", gamesRoot: defaultGamesRoot() });
    expect(s.update({ connectHost: "10.0.0.5", gamesRoot: defaultGamesRoot() })).toEqual({ allowlist: ["192.168.0.0/24"], connectHost: "10.0.0.5", gamesRoot: defaultGamesRoot() });
    expect(new SettingsStore(db, ["x"]).update({ allowlist: ["10.0.0.1"] })).toEqual({ allowlist: ["10.0.0.1"], connectHost: "10.0.0.5", gamesRoot: defaultGamesRoot() });
    expect(new SettingsStore(db, ["x"]).get().allowlist).toEqual(["10.0.0.1"]);
  });
  it("rejects invalid allowlist entries", () => {
    const s = new SettingsStore(openDb(":memory:"), []);
    expect(() => s.update({ allowlist: ["300.1.1.1"] })).toThrow(BadRequestError);
    expect(s.get().allowlist).toEqual([]);
  });
});

describe("gamesRoot", () => {
  it("defaults by whether D: exists", () => {
    expect(defaultGamesRoot(() => true)).toBe("D:\\GameServers");
    expect(defaultGamesRoot(() => false)).toBe("C:\\GameServers");
  });
  it("validates and stores", () => {
    const s = new SettingsStore(openDb(":memory:"), []);
    expect(() => s.update({ gamesRoot: "relative" })).toThrow(new BadRequestError("Games root must be an absolute folder path"));
    expect(() => s.update({ gamesRoot: "C:\\" })).toThrow(BadRequestError);
    expect(() => s.update({ gamesRoot: "C:" })).toThrow(BadRequestError);
    expect(() => s.update({ gamesRoot: 'E:\\Ga"mes' })).toThrow(BadRequestError);
    expect(s.update({ gamesRoot: "E:\\Games" }).gamesRoot).toBe("E:\\Games");
    expect(s.get().gamesRoot).toBe("E:\\Games");
  });
});

describe("isValidAllowEntry", () => {
  it.each(["1.2.3.4", "0.0.0.0", "255.255.255.255", "10.0.0.0/8", "1.2.3.4/0", "1.2.3.4/32"])("accepts %s", (v) => expect(isValidAllowEntry(v)).toBe(true));
  it.each(["300.1.1.1", "1.2.3", "1.2.3.4.5", "1.2.3.4/33", "1.2.3.4/", "1.2.3.4/-1", " 1.2.3.4", "1.2.3.4 ", "1.2.3.4/8/8", "a.b.c.d", "", "1.2.3.4x", "1.2.3.4/08x", "1.2.3.4/08"])("rejects %j", (v) => expect(isValidAllowEntry(v)).toBe(false));
});
