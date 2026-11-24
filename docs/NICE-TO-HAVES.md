# Skáli: roadmap and nice-to-haves

Ideas that are agreed or parked but not built yet. The approved designs live in `docs/superpowers/specs/`, and the plans in `docs/superpowers/plans/`.

## In progress

- **Auto-deploy** (`plans/2026-11-24-skali-auto-deploy.md`): push to `main`, then the server PC tests, builds, switches and health-checks Skáli by itself. The Deploys page shows each deploy and has Deploy now, Restart, Pause and Roll back. Skáli moves to port 4200.
  - Still to do on the server PC: the first real `install-deployer.ps1` run and the "Auto-deploy" acceptance items in
    `RUNNING.md` (only dry runs and the helper's tests ran on the dev PC). Parked: an automated test of the setup
    scripts themselves (they need elevation, NSSM and a real service, so they are covered by `-DryRun` and acceptance only).

## Planned next

### Plan 2: Settings editor
- Every config file per server, read through lossless INI, properties, JSON and YAML parsers (comments and order kept).
- A form view with inferred types and template metadata, plus a raw view (CodeMirror).
- Config history, so you can see and undo changes.
- Locked keys that Skáli depends on (ports, RCON) are shown but guarded.
- When a change needs a restart: **Restart now** or **Later**, and the card shows "restart pending".
- Fixes parked into this plan:
  - RCON connect never settles on close-without-error.
  - Per-packet timeout, truncation of single packets over 4096 bytes, and ASCII-only bodies.
  - Palworld options parser edge cases (trailing comma, BOM, `\t\f` in properties).

### Plan 3: Setup and maintenance
- A gallery of games with search over Steam's app list.
- SteamCMD, Temurin (Java) and Minecraft server downloads, done for you.
- A setup dialog with port-conflict checks and live progress, plus Steam login when a game needs it.
- An **Update** button per server, which takes a world backup first.
- World backup and restore, with retention.
- Auto-deploy waits while a SteamCMD install or update is running (a new busy reason).
- Palworld's `save()` timeout of 5 s must be fixed before Palworld goes live.

## Nice-to-haves (parked, no plan yet)

### Servers
- **Scheduled jobs:** restarts, backups and game updates on a timer.
- **Graceful stop-all on Windows shutdown**, so worlds save before a reboot. Today games only get what Windows sends their console.
- **Mods:** Forge/Fabric/modpacks, BepInEx, Palworld mods, and a mod manager. Vanilla only for now.
- **More fully supported games**, promoted from "Basic". AMP's community templates and LinuxGSM's game list are a good source of app ids, executables and ports.
- **More busy reasons** for auto-deploy beyond starting and stopping.

### Notifications and integrations
- **Discord, push or email notifications**: a server crashed, a deploy failed, the GitHub token is expiring.
- **Home integration:** a card in Home that links to Skáli or shows server status.

### Deploys
- A **database restore button** on the Deploys page (today it's a documented manual restore).
- **The helper updating itself** (today you re-run setup at the server PC).
- Parked from the auto-deploy final review:
  - The **Roll back** button for a kept release disappears once its deploy event falls out of the last 50 events.
    Fix: build the rollback rows from the kept releases, not from the events.
  - Failed deploys use up backup slots, so a run of 10 failures pushes out the backup from the last good state.
  - **Pause** is refused while a deploy is waiting for games to finish starting or stopping (up to 10 minutes).
  - A per-release folder-permission spot check. Today each release inherits from the locked `C:\SkaliDeploy`.
  - Raise the minimum git version above 2.31, or confirm that older git honours `safe.directory` set through the
    environment.
  - Ctrl+C in setup still reaches the build steps it runs. The outcome is safe, but RUNNING.md's "it finishes" wording
    promises more than it delivers.

### Polish
- UI:
  - Busy state clearing before the status update arrives.
  - A blank snackbar.
  - Confirm dialogs that stay open.
  - Disabling actions while disconnected.
  - An emptyable number field.
  - The "stopped" helper text.
- Performance: fetch cancellation and a smaller web bundle (about 640 kB now).
- A long `list`/help output over RCON can be cut off.

## Out of scope on purpose
- Logins, a PIN or accounts (the IP allowlist is the guard).
- Access from outside the home network, and router port forwarding (Skáli shows the ports, you set the router once).
- Linux, Docker, or more than one server PC.
- A general file browser.
- Deploying branches other than `main`, webhooks, or inbound ports for deploys.

## Known residual risk
- **Repo lockdown race (R3-I1):** someone who can write to the repo *before its first lockdown* could swap a folder for a link while the recursive `icacls` runs. That person could already change code that runs as SYSTEM, so the race gives them nothing new. The server PC has no untrusted local users. Documented in RUNNING.md. A non-recursive, parents-first walk would close it if it ever matters.
