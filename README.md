# Skáli

Windows game-server manager: a Node/TypeScript server (Windows service `Skali`, port 4100), a React web UI and a small
.NET helper (`tools/SkaliHelper`) that launches games as the low-privilege `SkaliGames` user, stops them with Ctrl+C
and reads their stats. It manages Valheim, Palworld, Minecraft and generic servers on one always-on PC, from a LAN-only
web page restricted by a client IP allowlist.

Layout: `apps/server` (API, supervisor, adapters), `apps/web` (UI), `packages/shared` (types), `tools/SkaliHelper`,
`scripts/` (installer).

## Develop

```
pnpm install
pnpm test
pnpm dev
```

## Run on the server PC

```powershell
.\scripts\install-service.ps1 -DryRun   # preview
.\scripts\install-service.ps1           # elevated
```

See [docs/RUNNING.md](docs/RUNNING.md) for prerequisites, install/update/uninstall, logs, router port forwarding,
lock-out recovery, troubleshooting and the acceptance checklist. Design:
[docs/superpowers/specs/2026-11-23-skali-design.md](docs/superpowers/specs/2026-11-23-skali-design.md).
