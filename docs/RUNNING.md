# Running Skáli

Skáli is a Windows service (`Skali`, NSSM, LocalSystem, port 4200) that manages the dedicated game servers on the
server PC (`192.168.0.100`). You use it from your PC (`192.168.0.150`) at `http://192.168.0.100:4200`.

Game servers run **detached** as the low-privilege local user `SkaliGames`. Stopping, restarting, updating or
uninstalling the `Skali` service never stops them.

## Prerequisites (server PC)

| Tool | Install |
| --- | --- |
| Node 22.12+ (system-wide, under Program Files) | official MSI from nodejs.org, or `winget install OpenJS.NodeJS.LTS`. Not nvm/fnm/volta. |
| pnpm | `corepack enable` |
| .NET SDK 10 | `winget install Microsoft.DotNet.SDK.10` |
| NSSM | `choco install nssm` |
| Git 2.31+ (system-wide, only for auto-deploy) | `winget install Git.Git` (installs under Program Files) |
| Build tools (only if better-sqlite3 has no prebuilt binary for your Node) | `winget install Microsoft.VisualStudio.2022.BuildTools` with the "Desktop development with C++" workload |

**Enable Win32 long paths** on the server PC (the dev repo's deepest `node_modules` path is about 257 characters even under `C:\skali`).
From an elevated shell: `New-ItemProperty -Path HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force`.
Keep the repo at `C:\skali`. The repo lockdown treats a failed ACL reset as fatal, so if a path is too long the installer aborts
(safely, with the repo root already locked) instead of leaving a child with a stale ACL. The install dry run warns when it is not 1.

The server PC's network must be on the **Private** profile: the web UI firewall rule only applies to Private networks.

**Where to put the repo:** clone it to a plain local folder such as `C:\skali` (the admin tests assume this too). Do
**not** use OneDrive or a user-profile folder (`C:\Users\...`): the installer locks the repo down to
Administrators + SYSTEM, which breaks OneDrive sync for that folder, and LocalSystem cannot read Files On-Demand
placeholders, so the service would fail to load its modules. The installer warns when the repo is under either.
Because of the lockdown, run `git` commands in the repo from an **elevated** PowerShell.

## Install

From an elevated PowerShell in the repo:

```powershell
.\scripts\install-service.ps1                          # allowlist defaults to 192.168.0.150
.\scripts\install-service.ps1 -AllowIp 192.168.0.150,192.168.0.151
.\scripts\install-service.ps1 -DryRun                  # prints every step, changes nothing, needs no elevation
```

It checks the tools, stops the service, **deletes every `node_modules`** (root, `apps\*`, `packages\*`), locks the repo down to
admins/SYSTEM (it also makes Administrators the owner of the repo, so the installing user cannot re-grant themselves access),
**then** runs `pnpm install --frozen-lockfile`, verifies better-sqlite3 loads under the system Node, runs `pnpm build` (shared,
server, web, and a `dotnet publish -c Release` of SkaliHelper to `tools\SkaliHelper\publish\SkaliHelper.exe`, where the server
looks for it), checks the root ACL plus a sample of children (including `node_modules`), creates
`C:\ProgramData\Skali` with SYSTEM + Administrators only (inheritance off, owner Administrators) **before** the service first starts
(or refuses an existing one it cannot trust, see below),
installs/updates the service, adds the firewall rule `Skali web (TCP 4200)` (Private, local subnet, node.exe only),
starts the service and checks `GET http://127.0.0.1:4200/api/games` returns 200 and the data dir ACL.

**Upgrading from 4100:** Skáli used to listen on port 4100 (now 4200, since another service owns 4100). Re-run `install-service.ps1`: it moves the service to 4200 and removes the old `Skali web (TCP 4100)` firewall rule. Then update your bookmark to `http://192.168.0.100:4200`.

**Why `node_modules` is deleted, the lock runs before the install, and `.npmrc` says `package-import-method=copy`:** the repo has
about 62k entries, almost all in `node_modules`, so two recursive icacls passes plus two link walks over it took very long. Now
`node_modules` is removed first (`cmd rmdir /s /q`, which does not follow junctions; each path is checked to be inside the repo),
the small source tree is locked, and `pnpm install` and the build run **inside the locked repo**: every file they create inherits
the locked root ACL, and non-admins cannot write under the root, so no further recursive pass or link walk is needed (the
installer only samples the ACLs of the root and some children, including `node_modules`, and rejects any ACE on them other than
SYSTEM/Administrators, inherited or not). `node_modules` is created after the link walk, under the locked root. pnpm's default would hard-link
`node_modules` files from its global store, and NTFS keeps one ACL per file shared by every link, which would leave the store's
links writable by the installing user and let the lock rewrite other projects' ACLs. With `copy`, install writes private
files that carry no ACL of their source (checked), and the installer fails if any hard-linked file remains. The cost: **every
update reinstalls `node_modules` (about a minute)**, and `git pull` must still be run from an elevated shell. The repo ACL commands use icacls `/L`, which applies a change to a junction itself rather than to its target; it does **not**
stop `/T` from traversing through junctions. So before any recursive icacls the installer enumerates every junction/symlink
under the repo and aborts if one resolves outside it; today every `node_modules` junction points inside the repo. A link target
counts as inside only if it is an absolute drive-letter path within the repo: `Volume{GUID}`, UNC and relative targets are
treated as outside. The order is: lock the repo root alone first (owner, foreign explicit ACEs removed, inheritance off, grant),
then check the links, then the recursive `setowner /T` and `icacls <repo>\* /reset /T /C /L` (a reset failure aborts), then check
the links again. Every child then inherits only from the locked root. The installer asserts the root (allowlist, no Deny ACEs) and samples the children for explicit foreign ACEs.

**Data dir: trusted or refused, never repaired.** If `C:\ProgramData\Skali` does not exist the installer creates it in one call,
already owned by Administrators with a protected ACL (SYSTEM + Administrators full control only). If it exists it is accepted only
when it is not a junction (nor any ancestor up to `C:\ProgramData`), is owned by Administrators/SYSTEM, has a protected root ACL with
only SYSTEM + Administrators (Allow), contains no junction/symlink, and every file in it is admin/SYSTEM-owned, has no foreign explicit
ACE and has a single hard link. An update of a dir the installer made passes and is left untouched. Anything else (for example a dir a
user pre-created, which could hold a chosen `secret.key`, a seeded database, open handles or links) stops the install with a message:
if it holds no Skali data you need, delete it from an elevated shell (`Remove-Item -Recurse -Force C:\ProgramData\Skali`) and re-run.
`-DryRun` prints which of the three paths would be taken. If you restore a backup file into `C:\ProgramData\Skali`, first reset its
ACL: `icacls <file> /setowner *S-1-5-32-544` FIRST, then `icacls <file> /reset` (`/reset` is denied on a moved file that does not
grant Administrators access, so take ownership first). A moved or copied-with-ACL file keeps its old owner and
ACEs, and the next update would refuse the whole directory.

**Residual risk of the repo lockdown:** anyone who could write to the repo before its first lockdown could, during the recursive
icacls, swap a folder they own for a junction. The installer's second link check detects this and aborts, but only afterwards.
Clone onto a PC with no untrusted local accounts. Such a person could already tamper with code that later runs as SYSTEM, so the
lockdown does not protect against them anyway. Check after an install: `fsutil hardlink list C:\skali\node_modules\.pnpm\express@5.3.0\node_modules\express\index.js` prints a single line.

`-AllowIp` only seeds the allowlist of a **new** database. Afterwards edit it on the Settings page.
`127.0.0.1` is always allowed.

## Update

Once [auto-deploy](#auto-deploy) is set up, pushing to `main` is the update: the helper deploys every green commit by
itself. The steps below are the manual path, without the helper.

From an **elevated** PowerShell (the repo ACL denies a normal shell write access, so `git pull` fails otherwise):

```powershell
cd C:\skali
git pull
.\scripts\install-service.ps1
```

The service is stopped for the build and restarted; running games are untouched. `node_modules` is deleted before the install, so
if an update fails midway there is no old build to fall back to (do not `nssm start Skali`): Skali stays stopped, games keep
running; fix the error and re-run `install-service.ps1` from an elevated shell, which reinstalls dependencies and rebuilds.

## Auto-deploy

Push to `main` and the server PC deploys it: the deploy helper (Windows service `SkaliDeployer`, LocalSystem, listening on
`127.0.0.1:4201` only, no firewall rule) checks GitHub every 2 minutes, waits for the commit's `CI` workflow to pass,
builds it in its own folder while Skáli keeps running, then stops Skáli, backs up the database, switches, starts and
health-checks it (`GET http://127.0.0.1:4200/api/games` within 60 s). A failed build changes nothing; a failed health
check switches back. Games are never stopped. Design: `docs/superpowers/specs/2026-11-24-auto-deploy-design.md`.

One failed deploy is not switched back: a new release that **migrates the database and then crashes**. The crash leaves
the database's write-ahead log non-empty, so the helper can't confirm which version the database is at, and it never
guesses: going back could put old code on a newer database. The deploy ends **failed (app didn't come up)**, the new
release stays in place (NSSM keeps restarting it) and auto-deploy stays on. This is expected, not a helper fault. The way
out is a fix: push a commit that starts on the migrated database; once its CI is green the helper stops the crash-looping
release and deploys it. To get the previous release back by hand instead, at the server PC in an elevated shell: stop `SkaliDeployer` and
`Skali`, restore the failed deploy's backup (`<time>-<sha7>` of the failed commit, the database from before the switch;
see section 6), point `current` back at the previous release (`cmd /c rmdir C:\SkaliDeploy\current`, then
`cmd /c mklink /J C:\SkaliDeploy\current C:\SkaliDeploy\releases\<previous sha7>`), start `Skali`, check the UI, then start
`SkaliDeployer`.

Layout of `C:\SkaliDeploy` (created by setup: SYSTEM + Administrators only, owner Administrators, no inheritance from
`C:\`; everything inside inherits that). Browse it from an **elevated** PowerShell, not File Explorer: Explorer's "You don't
have permission... Continue" grants your account access, and the next setup run then refuses the root.

| Path | What |
| --- | --- |
| `current` | junction to the running release; the `Skali` service's AppDirectory |
| `releases\<sha7>` | built releases (the last 5 successful ones are kept) |
| `repo` | a clone of `Gabrielmong/skali`, used only to fetch and export |
| `deployer\app` | the helper's own code (changes only when you re-run setup) |
| `deployer\deployer.json`, `github-token`, `api-token` | config and the two tokens |
| `deployer\corepack`, `deployer\pnpm-store` | the pnpm that corepack downloaded (setup fills it, the helper reuses it as SYSTEM) and the package store |
| `deployer\history.json`, `deployer\logs\` | deploy history and one log per event |
| `deployer\backups\` | a database backup per switch (the last 10) |
| `deployer\service.out.log` | the helper's own output |

The data dir stays `C:\ProgramData\Skali`, untouched. `C:\skali` stays as the manual fallback (see below).

### 1. Commit and push first

Setup builds the **HEAD of `C:\skali`** from GitHub (not from the folder), so everything you want running, including the
auto-deploy code itself, must be committed and pushed to `main` first. If that commit isn't on `main` on GitHub, setup
refuses and tells you to push.

### 2. Create the GitHub token

GitHub, Settings, Developer settings, Personal access tokens, **Fine-grained tokens**, Generate new token:

- Resource owner `Gabrielmong`; Repository access **Only select repositories**: `Gabrielmong/skali`.
- Repository permissions: **Contents: Read-only** and **Actions: Read-only** (Metadata: Read-only is added
  automatically). Nothing else.
- Expiration: fine-grained tokens expire. Note the date: when it passes, the Deploys page shows "GitHub token expired or
  revoked" and nothing deploys until you enter a new one (step 5).

The repo is public; the token exists because unauthenticated GitHub API calls are limited to 60 an hour.

### 3. Run the setup

Prerequisites: Skáli already installed by `install-service.ps1` (the `Skali` service, a trusted `C:\ProgramData\Skali` and
the `SkaliGames` user; setup refuses otherwise and says to run `install-service.ps1` first), and system-wide Node, pnpm
(corepack), Git 2.31+, NSSM, PowerShell and `tar` (setup refuses any of them under a user profile).

From an **elevated** PowerShell:

```powershell
cd C:\skali
git pull                                   # the same commit that is on GitHub's main
.\scripts\install-deployer.ps1 -DryRun     # preview: every step, "would fail: ..." for anything missing, changes nothing
.\scripts\install-deployer.ps1             # -Root C:\SkaliDeploy -From C:\skali are the defaults
```

It asks once for the token (hidden input; stored in `C:\SkaliDeploy\deployer\github-token`, never on the command line),
generates the API token Skáli uses to talk to the helper, clones the repo into `C:\SkaliDeploy\repo`, builds the helper
into `deployer\app`, then **bootstraps**: it builds `C:\skali`'s HEAD as `releases\<sha7>`, stops Skáli (games keep
running), backs up the database, points `current` at the new release, re-applies the service settings
(`AppDirectory = C:\SkaliDeploy\current`), starts Skáli and health-checks it. If that fails, Skáli is put back on
`C:\skali` with `install-service.ps1`'s settings and started, and the script stops with the reason (the helper service is
not installed then; fix the problem and re-run). One exception, the same as for any deploy: if the database changed
during the failed check while a game was started or stopped (or can't be read), going back would put old code on a newer
database or lose that game's state, so the new release stays running (NSSM keeps restarting it); the script then fails
with "...the new release stays in place", `nssm get Skali AppDirectory` shows `C:\SkaliDeploy\current`, and the Deploys
page lists the failed event by `setup` once the helper is installed. Ctrl+C during the bootstrap doesn't stop it halfway:
it finishes (and goes back on failure) first. Setup also refuses a `C:\skali` HEAD whose `apply-service-settings.ps1` is
too old to go back (no `-AppDirectory`): push and pull the current version first. On success it installs and starts `SkaliDeployer` (automatic, delayed
start; restarts 5 s after an exit). The Deploys page then shows that commit as running, deployed by `setup`.

### 4. The Deploys page

**Deploys** in Skáli's navigation (`http://192.168.0.100:4200/deploys`), behind the same IP allowlist:

- Top: **Running `<sha7>`** with the commit message and when it was deployed (local time), **Auto-deploy on** or
  **Auto-deploy paused (reason)**, what the helper is doing right now (for example "Deploying abc1234"), **Last GitHub
  check** with its error if it failed (GitHub unreachable, token expired or revoked), and **Helper update available**
  when `main` has a newer helper than the installed one. That flag is refreshed only when a deploy fetches from GitHub:
  a helper change on a commit that is skipped or not deployed shows after the next deploy, not at the next check.
- Buttons: **Deploy now** (the newest green commit, also one that failed before), **Restart Skáli**, **Pause** / **Resume**.
- Left: the last 50 events (deploys, skips with the reason, rollbacks, restarts, pauses), each "by `auto`", "by `you`"
  or "by `setup`", with a link to the commit's CI run. Kept releases have **Roll back to this** (disabled, with the
  reason, when the database is newer than that release knows). A rollback restarts Skáli on that release (games keep
  running), backs up the database first (if the backup fails it starts Skáli again on the same release and fails with
  the reason), and pauses auto-deploy once it succeeds.
- Right: the selected event's log, live while it runs. During a switch the page shows "Skáli is restarting…".
- When the helper isn't installed or isn't running: "The deploy helper isn't running, or isn't installed on this PC.
  See RUNNING.md → Auto-deploy.", linking to this section on GitHub. The rest of Skáli works as before.

### 5. Updating the helper (and replacing the token)

The helper never updates itself. When the page shows **Helper update available** (refreshed only when a deploy fetches,
see section 4), go to the server PC and re-run setup from an elevated PowerShell:

```powershell
cd C:\skali; git pull
.\scripts\install-deployer.ps1             # stops SkaliDeployer, fetches, rebuilds deployer\app from origin/main, starts it
.\scripts\install-deployer.ps1 -NewToken   # the same, asking for a new GitHub token first (for example after it expired)
```

A re-run never touches `current` or Skáli; the running deploy (if any) finishes before the helper stops. If the re-run
fails before the old `deployer\app` is replaced (for example the fetch or the build), the old helper is started again;
after that point it stays stopped until a re-run succeeds.

### 6. Restoring a database backup by hand

There is no restore button: a failed deploy restores its own backup when that is safe. Otherwise, from an elevated
PowerShell:

1. Pause auto-deploy on the Deploys page, then stop both services (games keep running): `nssm stop SkaliDeployer`,
   `nssm stop Skali`.
2. Pick a folder in `C:\SkaliDeploy\deployer\backups\`. Its name is `<time>-<sha7>`: it was taken just before switching
   to `<sha7>`, so it holds the database of the release that ran before. Restore it only while a release at least that
   new is current: old code against a newer database is not supported.
3. Delete `C:\ProgramData\Skali\skali.db-wal` and `skali.db-shm` if present, then copy the backup's `skali.db` (and its
   `-wal`/`-shm`, if the backup has them) into `C:\ProgramData\Skali`.
4. Reset each copied file's ACL, owner first, as for any file put into the data dir:
   `icacls C:\ProgramData\Skali\skali.db /setowner *S-1-5-32-544`, then `icacls C:\ProgramData\Skali\skali.db /reset`
   (the same for a copied `-wal`/`-shm`). Otherwise the next deploy or install refuses the data dir.
5. `nssm start Skali`, check the UI, then `nssm start SkaliDeployer` and resume auto-deploy.

### Helper logs

For when Skáli is down and the page can't be opened (elevated PowerShell; the files are admin-only):

- `C:\SkaliDeploy\deployer\service.out.log`: the helper's own output (startup, recovery, unexpected errors), rotated at 10 MB.
- `C:\SkaliDeploy\deployer\logs\<event-id>.log`: one log per deploy, rollback or restart (the page shows the same text);
  `deployer\history.json` lists the events. Tokens are redacted from both.
- Skáli's own log stays `C:\ProgramData\Skali\service.log`.

### Manual fallback (without the helper)

`C:\skali` stays a working install. To run Skáli from it again: pause auto-deploy (or `nssm stop SkaliDeployer`), then
in `C:\skali` from an elevated PowerShell `git pull` and `.\scripts\install-service.ps1`: it points the `Skali` service back
at `C:\skali`. **`git pull` first, always:** after auto-deploys, `C:\skali` can be older than the running release, and the
database may already be migrated past what its code knows. Check that `git rev-parse HEAD` in `C:\skali` is the running
release (the Deploys page's **Running `<sha7>`**) or newer before running `install-service.ps1`; never run older code on
a newer database. The helper's next deploy or rollback would point it at `current` again, so keep auto-deploy paused (or remove
the helper with `uninstall-service.ps1 -Deployer`) while you run from the clone.

## Uninstall

```powershell
.\scripts\uninstall-service.ps1                 # removes the service and the web firewall rule
.\scripts\uninstall-service.ps1 -Purge          # also deletes C:\ProgramData\Skali, all "Skali - *" rules and the SkaliGames user
.\scripts\uninstall-service.ps1 -Purge -DryRun  # preview
```

```powershell
.\scripts\uninstall-service.ps1 -Deployer                 # removes the SkaliDeployer service only (Skali keeps running)
.\scripts\uninstall-service.ps1 -Deployer -Purge          # also deletes C:\SkaliDeploy (releases, repo clone, tokens, history, backups)
.\scripts\uninstall-service.ps1 -Deployer -Purge -DryRun  # preview
```

`-Deployer -Purge` refuses while the `Skali` service still runs from inside `C:\SkaliDeploy` (`current`): first re-run
`install-service.ps1` from the clone (`C:\skali`) so Skali runs from the clone again, then purge. Copy any database backups
you want to keep out of `C:\SkaliDeploy\deployer\backups` first. Removing Skali itself (without `-Deployer`) while the helper
is installed prints a warning: the helper would start Skali again, so remove both.

To give the repo folder back to normal users afterwards: `icacls C:\skali /reset /T`.
`-Purge` also removes the `SkaliGames` Windows profile (`C:\Users\SkaliGames`) if one was ever created. Each purge step
runs independently; failures are listed at the end (for example a running game holding a log file in the data dir).

Game folders and saves are never deleted. Running games are never stopped; the script warns and lists any it finds.
`-Purge` deletes the database and secret key, so Skáli forgets all servers and their stored passwords.

## Logs

- Service log (startup, shutdown, helper errors): `C:\ProgramData\Skali\service.log` (NSSM rotates it at service start once it is over 10 MB; the app and NSSM both append to this one file, so it can grow between restarts).
- Per-server logs: `C:\ProgramData\Skali\logs\`.
- Live console output per server: the server's page in the UI.
- Deploy helper (when [auto-deploy](#auto-deploy) is set up): see [Auto-deploy, helper logs](#helper-logs).

## Router port forwarding

Forward only these. Values come from each adapter's `ports()` (`apps/server/src/games/*.ts`); All three follow the
ports configured per server; the table shows the defaults. Point each rule at `192.168.0.100`.

| Game | Forward | Protocol | Purpose |
| --- | --- | --- | --- |
| Valheim | 2456-2458 | UDP | game (2456), Steam query (2457), reserved (2458) |
| Palworld | 8211 | UDP | game |
| Minecraft | 25565 | TCP | game |

**Not forwarded** (local only): Palworld REST API `8212/TCP`, Minecraft RCON `25575/TCP`. Skáli opens Windows
Firewall inbound rules (`Skali - <server> - <port>/<PROTO>`) only for the forwarded ports.

## Locked out? (recovery)

Requests from addresses not on the allowlist get a 403 text. `127.0.0.1` is always allowed, so on the server PC open
`http://127.0.0.1:4200/settings` and fix the allowlist there.

Accepted Host headers: any IP literal (`192.168.0.100`), `localhost`, the server's own hostname, and
`<server-hostname>.local` / `<server-hostname>.home.arpa`. Any other name (for example another router DNS name) gets the
"unexpected Host header" 403 by design.

## Troubleshooting

- **Helper errors** (cannot launch/stop a game, "helper" in the message): read `service.log`. Check that
  `tools\SkaliHelper\publish\SkaliHelper.exe` exists (re-run the installer), and that `SkaliGames` exists
  (`Get-LocalUser SkaliGames`). Skáli recreates the user at startup.
- **Ctrl+C does not save the world on stop**: games get a console (`lpDesktop=""`) and Skáli sends Ctrl+C across users
  through the helper. If a game exits without saving, see the acceptance items below; the stop timeout is per server
  and Skáli force-kills after it.
- **Minecraft: "Java not found"**: the default Java path `java` is looked up on the machine PATH (the service runs as
  LocalSystem, so a Java that is only on your user PATH is invisible to it) with PATHEXT. Install a JDK system-wide, or
  set **Java path** to the full path of `java.exe`. The folder must be readable by the `SkaliGames` user: a JDK under
  `C:\Users\<you>\.jdks` is not.
- **Minecraft will not start / EULA**: open the server's Overview and accept the EULA first. Skáli writes `eula.txt`
  only after you do.
- **UI unreachable from another PC**: network profile is Public (set it to Private), or your IP is not in the
  allowlist, or you used a hostname other than the accepted ones above. Also look for leftover Windows Firewall
  "Node.js" **Block** rules (block beats allow): `Get-NetFirewallRule | ? DisplayName -like '*Node*'`; delete any
  Block rule for node.exe.
- **Service fails at start**: `service.log`. If better-sqlite3 fails to load (or `pnpm install` fails while building it), use a Node
  version with a prebuilt binary (Node 22 or 24 LTS, system-wide) or install the build tools (see Prerequisites), then
  re-run the installer.

## Acceptance on the server PC

Run after the first install on `192.168.0.100`. Tick each item and note any difference found.

### Install and access

- [ ] `.\scripts\install-service.ps1` (elevated) finishes; `Get-Service Skali` shows Running, and
      `Get-CimInstance Win32_Service -Filter "Name='Skali'"` shows StartName `LocalSystem`.
- [ ] `http://192.168.0.100:4200` loads from your PC (.150).
- [ ] `http://<server-hostname>:4200` loads from your PC. Names outside the accepted Host forms (see Locked out?) get 403 (by design).
- [ ] Another LAN device (not on the allowlist) gets the 403 text.
- [ ] On the server PC `http://127.0.0.1:4200` always works (also with an emptied allowlist).
- [ ] Data dir ACL: `icacls C:\ProgramData\Skali` lists only SYSTEM and Administrators (no other account or SID, no `(I)` inherited entries). Owner is Administrators or SYSTEM
      (`(Get-Acl C:\ProgramData\Skali).Owner`), as is the repo's. `secret.key` and `skali.db` inherit it (the installer also asserts this).
- [ ] better-sqlite3 loads under the system Node: in `apps\server`, `node -e "new (require('better-sqlite3'))(':memory:').close()"`
      prints nothing and exits 0.
- [ ] Firewall rule `Skali web (TCP 4200)` exists: Private, RemoteAddress LocalSubnet, program node.exe.

### Auto-deploy

- [ ] `.\scripts\install-deployer.ps1 -DryRun` lists no "would fail"; the real run ends with Skali and SkaliDeployer
      Running, `nssm get Skali AppDirectory` prints `C:\SkaliDeploy\current`, and the Deploys page shows the bootstrap
      commit "by setup".
- [ ] `icacls C:\SkaliDeploy` lists only SYSTEM and Administrators (no `(I)` entries); its owner is Administrators.
- [ ] No firewall rule was added for the helper (it listens on 127.0.0.1:4201 only).
- [ ] Push a small green commit: within a few minutes it deploys "by auto", and a game left running keeps its PID.
- [ ] Re-running `install-deployer.ps1` only restarts the helper; `current` and the `Skali` service are unchanged.
- [ ] The first auto-deploy's **Fetch** step succeeds as SYSTEM (its log on the Deploys page shows no "dubious ownership"
      or corepack download prompt), and so do its Install and Build steps.
- [ ] Crash-looping release: push a green commit whose server exits at startup without touching the database (for
      example `process.exit(1)` at the top of `main.ts`). The deploy ends **failed (rolled back automatically)**, the
      previous release is running again, and its log shows the stop succeeded even though NSSM reported the service as
      paused or start-pending. Then push the revert.

### Helper tests (admin-gated, server PC only)

Never run these on the dev PC. They need SYSTEM:

- [ ] Run `corepack pnpm --filter @skali/server test` once normally (publishes the helper and FakeGame), then run the
      admin tests as SYSTEM (repo at `C:\skali`; node, corepack and dotnet must be on the machine PATH). Either with
      Sysinternals PsExec:

      psexec -s -i cmd /c "cd /d C:\skali && set SKALI_ADMIN_TESTS=1&& set COREPACK_ENABLE_DOWNLOAD_PROMPT=0&& corepack pnpm --filter @skali/server exec vitest run test/proc/helper-user.test.ts > C:\ProgramData\skali-admin-tests.log 2>&1"

      or a one-shot scheduled task as SYSTEM:

      schtasks /create /tn SkaliAdminTests /ru SYSTEM /sc once /st 00:00 /f /tr "cmd /c cd /d C:\skali && set SKALI_ADMIN_TESTS=1&& set COREPACK_ENABLE_DOWNLOAD_PROMPT=0&& corepack pnpm --filter @skali/server exec vitest run test/proc/helper-user.test.ts > C:\ProgramData\skali-admin-tests.log 2>&1"
      schtasks /run /tn SkaliAdminTests
      (wait, then read C:\ProgramData\skali-admin-tests.log)
      schtasks /delete /tn SkaliAdminTests /f

      All tests pass. (Source: header of `apps/server/test/proc/helper-user.test.ts`.)
- [ ] Games launched as `SkaliGames` get a console (`lpDesktop=""`), and Ctrl+C reaches them across users.

### Valheim (existing folder)

- [ ] Add the existing Valheim folder through the UI (import its world if it is in a user profile). Start it, watch the
      console reach `Game server connected`; the card shows *running* with CPU/RAM.
- [ ] Task 4 Valheim proof: `-logFile -` output appears in the console, and Ctrl+C (Stop) saves the world.
- [ ] Join from a game client. Players shows 1 if A2S works, otherwise "—" (accepted).
- [ ] Restart from the card: console shows the world save, then a new run starts. Stop: world files' timestamps update.
- [ ] With Valheim running, `Restart-Service Skali`: afterwards the card shows *running* with the **same PID** and the
      console still streams.
- [ ] `nssm stop Skali` triggers a graceful shutdown: `service.log` shows `... received; shutting down (game servers keep
      running)` and the Valheim process keeps running. `nssm start Skali` brings the UI back.
- [ ] Kill `valheim_server.exe` in Task Manager: card shows *crashed*, and restarts after 10 s.
- [ ] Reboot the server PC with Valheim *running*: after boot Valheim is running again (desired state restored). Also
      check the world files' timestamps (`.fwl`/`.db` in the save folder) after the reboot: they show whether the
      world was saved before the PC went down. Skáli cannot tell an OS shutdown from a service restart, so games get
      only what Windows sends their console and are not stopped gracefully; a graceful stop-all on OS shutdown
      is planned for a later release.

### Config fixtures

- [ ] Compare the config-format fixtures with real files from installed servers and note any differences:
      Palworld `Pal\Saved\Config\WindowsServer\PalWorldSettings.ini` and Minecraft `server.properties`.

### Palworld and Minecraft

Repeat the Valheim start/stop/restart checks for each, plus one command each (Palworld `announce hi`, Minecraft `list`).
Install them from **New server**.

- [ ] Palworld: **pending** (not installed yet)
- [ ] Minecraft: **pending** (not installed yet)

### New server and Update (server PC)

- [ ] Fresh Palworld install from **New server**, then start it and send `announce hi`.
- [ ] Fresh Valheim install with a new world: start it and join from a game client.
- [ ] Minecraft Vanilla (latest) and Paper (latest) installs: start each and send `list`.
- [ ] One basic install from the built-in list: **Finish setup**, then start it. Spot-check a couple of basic installs'
      ports: the catalog's ports come from LinuxGSM's Linux defaults, and some names are raw Steam titles.
- [ ] An app ID typed by hand installs.
- [ ] A port clash with an existing server's port is shown in the setup dialog.
- [ ] Update on Valheim while it is running: a backup zip is present and the server comes back up.
- [ ] Minecraft update to a newer version: the old jar is kept as `.previous` and the world loads.
- [ ] A failed update shows "Update failed", and starting the server afterwards clears it.
- [ ] Auto-deploy waits during an install: the Deploys page shows the busy reason.
- [ ] A forced failure (for example disconnect the network mid-download), then **Retry**.
- [ ] Restart Skáli mid-install: the server shows "Install failed" with **Retry**.
- [ ] Remove a failed install with "Also delete `<folder>`" ticked: the folder is gone. Unticked: the folder is kept.
- [ ] The Steam install and error outputs match reality. The SteamCMD install-success and error test fixtures
      (`apps/server/test/fixtures/steamcmd/`) were synthetic, so watch the first real install's log for the
      "Success! App '<id>' fully installed" line and note any difference.
- [ ] Managed Java folder (exists only after a first Minecraft install; do that first): `icacls C:\ProgramData\Skali\tools\java`
      shows `SkaliGames:(OI)(CI)(RX)`, i.e. read and execute only, no `(M)` or `(F)`. And `icacls C:\ProgramData\Skali`
      still lists only SYSTEM and Administrators.
- [ ] Server folders are real folders, not junctions: `dir /AL <games root>` lists no `<JUNCTION>` or `<SYMLINKD>` for
      any server. Junction refusal on Retry: make an install fail (for example disconnect the network mid-download),
      then from an elevated shell rename that server's folder aside and create a junction in its place
      (`mklink /J <folder> <some other empty folder>`); **Retry** fails with "… is a link (junction or symlink) …" and
      the other folder gets no `SkaliGames` entry (`icacls <other folder>`). Remove the junction, rename the folder
      back, then remove the install.

### Settings editor (server PC)

- [ ] Palworld: edit `ExpRate` in the form, save, then restart. The game shows the new rate, and the ini's other lines
      are unchanged (compare with the History entry).
- [ ] Minecraft: edit `motd` in Raw view and save.
- [ ] A locked key can't be changed.
- [ ] Edit the file in Notepad while the page is open: saving in Skáli gives "changed on disk".
- [ ] Restore an older version from History.
- [ ] Add `Engine.ini`, or any other file, through **Add file**.
- [ ] Open the Raw view once in a real browser and check it: highlighting, dark mode, typing, and the History dialog's
      read-only viewer. Automated tests use a stand-in for CodeMirror.
- [ ] Saving a CRLF file from Raw view keeps CRLF. Check the History entry against the new file in Notepad++ or
      `Format-Hex`.

### Settings editor: known limits

- Leaving the server page through the top navigation drops unsaved edits without asking. Switching file or tab, or
  closing the browser tab, does ask.
- Files that aren't UTF-8 or UTF-16 text open read-only, with a message. So do files over 1 MB and binary files.
- In a file that mixes Windows (CRLF) and Unix (LF) line endings, a raw edit turns the CRLF lines into LF. Files that
  are all one style are kept as they are.
- A Palworld settings file that's broken and has no saved history only accepts raw text that leaves out the
  Skáli-managed keys (REST API and AdminPassword). Skáli puts them back on the next start.
