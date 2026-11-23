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
