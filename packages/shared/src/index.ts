export type GameId = "palworld" | "valheim" | "minecraft" | "basic";
export type ServerStatus = "stopped" | "starting" | "running" | "stopping" | "crashed";

export type LaunchValues = Record<string, string | number | boolean>;

export interface ServerRecordPublic {
  id: string;
  name: string;
  game: GameId;
  folder: string;
  launch: LaunchValues;
  desired: "running" | "stopped";
  autoRestart: boolean;
  autoStart: boolean;
  stopTimeoutSec: number;
  pid: number | null;
  pidStartTime: string | null;
  currentRunId: string | null;
  createdAt: string;
}

export interface PortSpec {
  port: number;
  protocol: "udp" | "tcp";
  purpose: string;
  forward: boolean;
}

export interface FieldSpec {
  key: string;
  label: string;
  type: "text" | "number" | "switch" | "password";
  default?: string | number | boolean;
  help?: string;
  min?: number;
  max?: number;
}

export interface GameInfo {
  id: GameId;
  displayName: string;
  launchFields: FieldSpec[];
  hasCommands: boolean;
  commandHelp?: string;
}

export interface RuntimeState {
  status: ServerStatus;
  detail?: string;
  startedAt?: string;
  cpuPct?: number;
  memBytes?: number;
  players?: { online: number; max: number } | null;
  crashPaused: boolean;
  runId?: string;
}

export interface AdoptRequest {
  game: GameId;
  name: string;
  folder: string;
  launch: LaunchValues;
  importWorldFrom?: string;
  acceptEula?: boolean;
}

/** Every mutating /api request must carry `X-Skali: 1` (CSRF guard; cross-origin pages can't set it without CORS). */
export const SKALI_HEADER = "X-Skali";
export const SKALI_HEADER_VALUE = "1";

/** A server as the API returns it: never carries secrets; password launch fields are masked as "****". */
export type ServerView = ServerRecordPublic &
  RuntimeState & {
    ports: PortSpec[];
    /** `${connectHost}:${first forwarded port}` */
    connectAddress: string;
    hasCommands: boolean;
    commandHelp?: string;
  };

/** The masked value of a password launch field; sending it back in a PATCH keeps the stored value. */
export const MASKED_SECRET = "****";

export interface RunInfo {
  runId: string;
  startedAt: string;
  sizeBytes: number;
}

export interface FsListing {
  path: string | null;
  parent: string | null;
  dirs: string[];
  files: string[];
  /** True when the folder held more entries than the listing returns. */
  truncated: boolean;
}

export type WsServerMessage =
  | { type: "status"; server: ServerView }
  | { type: "removed"; serverId: string }
  | { type: "logHistory"; serverId: string; runId: string | null; lines: string[] }
  | { type: "log"; serverId: string; runId: string; lines: string[] };

export type WsClientMessage =
  | { type: "subscribeLogs"; serverId: string }
  | { type: "unsubscribeLogs"; serverId: string };

const ALLOW_OCTET = /^(0|[1-9]\d{0,2})$/;
const ALLOW_PREFIX = /^(0|[1-9]\d?)$/;

/** Strict IPv4 address or IPv4 CIDR (/0-/32); no whitespace or other junk. Used by the server and the web UI. */
export function isValidAllowEntry(s: string): boolean {
  const [addr, prefix, ...rest] = s.split("/");
  if (rest.length > 0) return false;
  if (prefix !== undefined && !(ALLOW_PREFIX.test(prefix) && Number(prefix) <= 32)) return false;
  const parts = (addr ?? "").split(".");
  return parts.length === 4 && parts.every((p) => ALLOW_OCTET.test(p) && Number(p) <= 255);
}

/** Inspect note the Minecraft adapter emits while eula.txt is missing or not accepted; the UI keys off it. */
export const MINECRAFT_EULA_NOTE = "Accept the Minecraft EULA before the first start (server Overview)";
