import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LaunchValues } from "@skali/shared";
import type { GameId } from "@skali/shared";
import type { ServerRecord } from "../../src/servers/repo.js";

export function tmpFolder(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skali-games-"));
}

export function rec(game: GameId, folder: string, launch: LaunchValues = {}, secrets: Record<string, string> = {}, name = "Test"): ServerRecord {
  return {
    id: "id1", name, game, folder, launch, secrets,
    desired: "stopped", autoRestart: false, autoStart: false, stopTimeoutSec: 60,
    pid: null, pidStartTime: null, currentRunId: null, createdAt: "2026-01-01T00:00:00Z", configChangedAt: null, steamAppId: null, setupPending: false, createdFolder: false, job: null,
  };
}

export function touch(file: string, content = "x"): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
