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
