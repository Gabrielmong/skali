# Skáli

Windows game-server manager: a Node/TypeScript server (Windows service `Skali`, port 4200), a React web UI and a small
.NET helper (`tools/SkaliHelper`) that launches games as the low-privilege `SkaliGames` user, stops them with Ctrl+C
and reads their stats. It manages Valheim, Palworld, Minecraft and generic servers on one always-on PC, from a LAN-only
web page restricted by a client IP allowlist.

Layout: `apps/server` (API, supervisor, adapters), `apps/web` (UI), `packages/shared` (types), `tools/SkaliHelper`,
`apps/deployer` (the auto-deploy helper), `scripts/` (installers).

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

Auto-deploy (push to `main`, the server PC deploys each green commit; Deploys page in the UI), set up once after the
install:

```powershell
.\scripts\install-deployer.ps1 -DryRun  # preview
.\scripts\install-deployer.ps1          # elevated; commit and push first
```

See [docs/RUNNING.md](docs/RUNNING.md) for prerequisites, install/update/uninstall, auto-deploy, logs, router port forwarding,
lock-out recovery, troubleshooting and the acceptance checklist. Design:
[docs/superpowers/specs/2026-11-23-skali-design.md](docs/superpowers/specs/2026-11-23-skali-design.md).
