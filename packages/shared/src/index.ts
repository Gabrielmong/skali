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
    /** The server is up and its config changed after it started. */
    restartPending: boolean;
    job: JobView | null;
    setupPending: boolean;
    createdFolder: boolean;
    steamAppId: number | null;
  };

export type JobKind = "install" | "update";
export type JobStepState = "pending" | "running" | "done" | "failed" | "skipped";
export interface JobStepView { id: string; label: string; state: JobStepState }
export interface JobView { kind: JobKind; state: "running" | "failed"; steps: JobStepView[]; /** 0–100 */ progress: number | null; error?: string; runId: string }
export type MinecraftFlavour = "vanilla" | "paper";
export interface InstallRequest {
  game: GameId; name: string; folder: string; launch: LaunchValues;
  appId?: number; // basic only
  minecraft?: { flavour: MinecraftFlavour; version: string };
  palworld?: { serverName: string; serverPassword: string; maxPlayers: number };
  acceptEula?: boolean; // minecraft: must be true
}
export interface UpdateRequest { minecraft?: { flavour: MinecraftFlavour; version: string } }
export interface CatalogEntry { appId: number | null; game: GameId; name: string; star: boolean; ports?: PortSpec[]; exeHint?: string; notes?: string }
export interface SteamAppInfo { appId: number; name: string; windows: boolean }
export interface PortClash { port: number; protocol: "udp" | "tcp"; reason: string }
export interface ToolsStatus { steamcmd: boolean; java: number[] }

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

// ---------- Deploys page (mirrors the deploy helper's GET /status JSON) ----------

export type DeployEventKind = "DEPLOY" | "ROLLBACK" | "RESTART" | "PAUSE" | "RESUME";
export type DeployEventStatus = "RUNNING" | "SUCCEEDED" | "FAILED" | "SKIPPED";

export interface DeployEventView {
  id: string;
  kind: DeployEventKind;
  status: DeployEventStatus;
  sha?: string;
  message?: string;
  by: string;
  startedAt: string;
  finishedAt?: string;
  /** Bare reason text, e.g. "tests failed" or "rolled back automatically". */
  detail?: string;
  /** The GitHub Actions run of the CI workflow for this commit, when there is one. */
  ciRunUrl?: string;
  canRollback: boolean;
  rollbackBlockedReason?: string;
}

export interface DeployStatusView {
  running?: { sha: string; message: string; deployedAt: string };
  autoDeploy: { on: boolean; reason?: string };
  lastCheck?: { at: string; error?: string };
  /** e.g. "Deploying abc1234" while an operation runs. */
  busy?: string;
  helperUpdateAvailable: boolean;
  /** Newest first. */
  events: DeployEventView[];
}

export interface DeployLogChunk {
  log: string;
  /** Byte offset to pass as `from` next time (absent on a full read). */
  next?: number;
}

export type ConfigFormat = "ini" | "palworld" | "properties" | "json" | "yaml" | "raw";

export interface ConfigSourceView {
  id: string;
  kind: "launch" | "file";
  label: string;
  path?: string;
  format?: ConfigFormat;
  builtin: boolean;
}

export interface ConfigFieldView {
  id: string;
  key: string;
  section?: string;
  value: string | number | boolean;
  type: "switch" | "number" | "text" | "select" | "secret";
  label?: string;
  help?: string;
  group?: string;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  locked?: string;
}

export interface ConfigFileView {
  sourceId: string;
  format: ConfigFormat;
  etag: string;
  raw: string;
  fields: ConfigFieldView[] | null;
  parseError?: string;
  missing?: boolean;
  seededFrom?: string;
}

/** Exactly one of `changes` and `raw` is present. */
export interface ConfigSaveRequest {
  etag: string;
  changes?: Record<string, string | number | boolean>;
  raw?: string;
}

export interface ConfigSaveResult {
  file: ConfigFileView;
  restartPending: boolean;
}

export interface ConfigHistoryEntry {
  id: string;
  savedAt: string;
  sizeBytes: number;
}
