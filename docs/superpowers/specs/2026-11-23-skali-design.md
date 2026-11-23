# Skáli — design

Date: 2026-11-23. Status: draft for approval.

## Intent

The owner hosts dedicated game servers (Palworld, Valheim, Minecraft, and others over time) for friends on an always-on Windows server PC — the same PC that runs Home (`../iot`). Today every start, stop, restart or update means walking over to that PC, turning the monitor on, and doing it by hand. That walk is the pain: servers go down and stay down because it's a chore to fix.

Skáli is a small service on the server PC with a web UI the owner opens from their own PC. Opening the page and clicking **Restart** must be the whole job. Beyond that, it should make setting up a new server, changing its settings, watching its logs and sending it commands easy enough that the server PC never needs a monitor for game-server work.

Single user (the owner), LAN only.

## Goals

1. **Control:** start, stop, restart every server from the browser; see status (stopped / starting / running / stopping / crashed / updating), uptime, CPU and RAM, and player count where the game exposes it.
2. **Live logs:** a console view streaming the server's output live, with history of earlier runs.
3. **Commands:** a command box per server, wherever the game has a way to accept commands.
4. **Settings:** every setting a server has — config files and launch arguments — editable from the page, shown as switches, number fields, dropdowns and text fields, with a raw-text view of the same file always available.
5. **Setup from the page:** a searchable gallery of dedicated servers. Picking one installs it, writes a starting config, opens the firewall, and leaves it ready to start.
6. **Updates:** one button per server to update its game files (with an automatic world backup first).
7. **Survives itself:** restarting or updating Skáli never stops a running game server.

## Non-goals (v1)

- Any login, PIN or user accounts (owner's explicit choice — see Security).
- Access from outside the home network.
- Router port forwarding (Skáli shows which ports to forward; the owner does it once on the router).
- Mods of any kind (Forge/Fabric/modpacks, BepInEx, Palworld mods) — owner runs vanilla only for now. Minecraft supports Vanilla and Paper (Paper is plugin-free by default). Mod management, scheduled restarts/backups/updates, Discord notifications, a general file browser. Parked for later.
- Linux, Docker, or running servers on more than one machine.
- Integration with Home. Later, Home may get a card linking to Skáli or showing server status; nothing in v1 depends on it.

## Anti-goals (would be a failure even if it "works")

- **Stopping a server loses world progress.** Every Stop, Restart and Update must let the game save first. A Stop that kills the process and drops the last 30 minutes of a Valheim world is a bug, not a limitation.
- **Skáli's own lifecycle takes servers down** (an update, crash, or service restart of Skáli kills friends' sessions).
- **Saving settings mangles a config file** (lost comments, reordered keys, dropped unknown keys, broken formatting the game then rejects).
- **Exposed beyond the LAN.**

## Constraints

- Server PC: Windows, always on, already runs Home as an NSSM service (`HomeControl`, LocalService) on port 4000, plus Postgres. Node 22 system-wide, NSSM installed via Chocolatey.
- Owner's stack preference (from Home and Vaka): TypeScript, React 19, MUI, Vite. Owner likes MUI.
- Skáli is a **standalone app** in its own repo folder (`projects/skali`), its own Windows service, its own port. It must not share a process or a deploy cycle with Home.
- No build/deploy automation is required for v1; an install script like Home's `scripts/install-service.ps1` is enough.

## Approaches considered

| | Approach | Trade-off |
|---|---|---|
| A | A new section inside Home | Free sign-in, service, UI shell and live updates — but Home redeploys itself on every green commit, which restarts its service; game servers it parents would die with each deploy. Working around that makes the core feature fragile. |
| **B** | **Standalone app on Home's stack (chosen)** | Game servers' uptime is independent of Home. Reuses Home's patterns (NSSM install script, firewall script, secrets encryption, tray idea) by copying, not importing. Costs its own install and port. |
| C | Off-the-shelf (AMP, WindowsGSM, Pterodactyl, LinuxGSM) | AMP does most of this on Windows but is paid; WindowsGSM is a desktop app (still have to walk over); Pterodactyl/LinuxGSM need Linux/Docker. Doesn't match the owner's setup or style. |

The owner picked **B**.

## Decided by the owner

- Standalone app, named **Skáli** (Old Norse "hall"; owner's apps use Viking names).
- Only the owner uses it. **No PIN or login.**
- Day-one full-support games: **Palworld, Valheim, Minecraft**.
- A **searchable gallery** of dedicated servers for easy setup, not only the three.
- **Settings are complete and configurable:** per server, the owner chooses which config file(s) and launch settings to manage; parsed config files appear as switches and fields; inline (launch-argument) settings are editable too.
- Servers can be set up from the page (not only adopted).

## The design

### Architecture

- **One Node 22 + TypeScript process**, installed as the Windows service `Skali` via NSSM, serving a REST/JSON API, a WebSocket for live data (status, logs, install progress), and the built React app — all on one port (proposal: **4100**).
- **Web UI:** React 19 + Vite + MUI + TypeScript. Served by the service; Vite dev server proxies in development.
- **State:** SQLite (one file in `C:\ProgramData\Skali\`) for servers, settings metadata, run history; plain files for logs and backups. *(Builder's call between SQLite and JSON files; SQLite is the proposal because run history and log indexes grow.)*
- **Data layout:**
  - `C:\ProgramData\Skali\skali.db` — state
  - `C:\ProgramData\Skali\logs\<serverId>\<runStartedAt>.log` — one file per run
  - `C:\ProgramData\Skali\backups\<serverId>\<timestamp>.zip`
  - `C:\ProgramData\Skali\config-history\<serverId>\…` — previous versions of edited config files
  - `C:\ProgramData\Skali\tools\` — SteamCMD, Java runtimes
  - Game installs default to `D:\GameServers\<name>` or a configurable root (Settings page); adopted servers stay where they are.
- **Service account:** Skáli runs as **LocalSystem**, because it must add Windows Firewall rules and manage folder permissions. *(My call; see Security.)*
- **Game server account:** game servers do **not** run as SYSTEM. Their ports are forwarded to the internet, so a remote-code bug in a game or plugin must not hand over the PC (which also runs Home and Postgres). The installer creates a local standard user `SkaliGames` (random password, stored encrypted, "deny interactive logon"), and Skáli launches every server as that user (detached — e.g. `CreateProcessAsUser`/`CreateProcessWithLogonW` via a small helper; builder's call on mechanism). Skáli grants `SkaliGames` modify rights on each server's folder (new and adopted) and on its save folder. Saves are always pointed at an explicit folder inside the server folder (Valheim `-savedir`, Minecraft world dir, Palworld's own `Pal\Saved`), so nothing depends on `SkaliGames`' profile. *(My call.)*

### Process model (how Goal 7 is met)

Game servers are **not** children tied to Skáli's lifetime:

- Skáli spawns each server **detached**, with stdout and stderr redirected straight to that run's log file (the child holds the file handle, not a pipe to Skáli). Skáli records the PID and process start time in the DB.
- On Skáli start, it re-attaches to every server whose recorded PID is still alive with the same start time (guards against PID reuse), and resumes tailing its log file.
- Live console = Skáli tailing the log file and pushing new lines over the WebSocket.
- Because there's no stdin pipe, **commands go through each game's remote interface** (see Game adapters), not through stdin.
- **Crash handling:** if a process exits without Skáli having asked it to, the server is marked *crashed* and restarted automatically after 10 s; after 3 crashes within 10 minutes, Skáli stops retrying and shows the server as *crashed — auto-restart paused*. Auto-restart is on by default and can be turned off per server.
- **Start with Windows:** per-server "start when Skáli starts" toggle (default on for servers that were running when the PC went down — i.e. Skáli restores the last desired state).

### Game adapters

Each game is an **adapter**: a TypeScript module (code where behaviour differs) plus a data template (ports, defaults, field metadata). Adapters provide: install, update, launch command, graceful stop, command channel, player count, world-save location, and config sources.

**Palworld**
- Install/update: SteamCMD app `2394010`, anonymous.
- Launch: `PalServer.exe` with `-port`, `-players`, and perf flags (`-useperfthreads -NoAsyncLoadingThread -UseMultithreadForDS`) as editable launch settings.
- Config: `Pal\Saved\Config\WindowsServer\PalWorldSettings.ini` — the whole config lives in a single `OptionSettings=(Key=Value,…)` tuple line; needs its own parser/serializer. If the file doesn't exist yet, Skáli seeds it from `DefaultPalWorldSettings.ini`.
- Commands + players + graceful stop: Palworld's **REST API** (enable `RESTAPIEnabled=True`, set `AdminPassword`, Skáli generates and stores these). Stop = `save` then `shutdown`. RCON is the fallback if REST isn't available in the installed version.
- Note: `PalServer.exe` launches a child `PalServer-Win64-Shipping-Cmd.exe`; process tracking and CPU/RAM must follow the real server process.

**Valheim**
- Install/update: SteamCMD app `896660`, anonymous.
- Launch: `valheim_server.exe -nographics -batchmode -name -port -world -password -public -savedir -logFile -crossplay`. Valheim has **no config file**; all its settings are launch arguments, so the Settings page shows them as fields (world name, password, public toggle, crossplay toggle, port, save dir, world modifiers/presets).
- Logs: via `-logFile` pointed at the run's log file.
- Commands: Valheim's dedicated server accepts no console commands. The command box is hidden; the console is log-only.
- Players: Steam A2S query on port+1.
- **Graceful stop: Valheim only saves on Ctrl+C (console close / CTRL_C_EVENT).** A detached process started from a service has no shared console, so Skáli needs a way to deliver Ctrl+C to it (e.g. a tiny helper that attaches to the process's console and calls `GenerateConsoleCtrlEvent`). Must be verified to actually save the world before v1 ships. Fallback if impossible: stop waits for the next autosave isn't acceptable — find a mechanism.
- Adopt existing: the owner's dormant Valheim install on the server PC is the first "Add existing folder" test case.

**Minecraft (Java Edition)**
- Not on Steam. Install: choose **Vanilla** (Mojang version manifest) or **Paper** (PaperMC API), and a version (default latest release). Downloads the jar, writes `eula.txt` only after the owner ticks "I accept the Minecraft EULA" in the setup dialog.
- Java: Skáli detects the required Java version for the chosen Minecraft version and downloads a matching **Eclipse Temurin** JRE into `tools\` if not present. Memory (Xms/Xmx) is a launch setting.
- Config: `server.properties` (properties format); also `ops.json`, `whitelist.json` as editable lists.
- Commands + players + graceful stop: **RCON** (Skáli enables `enable-rcon`, sets a generated password and port). Stop = `save-all` then `stop`.
- Update: change version → download new jar → backup → restart.

**Basic (any other Steam dedicated server)**
- Install/update via SteamCMD by app id.
- After install, Skáli lists `.exe` files in the folder and suggests the most likely server executable; the owner confirms it and enters launch arguments and ports once.
- Commands: optional — owner can configure RCON (host/port/password) or Source-style A2S for players. Otherwise log-only console.
- Graceful stop: try Ctrl+C (same helper as Valheim), then close after a timeout (configurable, default 60 s), then kill.
- Config: the owner adds config files manually (see Settings).

### Gallery and setup

- **New server** page: a search bar over a gallery.
  - **Full support** cards (★) at the top: Palworld, Valheim, Minecraft.
  - **Steam** results below: Skáli keeps a cached copy of Steam's public app list filtered to dedicated-server tools (names containing "Dedicated Server" and similar), refreshed daily. Results are labelled *basic*.
  - Reference for promoting more games to full support later: AMP's community templates and LinuxGSM's game list (app ids, executables, ports).
- **Setup dialog** (per game): name, install folder (default under the games root), ports (pre-filled, checked for conflicts with other Skáli servers and with listening sockets), game-specific essentials (Palworld: server name, password, max players; Valheim: world name, password, public; Minecraft: flavour, version, memory, EULA).
- **Create** then runs, with live progress on the page: download SteamCMD if missing → install/download game → seed config → add Windows Firewall inbound rules (named `Skali - <server> - <port>/<proto>`) → done, server ready to start. Failures leave the server in *install failed* with the log and a Retry button.
- **Add existing folder:** pick a game (or basic), point at a folder; Skáli validates the executable is there and reads existing config. Nothing is downloaded.
- **Steam login:** some servers need a Steam account rather than anonymous SteamCMD. Skáli detects the failure, asks for credentials, and stores them encrypted (AES-256-GCM with a key in `C:\ProgramData\Skali\`, as Home's `apps/server/src/secrets.ts` does). Steam Guard codes are entered on the page when SteamCMD asks.
- **Delete server:** removes it from Skáli and its firewall rules; deleting game files and backups is a separate, explicit checkbox.

### Settings (config) — the configurable part

Each server has a list of **config sources**. A source is one of:
- a **config file** inside the server folder, with a format; or
- the **launch settings** (the server's command-line arguments).

Full-support adapters pre-populate the list (Palworld: `PalWorldSettings.ini` + launch settings; Valheim: launch settings; Minecraft: `server.properties`, `ops.json`, `whitelist.json` + launch settings incl. memory). For any server, the owner can **add a config file** by picking it from the server folder and choosing its format (auto-detected from the extension, overridable), or remove one from the list.

**Supported formats** (each with a parser that round-trips losslessly — comments, key order, blank lines, unknown keys preserved; only edited values change):
- INI (`[section]` + `key=value`), including Unreal-style INI and Palworld's `OptionSettings=(…)` tuple
- Java `.properties`
- JSON
- YAML
- Plain launch-argument list (`-flag`, `-key value`, `-key=value`, `+key value`)
- Anything else: raw text only

**Form view** (default) — every key in the file becomes a field:
- Inferred from the value: `true/false/True/False` → switch; integers/decimals → number field; everything else → text field.
- **Template metadata** overrides inference for known games: label, description, group/section, type, dropdown options, min/max/step, unit, "secret" (masked), "requires restart". E.g. Palworld's `Difficulty` is a dropdown, `ExpRate` a number with step 0.1, `ServerPassword` secret.
- Grouped by file section or by template groups; a filter box searches keys and labels.
- Keys present in the file but unknown to the template still appear (inferred type), so nothing is hidden.
- Changed fields are highlighted; a **Save** bar shows how many changes; **Reset** discards.

**Raw view** — a code editor (CodeMirror 6) on the same file with syntax highlighting; toggling between form and raw keeps them in sync. Saving raw text that the parser can't read shows the parse error and still allows saving (owner's file, owner's call), but then that file is raw-only until fixed.

**On save:**
- The previous version is copied to `config-history` (keep the last 20 per file); a **History** list can restore one.
- If the server is running and the file/setting requires a restart, Skáli offers **Restart now** (graceful) or **Later**; the server card shows "restart pending".
- Skáli-managed keys it depends on (RCON/REST enabled, passwords, ports) are shown but locked with a note, so the owner can't accidentally break Skáli's control channel.

### Updates and backups

- **Update** (Steam games): stop gracefully → back up world → `steamcmd +app_update <id> validate` → start (if it was running). Progress streams live.
- **Back up world** button: zips the adapter's save location (Palworld `Pal\Saved\SaveGames`, Valheim save dir, Minecraft world folders) to `backups\`. Keep the last 10 per server (configurable). **Restore** stops the server, backs up the current world first, unzips the chosen one, starts.
- A backup is also taken automatically before every update and restore.

### UI

Pages:
- **Servers (home):** a card per server — game icon, name, status chip, uptime, players `3/16`, CPU/RAM, connect address `<public-or-LAN-ip>:<port>` with copy button, and Start / Stop / Restart buttons. Restart is one click; Stop asks for confirmation if players are online.
- **Server detail:** tabs
  - *Console:* live log (auto-scroll with pause-on-scroll-up, search, ANSI colours, run picker for previous runs, download) and the command box (hidden when the game has no command channel; command history with ↑).
  - *Settings:* config sources list on the left, form/raw editor on the right.
  - *Backups:* list, Back up now, Restore, Delete.
  - *Overview:* install folder, game version/build, ports + "forward these on your router" list, firewall rule status, auto-restart toggle, start-with-Skáli toggle, Update, Delete.
- **New server:** gallery + search + setup dialog with live install progress.
- **Settings (Skáli):** games root folder, allowed client IPs, Steam credentials, backup retention, SteamCMD/Java status.

```
Skáli                                         [+ New server]
┌───────────────────────────┐ ┌───────────────────────────┐
│ ⛏ Minecraft — survival     │ │ ⚔ Valheim — friends-2026  │
│ ● Running  2h 14m  3/10   │ │ ○ Stopped                 │
│ CPU 12%  RAM 4.1 GB       │ │                           │
│ 192.168.1.20:25565  ⧉     │ │ 192.168.1.20:2456  ⧉      │
│ [Stop] [Restart]          │ │ [Start]                   │
└───────────────────────────┘ └───────────────────────────┘
```

### Security

No login, by the owner's choice. Because Skáli runs as LocalSystem and its settings include "which executable to run with which arguments", anyone who can reach the port can run anything on the server PC. Mitigations that cost the owner nothing day-to-day:
- **Client IP allowlist** (my call): a list of IPs and/or CIDR subnets; requests from other addresses get 403. The install script asks for it, defaulting to the owner's PC, `192.168.0.150` (reserved on the router, so it doesn't change). The server PC is `192.168.0.100` (also reserved), so connect addresses shown in the UI use that. Editable on the Settings page; `127.0.0.1` always allowed. Entering the whole subnet (`192.168.0.0/24`) is allowed but the Settings page warns that it lets every device on the network in.
- Windows Firewall rule for 4100 scoped to the LAN subnet (as Home's `scripts/firewall.ps1` does).
- Never exposed to the internet; only game ports are forwarded.
- Generated RCON/REST passwords and Steam credentials stored encrypted at rest.

### Install

- `scripts/install-service.ps1` (modelled on Home's): checks admin, Node 22, NSSM; builds; creates `C:\ProgramData\Skali` with admin/SYSTEM-only ACLs; installs/updates the `Skali` NSSM service (LocalSystem, auto start, restart on failure); adds the 4100 firewall rule; asks for the allowlist IP.
- Re-running updates in place. Because of the process model, updating Skáli doesn't touch running game servers.

## Decided by me (owner should check)

- Port **4100**; service name `Skali`; data in `C:\ProgramData\Skali`.
- Service runs as **LocalSystem** (needed for firewall rules and ACLs); **game servers run as a low-privilege `SkaliGames` user**, never SYSTEM.
- **Client IP allowlist** (IPs or subnets) instead of a PIN, defaulting to `192.168.0.150`.
- Adopting a folder whose world lives elsewhere (e.g. a Steam-client Valheim with worlds in a user profile) **copies** the world into the server's save folder; the original is left untouched.
- **Detached processes + log files + remote command channels** (REST/RCON) rather than stdin pipes, so Skáli can restart without killing servers. Consequence: Minecraft commands go via RCON (enabled automatically); Valheim has no command box.
- Crash auto-restart on by default (3 crashes in 10 min pauses it).
- Minecraft: Vanilla or Paper; Temurin JRE auto-downloaded.
- Config history: last 20 versions per file; world backups: last 10 per server.
- Skáli-critical config keys are locked in the form.
- CodeMirror 6 for the raw editor; SQLite for state.

## Left to the builder

- SQLite library/ORM choice (or JSON files if it stays simpler), WebSocket library, CodeMirror integration details.
- Exact mechanism for delivering Ctrl+C to a detached console process (must be proven with Valheim saving its world).
- Exact Steam app-list endpoint and the filter for "dedicated server tools".
- CPU/RAM sampling method.
- Parser implementations (existing round-trip-safe libraries vs. own), as long as round-trips are lossless and covered by tests with real config files from each game.
- Visual design within MUI.
