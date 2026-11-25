import { describe, expect, it } from "vitest";
import type { JobView, RuntimeState } from "@skali/shared";
import { getAdapter } from "../../src/games/registry.js";
import { effectiveAppId } from "../../src/games/types.js";
import { toView } from "../../src/http/views.js";
import type { ServerRecord } from "../../src/servers/repo.js";
import type { AppSettings } from "../../src/settings.js";

const rec = (configChangedAt: string | null): ServerRecord => ({
  id: "a", name: "v", game: "valheim", folder: "C:\\f",
  launch: { port: 2456, world: "W", public: true, crossplay: false, extraArgs: "", password: "secret1" },
  secrets: {}, desired: "running", autoRestart: true, autoStart: true, stopTimeoutSec: 30,
  pid: null, pidStartTime: null, currentRunId: null, createdAt: "2026-01-01T00:00:00.000Z", configChangedAt, steamAppId: null, setupPending: false, createdFolder: false, job: null,
});
const settings = { connectHost: "h", allowlist: [] } as unknown as AppSettings;
const pending = (r: ServerRecord, s: RuntimeState) => toView(r, s, getAdapter("valheim"), settings, null).restartPending;
const T0 = "2026-01-01T10:00:00.000Z";
const T1 = "2026-01-01T11:00:00.000Z";

describe("restartPending", () => {
  it("is true only when running/starting and configChangedAt > startedAt", () => {
    for (const status of ["running", "starting"] as const) {
      expect(pending(rec(T1), { status, crashPaused: false, startedAt: T0 })).toBe(true);
    }
    expect(pending(rec(T0), { status: "running", crashPaused: false, startedAt: T1 })).toBe(false);
    expect(pending(rec(T1), { status: "stopped", crashPaused: false, startedAt: T0 })).toBe(false);
    expect(pending(rec(null), { status: "running", crashPaused: false, startedAt: T0 })).toBe(false);
    expect(pending(rec(T1), { status: "running", crashPaused: false })).toBe(false);
  });
});

describe("steamAppId", () => {
  it("falls back to the adapter's app id; the record wins", () => {
    const v = (id: number | null) => toView({ ...rec(null), steamAppId: id }, { status: "stopped", crashPaused: false }, getAdapter("valheim"), settings, null).steamAppId;
    expect(v(null)).toBe(896660);
    expect(v(123)).toBe(123);
    expect(effectiveAppId({ ...rec(null), steamAppId: null }, getAdapter("minecraft"))).toBeNull();
  });
});

describe("job", () => {
  it("passes the job view through", () => {
    const job: JobView = { kind: "install", state: "running", steps: [], progress: 42, runId: "r" };
    const v = toView(rec(null), { status: "stopped", crashPaused: false }, getAdapter("valheim"), settings, job);
    expect(v.job).toEqual(job);
    expect(toView(rec(null), { status: "stopped", crashPaused: false }, getAdapter("valheim"), settings, null).job).toBeNull();
  });
});
