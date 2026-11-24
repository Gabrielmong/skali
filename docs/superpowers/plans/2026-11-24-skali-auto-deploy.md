# Skáli auto-deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push to `main` → the server PC tests-gates, builds, switches and health-checks Skáli by itself, with a Deploys page in Skáli to watch and steer it.

**Architecture:** A new workspace package `apps/deployer` (`@skali/deployer`) — a trimmed port of Home's `../iot/apps/deployer` — runs as the NSSM service `SkaliDeployer` (LocalSystem) from its own installed copy. It polls GitHub, builds commits into `releases\<sha>` under a locked root, switches the `current` junction the `Skali` service runs from, and serves a token-protected API on `127.0.0.1:4201`. Skáli's server proxies that API under `/api/deploys/*` and the web app adds a Deploys page.

**Tech Stack:** Node ≥22.12 + TypeScript (deployer: Node built-ins only), Vitest, Express 5 (Skáli server), React 19 + MUI (web), PowerShell 5.1 (setup), GitHub Actions `windows-latest`.

**Spec:** `docs/superpowers/specs/2026-11-24-auto-deploy-design.md` (approved). Reference implementation: `../iot/apps/deployer` + `../iot/scripts/{install-deployer,apply-service-settings}.ps1`, `../iot/scripts/lib/{deployer-*,service-settings}.ps1`, design `../iot/docs/superpowers/specs/2026-11-10-auto-deploy-design.md`.

## Global Constraints

- **Git:** the owner commits and pushes. Implementers never run `git commit/add/reset/checkout/stash` or create branches; every "Commit" step means "leave the change in the working tree".
- **Dev-PC safety:** never run `SKALI_ADMIN_TESTS=1`, never run setup/install/uninstall scripts without `-DryRun`, never create users/services/firewall rules or change ACLs outside the session scratchpad. `pnpm` is invoked as `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm …`.
- **Ports:** Skáli **4200** (was 4100; Home's deployer owns `127.0.0.1:4100`), Skáli deployer API **4201** on `127.0.0.1` only.
- **Names:** service `SkaliDeployer`; Skáli service `Skali`; deploy root `C:\SkaliDeploy` with `repo\`, `releases\<sha7>\`, `current` (junction), `deployer\` (`app\`, `history.json`, `logs\`, `backups\`, `pnpm-store\`, `deployer.json`, `github-token`, `api-token`, `service.out.log`). Data dir stays `C:\ProgramData\Skali` (untouched; trust rules of `Initialize-DataDirectory`/`Assert-DataDirAcl` still hold).
- **Timing values (spec):** poll **2 min**; CI pending timeout **30 min**; health `GET http://127.0.0.1:4200/api/games` → 200 within **60 s**; busy-wait up to **10 min**; keep **5** successful releases, **10** DB backups, ~**50** events.
- **CI gate:** only the workflow named **`CI`** counts; red → `skipped (tests failed)`; no result in 30 min → `skipped (no test result)`; failed commits never auto-retried; commit choice = Home's `pickCommit` rule.
- **Helper API commands (fixed set, nothing else):** `deployNow`, `restartApp`, `pause`, `resume`, `rollback(sha)` where `sha` must be a kept release. Never a path, command line, script or ref from the caller.
- **Secrets:** GitHub token and API token never in argv, URLs, git config or logs; git gets the token only via `GIT_CONFIG_*` env of the one child (Home's `gitEnv`). Every event log line passes the redactor.
- **Games:** nothing in this plan stops, kills or signals a game process. Stopping `Skali` is the only service action besides `nssm start/restart Skali`.
- **Lockdown:** `C:\SkaliDeploy` is created by setup with owner Administrators, protected DACL, SYSTEM + Administrators full control only (same rules as `Initialize-DataDirectory`); releases inherit it — so files created by export/install/build are admin-only without a per-release ACL pass. `.npmrc` `package-import-method=copy` stays.
- **Event texts (exact):** `skipped (tests failed)`, `skipped (no test result)`, `failed (rolled back automatically)`, `failed (rolled back, database restored)`, `failed (app didn't come up)`; rollback refusal `Can't roll back past a database change; push a fix instead.`

## Review Focus

1. **GitHub unreachable or token expired/revoked** → status shows the reason ("can't reach GitHub since HH:MM" / "GitHub token expired or revoked"), nothing deploys, the loop keeps going, no crash. *(Task 5 test.)*
2. **Helper killed mid-deploy** (reboot, crash) between stop and start → on start `recoverOnStart` makes sure `Skali` is running on `current` (or the previous release if `current` is a half-switched one), marks the event `failed` with `helper stopped during this`. *(Task 7 test.)*
3. **Database probe can't be trusted** (`skali.db-wal` non-empty, probe exits non-zero, DB locked) → treat the version as unknown: no automatic DB restore, rollback blocked with a reason. Never guess. *(Task 6 test.)*
4. **First deploy right after setup** (`current` points at the bootstrap release, history empty) → the first green commit deploys and becomes the running version; Deploys page shows it. *(Task 7 test.)*
5. **Skáli down or its busy route unreachable** while a fix is green → the busy check treats "can't ask" as not busy and the deploy proceeds (that's how a fix reaches a broken Skáli). *(Task 7 test.)*

---

### Task 1: Move Skáli to port 4200

**Files:**
- Modify: `apps/server/src/config.ts` (default port), `apps/web/vite.config.ts` (`SERVER`), `scripts/install-service.ps1` (`$port`, `$webRule = 'Skali web (TCP 4200)'`, remove legacy rule `'Skali web (TCP 4100)'` if present), `scripts/uninstall-service.ps1` (remove both rule names), `docs/RUNNING.md`, `README.md`
- Test: `apps/server/test/config.test.ts`; update host/origin fixtures in `test/http/{allowlist,app,ws-hub}.test.ts` from `:4100` to `:4200` (and the "other port" cases from `:4101` to `:4201`)

- [ ] **Step 1:** Change `config.test.ts` to expect `c.port` `4200`. Run `corepack pnpm --filter @skali/server test config` → FAIL.
- [ ] **Step 2:** Change the default in `config.ts`; update vite proxy, fixtures, scripts, docs (every `4100` reference except a RUNNING.md "Upgrading from 4100" note telling the owner to re-run `install-service.ps1` and update the bookmark to `http://192.168.0.100:4200`). Dry run must print removal of the legacy rule when it exists.
- [ ] **Step 3:** Run server + web tests, typecheck, parse-check `.ps1`, `install-service.ps1 -DryRun` → all PASS/exit 0; `grep -rn 4100` outside `docs/superpowers` and the upgrade note → nothing.
- [ ] **Step 4:** Leave uncommitted.

### Task 2: CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1:** Write a workflow `name: CI` on `push` to `main` and `pull_request`, one job on `windows-latest`: checkout, `actions/setup-node` (Node 22, pnpm cache), `corepack enable`, `actions/setup-dotnet` (10.0.x), `pnpm install --frozen-lockfile`, `pnpm typecheck` (add a root `typecheck` script running server + web + deployer typechecks if none exists), `pnpm test`. `SKALI_ADMIN_TESTS` is not set.
- [ ] **Step 2:** Verify locally: YAML parses (`node -e "require('yaml')…"` or PowerShell `ConvertFrom-Yaml` if available; otherwise a careful read), root `corepack pnpm typecheck` and `corepack pnpm test` pass on the dev PC. Note in the report that the first real run happens after the owner pushes.
- [ ] **Step 3:** Leave uncommitted.

### Task 3: Skáli-side deploy support (schema version, DB probe, busy route)

**Files:**
- Modify: `apps/server/src/db.ts` (export `SCHEMA_VERSION = MIGRATIONS.length`), `apps/server/package.json` build (writes `dist/schema-version.json` = `{"schemaVersion": N}`), `apps/server/src/http/app.ts`
- Create: `apps/server/src/deploy-probe.ts` (built to `dist/deploy-probe.js`), `apps/server/src/http/busy.ts`
- Test: `apps/server/test/deploy-probe.test.ts`, `apps/server/test/http/busy.test.ts`

**Interfaces:**
- Produces: `dist/schema-version.json` `{ schemaVersion: number }`; `node dist/deploy-probe.js <dbPath>` → stdout one JSON line `{ "userVersion": number, "walBytes": number, "servers": [{ "id": string, "pid": number|null, "desired": string }] }`, exit 0; exit 2 with a message on any failure. Opens the DB **read-only** (`readonly: true, fileMustExist: true`).
- Produces: `GET /api/deploys/busy` → `{ busy: boolean, reasons: string[] }`, answered **only for loopback** remote addresses (others 404), no `X-Skali` needed (GET). `busy` is true when any server's runtime state is `starting` or `stopping`; reasons like `"Valheim is stopping"`.

- [ ] **Step 1: Failing tests:** probe on a temp DB created by `openDb` prints `userVersion === SCHEMA_VERSION` and the servers' pid/desired; probe on a missing file exits 2; probe never creates a file. Busy route: loopback + a supervisor fake with one `stopping` server → `{busy:true, reasons:["<name> is stopping"]}`; idle → `{busy:false,reasons:[]}`; non-loopback remote → 404. Build test: after `pnpm --filter @skali/server build`, `dist/schema-version.json` matches `SCHEMA_VERSION`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement (busy reads the supervisor's runtime view used by `views.ts`; use the injected `remoteAddress` dep already used for allowlist tests). **Step 4:** Run → PASS, typecheck clean.
- [ ] **Step 5:** Leave uncommitted.

### Task 4: Deployer package scaffold and core infrastructure

**Files:**
- Create: `apps/deployer/{package.json,tsconfig.json,vitest.config.ts}` (`@skali/deployer`, `type: module`, deps none, devDeps `@types/node`, `typescript`, `vitest` matching the workspace versions), root `package.json` `build:deployer` script (not part of `build`), `pnpm-workspace.yaml` if needed
- Create by porting from `../iot/apps/deployer/src` (keep behaviour and tests, strip Home-only parts): `config.ts`, `system.ts`, `spawn-lines.ts`, `event-log.ts`, `redact.ts`, `history.ts`, `history-file.ts`, `op-error.ts`, `op-steps.ts` (without `applySettings` → Task 7), `command.ts`, `api.ts`, `op-context.ts`
- Test: ported `test/{config,system,event-log,redact,history,api}.test.ts`, `test/fakes.ts`

**Interfaces (Produces):**
- `DeployerConfig` fields: `root, githubRepo ("Gabrielmong/skali"), branch ("main"), tokenFile, apiTokenFile, apiPort (4201), serviceName ("Skali"), appPort (4200), dataDir ("C:\\ProgramData\\Skali"), pollMs (120000), ciWorkflowName ("CI"), ciTimeoutMs (1800000), busyWaitMs (600000), keepReleases (5), keepBackups (10), maxEvents (50), healthTimeoutMs (60000), stepTimeoutsMs, bin: { node, pnpm, git, nssm, powershell, tar }, installedDeployerTree`. `StepTimeouts`: `fetch, export, install, build, backup, settings`.
- `pathsFor(root)` → `{ repo, releases, current, data (root\deployer), eventLogs, backups, pnpmStore, historyFile, apiTokenFile, tokenFile }`.
- `Command = { type: 'deployNow'|'restartApp'|'pause'|'resume'; by: string } | { type: 'rollback'; sha: string; by: string }`, `by` limited to `"auto"` or `"you"` (else 400).
- `OpContext` as Home's minus `migrations`/`appEnv`/`backup` (no probe/busy members: Task 6's `probeDb` uses `ctx.sys.run`, Task 7's busy-wait uses the same injectable HTTP getter as the health check). `opSecrets(tokens)` = tokens only.
- Root `typecheck` and `test` (Task 2's scripts) gain the deployer package, so CI covers it.
- API: `startApi(api, { port, token })` listens on `127.0.0.1` only; bearer token check; routes `GET /status`, `GET /events/:id/log?from=<byte>`, `POST /command` → same shapes as Home's.

- [ ] **Step 1:** Port the listed tests first, adjusted for removed fields (no `pgDump`, `migrate`, `helpers`, `protect`, android, agent, ci-store) and new fields; add `config.test` asserting the defaults above and `command.test` rejecting `by: "admin"` and unknown types.
- [ ] **Step 2:** Run `corepack pnpm --filter @skali/deployer test` → FAIL. **Step 3:** Port the sources. **Step 4:** Run → PASS; `tsc --noEmit` clean.
- [ ] **Step 5:** Leave uncommitted.

### Task 5: GitHub client, commit pick and polling

**Files:**
- Create (port, trimmed): `apps/deployer/src/github.ts` (only: list commits on branch since a sha, `CI` workflow state for a commit + its run URL, `Conditional`/etag support, `GitHubError` with `kind: 'unreachable'|'auth'|'rate'|'other'`), `pick-commit.ts` (verbatim rule), `poll.ts`
- Test: ported `test/{github,pick-commit,poll}.test.ts`

**Interfaces (Produces):**
- `class GitHub { constructor(repo, tokenFile, fetchFn?); commitsSince(branch, sinceSha?): Promise<Commit[]>; ciState(sha, workflowName): Promise<{ state: CheckState; runUrl?: string }> }`
- `Commit { sha, message, date, author }`, `CheckState = 'pending'|'success'|'failure'|'none'`.
- `findPick(ctx, source, opts)` / `recordSkips(ctx, skips)` / `checkError(ctx, e): string` as in Home; skip notes carry `runUrl`.

- [ ] **Step 1: Failing tests** (ported plus): 401/403 → status text `GitHub token expired or revoked`; network error → `can't reach GitHub since HH:MM` (time from `ctx.now()`, first failure time kept across repeated failures); success after failure clears it; a workflow named `CodeQL` failing does not affect `ciState(sha,'CI')`; pick rule cases from Home (pending head waits; red head → newest green in range; 30-min timeout → `skipped (no test result)`; failed sha never auto-picked).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Leave uncommitted.

### Task 6: Releases, build steps, DB probe, backups, rollback eligibility

**Files:**
- Create: `apps/deployer/src/releases.ts` (port), `deploy-steps.ts` (Skáli steps), `db-probe.ts`, `backup.ts` (file copy), `rollback-eligibility.ts` (rewritten)
- Test: `test/{releases,deploy-steps,db-probe,backup,rollback-eligibility}.test.ts`

**Interfaces (Produces):**
- `buildRelease(ctx, sha, dir, log)`: steps `Fetch` (git fetch with `ctx.gitEnv()`), `Export` (git archive + tar into `releases\<sha7>`), `Install` (`pnpm install --frozen-lockfile --store-dir <pnpmStore>`), `Native check` (`node -e "require('better-sqlite3')"` in `apps/server`; failure text includes the Node-version guidance from `install-service.ps1`), `Build` (`pnpm build`), `Verify` (exists: `apps/server/dist/main.js`, `apps/server/dist/schema-version.json`, `apps/server/dist/deploy-probe.js`, `apps/web/dist/index.html`, `tools/SkaliHelper/publish/SkaliHelper.exe`). No per-release ACL step (root inherits; Global Constraints).
- `releaseSchemaVersion(dir): number` reads `apps/server/dist/schema-version.json`.
- `type DbProbe = { userVersion: number; walBytes: number; servers: { id: string; pid: number|null; desired: string }[] }`; `probeDb(ctx, releaseDir): Promise<DbProbe | undefined>` runs `bin.node <releaseDir>\apps\server\dist\deploy-probe.js <dataDir>\skali.db`; returns `undefined` on non-zero exit, bad JSON, or `walBytes > 0`.
- `backupDb(ctx, log): Promise<string>` copies `skali.db` (+ `-wal`, `-shm` if present) into `deployer\backups\<ISO-time>-<sha7>\`, prunes to the newest 10; `restoreDb(ctx, backupDir, log)` copies them back (removing any `-wal/-shm` not in the backup). Both only run while `Skali` is stopped (caller's duty; assert via `sys.status`).
- `rollbackBlockedReason(probe: DbProbe|undefined, targetSchemaVersion: number): string|undefined` → `undefined` when `probe && probe.userVersion <= target`; `ROLLBACK_BLOCKED` when newer; `"Can't read the database version right now; try again with Skáli stopped."` when probe is `undefined`.

- [ ] **Step 1: Failing tests:** build steps run in order with the exact args (fake `System`), stop at the first failing step and leave `current` untouched; `Verify` names the missing file; probe with `walBytes: 3` → `undefined`; probe exit 2 → `undefined`; backup keeps 10 of 12; restore removes a stray `-wal`; eligibility table (equal → allowed, higher → blocked text, undefined → unknown text); `pruneReleases` never deletes `current`'s target or kept shas.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Leave uncommitted.

### Task 7: Switch, health, rollback, restart, recovery, busy-wait and the Deployer loop

**Files:**
- Create (port + adapt): `apps/deployer/src/switch-to.ts`, `deploy.ts`, `rollback.ts`, `restart.ts`, `recover.ts`, `busy.ts`, `deployer.ts`, `real-context.ts`, `main.ts`; `op-steps.ts` gains `applySettings(ctx, log, sha)` running the release's `scripts/apply-service-settings.ps1` (Task 9) with `-Service Skali -Root <root> -Node <bin.node>`
- Test: ported/adapted `test/{deploy,rollback,restart,recover,deployer}.test.ts`, new `test/busy.test.ts`

**Interfaces:**
- Consumes: Tasks 4–6.
- `waitUntilIdle(ctx, log, maxMs = config.busyWaitMs)`: polls `GET http://127.0.0.1:4200/api/deploys/busy` every 15 s; logs reasons; returns when `busy:false`, on any error/unreachable (treated as not busy, logged), or after `maxMs` (logs "switching anyway").
- `deployCommit(ctx, commit, by)`: `buildRelease` → (auto only) `waitUntilIdle` → stop `Skali` → `before = probeDb(current)` (probe only with Skáli stopped: a running Skáli's WAL is non-empty, so the probe would always be `undefined`) → `backupDb` → switch `current` + `applySettings` → start → `checkHealth` (60 s). On health failure: stop `Skali`, `after = probeDb(newRelease)`;
  - `before && after && after.userVersion === before.userVersion` → switch back + start → `failed (rolled back automatically)`;
  - versions differ and `before && after` and every server's `pid`/`desired` equal in both → `restoreDb` → switch back + start → `failed (rolled back, database restored)`;
  - otherwise (incl. any probe `undefined`) → leave the new release, `nssm start Skali`, auto-deploy stays on → `failed (app didn't come up)`.
  - Success → prune releases (keep 5 successful) → `SUCCEEDED`.
- `rollbackTo(ctx, sha, by)`: only kept successful releases; stops `Skali`, probes, and if `rollbackBlockedReason` refuses, starts `Skali` again on the same release and fails with that reason; no busy-wait; pauses auto-deploy with reason `rolled back to <sha7>`.
- `restartApp(ctx, by)`: `nssm restart Skali` + health; text `Skáli didn't come up after restart` on failure.
- `recoverOnStart(ctx)`: as Home's `INTERRUPTED = 'helper stopped during this'`, ensuring `Skali` ends running.
- Status shows per kept release `canRollback`/`rollbackBlockedReason` computed from the release's schema version vs the **last DB version seen** by a probe (stored in history after every stopped-Skáli probe; unknown → blocked with the "can't read" text). The page never probes a running DB.
- `Deployer` status adds `helperUpdateAvailable: boolean` (installed `installedDeployerTree` vs `apps/deployer` tree of the newest fetched `main`, as Home) and per-event `ciRunUrl`.

- [ ] **Step 1: Failing tests** (fake system/GitHub/probe/clock): happy path order of steps; build failure leaves `Skali` untouched and never stops it; each of the three health-failure branches with the exact event text; a game pid changed during the window → no restore; busy-wait (a) busy then idle after 30 s, (b) unreachable → proceeds immediately, (c) busy for 10 min → "switching anyway"; `deployNow` skips busy-wait; rollback to non-kept sha → 400; recovery after a crash between stop and start leaves `Skali` started (Review Focus 2); first deploy with empty history (Review Focus 4); "one at a time" → second command gets 409 `busy`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS, typecheck clean.
- [ ] **Step 5:** Leave uncommitted.

### Task 8: Skáli server proxy and the Deploys page

**Files:**
- Create: `apps/server/src/http/deploys.ts`, `apps/web/src/pages/DeploysPage.tsx`, `apps/web/src/components/{DeployEventList,DeployLog}.tsx`
- Modify: `apps/server/src/http/app.ts`, `apps/server/src/config.ts` (`deployerUrl` from `SKALI_DEPLOYER_URL` default `http://127.0.0.1:4201`, `deployerTokenFile` from `SKALI_DEPLOYER_TOKEN_FILE`), `apps/web/src/{App.tsx,api.ts}` (nav entry "Deploys", route `/deploys`), `packages/shared/src/index.ts` (view types)
- Test: `apps/server/test/http/deploys.test.ts`, `apps/web/src/pages/DeploysPage.test.tsx`

**Interfaces:**
- Server routes (all behind the existing allowlist/Host/`X-Skali` middleware): `GET /api/deploys/status`, `GET /api/deploys/events/:id/log?from=`, `POST /api/deploys/{deploy-now,restart,pause,resume}`, `POST /api/deploys/rollback/:sha`. Each maps to one fixed helper command with `by: "you"`; `:sha` must match `/^[0-9a-f]{7,40}$/`. Helper unreachable / token file missing → `503 { error: "helper-not-running" }`.
- Shared types: `DeployStatusView`, `DeployEventView` (mirroring the helper's status JSON, incl. `canRollback`, `rollbackBlockedReason`, `ciRunUrl`, `helperUpdateAvailable`).
- Page: top bar (running version, on/paused + reason, last GitHub check/error, "helper update available", buttons Deploy now / Restart Skáli / Pause|Resume), event list left, log right (polls `log?from=` every 1 s while the selected event is `RUNNING`), Roll back with confirm dialog naming the release, disabled with reason when blocked; stacks on narrow screens; on fetch failures during a switch shows "restarting…" and resumes; on 503 `helper-not-running` shows the not-installed message linking to the RUNNING.md deploy section.

- [ ] **Step 1: Failing tests:** server — token read per request and sent as bearer; non-hex sha → 400 without calling the helper; helper down → 503 `helper-not-running`; POST without `X-Skali` → 403 (existing middleware). Web — renders status and events from a mocked API; clicking Roll back opens the confirm with the sha; blocked release shows the reason and a disabled button; 503 shows the not-installed message; log appends lines from successive `from=` polls.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement following the existing pages' look. **Step 4:** Run → PASS, web + server typecheck clean.
- [ ] **Step 5:** Leave uncommitted.

### Task 9: Shared service settings and per-release `apply-service-settings.ps1`

**Files:**
- Create: `scripts/lib/service-settings.ps1` (one function `Set-SkaliServiceSettings -Service -AppDirectory -Node -DryRun` applying every NSSM value `install-service.ps1` sets today, plus `AppEnvironmentExtra` entries `SKALI_PORT=4200`, `SKALI_DEPLOYER_TOKEN_FILE=C:\SkaliDeploy\deployer\api-token` when that file exists), `scripts/apply-service-settings.ps1` (params `-Service -Root -Node`; AppDirectory = `<Root>\current`)
- Modify: `scripts/install-service.ps1` to call `Set-SkaliServiceSettings` (same resulting settings as before, AppDirectory = repo); keep its `SKALI_INITIAL_ALLOWLIST` handling

- [ ] **Step 1:** Parse-check; `install-service.ps1 -DryRun` prints the same NSSM values as before plus `SKALI_PORT=4200`; `apply-service-settings.ps1 -Service Skali -Root C:\SkaliDeploy -Node <node> -DryRun` prints AppDirectory `C:\SkaliDeploy\current`. (Both scripts get `-DryRun`.)
- [ ] **Step 2:** Leave uncommitted.

### Task 10: `install-deployer.ps1` setup, uninstall, and docs

**Files:**
- Create: `scripts/install-deployer.ps1`, `scripts/lib/deployer-*.ps1` (ported/trimmed from `../iot/scripts/lib/deployer-{acl,bins,git,layout,paths,root,secrets,app}.ps1`)
- Modify: `scripts/uninstall-service.ps1` (`-Deployer` switch removes `SkaliDeployer` and, with `-Purge`, `C:\SkaliDeploy`), `docs/RUNNING.md` (deploy section), `README.md`

**Behaviour (decided):**
- Params: `-Root C:\SkaliDeploy` (no spaces), `-From C:\skali` (existing install), `-DryRun`.
- Refuses unless the `Skali` service exists, `Assert-DataDirAcl` passes and `SkaliGames` exists ("run install-service.ps1 first").
- Creates `-Root` in one step with the locked ACL (reuse `Initialize-DataDirectory`'s create-with-DACL helper; refuse an existing untrusted root exactly like the data dir).
- Finds system-wide `node`, `pnpm` (corepack), `git` ≥ 2.31, `nssm`, `powershell`, `tar`; refuses ones under a user profile (dry run warns).
- Reads the GitHub token once (hidden), stores `deployer\github-token`; generates `deployer\api-token` (32 random bytes hex). Both admin/SYSTEM-only by inheritance.
- Clones `https://github.com/Gabrielmong/skali.git` into `repo\` (token only via env of that git command).
- Bootstraps: exports the `-From` install's `HEAD` sha as `releases\<sha7>` via the deployer's own build steps (`node deployer\app\main.js --bootstrap <sha>`), points `current` at it, runs `apply-service-settings.ps1`, restarts `Skali`, health-checks 4200 — so the old `C:\skali` folder is no longer what runs (it stays as the manual fallback).
- Builds the deployer (`pnpm --filter @skali/deployer build`) into `deployer\app`, writes `deployer.json`, installs/starts NSSM `SkaliDeployer` (LocalSystem, AppDirectory `deployer\app`, logs `deployer\service.out.log`, restart on exit 5 s).
- Re-running it = helper update (stops `SkaliDeployer`, rebuilds `deployer\app`, starts it); never touches `current` on re-run.
- RUNNING.md deploy section: create the fine-grained token (repo `Gabrielmong/skali`, read-only Contents + Actions; note expiry), run setup, what the Deploys page shows, manual DB restore from `deployer\backups\` (stop Skali, setowner then reset as documented), updating the helper, where logs are (`deployer\service.out.log`, `deployer\logs\`), manual fallback `install-service.ps1`.

- [ ] **Step 1:** Parse-check all `.ps1`; `install-deployer.ps1 -DryRun` runs to completion on the dev PC printing every step, reporting missing prerequisites as `would fail: …` and changing nothing (verify no `SkaliDeployer` service, no `C:\SkaliDeploy`, no firewall rule afterwards). `uninstall-service.ps1 -Deployer -Purge -DryRun` completes.
- [ ] **Step 2:** Add the deployer's `--bootstrap <sha>` mode to `main.ts` with a test (fake context: builds, switches, applies settings, starts, health-checks; records a `DEPLOY` event `by: "setup"` — extend `Command.by` validation to allow `"setup"` only from this path, not the API).
- [ ] **Step 3:** Leave uncommitted.
