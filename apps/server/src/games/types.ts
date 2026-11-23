import type { GameInfo, LaunchValues, PortSpec } from "@skali/shared";
import type { ServerRecord } from "../servers/repo.js";

export interface LaunchSpec { exe: string; args: string[]; cwd: string; env?: Record<string, string> }
export type ReadyCheck =
  | { kind: "pattern"; pattern: RegExp }
  | { kind: "probe"; probe: (s: ServerRecord) => Promise<boolean> }
  | { kind: "none" };
export interface StopContext { ctrlC(): Promise<void> }
export type InspectResult =
  | { ok: true; exe: string; launch: LaunchValues; notes: string[] }
  | { ok: false; reason: string };

export interface GameAdapter {
  info: GameInfo;
  ready: ReadyCheck;
  defaultStopTimeoutSec: number;
  inspectFolder(folder: string): Promise<InspectResult>;
  validateLaunch(name: string, launch: LaunchValues): string[];
  ports(s: ServerRecord): PortSpec[];
  prepare(s: ServerRecord): Promise<{ secrets?: Record<string, string> }>;
  buildLaunch(s: ServerRecord): LaunchSpec;
  stop(s: ServerRecord, ctx: StopContext): Promise<void>;
  command: ((s: ServerRecord, cmd: string) => Promise<string>) | null;
  hasCommandsFor(s: ServerRecord): boolean;
  players(s: ServerRecord): Promise<{ online: number; max: number } | null>;
}
