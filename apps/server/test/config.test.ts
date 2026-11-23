import { describe, expect, it } from "vitest";
import { dataPaths, loadConfig } from "../src/config.js";

describe("config", () => {
  it("defaults", () => {
    const c = loadConfig({});
    expect(c.dataDir).toBe("C:\\ProgramData\\Skali");
    expect(c.port).toBe(4100);
    expect(c.runAsCurrentUser).toBe(false);
    expect(c.initialAllowlist).toEqual(["192.168.0.150"]);
    expect(c.helperPath).toMatch(/tools[\\/]SkaliHelper[\\/]publish[\\/]SkaliHelper\.exe$/);
  });
  it("env overrides", () => {
    const c = loadConfig({ SKALI_DATA_DIR: "D:\\x", SKALI_PORT: "5000", SKALI_RUN_AS_CURRENT_USER: "1", SKALI_INITIAL_ALLOWLIST: "10.0.0.5, 10.0.0.0/24" });
    expect([c.dataDir, c.port, c.runAsCurrentUser, c.initialAllowlist]).toEqual(["D:\\x", 5000, true, ["10.0.0.5", "10.0.0.0/24"]]);
    expect(dataPaths("D:\\x").logs).toBe("D:\\x\\logs");
  });
});
