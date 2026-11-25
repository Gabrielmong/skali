# Skáli New Server: Gallery and Install (Plan 3a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the browser, the owner picks a game from a gallery, fills a short setup dialog and gets a ready-to-start server; Steam and Minecraft servers get a one-click Update.

**Architecture:** A small **job runner** on the server runs ordered, persisted steps per server (install or update), writes their output as a console "run" (so the existing log streaming and run picker show it), and exposes a `job` view on every `ServerView`. Install and update are step lists built from new **tool modules** (download + zip, SteamCMD, Java/Temurin, Minecraft sources) and the existing adapter, adopt, ACL and firewall code. The web gets a New server page (gallery + setup dialog), a job panel with Retry, Finish setup for basic servers, an Update dialog, and two Settings additions.

**Tech Stack:**
- Server: Node 22 (global `fetch`), TypeScript, Express 5, better-sqlite3, Vitest; new deps `yazl` + `yauzl` (+ `@types/yazl`, `@types/yauzl`).
- Web: React 19, MUI 9, react-router 8, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-24-skali-setup-design.md` (approved; its "Decisions settled after the builder check" section is binding). Parent: `docs/superpowers/specs/2026-11-23-skali-design.md` §Gallery and setup, §Updates and backups.

## Global Constraints

- Owner directive: work on `main`; never commit, push, `git add`, stash, reset, checkout or branch. "Commit" steps mean **stop and report**. Never set `SKALI_ADMIN_TESTS=1`. Never run `install-service.ps1`, `uninstall-service.ps1`, `apply-service-settings.ps1`, `install-deployer.ps1` except with `-DryRun`. Never create Windows users, change ACLs, touch the firewall or call `icacls`/`nssm`/`sc` for real on the dev PC; tests inject fakes for every such call (existing pattern: `firewall`, `acl` deps in `Adopter`).
- Run pnpm as `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm …` from the repo root. `pnpm typecheck` and `pnpm test` stay green (CI runs them). Unit tests never touch the network: every HTTP call goes through an injected `fetch`, every SteamCMD call through an injected process runner.
- Tools live under `<dataDir>\tools\` (`path.win32.join(cfg.dataDir, "tools", …)`): `steamcmd\steamcmd.exe`, `java\<major>\`. Backups go to `<dataDir>\backups\<serverId>\<timestamp>-pre-update.zip`.
- Download sources, and only these: SteamCMD `https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip`; Mojang `https://piston-meta.mojang.com/mc/game/version_manifest_v2.json`; PaperMC's current download API (Fill v3, `https://fill.papermc.io/v3/projects/paper/...`; verify it's live when implementing); Adoptium `https://api.adoptium.net/v3/assets/latest/<major>/hotspot?architecture=x64&image_type=jre&os=windows&vendor=eclipse`.
- Downloads go to a temp file in the destination folder and are renamed into place only after the hash (when the source publishes one: Mojang SHA-1, Paper SHA-256, Adoptium SHA-256) matches. Zip extraction refuses entries that resolve outside the target folder.
- Steam IDs: Palworld `2394010`, Valheim `896660`, anonymous login. SteamCMD command: `+force_install_dir <folder> +login anonymous +app_update <id> validate +quit` (argv elements, no shell).
- Only one SteamCMD process at a time across all jobs; a waiting job logs `Waiting for SteamCMD (another install or update is running)`.
- Install folder rules = adopt's `checkFolder` deny rules (drive root, Windows, Program Files, ProgramData itself, Skáli data/install dir, user profiles) and the folder must be **new or empty**; Retry skips the new-or-empty check. Default `<gamesRoot>\<name>`.
- `gamesRoot` default: `D:\GameServers` when `D:\` exists, else `C:\GameServers`.
- Server names keep `NAME_RE`; firewall rule names keep `Skali - <server> - <port>/<PROTO>` via `ensureFirewallRules`.
- Job copy (exact): Skáli restart during install → `Skáli restarted during the install`; during update → `Skáli restarted during the update — check the server, then start it`; login needed → `This server needs a Steam login, which isn't supported yet (coming with Steam login in a later update)`.
- Secrets never in logs. A Palworld server password entered at setup is kept in the sealed `secrets` (`installServerPassword`) until the seed step writes it into the ini, then removed from `secrets`.
- Palworld REST `save` timeout: `60_000` ms (other calls keep 5 s).
- DB schema goes v2 → **v3** in exactly one new `MIGRATIONS` entry.
- Every mutating `/api` request already needs `X-Skali: 1` and the allowlist; new routes add nothing for this.

## Review Focus

1. **Skáli restarts (auto-deploy, reboot) in the middle of a job.** Expected: the job is marked failed with the exact copy above, install → Retry works, update → server stays stopped with `desired: "stopped"`. Tested in Task 7.
2. **Two installs at once.** Expected: the second waits for SteamCMD instead of corrupting its state, and both finish. Tested in Task 7 (runner) with Task 4's lock.
3. **Owner types an app ID that's Linux-only, a game (not a server), or nonsense.** Expected: app-info says "no Windows build" / "not found" and Create stays disabled; a server is never created. Tested in Task 4 (parser) and Task 6 (route).
4. **A port another program already listens on** (e.g. Home on the same PC, or a second Valheim on 2456). Expected: shown as a clash in the dialog and refused at Create. Tested in Task 5.
5. **A world folder that's huge or missing** at update time. Expected: missing → backup skipped with a log line; present → zip streams (no whole-file buffering) and a failed zip stops the update before any file changes. Tested in Task 3 (zip) and Task 9 (update steps).

---

## File structure

**Server (`apps/server/src`)**

| Path | Change | Holds |
|---|---|---|
| `db.ts` | modify | v3 migration |
| `servers/repo.ts` | modify | `steamAppId`, `setupPending`, `createdFolder`, `job` fields |
| `settings.ts` | modify | `gamesRoot` |
| `games/types.ts`, `games/*.ts` | modify | `steamAppId`, `installDefaults()`, `saveLocations()` |
| `channels/palworld-rest.ts` | modify | save timeout 60 s |
| `tools/download.ts` | new | `download()`, `extractZip()`, `zipPaths()` |
| `tools/steamcmd.ts` | new | ensure, run (locked), progress/failure parsing, app info |
| `tools/java.ts` | new | Temurin per major, installed majors |
| `tools/minecraft-sources.ts` | new | Vanilla/Paper version lists and downloads |
| `system/acl.ts` | modify | `grantReadExecute()` |
| `system/ports.ts` | new | port clash check |
| `servers/folders.ts` | new | folder deny rules shared by adopt and install |
| `games/catalog.json`, `games/catalog.ts` | new | built-in list + loader |
| `jobs/runner.ts` | new | `JobRunner` |
| `jobs/install.ts` | new | `Installer` (create + install steps + retry) |
| `jobs/update.ts` | new | update steps |
| `http/setup-routes.ts` | new | catalog, app-info, versions, ports, install, retry, update, tools |
| `http/app.ts`, `http/views.ts`, `http/ws-hub.ts`, `http/busy.ts`, `proc/supervisor.ts`, `main.ts` | modify | wiring |

**Other:** `packages/shared/src/index.ts` (types), `tools/catalog/generate.mjs` + `README.md` (dev script), `apps/web/src/pages/NewServerPage.tsx`, `apps/web/src/components/setup/*`, `apps/web/src/components/JobPanel.tsx`, `UpdateDialog.tsx`, `FinishSetup.tsx`, Settings page, `docs/RUNNING.md`, `docs/NICE-TO-HAVES.md`.

---

### Task 1: Data model — shared types, DB v3, repo, settings

**Files:**
- Modify: `packages/shared/src/index.ts`, `apps/server/src/db.ts`, `apps/server/src/servers/repo.ts`, `apps/server/src/settings.ts`, `apps/web/src/api.ts` (AppSettings type only)
- Test: `apps/server/test/servers/repo.test.ts`, `apps/server/test/db-migration.test.ts`, `apps/server/test/settings.test.ts`, `apps/server/test/schema-version.test.ts`

**Interfaces:**
- Produces (shared):
  ```ts
  export type JobKind = "install" | "update";
  export type JobStepState = "pending" | "running" | "done" | "failed" | "skipped";
  export interface JobStepView { id: string; label: string; state: JobStepState }
  export interface JobView { kind: JobKind; state: "running" | "failed"; steps: JobStepView[]; progress: number | null; error?: string; runId: string }
  export type MinecraftFlavour = "vanilla" | "paper";
  export interface InstallRequest {
    game: GameId; name: string; folder: string; launch: LaunchValues;
    appId?: number;                                   // basic only
    minecraft?: { flavour: MinecraftFlavour; version: string };
    palworld?: { serverName: string; serverPassword: string; maxPlayers: number };
    acceptEula?: boolean;                             // minecraft: must be true
  }
  export interface UpdateRequest { minecraft?: { flavour: MinecraftFlavour; version: string } }
  export interface CatalogEntry { appId: number | null; game: GameId; name: string; star: boolean; ports?: PortSpec[]; exeHint?: string; notes?: string }
  export interface SteamAppInfo { appId: number; name: string; windows: boolean }
  export interface PortClash { port: number; protocol: "udp" | "tcp"; reason: string }
  export interface ToolsStatus { steamcmd: boolean; java: number[] }
  ```
  `ServerView` gains `job: JobView | null; setupPending: boolean; createdFolder: boolean; steamAppId: number | null`.
- Produces (server): `ServerRecord` gains `steamAppId: number | null; setupPending: boolean; createdFolder: boolean; job: PersistedJob | null` where
  `PersistedJob = { kind: JobKind; state: "running" | "failed"; steps: JobStepView[]; error?: string; runId: string; params: Record<string, unknown> }` (exported from `repo.ts`). `repo.create(...)` accepts the three new optional fields (default null/false/false); `repo.update` accepts all four.
- Produces: `AppSettings.gamesRoot: string`; `defaultGamesRoot(exists = fs.existsSync): string` exported from `settings.ts`.

- [ ] **Step 1: Write failing tests**
  - `repo.test.ts`: `"round-trips steamAppId, setupPending, createdFolder and job"` — create with `{ steamAppId: 896660, createdFolder: true }`, update `{ setupPending: true, job: { kind: "install", state: "failed", steps: [{ id: "files", label: "Game files", state: "failed" }], error: "x", runId: "r", params: { a: 1 } } }`, `get()` returns them equal; `update(id, { job: null })` clears it. Defaults for a plain create: `null, false, false, null`.
  - `db-migration.test.ts`: a v2 database with one server row migrates to v3 and the row reads back with the defaults above; `SCHEMA_VERSION === 3`.
  - `settings.test.ts`: `defaultGamesRoot(() => true) === "D:\\GameServers"`, `defaultGamesRoot(() => false) === "C:\\GameServers"`; `update({ gamesRoot: "relative" })` throws `BadRequestError("Games root must be an absolute folder path")`; `update({ gamesRoot: "C:\\" })` throws (drive root); `update({ gamesRoot: "E:\\Games" })` stores it.
- [ ] **Step 2: Run them, expect failures** — `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm --filter @skali/server exec vitest run test/servers/repo.test.ts test/db-migration.test.ts test/settings.test.ts test/schema-version.test.ts`
- [ ] **Step 3: Implement.** v3 migration: `ALTER TABLE servers ADD COLUMN steam_app_id INTEGER; ADD COLUMN setup_pending INTEGER NOT NULL DEFAULT 0; ADD COLUMN created_folder INTEGER NOT NULL DEFAULT 0; ADD COLUMN job TEXT;` (`job` JSON, never containing secrets). `gamesRoot` validation: absolute Windows path, not a drive root, no `"`; the full folder deny rules are applied at install time (Task 5). Update `toView` in `http/views.ts` to emit the four new `ServerView` fields with `job: null` for now (Task 7 fills it). Fix any typecheck fallout in web fixtures that build `ServerView`s.
- [ ] **Step 4: Run tests + `pnpm typecheck`, expect PASS.**
- [ ] **Step 5: Stop and report (no commit).**

### Task 2: Adapter additions and Palworld save timeout

**Files:**
- Modify: `apps/server/src/games/types.ts`, `palworld.ts`, `valheim.ts`, `minecraft.ts`, `basic.ts`, `apps/server/src/channels/palworld-rest.ts`
- Test: `apps/server/test/games/*.test.ts` (existing files per adapter), `apps/server/test/channels/palworld-rest.test.ts`

**Interfaces:**
- Produces on `GameAdapter`:
  - `steamAppId: number | null` — palworld `2394010`, valheim `896660`, minecraft `null`, basic `null` (basic's comes from the record).
  - `installDefaults(): LaunchValues` — the same values `inspectFolder` returns today on success (palworld `{ port: 8211, players: 32, perfFlags: true, restPort: 8212, extraArgs: "" }`; valheim/minecraft/basic: their current inspect defaults; minecraft adds `mcFlavour: "vanilla"`). Refactor `inspectFolder` to use it.
  - `saveLocations(s: ServerRecord): string[]` — absolute paths: palworld `<folder>\Pal\Saved\SaveGames`; valheim `<folder>\saves` (the `-savedir` it launches with); minecraft `<folder>\<level>`, `<level>_nether`, `<level>_the_end` where `<level>` is `level-name` from `server.properties` (default `world`; read with the Plan 2 properties parser); basic `[]`.
- Produces: `createPalworldRest` default `saveTimeoutMs` = `60_000`.
- Produces: `toView` emits `steamAppId: rec.steamAppId ?? adapter.steamAppId` (so adopted Palworld/Valheim servers show Update), and every consumer that needs a server's app ID uses the same fallback — export it as `effectiveAppId(rec: ServerRecord, adapter: GameAdapter): number | null` from `games/types.ts`.

- [ ] **Step 1: Failing tests** — per adapter: `installDefaults()` equals the literal above / current inspect defaults; `saveLocations` for a temp folder (minecraft with `level-name=myworld` → three paths ending `myworld`, `myworld_nether`, `myworld_the_end`; no `server.properties` → `world…`). Palworld REST: a fake fetch that never answers; `save()` aborts after the configured timeout and the default is `60_000` (assert via an exported `DEFAULT_SAVE_TIMEOUT_MS`).
- [ ] **Step 2: Run, expect FAIL** — `… vitest run test/games test/channels/palworld-rest.test.ts`
- [ ] **Step 3: Implement.** Palworld `defaultStopTimeoutSec` stays 120 (≥ 60 s save + shutdown wait); confirm in the report.
- [ ] **Step 4: Run, expect PASS** (plus `pnpm typecheck`).
- [ ] **Step 5: Stop and report.**

### Task 3: Download, extract and zip utilities

**Files:**
- Create: `apps/server/src/tools/download.ts`; add deps `yazl`, `yauzl`, `@types/yazl`, `@types/yauzl` to `apps/server/package.json`
- Test: `apps/server/test/tools/download.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type FetchFn = typeof fetch;
  export interface DownloadOpts { fetch?: FetchFn; sha1?: string; sha256?: string; onProgress?: (pct: number | null) => void }
  export async function download(url: string, dest: string, opts?: DownloadOpts): Promise<void>;
  export async function extractZip(zipFile: string, destDir: string): Promise<void>;
  /** Streams each existing path (file or folder, recursively) into one zip; entries are named relative to `baseDir`. Returns false (and writes nothing) when no path exists. */
  export async function zipPaths(paths: string[], baseDir: string, destZip: string): Promise<boolean>;
  ```
- [ ] **Step 1: Failing tests**
  - `download writes the body to dest via a temp file and renames it` (fake fetch returning a `Response` with a 3-chunk body; dest content equals; no `*.part` left).
  - `download rejects on hash mismatch and leaves no file` (sha256 wrong → throws `/checksum/i`, `dest` and temp absent).
  - `download rejects on non-2xx` (404 → throws containing `404`).
  - `download reports progress from content-length` (values ascending, last is 100); without content-length → `null`.
  - `extractZip extracts files and folders` (build a zip with `yazl` in the test).
  - `extractZip refuses an entry outside destDir` (entry `../evil.txt` → throws, nothing written outside).
  - `zipPaths zips a folder tree and a single file; extractZip round-trips it`.
  - `zipPaths returns false when no path exists` and creates no file.
  - `zipPaths failure removes the partial zip` (a path that's unreadable mid-way can be simulated by passing a dangling symlink-free unreadable file via a stubbed stream; acceptable alternative: destination folder missing → rejects and nothing left).
- [ ] **Step 2: Run, expect FAIL** — `… vitest run test/tools/download.test.ts`
- [ ] **Step 3: Implement** with `stream.pipeline` (no whole-file buffering), `crypto.createHash` while streaming, temp name `<dest>.part`, `fs.rename` at the end. `zipPaths` writes to `<destZip>.part` then renames.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Stop and report.**

### Task 4: SteamCMD module

**Files:**
- Create: `apps/server/src/tools/steamcmd.ts`, `apps/server/test/fixtures/steamcmd/*.txt`
- Test: `apps/server/test/tools/steamcmd.test.ts`

**Interfaces:**
- Consumes: `download`, `extractZip` (Task 3); `Mutex` (`util/mutex.ts`).
- Produces:
  ```ts
  export type LineRunner = (exe: string, args: string[], onLine: (line: string) => void) => Promise<number>; // exit code
  export interface SteamCmdDeps { toolsDir: string; run?: LineRunner; fetch?: FetchFn; lock?: Mutex }
  export class SteamCmd {
    constructor(deps: SteamCmdDeps);
    readonly exe: string;                         // <toolsDir>\steamcmd\steamcmd.exe
    installed(): boolean;
    ensure(log: (l: string) => void): Promise<void>;   // download + extract if missing
    /** Waits for the shared lock; calls onWait once if it had to wait. Throws SteamCmdError on failure. */
    appUpdate(folder: string, appId: number, io: { log: (l: string) => void; progress: (p: number | null) => void; onWait?: () => void }): Promise<void>;
    appInfo(appId: number): Promise<SteamAppInfo | null>;  // null = unknown app; ensures SteamCMD first and takes the same lock
  }
  export class SteamCmdError extends Error { constructor(readonly kind: "login" | "failed", message: string) }
  export function parseProgress(line: string): number | null;
  export function parseAppInfo(appId: number, output: string): SteamAppInfo | null;
  ```
- [ ] **Step 1: Record fixtures.** In a scratch folder outside the repo, download SteamCMD and capture: `+login anonymous +app_info_update 1 +app_info_print 896660 +quit` (Valheim server: windows), `… +app_info_print 4020 +quit` or another known Linux-only/no-windows app if you can find one, `… +app_info_print 999999999 +quit` (unknown), and the first-run self-update output. For `app_update` success/progress/no-subscription lines, if you can't capture them without a large download, write fixtures from these known formats and say so in the report: ` Update state (0x61) downloading, progress: 45.12 (123456 / 273600)`, `Success! App '896660' fully installed.`, `ERROR! Failed to install app '123' (No subscription)`. Save as `apps/server/test/fixtures/steamcmd/*.txt`. Never commit or keep the scratch SteamCMD in the repo.
- [ ] **Step 2: Failing tests**
  - `parseProgress` → `45.12` for the line above, `null` for others.
  - `parseAppInfo(896660, fixture)` → `{ appId: 896660, name: "Valheim Dedicated Server", windows: true }`; unknown fixture → `null`; a depot set without `windows` in any `oslist` → `windows: false`.
  - `appUpdate` passes argv exactly `["+force_install_dir", folder, "+login", "anonymous", "+app_update", "896660", "validate", "+quit"]`, forwards lines to `log`, progress to `progress`, resolves on the `Success!` line.
  - `appUpdate` throws `SteamCmdError` kind `"login"` on `No subscription` / `Login Failure` / `requires a Steam account`-style lines, kind `"failed"` on other `ERROR!` lines or a missing `Success!`.
  - `two appUpdate calls run one at a time and the second calls onWait` (fake runner with deferred promises).
  - `ensure downloads and extracts when steamcmd.exe is missing, and does nothing when present` (fake fetch serving a zip built with yazl containing `steamcmd.exe`).
- [ ] **Step 3: Run, expect FAIL** — `… vitest run test/tools/steamcmd.test.ts`
- [ ] **Step 4: Implement.** The default `LineRunner` spawns with `windowsHide`, splits stdout+stderr on `\r` or `\n`, no shell. SteamCMD's exit code is not trusted; success is the `Success!` line. Retry `appUpdate` once automatically when the output shows SteamCMD self-updated and quit before installing (first-run behaviour).
- [ ] **Step 5: Run, expect PASS. Stop and report.**

### Task 5: Java, Minecraft sources, ports, folder rules

**Files:**
- Create: `apps/server/src/tools/java.ts`, `apps/server/src/tools/minecraft-sources.ts`, `apps/server/src/system/ports.ts`, `apps/server/src/servers/folders.ts`
- Modify: `apps/server/src/system/acl.ts`, `apps/server/src/servers/adopt.ts` (use `folders.ts`)
- Test: `apps/server/test/tools/java.test.ts`, `test/tools/minecraft-sources.test.ts`, `test/system/ports.test.ts`, `test/servers/folders.test.ts` (adopt tests stay green unchanged)

**Interfaces:**
- Produces:
  ```ts
  // tools/java.ts
  export class JavaTools {
    constructor(deps: { toolsDir: string; fetch?: FetchFn; grant?: (dir: string) => Promise<void> });
    javaExe(major: number): string;                 // <toolsDir>\java\<major>\bin\java.exe
    installedMajors(): number[];                    // sorted ascending
    ensure(major: number, log: (l: string) => void): Promise<string>; // returns javaExe; downloads, verifies sha256, extracts (flattening the zip's single top folder), then grant(<toolsDir>\java)
    isManaged(javaPath: string): boolean;           // true when javaPath is under <toolsDir>\java\
  }
  // tools/minecraft-sources.ts
  export interface McDownload { url: string; sha1?: string; sha256?: string; javaMajor: number; build?: number }
  export class MinecraftSources {
    constructor(deps?: { fetch?: FetchFn });
    versions(flavour: MinecraftFlavour): Promise<{ versions: string[]; latest: string }>; // releases only, newest first
    resolve(flavour: MinecraftFlavour, version: string): Promise<McDownload>;
  }
  export function compareMcVersions(a: string, b: string): number; // "1.21.4" vs "1.20.6"
  // system/acl.ts
  export async function grantReadExecute(folder: string, user: string, run?: typeof runProcess): Promise<void>; // icacls <folder> /grant <user>:(OI)(CI)RX /Q
  // system/ports.ts
  export type PortProbe = (port: number, protocol: "udp" | "tcp") => Promise<boolean>; // true = free
  export async function findPortClashes(ports: PortSpec[], others: { name: string; ports: PortSpec[] }[], probe?: PortProbe): Promise<PortClash[]>;
  // servers/folders.ts
  export function assertAllowedFolder(folder: string, usersRoot: string, prot: ProtectedPaths, verb: "adopted" | "used"): string; // returns resolved path; throws BadRequestError("This folder can't be <verb>: <why>")
  export function assertNewOrEmpty(folder: string): void; // throws BadRequestError("The install folder must be new or empty")
  ```
  `ProtectedPaths` and `defaultProtected()` move to `folders.ts` (re-exported from `adopt.ts` so existing imports keep working).
- Java major for Paper: Paper's API gives no Java version; use Mojang's `javaVersion.majorVersion` for the same version id for both flavours.
- [ ] **Step 1: Failing tests**
  - Java: `ensure` with a fake fetch (assets JSON with `binary.package.link` + `checksum`, then a zip whose single top folder is `jdk-21.0.5+11-jre/bin/java.exe`) produces `<toolsDir>\java\21\bin\java.exe` and calls `grant` with `<toolsDir>\java`; checksum mismatch → throws, no folder left; second `ensure` makes no fetch; `isManaged` true/false cases.
  - Minecraft: vanilla `versions` filters `type === "release"` and returns manifest `latest.release`; `resolve("vanilla","1.21.4")` returns the version JSON's `downloads.server.url/sha1` and `javaVersion.majorVersion`; a version with no `downloads.server` → `BadRequestError("Minecraft <v> has no server download")`; paper `resolve` returns latest stable build url + sha256 and the Mojang java major; `compareMcVersions("1.21.10","1.21.9") > 0`.
  - Ports: clash with another server (same port+protocol) → reason `Used by <name>`; same port different protocol → no clash; probe returns false → reason `Something on this PC is already using it`; real default probe test: bind a TCP server on an ephemeral port in the test, `findPortClashes` reports it; duplicate within the request itself → `Listed twice`.
  - Folders: drive root, `C:\Windows\x`, ProgramData itself, Skáli data dir, `C:\Users\bob` all rejected with `can't be used`; `assertNewOrEmpty` passes for a missing path and an empty folder, rejects a folder with one file.
- [ ] **Step 2: Run, expect FAIL.** `… vitest run test/tools test/system/ports.test.ts test/servers`
- [ ] **Step 3: Implement.** Default probe binds `0.0.0.0` (`net.createServer().listen` for TCP, `dgram` bind for UDP) and closes immediately.
- [ ] **Step 4: Run, expect PASS** (adopt tests included).
- [ ] **Step 5: Stop and report.**

### Task 6: Catalog and its routes

**Files:**
- Create: `tools/catalog/generate.mjs`, `tools/catalog/README.md`, `apps/server/src/games/catalog.json`, `apps/server/src/games/catalog.ts`, `apps/server/src/http/setup-routes.ts`
- Modify: `apps/server/src/http/app.ts` (mount router; `AppDeps.setup?`)
- Test: `apps/server/test/games/catalog.test.ts`, `apps/server/test/http/setup-routes.test.ts`

**Interfaces:**
- Consumes: `SteamCmd.appInfo` (Task 4), `MinecraftSources` (Task 5), `findPortClashes` (Task 5).
- Produces:
  ```ts
  // games/catalog.ts
  export function catalog(): CatalogEntry[]; // ★ entries first (palworld 2394010, valheim 896660, minecraft null; star: true, game set), then catalog.json entries sorted by name (game: "basic", star: false)
  // http/setup-routes.ts
  export interface SetupRouteDeps {
    steamCmd: Pick<SteamCmd, "appInfo" | "installed">;
    java: Pick<JavaTools, "installedMajors">;
    mcSources: Pick<MinecraftSources, "versions">;
    portsInUse: (exceptId?: string) => { name: string; ports: PortSpec[] }[];
    probe?: PortProbe;
  }
  export function setupRouter(deps: SetupRouteDeps): Router; // mounted at /api
  ```
  Routes (this task): `GET /api/catalog` → `CatalogEntry[]`; `POST /api/steam/app-info` `{ appId }` → `SteamAppInfo` or 404 `{ error: "No Steam app with that ID" }` (appId must be a positive integer ≤ 2^31, else 400); `GET /api/minecraft/versions?flavour=vanilla|paper`; `POST /api/servers/check-ports` `{ ports: PortSpec[], exceptId? }` → `{ clashes: PortClash[] }`; `GET /api/tools` → `ToolsStatus`. Tasks 8–9 add more routes to this router.
- `catalog.json` entry shape: `{ "appId": number, "name": string, "ports"?: PortSpec[], "exeHint"?: string, "notes"?: string }`, top-level `{ "source": "LinuxGSM (MIT) …", "generated": "<ISO date>", "entries": [...] }`.
- [ ] **Step 1: Write and run the generator.** `tools/catalog/generate.mjs <steamcmd.exe> [out]` reads LinuxGSM's `lgsm/data/serverlist.csv` and each server's `_default.cfg` (`appid`, `port`/`queryport` defaults) from `raw.githubusercontent.com/GameServerManagers/LinuxGSM/master/…` (verify current paths), keeps entries with a Steam app id that `app_info_print` shows has a `windows` depot, excludes 2394010 and 896660, and writes `catalog.json`. Run it once with a scratch SteamCMD (from Task 4's approach). If it can't finish (network, rate limits), ship what verified and say how many entries in the report. README: what it does, how to rerun, attribution.
- [ ] **Step 2: Failing tests** — catalog: ★ entries first in order palworld, valheim, minecraft; no duplicate appIds; every entry `appId` positive integer and `game === "basic"`; json `source` mentions LinuxGSM. Routes (supertest on a bare express app with the router and fakes): app-info 200/404/400 cases; versions passes flavour and 400 on others; check-ports returns clashes from fakes and excludes `exceptId`; tools returns `{ steamcmd: true, java: [21] }` from fakes.
- [ ] **Step 3: Run, expect FAIL. Step 4: Implement, mount in `createApp` when `deps.setup` is given. Step 5: Run, expect PASS. Stop and report.**

### Task 7: Job runner, start guard, busy reasons, job in views

**Files:**
- Create: `apps/server/src/jobs/runner.ts`
- Modify: `apps/server/src/proc/supervisor.ts`, `apps/server/src/http/views.ts`, `apps/server/src/http/ws-hub.ts`, `apps/server/src/http/busy.ts`, `apps/server/src/http/app.ts`
- Test: `apps/server/test/jobs/runner.test.ts`, `test/proc/supervisor*.test.ts` (start guard), `test/http/busy.test.ts`, `test/http/views.test.ts`

**Interfaces:**
- Consumes: `repo.update(id, { job })`, `createRun`, `appendSkaliLine` (`logs/runs.ts`), `SupervisorEvent` "log" shape.
- Produces:
  ```ts
  export interface StepCtx { log(line: string): void; progress(pct: number | null): void }
  export interface JobStep { id: string; label: string; run(ctx: StepCtx): Promise<void> }
  export interface JobRunnerDeps {
    repo: ServerRepo; logsDir: string;
    emit: (e: SupervisorEvent) => void;          // "log" events, same as the supervisor's
    changed: (serverId: string) => void;         // → AppEvent "changed"
    now?: () => Date;
  }
  export class JobRunner {
    constructor(deps: JobRunnerDeps);
    /** Persists a running job (new run log), runs steps from the first not-done one, persists every state change. Resolves when finished; rejects never — failures land in the job. */
    run(serverId: string, kind: JobKind, steps: JobStep[], params: Record<string, unknown>, opts?: { resume?: boolean; onDone?: () => Promise<void> }): Promise<void>;
    isRunning(serverId: string): boolean;
    view(serverId: string): JobView | null;        // from the record's job + live progress
    busyReasons(): string[];                       // "<name> is installing" | "<name> is updating"
    /** At startup: every persisted running job becomes failed with the exact copy; update jobs also set desired "stopped". */
    boot(): void;
    clear(serverId: string): void;                 // job = null
  }
  ```
  On success the job is cleared (`job: null`) and `onDone` runs; on failure `state: "failed"`, the failing step `failed`, later steps stay `pending`, `error` = the step's error message (for `SteamCmdError` kind `login`, the exact login copy). With `resume: true`, steps already `done` are `skipped`-not-rerun (keep their `done` state) and a **new** run log is created.
- `SupervisorDeps.startGuard?: (id: string) => string | null`; `start()` throws `ConflictError(reason)` when it returns a reason; `boot()` auto-start skips such servers without marking them crashed.
- `toView(rec, state, adapter, settings, job: JobView | null)`; `WsHubDeps.job: (id) => JobView | null`; `BusyDeps.jobReasons?: () => string[]` appended to `reasons`.
- Start guard reasons (exact): job running → `Installing…` / `Updating…`; failed install → `Install failed — retry or remove it`; `setupPending` → `Finish setup first`.
- [ ] **Step 1: Failing tests (runner)** — steps run in order and the job clears on success; a throwing step → failed state with error, later steps pending, `changed` called on every transition; log lines land in the run's `console.log` and as `log` events with the job's `runId`; resume skips `done` steps; `boot()` converts running install → failed with `Skáli restarted during the install`, running update → failed with the update copy and `desired: "stopped"`; `busyReasons` while running; progress appears in `view()` and resets to null between steps; secrets never appear in the log (a step logging is the step's responsibility — assert the runner itself logs only step labels and errors).
- [ ] **Step 2: Failing tests (wiring)** — supervisor `start` refused with each guard reason; busy route includes job reasons; `toView` passes job through.
- [ ] **Step 3: Run, expect FAIL. Step 4: Implement. Step 5: Run, expect PASS (whole server suite). Stop and report.**

### Task 8: Installer — create, install steps, retry, remove

**Files:**
- Create: `apps/server/src/jobs/install.ts`
- Modify: `apps/server/src/http/setup-routes.ts`, `apps/server/src/http/app.ts` (DELETE `deleteFolder`, PATCH `steamAppId` + clearing `setupPending`), `apps/server/src/servers/adopt.ts` (`remove` refuses while a job runs; returns), `apps/server/src/main.ts` (construct `SteamCmd`, `JavaTools`, `MinecraftSources`, `JobRunner`, `Installer`; call `jobs.boot()` before `supervisor.boot()`)
- Test: `apps/server/test/jobs/install.test.ts`, `test/http/setup-routes.test.ts`, `test/http/app*.test.ts`

**Interfaces:**
- Consumes: Tasks 1–7.
- Produces:
  ```ts
  export interface InstallerDeps {
    repo: ServerRepo; runner: JobRunner; adapter: (id: GameId) => GameAdapter;
    steamCmd: SteamCmd; java: JavaTools; mc: MinecraftSources;
    settings: SettingsStore; configService: Pick<ConfigService, "read" | "save">;
    gamesUser: string | null; acl?: typeof grantModify; firewall?: typeof ensureFirewallRules;
    probe?: PortProbe; protectedPaths?: Partial<ProtectedPaths>; usersRoot?: string;
  }
  export class Installer {
    constructor(deps: InstallerDeps);
    /** Validates, creates the folder + record (createdFolder true, job running), starts the job without awaiting it, returns the record. */
    install(req: InstallRequest): Promise<ServerRecord>;
    retry(serverId: string): Promise<void>;        // ConflictError unless the job is a failed install
  }
  ```
  Routes: `POST /api/servers/install` (body keys exactly those of `InstallRequest`) → 201 `ServerView`; `POST /api/servers/:id/retry` → 202. `DELETE /api/servers/:id?deleteFolder=1` deletes the folder (`fs.rm` recursive) only when `createdFolder` and the job is a failed install; otherwise the flag is ignored. `PATCH` accepts `steamAppId` (basic only, positive integer or null); any PATCH with `launch` on a `setupPending` server validates that `launch.exe` exists in the folder, then sets `setupPending: false` (firewall re-sync already happens on port change; make sure it also happens on this first save).
- Validation in `install()` (all before anything is created; `BadRequestError` messages are shown in the dialog): name (`NAME_RE`, unique), folder (`assertAllowedFolder(…, "used")` + `assertNewOrEmpty`), `adapter.validateLaunch`, ports (`findPortClashes` against other servers + probe → `Port <p>/<proto>: <reason>`), basic needs `appId`, minecraft needs `minecraft` and `acceptEula === true` (`Accept the Minecraft EULA to continue`), palworld needs `palworld`.
- Steps by game (ids/labels exact):
  - Steam games (palworld, valheim, basic): `steamcmd` "Get SteamCMD" → `files` "Download game files" (`appUpdate`, then `adapter.inspectFolder` must be ok for palworld/valheim, else fail `Server program not found after install`) → `config` "Write settings" → `permissions` "Folder permissions" (`grantModify` when `gamesUser`) → `firewall` "Firewall rules" → basic adds `confirm` "Confirm server program" (sets `setupPending: true` and launch `exe` to the basic adapter's suggestion, ports from the catalog entry if any).
  - Minecraft: `java` "Get Java <major>" → `files` "Download server jar" (`server.jar`, verified) → `config` "Write settings" (`writeEula`; seed `server.properties` with `server-port`, and the adapter's RCON keys if they aren't already set by `prepare`) → `permissions` → `firewall`. Launch values set: `jar: "server.jar"`, `javaPath: java.ensure(...)`, `mcFlavour`, `mcVersion`, `paperBuild` (paper), `memoryMb`.
  - Palworld `config`: `configService.read` the `palworld-settings` source (seeds from Default), then `save` with `changes: { ServerName, ServerPassword, ServerPlayerMaxNum }` from `params` + `secrets.installServerPassword`; afterwards remove `installServerPassword` from `secrets`. Valheim `config`: nothing beyond launch values (no-op step, still listed).
  - Record created with `steamAppId` = adapter's or `appId`, `createdFolder: true`, launch = `{ ...adapter.installDefaults(), ...req.launch }` (Palworld also sets `players` = `palworld.maxPlayers`).
  - Job `params` hold everything non-secret the steps need (game, appId, minecraft choice, Palworld server name and max players); `retry()` rebuilds the same step list from `params` and calls `runner.run(…, { resume: true })`.
- [ ] **Step 1: Failing tests** (fakes for SteamCmd/Java/Mc/acl/firewall/probe; temp folders):
  - `install rejects a non-empty folder / bad name / clash / missing EULA` with the messages above and creates nothing (no record, no folder).
  - `palworld install runs steps in order` (fake `appUpdate` creates the exe and `DefaultPalWorldSettings.ini`), ends with job cleared, ini contains `ServerName="My server"` and the password, `secrets.installServerPassword` gone, firewall called with the server's ports, acl called with folder + games user.
  - `valheim install` sets `steamAppId: 896660` and launch world/password from the request.
  - `minecraft install` writes `eula.txt` (`eula=true`), `server.jar`, launch `javaPath` = managed java exe, `mcFlavour`/`mcVersion`.
  - `basic install ends setupPending with suggested exe`; PATCH with launch whose exe exists clears it; with a missing exe → 400.
  - `a SteamCmdError login fails the job with the login copy`; `retry resumes at the failed step` (first `appUpdate` throws, second succeeds; `steamcmd` step not rerun).
  - `remove of a failed install with deleteFolder deletes the folder; without it keeps it; remove while installing → 409`.
  - Route tests: install 201 body has `job.state === "running"`; unknown body key → 400; retry 202/409.
- [ ] **Step 2: Run, expect FAIL. Step 3: Implement. Step 4: Run, expect PASS + typecheck. Step 5: Stop and report.**

### Task 9: Update job and pre-update backup

**Files:**
- Create: `apps/server/src/jobs/update.ts`
- Modify: `apps/server/src/http/setup-routes.ts`, `apps/server/src/main.ts`
- Test: `apps/server/test/jobs/update.test.ts`, `test/http/setup-routes.test.ts`

**Interfaces:**
- Consumes: `JobRunner`, `SteamCmd`, `JavaTools`, `MinecraftSources`, `compareMcVersions`, `zipPaths`, adapter `saveLocations`, supervisor `stop`/`start`/`state`.
- Produces:
  ```ts
  export interface UpdaterDeps { repo: ServerRepo; runner: JobRunner; adapter: (id: GameId) => GameAdapter; supervisor: Pick<Supervisor, "stop" | "start" | "state">; steamCmd: SteamCmd; java: JavaTools; mc: MinecraftSources; backupsDir: string; now?: () => Date }
  export class Updater {
    constructor(deps: UpdaterDeps);
    /** Throws BadRequestError when the server can't be updated; starts the job without awaiting. Returns warnings (e.g. downgrade). */
    update(serverId: string, req: UpdateRequest): Promise<{ warnings: string[] }>;
  }
  ```
  Route: `POST /api/servers/:id/update` body `UpdateRequest` → 202 `{ warnings }`. Refused (409) while a job runs or the server is `starting`/`stopping`; refused (400 `This server has no Steam app ID`) for basic without `steamAppId`; minecraft requires `req.minecraft`.
- Steps (ids/labels exact): `stop` "Stop server" (only if running; remember `wasRunning` in params) → `backup` "Back up world" (`zipPaths(adapter.saveLocations(rec), rec.folder, <backupsDir>\<id>\<ISO time with : and . replaced by ->-pre-update.zip)`; returns false → log `No world folder yet; nothing to back up`) → Steam: `files` "Update game files" (`appUpdate` with `effectiveAppId`); Minecraft: `java` "Get Java <major>" (only rewrite `javaPath` when `java.isManaged(current javaPath)`; otherwise log a warning if the majors differ) then `files` "Download server jar" (download to temp, then rename current jar to `<jar>.previous` (replacing an older `.previous`), then move new jar in; update `mcFlavour`/`mcVersion`/`paperBuild`) → `start` "Start server" (only if `wasRunning`). A failure in any step leaves the server stopped (never starts it).
- Downgrade warning (exact): `Minecraft <new> is older than <current>. Worlds opened in a newer version may break; a backup is taken first.` Unknown current version (adopted) → no warning.
- [ ] **Step 1: Failing tests** — running steam server: stop → backup zip exists → appUpdate called with `steamAppId` → started again; stopped server: no stop/start calls; backup failure → job failed and `appUpdate` never called; missing save folder → logged and continues; minecraft: jar replaced, `.previous` kept, managed javaPath switched to new major, unmanaged javaPath kept with a warning line; downgrade returns the warning; route 409 while installing; basic without app id → 400.
- [ ] **Step 2: Run, expect FAIL. Step 3: Implement. Step 4: Run, expect PASS. Step 5: Stop and report.**

### Task 10: Web — New server page and setup dialog

**Files:**
- Create: `apps/web/src/pages/NewServerPage.tsx`, `apps/web/src/components/setup/SetupDialog.tsx`, `apps/web/src/components/setup/PortsField.tsx`, tests beside them
- Modify: `apps/web/src/App.tsx` (route `/new`; app-bar button "New server" → `/new`; `/add` stays), `apps/web/src/api.ts`
- Test: `apps/web/src/pages/NewServerPage.test.tsx`, `apps/web/src/components/setup/SetupDialog.test.tsx`

**Interfaces:**
- Consumes (api.ts additions): `getCatalog()`, `steamAppInfo(appId)`, `minecraftVersions(flavour)`, `checkPorts(ports, exceptId?)`, `installServer(req: InstallRequest)`, `getTools()`, `retryInstall(id)`, `updateServer(id, req)`.
- Page: search box filtering by name (case-insensitive); ★ cards first; "basic" results as a list; an "Other Steam app ID" field that calls `steamAppInfo` and shows the name, `No Windows build — this server can't run here`, or `No Steam app with that ID`, with **Set up** enabled only for a Windows app; a link "Add an existing folder instead" → `/add`.
- Dialog fields: name; install folder (default `<gamesRoot>\<name>`, follows the name until the owner edits it; FolderPicker as on AddServerDialog); ports (from `installDefaults` via the game's `launchFields` defaults or the catalog entry; each shows a clash from `checkPorts`, debounced 400 ms); essentials per the spec table (Palworld server name/password/max players 1–32 default 32; Valheim world/password ≥5 chars/public/crossplay; Minecraft flavour/version (default latest)/memory default 4096/EULA checkbox with a link to `https://aka.ms/MinecraftEULA`; Basic: nothing). **Create** disabled while any clash, EULA unticked (Minecraft), or a required field is empty. Server errors from `installServer` show in the dialog; success navigates to `/servers/<id>`.
- [ ] **Step 1: Failing tests** — filtering; app-ID states; Create disabled on clash and on missing EULA; submit sends the exact `InstallRequest` for Palworld (`palworld: { serverName, serverPassword, maxPlayers }`) and Minecraft (`minecraft: { flavour, version }`, `acceptEula: true`); folder follows name until edited; server error text shown.
- [ ] **Step 2: Run, expect FAIL** — `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm --filter @skali/web exec vitest run src/pages/NewServerPage.test.tsx src/components/setup`
- [ ] **Step 3: Implement. Step 4: Run, expect PASS + typecheck. Step 5: Stop and report.**

### Task 11: Web — job panel, Finish setup, Update, remove, Settings

**Files:**
- Create: `apps/web/src/components/JobPanel.tsx`, `UpdateDialog.tsx`, `FinishSetup.tsx`, tests beside them
- Modify: `apps/web/src/pages/ServerPage.tsx`, `components/ServerCard.tsx`, `components/StatusChip.tsx`, `components/OverviewTab.tsx` (Update button, Steam app ID field for basic, remove dialog checkbox), `components/ServerActions.tsx` (Start disabled with the guard reason when `job` or `setupPending`), `pages/SettingsPage.tsx`
- Test: the new component tests, `ServerCard.test.tsx`, `OverviewTab.test.tsx`, `SettingsPage.test.tsx`

**Interfaces / behaviour:**
- `StatusChip` shows `Installing…`, `Updating…`, `Install failed`, `Update failed` when `job` is set (overriding the supervisor status label), and `Finish setup` when `setupPending`.
- `JobPanel` (top of ServerPage when `job`): step list with state icons, a progress bar when `progress !== null`, the `error` text, **Retry** for a failed install (calls `retryInstall`), and the console tab switched to `job.runId`.
- `FinishSetup` (Overview, when `setupPending`): the basic launch form (existing `LaunchFieldsForm`) pre-filled; Save → `patchServer(id, { launch })`.
- `UpdateDialog`: Steam → a confirm ("Stops the server, backs up the world, updates, and starts it again if it was running"); Minecraft → flavour + version pickers (current shown, `unknown` for adopted) and the downgrade warning from the response. Update button hidden for basic without `steamAppId`.
- Remove dialog: checkbox `Also delete <folder>` (unticked) only when `createdFolder && job?.kind === "install" && job.state === "failed"`; passes `deleteFolder=1`.
- Settings page: "Games folder" text field (saves `gamesRoot`); "Tools" lines: `SteamCMD: installed` / `not installed yet (downloaded on first install)`, `Java: 21, 17` / `none yet`.
- [ ] **Step 1: Failing tests** for each bullet (chip labels, Retry calls api, Start disabled with reason, Update hidden/shown, downgrade warning shown, checkbox visibility and query flag, settings save and tool lines).
- [ ] **Step 2: Run, expect FAIL. Step 3: Implement. Step 4: Run, expect PASS + typecheck. Step 5: Stop and report.**

### Task 12: Docs and acceptance list

**Files:**
- Modify: `docs/RUNNING.md`, `docs/NICE-TO-HAVES.md`

- [ ] **Step 1:** RUNNING.md: replace "Install them manually first (SteamCMD for Palworld, a server jar for Minecraft)." with "Install them from **New server**". Add a section "New server and Update (server PC)" with checkboxes: fresh Palworld install then start + `announce hi`; fresh Valheim install with a new world, start, join; Minecraft Vanilla latest and Paper latest installs, start, `list`; one basic install from the list (Finish setup, start); an app ID typed by hand; a port clash shown for an existing server's port; Update on Valheim while running (backup zip present, server back up); Minecraft update to a newer version (`.previous` jar, world loads); auto-deploy waits during an install (Deploys page shows the busy reason); a forced failure (e.g. disconnect network mid-download) then Retry; Skáli restart mid-install → "install failed" + Retry; check `tools\java` grants SkaliGames read only and `C:\ProgramData\Skali` stays restricted.
- [ ] **Step 2:** NICE-TO-HAVES: move Plan 3a to "In progress"; Plan 3b keeps backups tab/restore/retention and Steam login; note the gallery uses a built-in list (Steam's app-list API is retired) and regenerating it is `tools/catalog/generate.mjs`; mark the Palworld save-timeout item done.
- [ ] **Step 3:** Run `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm typecheck` and `… pnpm test`; expect PASS (known timing-flaky: `survival.test.ts`, `firewall.test.ts` — rerun once if they fail).
- [ ] **Step 4: Stop and report.**
