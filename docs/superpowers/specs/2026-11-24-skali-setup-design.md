# Skáli Plan 3a — New server: gallery and install

Status: draft for the owner's approval (2026-11-24). Parent design: `2026-11-23-skali-design.md` §Gallery and setup, §Updates and backups. This document replaces the parent's "Steam app list" gallery source (see Approaches) and splits Plan 3 in two.

## Why

Today Skáli can only adopt a server that is already installed: the owner installs SteamCMD or a Minecraft jar and Java by hand on the server PC, then uses **Add server**. The point of Skáli is to not walk to the server PC. After 3a, a new server goes from nothing to "ready to start" from the browser on 192.168.0.150, and an installed Steam server can be updated with one button.

## Goals

- A **New server** page: search over a gallery. ★ Palworld, Valheim, Minecraft on top; a built-in list of other Steam dedicated servers below ("basic"); "Other Steam app ID" for anything not listed.
- A **setup dialog** per game: name, install folder, ports (checked for conflicts), and the game's essentials.
- **Create** runs an install job with live progress on the page: tools (SteamCMD / Java) if missing → game files → seed config → folder permissions + firewall rules → ready. Failure leaves the server in *install failed* with the log and **Retry**.
- An **Update** button: Steam games run `app_update <id> validate`; Minecraft changes version. Both stop the server gracefully first, take a world backup, and start it again if it was running.
- Skáli **Settings** page gains: games root folder, and a status line for SteamCMD and each Java runtime (installed version / not installed).
- Auto-deploy waits while an install or update runs (new busy reason).
- **Add existing folder** stays as it is, reachable from the New server page.

## Non-goals (3a)

- **Plan 3b:** Backups tab (list, Back up now, Restore, Delete), retention, and Steam login with Steam Guard. 3a only contains the "zip the world before an update" step that Update needs, writing to the same `backups\` location 3b will list.
- Mods, modpacks, Forge/Fabric. Vanilla and Paper only (owner: vanilla only, no mods).
- Promoting more games to ★ full support.
- Deleting game files when a server is removed (unchanged from today).
- Scheduled updates.

## Anti-goals

- An install that half-succeeds and leaves a server that looks ready but won't start.
- Any install step that runs while the game is running, or two jobs on one server at once.
- Downloading anything from a source other than Valve (SteamCMD), Mojang, PaperMC, or Adoptium.
- Secrets (RCON/REST passwords, Steam credentials later) in logs or in Skáli's own argv — same rule as today. (Valheim's `-password` launch arg is the game's only way to take it and already works that way for adopted servers; unchanged.)

## Constraints (from the project)

- Skáli runs as LocalSystem (NSSM service `Skali`); game servers run as the low-privilege user `SkaliGames`. Installs run as LocalSystem, so after the install the folder gets the same `grantModify(folder, SkaliGames)` the adopt flow does. **Java under `tools\` must be readable and executable by `SkaliGames`**; `C:\ProgramData\Skali` holds secrets, so the builder must check its ACL and grant read+execute on `tools\java\` only, never on the data folder as a whole.
- Folder rules: the install folder must pass the same `checkFolder` rules as adopt (not a drive root, not under Windows / Program Files / ProgramData / Skáli's data or install dir, not a user profile), and must be **new or empty**. Skáli creates it.
- Server names follow `NAME_RE` (`^[A-Za-z0-9 _.-]{1,40}$`). Firewall rules keep the `Skali - <server> - <port>/<PROTO>` naming and the existing `ensureFirewallRules`.
- Owner does git; no new Windows services, no system-wide installs (Java is a private copy under `tools\`, not on PATH).

## Approaches considered (gallery source)

Steam has retired `ISteamApps/GetAppList` (reported returning 404); the replacement `IStoreService/GetAppList` needs a Web API key and lists only apps with store pages, which most dedicated servers don't have. The owner confirmed the public Web API offers no other app-list method.

1. **Built-in list + app ID box** — *chosen.* A JSON list of ~100 well-known Windows dedicated servers ships with Skáli; search runs over it; anything else is added by app ID, which Skáli confirms by asking SteamCMD for the app's name. No key, no refresh, and the list can carry default ports.
2. Steam's new API with an owner-supplied key — always current, but would miss most dedicated servers and adds a key to manage.
3. Only the three ★ games + app ID box — no browsing, which is what the owner asked for.

## Design

### Tools (`C:\ProgramData\Skali\tools\`)

- **SteamCMD:** `tools\steamcmd\steamcmd.exe`, downloaded from Valve's `steamcmd.zip` on first need. First run self-updates; that output is part of the job log.
- **Java (Temurin JRE):** `tools\java\<major>\` per Java major version, from the Adoptium API (latest GA JRE, windows x64, hotspot). Minecraft's required major comes from the version's Mojang metadata (`javaVersion.majorVersion`).
- Downloads go to a temp file and are moved into place only when complete; a half-finished tool download never looks installed.

### Game sources

- **Palworld** `2394010`, **Valheim** `896660`, **basic** by app ID: `steamcmd +force_install_dir <folder> +login anonymous +app_update <id> validate +quit`. The app ID is stored on the server record (new `steamAppId`, null for Minecraft and for adopted servers unless the owner sets it), so Update knows what to run.
- **Minecraft:** flavour **Vanilla** (Mojang version manifest → version JSON → `downloads.server`) or **Paper** (PaperMC's current download API — the builder must check which API version is live, as PaperMC has been moving off `api.papermc.io/v2`). Version list shows releases only, default latest. Verify downloads by the hash the source publishes (Mojang SHA-1, Paper SHA-256). EULA written only when ticked (reuse `writeEula`); Create is disabled until it is ticked.

### Built-in list (`apps/server/src/games/catalog.json`)

Entry: `{ appId, name, ports?: PortSpec[], exeHint?, notes? }`. ★ games are not in it (they come from the adapters). Built once by a dev script from LinuxGSM's game list (MIT; keep attribution in the file) and kept only entries whose SteamCMD app info shows a Windows depot. LinuxGSM is Linux-oriented, so executables are only hints; after install the basic adapter's existing exe detection suggests the server program and the owner confirms it in the setup result. Regenerating the list is a manual dev task, not something Skáli does at runtime.

**App ID box:** Skáli runs `steamcmd +login anonymous +app_info_print <id> +quit` and shows the app's name (or "not found / no Windows build") before Create is enabled.

### Setup dialog

| Game | Essentials |
|---|---|
| Palworld | server name, password (optional), max players (default 32) |
| Valheim | world name, password (min 5 chars, Valheim's rule), public toggle, crossplay toggle |
| Minecraft | Vanilla/Paper, version, memory (default 4096 MB), EULA tick |
| Basic | nothing up front; exe, args and ports confirmed after install (from the catalog's hints where present) |

All games: **name**, **install folder** (default `<games root>\<name>`, editable via the existing FolderPicker), **ports** (pre-filled from the adapter or catalog). Defaults otherwise come from the adapter's existing `inspectFolder` defaults so an installed server ends up with the same launch values an adopted one would.

**Port check** (on the dialog and again server-side at Create): a port clashes if another Skáli server uses it (same protocol) or something on the PC is already listening on it (try to bind it). Clashes show next to the field; Create is refused with the reason.

### Install job

- New server statuses **installing** and **install failed** (alongside stopped/running/…). A server in either can't be started; *installing* can't be removed. Remove of an *install failed* server is allowed and offers to delete the folder Skáli created (only that folder, only if Skáli created it).
- The server record is created first (so the card appears with live progress), then the job runs its steps; each step's output streams as log lines over the existing WebSocket log channel to the server page, plus a step list (pending / running / done / failed) and SteamCMD's download percentage where it reports one.
- Steps: tools → game files → seed config (adapter's existing seed-from-default behaviour, plus the essentials from the dialog written into launch values / config) → `grantModify` → firewall rules → status *stopped* (ready).
- **Retry** reruns from the first failed step; earlier completed steps are skipped (SteamCMD `validate` makes re-running game files safe anyway).
- If Skáli restarts mid-job, a job found *installing* at startup becomes *install failed* ("Skáli restarted during the install") with Retry.
- One job per server at a time; jobs on different servers may run together, but only one SteamCMD process at a time (SteamCMD shares its own folder state), others queue with "waiting for SteamCMD".
- **Steam login needed** (SteamCMD reports no subscription / login required): the job fails with a clear message that this server needs a Steam login, which arrives in 3b.

### Update

- Button on the server's Overview tab, for servers with a `steamAppId` (Steam) or game `minecraft`. Minecraft opens a version picker.
- Steps (same job machinery and live progress; status shows *updating*): graceful stop if running → zip the world (Palworld `Pal\Saved\SaveGames`, Valheim save dir, Minecraft world folders per `server.properties` `level-name`) into `C:\ProgramData\Skali\backups\<server id>\<timestamp>-pre-update.zip` → update → start if it was running.
- A failed update leaves the server *stopped* with the log; it doesn't auto-start a possibly broken install. The pre-update zip is kept (3b's retention will manage it; 3a never deletes backups).

### Auto-deploy

`/api/deploys/busy` adds a reason for every running install or update job ("<server> is installing" / "is updating").

### Palworld save timeout

The parent roadmap requires Palworld's REST `save()` (5 s timeout) to be fixed before Palworld goes live, since a freshly installed Palworld is the first one that will run. Raise the timeout for `save` only (large worlds take longer) and keep stop's existing "save failed → shutdown anyway" behaviour.

### Settings

- `gamesRoot` setting, default `D:\GameServers` if drive D: exists, else `C:\GameServers`. Must pass the folder rules (as a parent; it may not exist yet).
- Tool status: SteamCMD installed/not, each Java major present. No "install now" button; tools install on demand.

## Decisions settled after the builder check

Calls made by Claude (not the owner) unless marked; each is cheap to change at plan review.

1. **Basic servers after install:** the job's last step is **Confirm server program**. The job ends with the server *stopped* but flagged `setupPending`; its card and Overview show "Finish setup" with the launch form pre-filled (detected exe, catalog ports/args). Start is disabled until the owner saves that form once; saving runs the firewall step with the confirmed ports. If no exe was detected, the form is empty and the same rule applies. No new status.
2. **Minecraft records and Update:** launch values gain `mcFlavour` (`vanilla` | `paper`) and `mcVersion` (and `paperBuild` for Paper). Update downloads the new jar to a temp file, verifies it, then replaces `launch.jar`'s file, keeping the previous jar as `<jar>.previous`. If the new version needs a different Java major, Update fetches it and rewrites `javaPath` **only if** `javaPath` points into `tools\java\` (an owner-set Java is left alone, with a warning if it's the wrong major). Downgrades are allowed with a warning ("worlds opened in a newer version may break"), since the pre-update backup makes it recoverable. Adopted Minecraft servers get Update too; with no recorded flavour/version, the picker asks for the flavour and shows "current version: unknown".
3. **Essentials, where they land:** Palworld — the install's "seed config" step creates `PalWorldSettings.ini` from the installed `DefaultPalWorldSettings.ini` (the adapter's existing seed path, `palworld.ts`) and writes `ServerName`, `ServerPassword`, `ServerPlayerMaxNum` into it through the Plan 2 config layer, plus `-players` in launch values. Valheim — world name, password, public, crossplay go into launch values exactly as an adopted Valheim's do today. Minecraft — `server.properties` doesn't exist until first run; Skáli seeds it with `server-port`, RCON and nothing else, and the rest is left to the game's defaults (editable in Settings afterwards).
4. **Folder ownership and Retry:** the record gets `createdFolder: boolean`. Remove of an *install failed* server shows "Also delete <folder>" (unticked) only when `createdFolder` is true. Retry skips the "new or empty" check, re-runs the port check, and resumes at the first failed step.
5. **App IDs for adopted servers:** Palworld and Valheim take their app ID from the adapter, so adopted ones get Update automatically. Basic servers get an editable "Steam app ID" field on Overview; Update shows when it's set.
6. **Palworld save timeout:** 60 s for the `save` call only (other REST calls keep 5 s). The stop budget (`defaultStopTimeoutSec`) is raised to cover it if it's currently shorter than save + shutdown.
7. **Backup zip:** a streaming zip library is a new server dependency (not PowerShell `Compress-Archive`, which fails on large files). If the save folder doesn't exist yet (never-run server), the backup step is skipped with a log note. No disk-space preflight; a failed zip fails the update before anything is changed.
8. **Port check:** UDP ports are checked with a UDP bind, TCP with a TCP listen, on all interfaces. All of a server's ports count, forwarded or not (RCON, REST, query).
9. **Catalog:** the generator script is committed under `tools/catalog/` with a README; it's run once during implementation (needs network + SteamCMD on the dev PC) and is not part of CI or the test suite. The JSON it produces is what ships.
10. **Updating at restart:** a job found *updating* at startup ends as *stopped* with "Skáli restarted during the update — check the server, then start it", and `desired` is set to stopped so auto-start doesn't launch a possibly half-updated install.

## Left to the builder

- Exact step names, job table shape (a DB table vs. in-memory with startup reconciliation, as long as restart → *install failed* holds), and how progress messages are added to the shared WebSocket message types.
- SteamCMD output parsing for percentage and error detection; the exact strings must be taken from real SteamCMD output, recorded as test fixtures.
- How the New server page is laid out within the existing MUI style; the gallery's card design.
- Which LinuxGSM fields map to ports.
- Server-PC acceptance items in `RUNNING.md` (fresh Palworld, Valheim, Minecraft Vanilla and Paper installs; one basic install; Update on each; auto-deploy waiting during an install; a forced failure and Retry).
