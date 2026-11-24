# Running Skáli

Skáli is a Windows service (`Skali`, NSSM, LocalSystem, port 4100) that manages the dedicated game servers on the
server PC (`192.168.0.100`). You use it from your PC (`192.168.0.150`) at `http://192.168.0.100:4100`.

Game servers run **detached** as the low-privilege local user `SkaliGames`. Stopping, restarting, updating or
uninstalling the `Skali` service never stops them.

## Prerequisites (server PC)

| Tool | Install |
| --- | --- |
| Node 22.12+ (system-wide, under Program Files) | official MSI from nodejs.org, or `winget install OpenJS.NodeJS.LTS`. Not nvm/fnm/volta. |
| pnpm | `corepack enable` |
| .NET SDK 10 | `winget install Microsoft.DotNet.SDK.10` |
| NSSM | `choco install nssm` |
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

It checks the tools, deletes a hard-linked `node_modules` if one exists, runs `pnpm install --frozen-lockfile`,
verifies better-sqlite3 loads under the system Node, runs `pnpm build` (shared, server, web, and a
`dotnet publish -c Release` of SkaliHelper to `tools\SkaliHelper\publish\SkaliHelper.exe`, where the server looks for it), and only
**then** locks the repo down to admins/SYSTEM (it also makes Administrators the owner of the repo, so
the installing user cannot re-grant themselves access), creates
`C:\ProgramData\Skali` with SYSTEM + Administrators only (inheritance off, owner Administrators) **before** the service first starts
(or refuses an existing one it cannot trust, see below),
installs/updates the service, adds the firewall rule `Skali web (TCP 4100)` (Private, local subnet, node.exe only),
starts the service and checks `GET http://127.0.0.1:4100/api/games` returns 200 and the data dir ACL.

**Why the lockdown runs after the install, and why `.npmrc` says `package-import-method=copy`:** pnpm's default
hard-links `node_modules` files from its global store, and NTFS keeps one ACL per file, shared by every link. A
lockdown run before the install would leave the store's links writable by the installing user (a way to change code
LocalSystem runs). A lockdown over an existing linked `node_modules` would rewrite the ACLs of the store and of every
other pnpm project on the PC. With `copy`, install writes private files that simply inherit the repo ACL, and the
installer deletes an old hard-linked `node_modules` first (this removes only this repo's links) and fails if any
remain. The repo ACL commands use icacls `/L`, which applies a change to a junction itself rather than to its target; it does **not**
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

From an **elevated** PowerShell (the repo ACL denies a normal shell write access, so `git pull` fails otherwise):

```powershell
cd C:\skali
git pull
.\scripts\install-service.ps1
```

The service is stopped for the build and restarted; running games are untouched.

## Uninstall

```powershell
.\scripts\uninstall-service.ps1                 # removes the service and the web firewall rule
.\scripts\uninstall-service.ps1 -Purge          # also deletes C:\ProgramData\Skali, all "Skali - *" rules and the SkaliGames user
.\scripts\uninstall-service.ps1 -Purge -DryRun  # preview
```

To give the repo folder back to normal users afterwards: `icacls C:\skali /reset /T`.
`-Purge` also removes the `SkaliGames` Windows profile (`C:\Users\SkaliGames`) if one was ever created. Each purge step
runs independently; failures are listed at the end (for example a running game holding a log file in the data dir).

Game folders and saves are never deleted. Running games are never stopped; the script warns and lists any it finds.
`-Purge` deletes the database and secret key, so Skáli forgets all servers and their stored passwords.

## Logs

- Service log (startup, shutdown, helper errors): `C:\ProgramData\Skali\service.log` (NSSM rotates it at service start once it is over 10 MB; the app and NSSM both append to this one file, so it can grow between restarts).
- Per-server logs: `C:\ProgramData\Skali\logs\`.
- Live console output per server: the server's page in the UI.

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
`http://127.0.0.1:4100/settings` and fix the allowlist there.

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
- [ ] `http://192.168.0.100:4100` loads from your PC (.150).
- [ ] `http://<server-hostname>:4100` loads from your PC. Names outside the accepted Host forms (see Locked out?) get 403 (by design).
- [ ] Another LAN device (not on the allowlist) gets the 403 text.
- [ ] On the server PC `http://127.0.0.1:4100` always works (also with an emptied allowlist).
- [ ] Data dir ACL: `icacls C:\ProgramData\Skali` lists only SYSTEM and Administrators (no other account or SID, no `(I)` inherited entries). Owner is Administrators or SYSTEM
      (`(Get-Acl C:\ProgramData\Skali).Owner`), as is the repo's. `secret.key` and `skali.db` inherit it (the installer also asserts this).
- [ ] better-sqlite3 loads under the system Node: in `apps\server`, `node -e "new (require('better-sqlite3'))(':memory:').close()"`
      prints nothing and exits 0.
- [ ] Firewall rule `Skali web (TCP 4100)` exists: Private, RemoteAddress LocalSubnet, program node.exe.

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
Install them manually first (SteamCMD for Palworld, a server jar for Minecraft).

- [ ] Palworld: **pending** (not installed yet)
- [ ] Minecraft: **pending** (not installed yet)
