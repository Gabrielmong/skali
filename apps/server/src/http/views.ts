import { MASKED_SECRET, type LaunchValues, type JobView, type PortSpec, type RuntimeState, type ServerView } from "@skali/shared";
import { effectiveAppId, type GameAdapter } from "../games/types.js";
import type { ServerRecord } from "../servers/repo.js";
import type { AppSettings } from "../settings.js";

/** Launch values with every non-empty password-type field replaced by "****". */
export function maskLaunch(launch: LaunchValues, adapter: GameAdapter): LaunchValues {
  const out: LaunchValues = { ...launch };
  for (const f of adapter.info.launchFields) {
    if (f.type !== "password") continue;
    const v = out[f.key];
    if (v !== undefined && v !== null && String(v) !== "") out[f.key] = MASKED_SECRET;
  }
  return out;
}

/** The server is up and its config changed after it started. */
export function isRestartPending(rec: ServerRecord, state: RuntimeState): boolean {
  return (
    (state.status === "running" || state.status === "starting") &&
    !!rec.configChangedAt &&
    !!state.startedAt &&
    rec.configChangedAt > state.startedAt
  );
}

/** The API's view of a server. Built field by field so `secrets` (or any future private field) never leaks. */
export function toView(rec: ServerRecord, state: RuntimeState, adapter: GameAdapter, settings: AppSettings, job: JobView | null): ServerView {
  let ports: PortSpec[] = [];
  try {
    ports = adapter.ports(rec);
  } catch {
    // malformed launch values (e.g. basic's port list): show none rather than failing the whole list
  }
  const fwd = ports.find((p) => p.forward) ?? ports[0];
  let hasCommands = false;
  try {
    hasCommands = !!adapter.command && adapter.hasCommandsFor(rec);
  } catch {
    hasCommands = false;
  }
  const restartPending = isRestartPending(rec, state);
  return {
    id: rec.id,
    name: rec.name,
    game: rec.game,
    folder: rec.folder,
    launch: maskLaunch(rec.launch, adapter),
    desired: rec.desired,
    autoRestart: rec.autoRestart,
    autoStart: rec.autoStart,
    stopTimeoutSec: rec.stopTimeoutSec,
    pid: rec.pid,
    pidStartTime: rec.pidStartTime,
    currentRunId: rec.currentRunId,
    createdAt: rec.createdAt,
    status: state.status,
    crashPaused: state.crashPaused,
    restartPending,
    ...(state.detail !== undefined ? { detail: state.detail } : {}),
    ...(state.startedAt !== undefined ? { startedAt: state.startedAt } : {}),
    ...(state.cpuPct !== undefined ? { cpuPct: state.cpuPct } : {}),
    ...(state.memBytes !== undefined ? { memBytes: state.memBytes } : {}),
    ...(state.players !== undefined ? { players: state.players } : {}),
    ...(state.runId !== undefined ? { runId: state.runId } : {}),
    ports,
    connectAddress: fwd ? `${settings.connectHost}:${fwd.port}` : settings.connectHost,
    hasCommands,
    job,
    setupPending: rec.setupPending,
    createdFolder: rec.createdFolder,
    steamAppId: effectiveAppId(rec, adapter),
    ...(adapter.info.commandHelp !== undefined ? { commandHelp: adapter.info.commandHelp } : {}),
  };
}
