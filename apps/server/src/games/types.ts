import type { ConfigFormat, GameInfo, LaunchValues, PortSpec } from "@skali/shared";
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

export interface FieldMeta {
  label?: string; help?: string; group?: string;
  type?: "switch" | "number" | "text" | "select" | "secret";
  options?: string[]; min?: number; max?: number; step?: number; unit?: string;
}
/** Both maps are keyed by field `key`. The locked value is the note shown to the owner. */
export interface ConfigTemplate { fields: Record<string, FieldMeta>; locked: Record<string, string> }
/** `path` and `seedFrom` are relative to the server folder. */
export interface BuiltinSource { id: string; label: string; path: string; format: ConfigFormat; template?: ConfigTemplate; seedFrom?: string }

export interface GameAdapter {
  info: GameInfo;
  ready: ReadyCheck;
  configSources: BuiltinSource[];
  defaultStopTimeoutSec: number;
  /** Steam app id of the dedicated server, or null when there is none (basic's comes from the record). */
  steamAppId: number | null;
  /** The launch values a fresh install starts with (the same ones inspectFolder returns on success). */
  installDefaults(): LaunchValues;
  /** Absolute paths of the server's save data, for backups. */
  saveLocations(s: ServerRecord): string[];
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

/** The app id a server's install/update uses: the record's own, else the adapter's. */
export function effectiveAppId(rec: ServerRecord, adapter: GameAdapter): number | null {
  return rec.steamAppId ?? adapter.steamAppId;
}
