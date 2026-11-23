import { describe, expect, it } from "vitest";
import { nextCrashAction } from "../../src/proc/crash-policy.js";

describe("nextCrashAction", () => {
  const now = 1_000_000_000;

  it("restarts after 10 s for the first and second crash", () => {
    expect(nextCrashAction([now], now, true)).toEqual({ action: "restart", delayMs: 10000 });
    expect(nextCrashAction([now - 1000, now], now, true)).toEqual({ action: "restart", delayMs: 10000 });
  });

  it("pauses on the third crash within 10 minutes", () => {
    expect(nextCrashAction([now - 500_000, now - 1000, now], now, true)).toEqual({ action: "pause" });
  });

  it("ignores crashes older than 600 000 ms", () => {
    expect(nextCrashAction([now - 600_000, now - 700_000, now - 1000, now], now, true)).toEqual({ action: "restart", delayMs: 10000 });
  });

  it("pauses when auto-restart is off", () => {
    expect(nextCrashAction([now], now, false)).toEqual({ action: "pause" });
  });
});
