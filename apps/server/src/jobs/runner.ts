import type { JobKind, JobStepView, JobView } from "@skali/shared";
import { appendSkaliLine, createRun } from "../logs/runs.js";
import type { SupervisorEvent } from "../proc/supervisor.js";
import type { PersistedJob, ServerRecord, ServerRepo } from "../servers/repo.js";
import { SteamCmdError } from "../tools/steamcmd.js";

export const RESTART_DURING_INSTALL = "Skáli restarted during the install";
export const RESTART_DURING_UPDATE = "Skáli restarted during the update — check the server, then start it";
export const LOGIN_NEEDED =
  "This server needs a Steam login, which isn't supported yet (coming with Steam login in a later update)";

export interface StepCtx {
  log(line: string): void;
  progress(pct: number | null): void;
}
export interface JobStep {
  id: string;
  label: string;
  run(ctx: StepCtx): Promise<void>;
}
export interface JobRunnerDeps {
  repo: ServerRepo;
  logsDir: string;
  /** "log" events, same as the supervisor's. */
  emit: (e: SupervisorEvent) => void;
  /** Becomes an AppEvent "changed". */
  changed: (serverId: string) => void;
  now?: () => Date;
}

const PROGRESS_NOTIFY_MS = 1_000;

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Why a server can't be started right now because of its job / setup state, or null. */
export function startGuardReason(rec: Pick<ServerRecord, "job" | "setupPending">): string | null {
  const job = rec.job;
  if (job?.state === "running") return job.kind === "install" ? "Installing…" : "Updating…";
  if (job?.state === "failed" && job.kind === "install") return "Install failed — retry or remove it";
  if (rec.setupPending) return "Finish setup first";
  return null;
}

export class JobRunner {
  private readonly live = new Map<string, { progress: number | null }>();

  constructor(private readonly deps: JobRunnerDeps) {}

  isRunning(serverId: string): boolean {
    return this.live.has(serverId);
  }

  view(serverId: string): JobView | null {
    let job: PersistedJob | null;
    try {
      job = this.deps.repo.get(serverId).job;
    } catch {
      return null;
    }
    if (!job) return null;
    const progress = job.state === "running" ? (this.live.get(serverId)?.progress ?? null) : null;
    return {
      kind: job.kind,
      state: job.state,
      steps: job.steps.map((s) => ({ ...s })),
      progress,
      ...(job.error !== undefined ? { error: job.error } : {}),
      runId: job.runId,
    };
  }

  busyReasons(): string[] {
    const out: string[] = [];
    for (const rec of this.deps.repo.list()) {
      if (rec.job?.state !== "running") continue;
      out.push(`${rec.name} is ${rec.job.kind === "install" ? "installing" : "updating"}`);
    }
    return out;
  }

  boot(): void {
    for (const rec of this.deps.repo.list()) {
      if (rec.job?.state !== "running") continue;
      const steps = rec.job.steps.map((s): JobStepView => (s.state === "running" ? { ...s, state: "failed" } : s));
      const job: PersistedJob = {
        ...rec.job,
        state: "failed",
        steps,
        error: rec.job.kind === "install" ? RESTART_DURING_INSTALL : RESTART_DURING_UPDATE,
      };
      this.deps.repo.update(rec.id, rec.job.kind === "update" ? { job, desired: "stopped" } : { job });
    }
  }

  /** Removes the job record. Refused (returns false) while the job is running. */
  clear(serverId: string): boolean {
    if (this.live.has(serverId)) return false;
    this.deps.repo.update(serverId, { job: null });
    this.notify(serverId);
    return true;
  }

  /**
   * Runs a job to completion. Resolves true when it ran (success or failure lands in the job; never rejects for step
   * failures) and false when refused because a job is already running for this server.
   */
  async run(
    serverId: string,
    kind: JobKind,
    steps: JobStep[],
    params: Record<string, unknown>,
    opts: { resume?: boolean } = {},
  ): Promise<boolean> {
    const { repo, logsDir } = this.deps;
    if (this.live.has(serverId)) return false;
    const live = { progress: null as number | null };
    this.live.set(serverId, live);
    let timer: NodeJS.Timeout | undefined;
    try {
      const prior0 = opts.resume ? repo.get(serverId).job : null;
      const prior = prior0 && prior0.kind === kind && prior0.state === "failed" ? prior0 : null;
      const doneIds = new Set((prior?.steps ?? []).filter((s) => s.state === "done").map((s) => s.id));
      const { runId, consolePath } = createRun(logsDir, serverId, (this.deps.now ?? (() => new Date()))());
      const views: JobStepView[] = steps.map((s) => ({
        id: s.id,
        label: s.label,
        state: doneIds.has(s.id) ? "done" : "pending",
      }));
      let lastNotify = 0;
      const stopTimer = (): void => {
        clearTimeout(timer);
        timer = undefined;
      };

      const persist = (state: "running" | "failed", error?: string): void => {
        const job: PersistedJob = {
          kind,
          state,
          steps: views.map((v) => ({ ...v })),
          runId,
          params,
          ...(error !== undefined ? { error } : {}),
        };
        repo.update(serverId, { job });
        stopTimer();
        this.notify(serverId);
      };
      // Lines are appended in order; a write chain keeps them ordered without making step code async.
      let chain: Promise<void> = Promise.resolve();
      const writeLine = (line: string): void => {
        chain = chain.then(() => appendSkaliLine(consolePath, line)).catch(() => undefined);
        try {
          this.deps.emit({ type: "log", serverId, runId, lines: [`[skali] ${line}`] });
        } catch {
          // a subscriber must not break the job
        }
      };

      persist("running");
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i]!;
        const v = views[i]!;
        if (v.state === "done") continue;
        v.state = "running";
        live.progress = null;
        persist("running");
        writeLine(step.label);
        try {
          await step.run({
            log: (line) => writeLine(line),
            progress: (pct) => {
              const prev = live.progress;
              live.progress = pct;
              if (pct === null) {
                if (prev !== null) {
                  stopTimer();
                  this.notify(serverId);
                }
                return;
              }
              const t = Date.now();
              if (t - lastNotify >= PROGRESS_NOTIFY_MS) {
                lastNotify = t;
                stopTimer();
                this.notify(serverId);
              } else if (!timer) {
                // trailing notify so the last value in the window is not lost when the step goes quiet
                timer = setTimeout(() => {
                  timer = undefined;
                  lastNotify = Date.now();
                  this.notify(serverId);
                }, PROGRESS_NOTIFY_MS - (t - lastNotify));
              }
            },
          });
          v.state = "done";
          live.progress = null;
        } catch (e) {
          const msg = e instanceof SteamCmdError && e.kind === "login" ? LOGIN_NEEDED : errText(e);
          v.state = "failed";
          live.progress = null;
          writeLine(`${step.label} failed: ${msg}`);
          await chain;
          persist("failed", msg);
          return true;
        }
      }
      await chain;
      repo.update(serverId, { job: null });
      stopTimer();
      this.live.delete(serverId);
      this.notify(serverId);
    } catch {
      // repo trouble (e.g. the server was deleted mid-job): nothing left to record
    } finally {
      clearTimeout(timer);
      if (this.live.get(serverId) === live) this.live.delete(serverId);
    }
    return true;
  }

  private notify(serverId: string): void {
    try {
      this.deps.changed(serverId);
    } catch {
      // subscriber trouble must not break the job
    }
  }
}
