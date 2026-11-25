import fs from "node:fs";
import path from "node:path";
import type { AdoptRequest, GameId, RuntimeState } from "@skali/shared";
import { BadRequestError, ConflictError } from "../errors.js";
import type { GameAdapter, InspectResult } from "../games/types.js";
import { grantModify } from "../system/acl.js";
import { ensureFirewallRules, removeFirewallRules } from "../system/firewall.js";
import type { ServerRecord, ServerRepo } from "./repo.js";
import { assertNoReparsePoints } from "../util/files.js";
import { Mutex } from "../util/mutex.js";
import { assertAllowedFolder, assertNotLinked, defaultProtected, norm, type ProtectedPaths } from "./folders.js";
import { findValheimWorlds } from "./valheim-worlds.js";

export interface AdopterDeps {
  repo: ServerRepo;
  adapter: (id: GameId) => GameAdapter;
  gamesUser: string | null;
  firewall?: typeof ensureFirewallRules;
  removeFirewall?: typeof removeFirewallRules;
  acl?: typeof grantModify;
  usersRoot?: string;
  /** Protected locations; default to the process environment. */
  protectedPaths?: Partial<ProtectedPaths>;
}

export { defaultProtected, type ProtectedPaths };

function checkFolder(folder: unknown, usersRoot: string, prot: ProtectedPaths): string {
  if (typeof folder === "string" && path.isAbsolute(folder) && !folder.includes('"')) {
    let isDir = false;
    try { isDir = fs.statSync(folder).isDirectory(); } catch { /* not found */ }
    if (!isDir) throw new BadRequestError("Folder does not exist");
  }
  const r = assertAllowedFolder(folder, usersRoot, prot, "adopted");
  // The games user is granted Modify here (icacls /L): a link folder would redirect that grant, so refuse it.
  assertNotLinked(r);
  return r;
}

function runUndo(undo: (() => void)[]): void {
  for (const u of undo.splice(0).reverse()) { try { u(); } catch { /* best effort */ } }
}

export class Adopter {
  private readonly lock = new Mutex();
  private readonly prot: ProtectedPaths;
  constructor(private readonly deps: AdopterDeps) {
    this.prot = { ...defaultProtected(), ...deps.protectedPaths };
  }
  private check(folder: unknown): string {
    return checkFolder(folder, this.deps.usersRoot ?? "C:\\Users", this.prot);
  }

  async inspect(game: GameId, folder: string): Promise<InspectResult & { worlds?: Awaited<ReturnType<typeof findValheimWorlds>> }> {
    const res = await this.deps.adapter(game).inspectFolder(this.check(folder));
    if (game === "valheim") return { ...res, worlds: await findValheimWorlds(this.deps.usersRoot) };
    return res;
  }

  /** Serialized so two concurrent adopts of one folder cannot both pass the clash check. */
  adopt(req: AdoptRequest): Promise<ServerRecord> {
    return this.lock.run(() => this.doAdopt(req));
  }

  // Rollback intentionally does not revoke the ACL grant (harmless on the game folder).
  private async doAdopt(req: AdoptRequest): Promise<ServerRecord> {
    const { repo } = this.deps;
    const adapter = this.deps.adapter(req.game);
    const folder = this.check(req.folder);
    const insp = await adapter.inspectFolder(folder);
    if (!insp.ok) throw new BadRequestError(insp.reason);
    const errors = adapter.validateLaunch(req.name, req.launch);
    if (errors.length) throw new BadRequestError(errors.join("; "));
    const clash = repo.list().find((s) => norm(s.folder) === norm(folder));
    if (clash) throw new BadRequestError(`Folder already managed by ${clash.name}`);

    const launch = { ...req.launch };
    const undo: (() => void)[] = [];
    let created: ServerRecord | null = null;
    try {
      if (req.importWorldFrom !== undefined) {
        if (req.game !== "valheim") throw new BadRequestError("World import is only supported for Valheim");
        launch.world = await this.importWorld(folder, req.importWorldFrom, undo);
      }
      if (req.game === "minecraft" && req.acceptEula === true) writeEula(folder, undo);
      created = repo.create({ name: req.name, game: req.game, folder, launch, stopTimeoutSec: adapter.defaultStopTimeoutSec });
      if (this.deps.gamesUser) {
        assertNotLinked(folder);
        await (this.deps.acl ?? grantModify)(folder, this.deps.gamesUser);
      }
      await (this.deps.firewall ?? ensureFirewallRules)(created.name, adapter.ports(created));
      return created;
    } catch (e) {
      if (created) {
        try { repo.delete(created.id); } catch { /* best effort */ }
        try { await (this.deps.removeFirewall ?? removeFirewallRules)(created.name); } catch { /* best effort */ }
      }
      runUndo(undo);
      throw e;
    }
  }

  /**
   * Removes the server's firewall rules and record. Refused while it runs, or while a pid is still tracked (a stop
   * that couldn't confirm the process gone). `state` may be a getter so the check is repeated after the (slow)
   * firewall step; if something started meanwhile, the rules are restored and the removal is refused. Also refused
   * while an install or update job runs. `beforeDelete` runs after the last check, before the record is deleted.
   * Returns the record as it was removed.
   */
  async remove(
    id: string,
    state: RuntimeState | (() => RuntimeState),
    opts: { beforeDelete?: (rec: ServerRecord) => Promise<void> } = {},
  ): Promise<ServerRecord> {
    const read = typeof state === "function" ? state : () => state;
    const check = (): ServerRecord => {
      const s = read();
      if (s.status !== "stopped" && s.status !== "crashed") throw new ConflictError("Stop the server before removing it");
      const rec = this.deps.repo.get(id);
      if (rec.job?.state === "running") {
        throw new ConflictError(rec.job.kind === "install" ? "Wait for the install to finish" : "Wait for the update to finish");
      }
      if (rec.pid !== null) throw new ConflictError(s.detail ?? "The previous process may still be running; stop it first");
      return rec;
    };
    const rec = check();
    await (this.deps.removeFirewall ?? removeFirewallRules)(rec.name);
    let cur: ServerRecord;
    try {
      cur = check();
    } catch (e) {
      try {
        const now = this.deps.repo.get(id);
        await (this.deps.firewall ?? ensureFirewallRules)(now.name, this.deps.adapter(now.game).ports(now));
      } catch {
        // best effort; the rules come back on the next rename/port change or re-adopt
      }
      throw e;
    }
    // Runs while the record still exists (so its folder still counts as taken); must not throw.
    await opts.beforeDelete?.(cur);
    this.deps.repo.delete(cur.id);
    return cur;
  }

  /** Copies a world found by findValheimWorlds (matched by name or fwlPath) into the server folder; never overwrites. */
  private async importWorld(folder: string, from: string, undo: (() => void)[]): Promise<string> {
    const worlds = await findValheimWorlds(this.deps.usersRoot);
    const w =
      worlds.find((x) => x.name === from) ??
      worlds.find((x) => path.resolve(x.fwlPath).toLowerCase() === path.resolve(from).toLowerCase());
    if (!w) throw new BadRequestError("Unknown world to import");
    const srcDir = path.dirname(w.fwlPath);
    const destDir = path.join(folder, "saves", "worlds_local");
    const pairs = [".fwl", ".db"].map((ext) => [path.join(srcDir, w.name + ext), path.join(destDir, w.name + ext)] as const);
    const exists = () => new BadRequestError(`World "${w.name}" already exists in the server folder`);
    if (pairs.some(([, d]) => fs.existsSync(d))) throw exists();
    assertNoReparsePoints(folder, destDir);
    const savesDir = path.join(folder, "saves");
    const madeSaves = !fs.existsSync(savesDir);
    const madeWorlds = !fs.existsSync(destDir);
    fs.mkdirSync(destDir, { recursive: true });
    if (madeSaves) undo.push(() => fs.rmdirSync(savesDir));
    if (madeWorlds) undo.push(() => fs.rmdirSync(destDir));
    for (const [s, d] of pairs) {
      try {
        fs.copyFileSync(s, d, fs.constants.COPYFILE_EXCL);
      } catch (e) {
        runUndo(undo); // remove the first copy
        throw (e as NodeJS.ErrnoException).code === "EEXIST" ? exists() : e;
      }
      undo.push(() => fs.rmSync(d, { force: true }));
    }
    return w.name;
  }
}

/** Sets eula=true in the folder's eula.txt, keeping its other lines. `undo` receives a restore step. */
export function writeEula(folder: string, undo: (() => void)[] = []): void {
  const file = path.join(folder, "eula.txt");
  assertNoReparsePoints(folder, file);
  let prev: string | null = null;
  try { prev = fs.readFileSync(file, "utf8"); } catch { /* absent */ }
  let next: string;
  if (prev === null) next = "eula=true\r\n";
  else if (/^\s*eula\s*=.*$/im.test(prev)) next = prev.replace(/^(\s*)eula\s*=.*$/im, "$1eula=true");
  else next = prev + (prev === "" || prev.endsWith("\n") ? "" : "\n") + "eula=true\n";
  fs.writeFileSync(file, next);
  undo.push(() => (prev === null ? fs.rmSync(file, { force: true }) : fs.writeFileSync(file, prev)));
}
