# Skáli auto-deploy — Design

*Date: 2026-11-24 · Status: approved by the owner 2026-11-24 · Builds on: Skáli core (`docs/superpowers/specs/2026-11-23-skali-design.md`, `scripts/install-service.ps1`, `scripts/lib/*`, `docs/RUNNING.md`) · Modeled on: Home's deployer (`../iot/docs/superpowers/specs/2026-11-10-auto-deploy-design.md`, `../iot/apps/deployer`)*

## 1. Intent

Updating Skáli today means going to the server PC, opening an elevated shell, running `git pull`, and re-running `install-service.ps1`. The owner built Skáli so they wouldn't have to walk to the server PC, and updating Skáli has become the next reason to walk over. The owner wants this: **push to `main`, and the server PC picks the change up and redeploys Skáli by itself**, once the commit's tests pass on GitHub. They also want a page in Skáli to see and steer deploys.

Home already works this way and the owner is happy with it, so Skáli follows the same pattern. Where the two apps differ, this design keeps Skáli simpler.

## 2. Decided by the owner

- **A separate deploy helper for Skáli**, living in the Skáli repo as a trimmed copy of Home's deployer. It is not shared with Home: each app must work without the other, and the two repos stay independent.
- **GitHub runs the tests.** A commit deploys only after its GitHub Actions checks are green. Skáli's tests need Windows (the .NET helper, the survival test), so CI runs on GitHub's Windows runners.
- **Helper self-updates work as in Home.** The page shows "helper update available". The owner re-runs the setup script at the server PC. Helper updates are rare, so walking over for them is acceptable.
- **Auto-deploy comes before Plan 2** (settings editor) and Plan 3 (gallery, install, update, backups).
- **Skáli moves from port 4100 to 4200**, and Skáli's helper uses **4201**. Home is on the same server PC, and Home's deployer listens on `127.0.0.1:4100` by default (`iot/apps/deployer/src/config.ts`), so the two collide today. Home is left unchanged. This is the first step of the plan: change the default `SKALI_PORT`, the installer's web firewall rule (the old 4100 rule is removed), the smoke checks and the docs. The owner re-runs `install-service.ps1` once to pick it up and updates their bookmark to `http://192.168.0.100:4200`.
- **The repo (`Gabrielmong/skali`) is public.** GitHub Actions on Windows runners is therefore free and unmetered. The helper still uses a fine-grained read-only token, because unauthenticated API calls are limited to 60 an hour, which the 2-minute polling would exceed.
- **Skáli is already installed** on the server PC through `install-service.ps1` at `C:\skali`.

## 3. Goals

### Deploying
- **Polling:** the helper checks GitHub for new commits on `main` every **2 minutes**.
- **CI gate:** a commit deploys only when the GitHub Actions workflow named **`CI`** succeeded for it. Other checks (CodeQL, Dependabot and so on) are ignored, matching what Home does today. *(My call.)*
  - Pending: wait, up to **30 minutes**.
  - Red: record the commit as **skipped (tests failed)**.
  - No result after 30 minutes: record it as **skipped (no test result)**.
  - Commit choice follows Home's rule exactly. If the head is pending, wait for it. If the head is red or has no result, deploy the newest green commit between the running version and the head.
- **Failed commits are not retried automatically.** Auto-deploy waits for a newer green commit. **Deploy now** may retry one on purpose.
- **Build first, switch after.** The new commit is exported and built in its own `releases\<sha>` folder while the current Skáli keeps running. The switch is short: stop Skáli, back up the database, start, then health-check. Skáli migrates its own database on start (`db.ts`, `PRAGMA user_version`). The helper does not run migrations itself.
- **Games are never touched.** Stopping Skáli never stops games; this is already true and covered by the acceptance checklist. During the switch, only the web page blinks.
- **A failed build changes nothing.** The old version keeps running.
- **Health check:** `GET http://127.0.0.1:4200/api/games` must return 200 within **60 s**. That is the same check the installer uses, and 60 s allows for first-boot work.
  - On failure, if the database version did not change: switch back automatically and record **failed (rolled back automatically)**.
  - On failure, if the database version did change, the helper first stops the new Skáli and compares the database with the pre-deploy backup.
    - **If no game was started or stopped during the check**, i.e. the `pid` and desired state of every server are unchanged: restore the backup, switch back, start, and record **failed (rolled back, database restored)**.
    - **Otherwise,** do what Home does: leave the new release in place with NSSM restarting it and auto-deploy **on**, so a fix deploys by itself once it is green, and record **failed (app didn't come up)**.
    - Restoring in the second case would lose the record of a game launched during the window, and the old Skáli would then start a second copy of it. *(My call; it differs from Home, which never restores. Skáli's database is one small file, so a backup taken a moment earlier with Skáli stopped is an exact restore point.)*
- **Database backup on every switch.** Copy `skali.db` (plus any `-wal`/`-shm` files) while Skáli is stopped. Keep the last **10** backups.
- **One thing at a time.** While a deploy, rollback or restart runs, other commands are refused with "busy".
- **Auto-deploys don't interrupt Skáli mid-action.** Before stopping Skáli, an auto-deploy asks it whether any server is `starting` or `stopping`, for example a graceful Ctrl+C stop that is still waiting. If so, it waits and checks again, for up to **10 minutes**, then switches anyway.
  - The question is a read-only local route on Skáli, e.g. `GET /api/deploys/busy` from 127.0.0.1.
  - **Deploy now**, **Restart** and **Roll back** don't wait: the owner chose that moment.
  - A pending crash auto-restart cancelled by the switch is fine. The new Skáli reconciles desired state on boot and starts the game again.
  - Plan 3 will add more busy reasons, such as SteamCMD installs. *(My call.)*

### The Deploys page (inside Skáli, behind the IP allowlist)
- **Placement:** a new **Deploys** entry in Skáli's navigation.
- **Top bar:**
  - the running version (short hash, message, deploy time)
  - auto-deploy **on** or **paused**, with the reason
  - the last GitHub check and whether it worked, e.g. "can't reach GitHub since 14:02" or "GitHub token expired"
  - "helper update available", when `main` has a newer helper than the installed one
  - buttons: **Deploy now**, **Restart Skáli**, **Pause/Resume auto-deploy**
- **Event list** (left): deploys (in progress, succeeded, failed or skipped, with the reason), rollbacks, restarts and pauses or resumes. Newest first, about the last 50. Each event shows who started it: **auto** or **you**. Deploy and skip entries show the commit's CI result (passed, failed, pending, none) and link to its GitHub Actions run. *(My call: there is no in-page CI pipeline view like Home's. GitHub's own page shows the job steps and logs, and the repo is public.)*
- **Log** (right): the selected event's log, streaming live while a deploy runs. On a phone the list and the log stack.
- **Roll back to this:** on each kept successful release other than the running one.
  - Disabled, with the reason, when the database version is newer than that release knows (see §6).
  - Rolling back **pauses auto-deploy**.
  - Asks for confirmation first.
- **During the switch** the page shows "restarting…" instead of an error, then picks up again, including the rest of the deploy's log.
- **When the helper isn't running or installed,** e.g. on the dev PC, the page says so and links to the setup section of `docs/RUNNING.md`. The rest of Skáli is unaffected.

### CI
- **Workflow:** `.github/workflows/ci.yml` runs on pushes to `main` and on pull requests, on `windows-latest`. It sets up Node 22, pnpm via corepack and the .NET 10 SDK, then runs `pnpm install --frozen-lockfile`, `pnpm typecheck` (or the per-package equivalent) and `pnpm test`.
- **Admin tests** (`SKALI_ADMIN_TESTS`) stay off in CI. They create Windows users.

### Setup
- **Setup script:** a one-time, elevated `scripts/install-deployer.ps1`. It installs the helper service and moves the current `C:\skali` install to the release layout (§5). It stores the GitHub token, asking for it once with hidden input.
  - It requires an existing install made by `install-service.ps1`: the `Skali` service, a trusted data dir and the `SkaliGames` user. If there is none, it refuses and says to run `install-service.ps1` first. *(My call: no separate first-install path.)*
  - It leaves `C:\ProgramData\Skali` exactly as it is: same path, same ACL, same trust rules.
  - It ends with a running Skáli.
- **Docs:** `docs/RUNNING.md` gains a deploy section covering:
  - creating the fine-grained token
  - running the setup
  - what the Deploys page shows
  - restoring a database backup by hand
  - updating the helper
  - where the helper's own logs are, for when Skáli is down

## 4. Non-goals

- Deploying branches other than `main`, or to more than one PC.
- Notifications (push, email, Discord). The page is the only place to look.
- A database restore button. Manual restore is documented, and the automatic restore happens only inside a failed deploy.
- The helper updating itself.
- Deploying game-server updates. That belongs to Plan 3.
- Webhooks, a self-hosted runner, or inbound ports. The server PC pulls; nothing pushes to it.

## 5. Anti-goals (a failure even if it "works")

- **A deploy that stops or restarts a game.**
- **A deploy that leaves Skáli down when it didn't need to.** A bad build or a failed health check must leave a working version running.
- **A deploy that weakens the lockdown.**
  - Every release folder gets the same guarantee as today's repo: only Administrators and SYSTEM can change what runs as LocalSystem.
  - The data dir's trust rules (the installer's `Initialize-DataDirectory` / `Assert-DataDirAcl`) still hold after every deploy and rollback.
- **Skáli gaining a way to run arbitrary things through the helper.** Skáli may only ask for a fixed set of commands. It never passes a command line, a path, a script or a git ref. A rollback target must be one of the helper's own kept releases.
- **Secrets in logs.** The GitHub token and `secret.key` contents never appear in a deploy log or on the page. Log lines are redacted before they are stored.
- **Running old code against a newer database.**
- **Deploying a red commit.**

## 6. Constraints and facts from the codebase

- **Service accounts.** Skáli runs as **LocalSystem** under NSSM (service `Skali`, port 4200 after this plan; was 4100), which differs from Home's LocalService. Skáli already has admin-level power, so the helper split exists here for *availability*, not privilege: it must keep running and deploying when Skáli is broken, and a service cannot reliably replace and restart itself. The helper runs as LocalSystem too.
- **Paths.** `config.ts` derives `helperPath` and `webDist` from the repo root of the running code, so they follow the release automatically. `SKALI_DATA_DIR`, `SKALI_PORT` and `SKALI_INITIAL_ALLOWLIST` come from NSSM environment settings.
- **Database versions.** Skáli's migrations are an in-code list, and `PRAGMA user_version` counts how many have been applied. **Rollback rule (exact):** allowed only if the database's `user_version` ≤ the number of migrations in the target release. The helper reads the count from a small file the build writes into the release (e.g. `apps/server/dist/schema-version.json`), so it doesn't have to parse code.
- **The game-launch helper.** `SkaliHelper.exe` (the .NET launcher) is a short-lived program per call, and games don't keep it open. Deleting an old release folder therefore never affects a running game.
- **The current installer** (`install-service.ps1`) does this in order:
  1. stop the service
  2. delete `node_modules`
  3. lock the repo (root first, link walks, recursive reset)
  4. `pnpm install` with `.npmrc` `package-import-method=copy`
  5. check better-sqlite3 loads
  6. `pnpm build` (shared, server, web, then `dotnet publish` of the helper)
  7. check the data dir trust rules
  8. configure NSSM, apply the firewall rule for the web UI, start, run the `/api/games` health check

  The deploy steps reuse these pieces. The lockdown order matters: lock the release folder **before** install and build, so everything they create inherits the locked ACL. That is the fast-lockdown design from Task 16.
- **Node and pnpm.** Node must be a system-wide install. pnpm comes through corepack. The server PC has the .NET 10 SDK. `git` must also be system-wide; setup refuses one under a user profile, as Home's does.
- **No better-sqlite3 binary.** If no prebuilt better-sqlite3 binary exists for the server's Node, the build step fails, and per the goals that changes nothing.

## 7. Shape of the solution (my calls; the builder may refine)

- **The helper (`apps/deployer`)** is Node + TypeScript using Node built-ins only, with Vitest tests. It runs as the NSSM service **`SkaliDeployer`** under LocalSystem, from its own installed copy, so a deploy never swaps its code. Start by copying Home's `apps/deployer` and removing:
  - Postgres, `pg_dump` and Prisma
  - go2rtc/ffmpeg tools
  - the Android APK and the PC agent
  - GraphQL

  Also drop Home's CI pipeline view (`ci/` watcher, job logs, `ci.json`). Keep only what reads the `CI` workflow's result for a commit. Keep the commit choice, history, event logs, redaction, the release layout and rollback eligibility (rewritten for `user_version`).
- **Folder layout,** e.g. under `C:\skali`:
  - `repo\`: used only for fetch and export
  - `releases\<short-sha>\`: keep the last **5** successful releases
  - `current`: a junction to the running release. The `Skali` service's AppDirectory points to it, and NSSM settings are re-applied on every switch.
  - `deployer\`: history, logs, config, token and backups
  - **The data dir stays `C:\ProgramData\Skali`.** It is not moved.
- **Talking to Skáli:**
  - The helper listens on `127.0.0.1` only, on a fixed port, with a random API token kept in a file only SYSTEM and Administrators can read. Skáli runs as SYSTEM, so it can read it.
  - Skáli's server is the only client. It exposes REST routes under `/api/deploys` (status and events, one event's log, the live log over Skáli's existing WebSocket or polling) and the actions `deploy-now`, `restart`, `pause`, `resume` and `rollback/:releaseId`.
  - These routes are protected like the rest of Skáli: IP allowlist, Host check and `X-Skali` on non-GET requests.
- **GitHub access:** a fine-grained personal access token scoped to the Skáli repo, read-only for **Contents** and **Actions/Checks**. It is used for `git fetch` over HTTPS (passed only through environment variables, never in a URL or git config) and for the checks API.
- **Deploy steps,** each one a labelled section of the event log:
  1. fetch
  2. CI check
  3. export the commit to `releases\<sha>`
  4. lock the release folder (root first, link walk)
  5. `pnpm install --frozen-lockfile`
  6. check better-sqlite3 loads
  7. `pnpm build`
  8. sampled ACL assert
  9. stop `Skali`
  10. back up the database
  11. switch the junction and re-apply NSSM settings
  12. start
  13. health check
  14. prune old releases and backups
- **Restart Skáli** means `nssm restart Skali`, followed by the same health check.
- **`install-service.ps1` stays** as the manual path, documented as "deploy without the helper". *(Builder: decide whether it becomes a thin wrapper over the shared steps.)*

## 8. Left to the builder

- The helper's port and file formats; how the live log reaches the page; event retention beyond about 50.
- How the setup moves today's `C:\skali` repo install into `C:\skali\repo` + `releases\` + `current` without downtime beyond one switch. This includes whether the existing clone becomes `repo\` or a fresh clone is made.
- Wording, icons and empty states on the Deploys page, following Skáli's existing look.
- Error messages for: GitHub unreachable, an expired token (fine-grained tokens expire), a full disk, and a Windows runner outage.
- The exact CI job layout, such as whether to cache pnpm and NuGet.
