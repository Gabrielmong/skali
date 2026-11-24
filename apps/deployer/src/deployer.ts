import { actualRunning } from './actual-running.js';
import type { DeployerApi } from './api.js';
import type { Command } from './command.js';
import { deployCommit } from './deploy.js';
import type { Commit } from './github.js';
import { GitHubError } from './github.js';
import type { DeployEvent, DeployerState } from './history.js';
import { type OpContext, short } from './op-context.js';
import { OpError } from './op-error.js';
import { type CommitSource, checkError, findPick, recordSkips } from './poll.js';
import { restartApp } from './restart.js';
import { type MarkedEvent, markEvents } from './rollback-eligibility.js';
import { assertCanRollback, rollbackTo } from './rollback.js';
import { watchStart } from './watch-start.js';

export type { Command } from './command.js';
export { OpError } from './op-error.js';

export interface StatusView {
  running?: DeployerState['running'];
  autoDeploy: DeployerState['autoDeploy'];
  lastCheck?: DeployerState['lastCheck'];
  busy?: string; // e.g. "Deploying abc1234"
  helperUpdateAvailable: boolean;
  /** Newest first; each keeps its ciRunUrl, kept releases carry canRollback / rollbackBlockedReason. */
  events: MarkedEvent[];
}

export interface Ops {
  deployCommit: typeof deployCommit;
  rollbackTo: typeof rollbackTo;
  restartApp: typeof restartApp;
}

const REAL_OPS: Ops = { deployCommit, rollbackTo, restartApp };
const FIRST_TICK_MS = 10_000;
const STOP_WAIT_MS = 600_000;
const REV_PARSE_TIMEOUT_MS = 30_000;
/** What the API answers (409) to any command while an operation runs. */
export const BUSY = 'busy';

const busyLabel = (c: Command) =>
  c.type === 'rollback' ? `Rolling back to ${short(c.sha)}` : c.type === 'restartApp' ? 'Restarting Skáli' : 'Deploying';

/** The apps/deployer tree of the newest fetched main (`git rev-parse refs/remotes/origin/<branch>:apps/deployer`). */
export async function fetchedDeployerTree(ctx: OpContext): Promise<string | undefined> {
  const lines: string[] = [];
  const ref = `refs/remotes/origin/${ctx.config.branch}:apps/deployer`;
  await ctx.sys.run(ctx.config.bin.git, ['-C', ctx.paths.repo, 'rev-parse', ref], {
    env: ctx.gitLocalEnv(),
    timeoutMs: REV_PARSE_TIMEOUT_MS,
    onLine: (l) => lines.push(l),
  });
  return lines.map((l) => l.trim()).filter(Boolean).at(-1);
}

/** The poll loop and the one-at-a-time command runner behind the API. */
export class Deployer implements DeployerApi {
  private busy?: string;
  private inFlight?: Promise<void>;
  private ticking?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private stopped = true;
  private shuttingDown = false; // set by stop(): no new work after it
  private helperUpdate = false;

  constructor(
    private readonly ctx: OpContext,
    private readonly github: CommitSource,
    private readonly ops: Ops = REAL_OPS,
  ) {}

  start(): void {
    this.stopped = false;
    this.schedule(FIRST_TICK_MS);
  }

  /** Stops polling and waits (up to 10 min) for the operation in flight; never interrupts one. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.shuttingDown = true;
    clearTimeout(this.timer);
    let timeout: NodeJS.Timeout | undefined;
    const limit = new Promise<void>((r) => (timeout = setTimeout(r, STOP_WAIT_MS)));
    await Promise.race([Promise.allSettled([this.ticking, this.inFlight]), limit]);
    clearTimeout(timeout);
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => {
      void this.tick()
        .catch((e: unknown) => console.error('Scheduled check failed:', e)) // never an unhandled rejection
        .finally(() => {
          if (!this.stopped) this.schedule(this.ctx.config.pollMs);
        });
    }, ms);
  }

  /** One auto-deploy check; skipped while paused or while anything else runs. */
  async tick(): Promise<void> {
    if (this.ticking || this.busy || !this.ctx.history.state().autoDeploy.on) return;
    this.ticking = this.check().finally(() => (this.ticking = undefined));
    return this.ticking;
  }

  private async check(): Promise<void> {
    if (this.shuttingDown) return;
    const pick = await this.poll();
    // A command, a pause or stop() may have come in while GitHub answered.
    if (!pick || this.shuttingDown || this.busy || !this.ctx.history.state().autoDeploy.on) return;
    const { commit, runUrl } = pick;
    this.busy = `Deploying ${short(commit.sha)}`;
    const opts = { waitForIdle: true, ...(runUrl ? { ciRunUrl: runUrl } : {}) };
    await this.launch((ctx) => this.ops.deployCommit(ctx, commit, 'auto', opts)).catch(() => undefined);
    await this.inFlight;
  }

  /** One GitHub check: lastCheck, SKIPPED events, the helper-update flag; the commit to deploy, if any. */
  private async poll(): Promise<{ commit: Commit; runUrl?: string } | undefined> {
    const { ctx, github } = this;
    const at = ctx.now().toISOString();
    try {
      const runningSha = actualRunning(ctx)?.sha;
      const { failedShas } = ctx.history.state();
      const pick = await findPick(ctx, github, {
        runningSha,
        failed: failedShas,
        ciTimeoutMs: ctx.config.ciTimeoutMs,
        includeRunning: false,
      });
      ctx.history.update({ lastCheck: { at } });
      recordSkips(ctx, pick.skip);
      await this.checkHelper();
      return pick.action === 'deploy' ? { commit: pick.commit, runUrl: pick.runUrl } : undefined;
    } catch (e) {
      try {
        ctx.history.update({ lastCheck: { at, error: checkError(ctx, e) } });
      } catch (saveError) {
        console.error("Couldn't record the failed check:", saveError); // e.g. EPERM on history.json
      }
      return undefined;
    }
  }

  private async checkHelper(): Promise<void> {
    try {
      const tree = await fetchedDeployerTree(this.ctx);
      if (tree) this.helperUpdate = tree !== this.ctx.config.installedDeployerTree;
    } catch {
      // keep the last answer; a failed lookup shouldn't stop deploys
    }
  }

  /** Validates (OpError on refusal), then runs the operation in the background and answers with its event. */
  async command(c: Command): Promise<{ eventId: string }> {
    if (this.shuttingDown) throw new OpError('Helper is shutting down', 409);
    if (this.busy) throw new OpError(BUSY, 409);
    if (c.type === 'pause' || c.type === 'resume') return { eventId: this.setAutoDeploy(c.type, c.by) };
    this.busy = busyLabel(c); // claimed before any await, so a second command meets 409
    try {
      if (c.type === 'restartApp') return { eventId: await this.launch((ctx) => this.ops.restartApp(ctx, c.by)) };
      if (c.type === 'rollback') {
        assertCanRollback(this.ctx, c.sha);
        return { eventId: await this.launch((ctx) => this.ops.rollbackTo(ctx, c.sha, c.by)) };
      }
      const { commit, runUrl } = await this.deployNowCommit();
      this.busy = `Deploying ${short(commit.sha)}`;
      const opts = { waitForIdle: false, ...(runUrl ? { ciRunUrl: runUrl } : {}) };
      return { eventId: await this.launch((ctx) => this.ops.deployCommit(ctx, commit, c.by, opts)) };
    } catch (e) {
      if (!this.inFlight) this.busy = undefined;
      throw e;
    }
  }

  private setAutoDeploy(type: 'pause' | 'resume', by: string): string {
    const { history } = this.ctx;
    history.update({ autoDeploy: type === 'pause' ? { on: false, reason: `paused by ${by}` } : { on: true } });
    return history.record({ kind: type === 'pause' ? 'PAUSE' : 'RESUME', status: 'SUCCEEDED', by }).id;
  }

  /** Deploy now: the newest green commit, failed ones included (an explicit retry). */
  private async deployNowCommit(): Promise<{ commit: Commit; runUrl?: string }> {
    const { ctx, github } = this;
    const runningSha = actualRunning(ctx)?.sha;
    let found: { commit: Commit; runUrl?: string } | undefined;
    try {
      // ciTimeoutMs 0: a commit still waiting for CI never hides an older green one.
      const pick = await findPick(ctx, github, { runningSha, failed: [], ciTimeoutMs: 0, includeRunning: true });
      if (pick.action === 'deploy') found = { commit: pick.commit, runUrl: pick.runUrl };
    } catch (e) {
      if (e instanceof GitHubError) throw new OpError(e.message, 400);
      throw e;
    }
    if (!found) throw new OpError('No green commit to deploy', 400);
    if (runningSha !== undefined && short(found.commit.sha) === short(runningSha)) {
      throw new OpError(`Already running ${short(found.commit.sha)}`, 400);
    }
    return found;
  }

  /** Starts `op` (busy is already claimed) and resolves with its event id once it records one. */
  private launch(op: (ctx: OpContext) => Promise<DeployEvent>): Promise<string> {
    const { ctx, started } = watchStart(this.ctx);
    const running = op(ctx);
    this.inFlight = running
      .then(
        () => undefined,
        (e: unknown) => {
          if (!(e instanceof OpError)) console.error('Operation failed unexpectedly:', e);
        },
      )
      .finally(() => {
        this.busy = undefined;
        this.inFlight = undefined;
      });
    return Promise.race([started, running.then((ev) => ev.id)]);
  }

  async status(): Promise<StatusView> {
    const state = this.ctx.history.state();
    const running = actualRunning(this.ctx);
    return {
      ...(running ? { running } : {}),
      autoDeploy: state.autoDeploy,
      ...(state.lastCheck ? { lastCheck: state.lastCheck } : {}),
      ...(this.busy ? { busy: this.busy } : {}),
      helperUpdateAvailable: this.helperUpdate,
      events: markEvents(this.ctx, this.ctx.history.events(), running?.sha),
    };
  }
}
