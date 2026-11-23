# Skáli Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Windows service on the server PC that runs and controls already-installed Palworld, Valheim, Minecraft and "basic" game servers from a browser: start/stop/restart, live console, commands, status/players/CPU/RAM, add an existing folder, with game servers surviving Skáli restarts.

**Architecture:** One Node 22 + TypeScript process (Express 5 REST + `ws` WebSocket + static React build) installed as the NSSM service `Skali` (LocalSystem) on port 4100. Game processes are launched **detached** by a small .NET helper (`SkaliHelper.exe`) that runs them as the low-privilege `SkaliGames` user with stdout redirected to a per-run log file; Skáli tails that file and talks to each game through its remote interface (RCON, Palworld REST, Ctrl+C). State lives in SQLite.

**Tech Stack:** Node ≥22.12, pnpm 9 workspace, TypeScript 7, Express 5, ws 8, better-sqlite3, Vitest 5; React 19, Vite 8, MUI 9, react-router 8, ansi_up; .NET 10 (C#) for `SkaliHelper` and `FakeGame`; NSSM; PowerShell 5.1 install scripts.

**Spec:** `docs/superpowers/specs/2026-11-23-skali-design.md`

**Scope of this plan (1 of 3):** core control of existing installs. **Not here:** config-file form/raw editor and config history (Plan 2), gallery / SteamCMD install / update / backups / Temurin download / Steam login (Plan 3). Launch settings (Valheim's whole config, Palworld/Minecraft port/memory) *are* editable here, as fields.

## Global Constraints

- Repo root: `c:\Users\gabri\OneDrive\projects\skali`. pnpm workspace: `apps/server` (`@skali/server`), `apps/web` (`@skali/web`), `packages/shared` (`@skali/shared`). C# under `tools/SkaliHelper`, `tools/FakeGame`.
- Copy Home's (`../iot`) versions: TypeScript `^7.0.2`, Express `^5.3.0`, ws `^8.22.1`, Vitest `^5.1.0`, React `^19.3.1`, MUI `^9.5.0`, react-router `^8.5.1`, Vite `^8.3.6`, `@vitejs/plugin-react ^6.1.2`, `packageManager: pnpm@9.15.9`, `engines.node >=22.12`, and `tsconfig.base.json` verbatim.
- Port **4100**; service name **`Skali`**; data dir **`C:\ProgramData\Skali`** (override with env `SKALI_DATA_DIR`).
- Data layout: `skali.db`, `secret.key`, `logs\<serverId>\<runId>\console.log`, `service.log`.
- Games user **`SkaliGames`**: standard local user, password reset by Skáli at every boot, rights: `SeBatchLogonRight` granted; `SeDenyInteractiveLogonRight`, `SeDenyRemoteInteractiveLogonRight`, `SeDenyNetworkLogonRight` granted (i.e. denied logon).
- Env `SKALI_RUN_AS_CURRENT_USER=1` (dev/tests): launch games as the current user, skip ACL grants and user management.
- Allowlist default **`["192.168.0.150"]`**; `127.0.0.1`, `::1` always allowed; IPv4-mapped IPv6 (`::ffff:a.b.c.d`) normalized. Default connect host **`192.168.0.100`**.
- Firewall rule names: **`Skali - <server name> - <port>/<UDP|TCP>`**; web rule **`Skali web (TCP 4100)`**, Private profile, `RemoteAddress LocalSubnet`.
- Server names: `/^[A-Za-z0-9 _.-]{1,40}$/`, unique (case-insensitive).
- Crash policy: auto-restart after **10 s**; **3 crashes within 10 min** → pause auto-restart (`crashPaused`). Manual Start clears crash history.
- Log runs kept per server: **30** (my call; spec silent). Console history sent on subscribe: last **500** lines; web keeps at most **5000** lines.
- Default ports: Palworld game **8211/UDP**, REST **8212/TCP** (not forwarded); Valheim **2456–2458/UDP**; Minecraft **25565/TCP**, RCON **25575/TCP** (not forwarded).
- Skáli-written lines in console logs are prefixed **`[skali] `**.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Skáli restarts/stops (NSSM stop, crash, reinstall) while games run** — games must keep running and be re-attached. Node's libuv puts non-detached children in a kill-on-close job object; helper must be spawned `detached` and launch games with `CREATE_BREAKAWAY_FROM_JOB`. → Task 11 survival test.
2. **PID reused after a reboot** — a recorded PID that's alive but belongs to another process must never be re-attached or killed. → Task 10 test `boot ignores pid whose start time differs`.
3. **Game exits immediately on start** (bad exe path, missing EULA, port in use) — server shows *crashed* with the reason in the console and on the card; a launch failure (helper error) does not auto-restart; a fast exit goes through the crash policy and pauses after 3. → Task 10 tests.
4. **Stop clicked while still *starting*** (Palworld loading, REST not up yet) — graceful path falls back to Ctrl+C, then kill after the timeout; never hangs in *stopping*. Double-clicked Start never launches twice. → Task 10 tests.
5. **Huge or chatty logs** (multi-GB console.log, partial lines, split UTF-8) — history reads only the file's tail; the tailer never emits broken lines. → Task 9 tests.

---

### Task 1: Workspace scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `README.md`
- Create: `apps/server/package.json`, `apps/server/tsconfig.json`, `apps/server/vitest.config.ts`, `apps/server/src/config.ts`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`
- Test: `apps/server/test/config.test.ts`

**Interfaces:**
- Produces: `loadConfig(env?: NodeJS.ProcessEnv): AppConfig` where `AppConfig = { dataDir: string; port: number; helperPath: string; runAsCurrentUser: boolean; webDist: string; initialAllowlist: string[] }`; `dataPaths(dataDir: string): { db: string; secretKey: string; logs: string; serviceLog: string }`.
- Produces in `@skali/shared` (types only, filled in by later tasks): `GameId = 'palworld' | 'valheim' | 'minecraft' | 'basic'`, `ServerStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed'`.

- [ ] **Step 1:** `git init`; root `package.json` mirrors Home's (`name: "skali"`, scripts `test: pnpm -r test`, `build: pnpm --filter @skali/shared build && pnpm --filter @skali/server build && pnpm --filter @skali/web build && pnpm build:helper`, `build:helper: dotnet publish tools/SkaliHelper -c Release -r win-x64 --self-contained -p:PublishSingleFile=true -o tools/SkaliHelper/publish`, `dev`, `start`), `onlyBuiltDependencies: [better-sqlite3, esbuild]`. `.gitignore`: `node_modules, dist, publish, bin, obj, .env, *.log`.
- [ ] **Step 2: Write the failing test** `apps/server/test/config.test.ts`:

```ts
it("defaults", () => {
  const c = loadConfig({});
  expect(c.dataDir).toBe("C:\\ProgramData\\Skali");
  expect(c.port).toBe(4100);
  expect(c.runAsCurrentUser).toBe(false);
  expect(c.initialAllowlist).toEqual(["192.168.0.150"]);
  expect(c.helperPath).toMatch(/tools[\\/]SkaliHelper[\\/]publish[\\/]SkaliHelper\.exe$/);
});
it("env overrides", () => {
  const c = loadConfig({ SKALI_DATA_DIR: "D:\\x", SKALI_PORT: "5000", SKALI_RUN_AS_CURRENT_USER: "1", SKALI_INITIAL_ALLOWLIST: "10.0.0.5, 10.0.0.0/24" });
  expect([c.dataDir, c.port, c.runAsCurrentUser, c.initialAllowlist]).toEqual(["D:\\x", 5000, true, ["10.0.0.5", "10.0.0.0/24"]]);
  expect(dataPaths("D:\\x").logs).toBe("D:\\x\\logs");
});
```

- [ ] **Step 3:** Run `pnpm install && pnpm --filter @skali/server test` → FAIL (module not found).
- [ ] **Step 4:** Implement `config.ts` (`helperPath` resolved relative to repo root from `import.meta.url`; `webDist` = `<repo>/apps/web/dist`; Windows paths via `path.win32.join`).
- [ ] **Step 5:** Run tests → PASS. Commit `chore: scaffold skali workspace`.

---

### Task 2: SkaliHelper (current-user mode) + FakeGame + Node wrapper

**Files:**
- Create: `tools/SkaliHelper/SkaliHelper.csproj` (net10.0, Exe, nullable, `AllowUnsafeBlocks`), `tools/SkaliHelper/Program.cs`, `Launch.cs`, `Stats.cs`, `CtrlC.cs`, `Kill.cs`, `Native.cs`, `CommandLine.cs`
- Create: `tools/FakeGame/FakeGame.csproj`, `tools/FakeGame/Program.cs`
- Create: `apps/server/src/proc/helper.ts`
- Test: `apps/server/test/proc/helper.test.ts`, `apps/server/test/support/fake-game.ts`

**Interfaces:**
- Helper CLI: `SkaliHelper.exe <verb>`; JSON request on **stdin**, JSON response on **stdout**, exit 0; on failure exit 1 with `{"error": "<message>"}`.
  - `launch`: `{ exe, args: string[], cwd, stdoutPath, env?: Record<string,string>, user?: { name, password } }` → `{ pid, startTime }` (`startTime` = process creation time, ISO 8601 UTC, ms precision).
  - `stats`: `{ pids: number[] }` → `{ processes: { pid, alive, startTime?, cpuMs?, memBytes? }[] }` — `cpuMs`/`memBytes` summed over the process and all descendants (Toolhelp32 snapshot).
  - `ctrlc`: `{ pid }` → `{ sent: true }`.
  - `kill`: `{ pid }` → `{ killed: boolean }` (whole tree).
- Node: `createHelper(helperPath: string): Helper`; `interface Helper { launch(r: LaunchRequest): Promise<{ pid: number; startTime: string }>; stats(pids: number[]): Promise<ProcStat[]>; ctrlC(pid: number): Promise<void>; kill(pid: number): Promise<boolean>; ensureUser(name: string): Promise<{ created: boolean; password: string }> }`. Errors reject with `HelperError(message)`.
- FakeGame flags: `--ready-after <s>` (prints `READY` after s seconds), `--echo-args` (prints `ARGS <json>` of its argv), `--echo-env <NAME>` (prints `ENV <NAME>=<value>`), `--crash-after <s>` (exit 1), `--ignore-ctrlc`, `--spawn-child` (starts a copy of itself with `--idle`), `--print-utf8` (prints `ÆØÅ ✓`). Default: prints `TICK <n>` every second. On Ctrl+C (unless ignored): prints `SAVING`, sleeps 500 ms, prints `SAVED`, exits 0.

Launch implementation (decisions the implementer can't infer):
- Open `stdoutPath` with `FILE_APPEND_DATA`, share `READ|WRITE|DELETE`, inheritable; use it for stdout and stderr; stdin = `NUL`.
- Flags: `CREATE_NEW_CONSOLE | CREATE_UNICODE_ENVIRONMENT | CREATE_BREAKAWAY_FROM_JOB`; `STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW`, `wShowWindow = SW_HIDE`. **Never** `CREATE_NEW_PROCESS_GROUP` (it disables Ctrl+C). If `CreateProcess*` fails with `ERROR_ACCESS_DENIED` because of breakaway, retry without `CREATE_BREAKAWAY_FROM_JOB`.
- Environment = the launching user's environment block (`CreateEnvironmentBlock` for `user`, current env otherwise) with `env` entries overriding.
- Command line built with `CommandLine.Join(exe, args)` using MSVCRT rules (quote when needed, double backslashes before quotes).
- `ctrlc`: `FreeConsole(); AttachConsole(pid); SetConsoleCtrlHandler(null, true); GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0); Sleep(200); FreeConsole();`.

- [ ] **Step 1: Write the failing tests** (`helper.test.ts`, Windows-only; `beforeAll` runs `dotnet publish` for both projects if `publish/` is missing; `fake-game.ts` exports `fakeGamePath`):

```ts
it("launch writes stdout to file and returns pid + startTime", async () => {
  const out = tmpFile();
  const { pid, startTime } = await helper.launch({ exe: fakeGamePath, args: ["--ready-after", "0"], cwd: tmpDir, stdoutPath: out });
  await waitForFile(out, /READY/);
  const [s] = await helper.stats([pid]);
  expect(s).toMatchObject({ pid, alive: true, startTime });
  expect(s.memBytes).toBeGreaterThan(0);
});
it("args round-trip with spaces, quotes and trailing backslashes", async () => {
  const args = ["--echo-args", "a b", 'say "hi"', "C:\\path with space\\", ""];
  ...expect(JSON.parse(lineAfter(out, "ARGS "))).toEqual(args);
});
it("env override reaches the process", ...);              // --echo-env SteamAppId with env { SteamAppId: "892970" }
it("ctrlc makes the game save and exit 0", async () => {  // SAVING then SAVED appear, then stats alive=false within 10 s
});
it("kill ends an --ignore-ctrlc game and its child", async () => {  // --spawn-child; after kill both pids dead
});
it("stats sums descendants", ...);                          // --spawn-child: memBytes(parent tree) > memBytes(child alone)
it("stats reports dead pid", ...);                          // pid 999999 → { alive: false }
it("utf8 output is preserved", ...);                         // file contains "ÆØÅ ✓"
it("launch of missing exe rejects with HelperError", ...);
```

- [ ] **Step 2:** Run `pnpm --filter @skali/server test helper` → FAIL.
- [ ] **Step 3:** Implement FakeGame, SkaliHelper verbs `launch` (current-user path: `CreateProcessW`), `stats`, `ctrlc`, `kill`; `helper.ts` spawns the exe with `{ detached: true, windowsHide: true, stdio: "pipe" }`, writes the JSON, parses stdout.
- [ ] **Step 4:** Run tests → PASS.
- [ ] **Step 5:** Commit `feat: add SkaliHelper process launcher and FakeGame`.

---

### Task 3: Run as `SkaliGames` (user management in the helper)

**Files:**
- Modify: `tools/SkaliHelper/Launch.cs`, `Program.cs`
- Create: `tools/SkaliHelper/Users.cs`
- Modify: `apps/server/src/proc/helper.ts`
- Create: `apps/server/src/system/games-user.ts`
- Test: `apps/server/test/proc/helper-user.test.ts` (runs only when `SKALI_ADMIN_TESTS=1` and the process is elevated)

**Interfaces:**
- Helper verb `ensure-user`: `{ name }` → `{ created, password }`: creates the local user if missing (`NetUserAdd`, `UF_DONT_EXPIRE_PASSWD | UF_PASSWD_CANT_CHANGE`), not in any group except Users; always sets a new random 32-char password; grants the four rights from Global Constraints via `LsaAddAccountRights`.
- `launch` with `user`: `LogonUserW(name, ".", password, LOGON32_LOGON_BATCH)` → `CreateProcessAsUserW` with `lpDesktop = ""` so the process gets its own non-interactive desktop, plus `LoadUserProfile`/`CreateEnvironmentBlock` for that token.
- `ensureGamesUser(helper: Helper, cfg: AppConfig): Promise<{ name: string; password: string } | null>` — returns `null` when `cfg.runAsCurrentUser`.

- [ ] **Step 1: Write the failing tests:** `ensure-user` twice → first `created: true`, second `created: false`, passwords differ; launch FakeGame `--echo-env USERNAME` as the user → prints `ENV USERNAME=SkaliGames`; Ctrl+C to that process still produces `SAVED`; `afterAll` deletes a test user (use name `SkaliGamesTest`, never `SkaliGames`).
- [ ] **Step 2:** Run elevated with `SKALI_ADMIN_TESTS=1` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS; also run without the env var → skipped, rest of suite green.
- [ ] **Step 5:** Commit `feat: run game servers as the SkaliGames user`.

---

### Task 4: Real-game proof on the server PC (manual gate)

No code. This de-risks the spec's biggest unknowns before building on them. Do it on the server PC (`192.168.0.100`), elevated PowerShell, with `tools\SkaliHelper\publish\SkaliHelper.exe` copied over.

- [ ] **Step 1:** Create the user: `'{"name":"SkaliGames"}' | .\SkaliHelper.exe ensure-user` → note password. Grant it modify on the existing Valheim folder: `icacls "<valheim dir>" /grant "SkaliGames:(OI)(CI)M"`.
- [ ] **Step 2:** Launch Valheim as `SkaliGames` via `launch` with args `-nographics -batchmode -name SkaliTest -port 2456 -world SkaliTest -password skalitest1 -public 0 -savedir <valheim dir>\saves -logFile -` and env `{ "SteamAppId": "892970" }`, `stdoutPath` = `C:\Temp\valheim.log`. **Expected:** log file fills with Unity output and reaches `Game server connected`. If `-logFile -` writes nothing to the file, record that and use `-logFile <runDir>\console.log`. Task 8's Valheim adapter must then omit the stdout redirect target for Valheim. Write down which worked.
- [ ] **Step 3:** `ctrlc` the pid. **Expected:** log shows the world being saved (`World saved` / `Saved world`), process exits, `saves\worlds_local\SkaliTest.fwl` and `.db` exist with a fresh timestamp.
- [ ] **Step 4:** Launch again via a **detached Node script** (`node -e` spawning the helper the way `helper.ts` does), then kill that Node process from Task Manager. **Expected:** `valheim_server.exe` still running.
- [ ] **Step 5:** Record outcomes in `docs/notes/2026-11-23-real-game-proof.md` and commit it. **If Step 3 fails, stop and bring it back to the owner.** The anti-goal "stop loses world progress" depends on it.

---

### Task 5: Storage — DB, secrets, server repo, settings

**Files:**
- Create: `apps/server/src/db.ts`, `apps/server/src/secrets.ts` (copy of Home's `encryptSecret`/`decryptSecret` + `loadOrCreateKey(path: string): Buffer`), `apps/server/src/servers/repo.ts`, `apps/server/src/settings.ts`, `apps/server/src/errors.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `apps/server/test/servers/repo.test.ts`, `apps/server/test/settings.test.ts`, `apps/server/test/secrets.test.ts`

**Interfaces:**
- `errors.ts`: `class BadRequestError extends Error`, `class ConflictError extends Error`, `class NotFoundError extends Error`.
- `openDb(path: string): Database` — migrations by `PRAGMA user_version`; v1 tables:
  - `servers(id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, game TEXT NOT NULL, folder TEXT NOT NULL, launch TEXT NOT NULL, secrets TEXT NOT NULL, desired TEXT NOT NULL, auto_restart INTEGER NOT NULL, auto_start INTEGER NOT NULL, stop_timeout_sec INTEGER NOT NULL, pid INTEGER, pid_start_time TEXT, current_run_id TEXT, created_at TEXT NOT NULL)`
  - `settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)`
- `type LaunchValues = Record<string, string | number | boolean>`
- `interface ServerRecord { id: string; name: string; game: GameId; folder: string; launch: LaunchValues; secrets: Record<string, string>; desired: 'running' | 'stopped'; autoRestart: boolean; autoStart: boolean; stopTimeoutSec: number; pid: number | null; pidStartTime: string | null; currentRunId: string | null; createdAt: string }` (in `@skali/shared` minus `secrets`, as `ServerRecordPublic`).
- `class ServerRepo { constructor(db: Database, key: Buffer); list(): ServerRecord[]; get(id: string): ServerRecord; create(input: Pick<ServerRecord,'name'|'game'|'folder'|'launch'|'stopTimeoutSec'> & { secrets?: Record<string,string> }): ServerRecord; update(id: string, patch: Partial<Omit<ServerRecord,'id'|'createdAt'>>): ServerRecord; delete(id: string): void }` — `id` = `crypto.randomUUID()`; defaults `desired: 'stopped'`, `autoRestart: true`, `autoStart: true`; `secrets` stored as one encrypted JSON blob; `get` of unknown id → `NotFoundError`; invalid or duplicate name → `BadRequestError` (`"Name already used"` / `"Name may only contain letters, numbers, spaces, _ . -"`).
- `interface AppSettings { allowlist: string[]; connectHost: string }`; `class SettingsStore { constructor(db: Database, initialAllowlist: string[]); get(): AppSettings; update(patch: Partial<AppSettings>): AppSettings }` — defaults `{ allowlist: initialAllowlist, connectHost: "192.168.0.100" }`; `allowlist` entries validated by `isValidAllowEntry` (Task 13 exports it; here implement it in `apps/server/src/http/allowlist.ts` as a stub returning IPv4/CIDR validity, tested here).

- [ ] **Step 1: Write the failing tests:** create/get round-trip including decrypted secrets; secrets column in raw DB does not contain the plaintext; duplicate name differing only by case → BadRequest; `name: "a/b"` → BadRequest; update patch persists; delete then get → NotFound; reopening DB keeps rows and `user_version = 1`; settings defaults and update; `allowlist: ["300.1.1.1"]` → BadRequest; key file created with 32 bytes and reused.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: add sqlite storage for servers and settings`.

---

### Task 6: Config formats needed by the control channels

**Files:**
- Create: `apps/server/src/config-formats/properties.ts`, `apps/server/src/config-formats/palworld-options.ts`
- Create: `apps/server/test/fixtures/server.properties` (a real Minecraft 1.21 file with comments), `apps/server/test/fixtures/DefaultPalWorldSettings.ini` (real Palworld file)
- Test: `apps/server/test/config-formats/properties.test.ts`, `palworld-options.test.ts`

**Interfaces** (Plan 2 builds its full editor on these, so keep them lossless):
- `parseProperties(text: string): PropertiesDoc`; `PropertiesDoc { get(key: string): string | undefined; set(key: string, value: string): void; keys(): string[]; toString(): string }` — `set` on a missing key appends `key=value` using the file's line ending; keeps `\r\n` vs `\n`; escapes `:`/`=` in values only if needed (Minecraft does not escape; don't add escapes it didn't have).
- `parsePalworldIni(text: string): PalworldDoc`; `PalworldDoc { get(key: string): string | undefined; set(key: string, rawValue: string): void; keys(): string[]; toString(): string }` — operates on the `OptionSettings=(…)` line inside `[/Script/Pal.PalGameWorldSettings]`; raw values are tokens as written (`True`, `1.000000`, `"My Server"`, `None`); quoted strings may contain `,` `(` `)` and `\"`; missing line → `throw new PalworldIniError("OptionSettings line not found")`. Helper `quotePal(s: string): string` returns `"…"` with `"`→`\"`.

- [ ] **Step 1: Write the failing tests:** unchanged parse→toString is byte-identical for both fixtures; `set("rcon.password","x")` changes exactly one line; set of a missing key appends; CRLF preserved; Palworld `set("RESTAPIEnabled","True")` changes only that token; `set("ServerName", quotePal('a, "b" (c)'))` then re-parse `get` returns the same raw token; `keys()` includes `Difficulty`, `ExpRate`, `AdminPassword`; empty file → `PalworldIniError`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement (hand-written scanner for the tuple; no regex split on commas). **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: lossless properties and Palworld ini parsers`.

---

### Task 7: Control channels — RCON, Palworld REST, A2S

**Files:**
- Create: `apps/server/src/channels/rcon.ts`, `palworld-rest.ts`, `a2s.ts`
- Create: `apps/server/test/fakes/rcon-server.ts`, `palworld-rest-server.ts`, `a2s-server.ts`
- Test: `apps/server/test/channels/*.test.ts`

**Interfaces:**
- `class RconClient { static connect(host: string, port: number, password: string, timeoutMs?: number /*5000*/): Promise<RconClient>; exec(command: string): Promise<string>; close(): void }` — Source RCON: little-endian `int32 size, int32 id, int32 type, ASCII body, 0x00, 0x00`; auth type 3, exec type 2; auth reply id `-1` → `RconAuthError`; connect/read timeout → `RconTimeoutError`. Serialize exec calls (one in flight).
- `withRcon<T>(host, port, password, fn: (c: RconClient) => Promise<T>): Promise<T>` (connect, run, always close).
- `createPalworldRest(opts: { host?: string /*127.0.0.1*/; port: number; password: string; timeoutMs?: number /*5000*/ }): PalworldRest` with `info(): Promise<{ version: string; servername: string }>`, `players(): Promise<{ name: string; playerId: string; userId: string }[]>`, `metrics(): Promise<{ currentplayernum: number; maxplayernum: number }>`, `announce(message: string)`, `save()`, `shutdown(waittime: number, message: string)`, `kick(userid: string, message?: string)`, `ban(userid: string, message?: string)`, `unban(userid: string)`. Base URL `http://host:port/v1/api/`, Basic auth `admin:<password>`; non-2xx → `PalworldRestError(status, body)`.
- `queryA2SInfo(host: string, port: number, timeoutMs?: number /*2000*/): Promise<{ name: string; players: number; maxPlayers: number } | null>` — sends `FF FF FF FF 54 "Source Engine Query\0"`; on `0x41` challenge, resend with the 4 challenge bytes appended; timeout → `null`.

- [ ] **Step 1: Write the failing tests** against the fakes: RCON auth ok + `exec("list")` returns fake's reply; wrong password → `RconAuthError`; server that never replies → `RconTimeoutError` within 5.5 s; two concurrent `exec` calls get their own replies; REST sends correct Basic auth header and paths (`GET info`, `GET metrics`, `POST shutdown` body `{"waittime":1,"message":"…"}`); 401 → `PalworldRestError` with status 401; A2S without challenge, with challenge, and silent server → `null`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: add RCON, Palworld REST and A2S clients`.

---

### Task 8: Game adapters

**Files:**
- Create: `apps/server/src/games/types.ts`, `palworld.ts`, `valheim.ts`, `minecraft.ts`, `basic.ts`, `registry.ts`, `apps/server/src/util/args.ts`
- Modify: `packages/shared/src/index.ts` (add `PortSpec`, `FieldSpec`, `GameInfo`)
- Test: `apps/server/test/games/*.test.ts`, `apps/server/test/util/args.test.ts`

**Interfaces:**
- Shared: `PortSpec { port: number; protocol: 'udp' | 'tcp'; purpose: string; forward: boolean }`; `FieldSpec { key: string; label: string; type: 'text' | 'number' | 'switch' | 'password'; default?: string | number | boolean; help?: string; min?: number; max?: number }`; `GameInfo { id: GameId; displayName: string; launchFields: FieldSpec[]; hasCommands: boolean; commandHelp?: string }`.
- `splitArgs(s: string): string[]` (whitespace split, double quotes group, `\"` escapes).
- `types.ts`:
```ts
export interface LaunchSpec { exe: string; args: string[]; cwd: string; env?: Record<string, string> }
export type ReadyCheck = { kind: 'pattern'; pattern: RegExp } | { kind: 'probe'; probe: (s: ServerRecord) => Promise<boolean> } | { kind: 'none' };
export interface StopContext { ctrlC(): Promise<void> }
export type InspectResult = { ok: true; exe: string; launch: LaunchValues; notes: string[] } | { ok: false; reason: string };
export interface GameAdapter {
  info: GameInfo;
  ready: ReadyCheck;
  defaultStopTimeoutSec: number;
  inspectFolder(folder: string): Promise<InspectResult>;
  validateLaunch(name: string, launch: LaunchValues): string[];           // [] = valid
  ports(s: ServerRecord): PortSpec[];
  prepare(s: ServerRecord): Promise<{ secrets?: Record<string, string> }>; // ensure control channel before every start
  buildLaunch(s: ServerRecord): LaunchSpec;
  stop(s: ServerRecord, ctx: StopContext): Promise<void>;                  // ask the game to save and exit; must not wait for exit
  command: ((s: ServerRecord, cmd: string) => Promise<string>) | null;
  hasCommandsFor(s: ServerRecord): boolean;                                // used by views and the supervisor instead of info.hasCommands
  players(s: ServerRecord): Promise<{ online: number; max: number } | null>;
}
```
- `registry.ts`: `getAdapter(id: GameId): GameAdapter`; `listGames(): GameInfo[]`.

Per-adapter values (from spec; tests assert them):
- **Valheim** — fields `name`(text), `port`(number, 2456), `world`(text, "Dedicated"), `password`(password), `public`(switch, true), `crossplay`(switch, false), `extraArgs`(text, ""). `validateLaunch`: password ≥ 5 chars and must not contain the server name (`name` field), case-insensitive. Exe `valheim_server.exe`; args `-nographics -batchmode -name <name> -port <port> -world <world> -password <pw> -public <1|0> -savedir <folder>\saves -logFile -` + `-crossplay` if set + `splitArgs(extraArgs)`. (Use Task 4's recorded finding for `-logFile`.) Env `{ SteamAppId: "892970" }`. Ready pattern `/Game server connected/`. Stop timeout 90 s. Stop = `ctx.ctrlC()`. Ports `port, port+1, port+2` UDP forward. Players = `queryA2SInfo("127.0.0.1", port+1)`. `command: null`.
- **Palworld** — fields `port`(8211), `players`(number, 32, max 32), `perfFlags`(switch, true), `restPort`(number, 8212), `extraArgs`. Exe `<folder>\Pal\Binaries\Win64\PalServer-Win64-Shipping-Cmd.exe`; args `Pal -port=<port> -players=<n>` + (`-useperfthreads -NoAsyncLoadingThread -UseMultithreadForDS` if perfFlags) + extra. `prepare`: ini `<folder>\Pal\Saved\Config\WindowsServer\PalWorldSettings.ini`; if missing or has no `OptionSettings` line, copy `<folder>\DefaultPalWorldSettings.ini` there (creating dirs); generate `adminPassword` secret (24 chars) if absent; set `RESTAPIEnabled=True`, `RESTAPIPort=<restPort>`, `AdminPassword=quotePal(pw)`; write file only if changed. Ready = probe `rest.info()` succeeds. Stop timeout 120 s. Stop = `rest.save()` then `rest.shutdown(1, "Server is restarting/stopping")`; on any REST error → `ctx.ctrlC()`. Command parser: `help`, `save`, `info`, `players`, `announce <msg>`, `kick <userId> [msg]`, `ban <userId> [msg]`, `unban <userId>`; unknown → returns the help text. `commandHelp` lists those. Ports `port`/UDP forward, `restPort`/TCP not forwarded. Players from `metrics()`; error → `null`.
- **Minecraft** — fields `jar`(text, detected), `javaPath`(text, "java"), `memoryMb`(number, 4096, min 1024), `jvmArgs`(text, ""), `port`(25565), `rconPort`(25575). `inspectFolder`: ok if a `*.jar` exists (prefer `server.jar`, then names containing `paper` or `server`); note if `eula.txt` lacks `eula=true`. Exe `javaPath`; args `-Xms<m>M -Xmx<m>M` + jvmArgs + `-jar <jar> nogui`. `prepare`: if `eula.txt` lacks `eula=true` → `throw new BadRequestError("Accept the Minecraft EULA first (server Overview)")`; ensure `server.properties` (create if missing) has `server-port`, `enable-rcon=true`, `rcon.port`, `rcon.password` (generate secret `rconPassword` 24 chars if absent), `broadcast-rcon-to-ops=false`. Ready `/Done \(\d/`. Stop timeout 60 s. Stop = RCON `save-all` then `stop`; on RCON error → `ctx.ctrlC()`. Command = RCON exec. Players: RCON `list` → parse `/There are (\d+) of a max of (\d+) players online/`; error → `null`. Ports `port`/TCP forward, `rconPort`/TCP not forwarded.
- **Basic** — fields `exe`(text, relative path), `args`(text), `ports`(text, e.g. `"27015/udp, 27016/tcp"`), `queryPort`(number, optional), `rconPort`(number, optional), `rconPassword`(password, optional). `inspectFolder` lists `.exe` files (excluding `UnityCrashHandler*`, `*redist*`, `steamcmd*`, `uninstall*`), picks the one containing `server` or `dedicated`, else the largest; `launch.exe` set to it. Ready none. Stop timeout 60 s, stop = Ctrl+C. Command = RCON if `rconPort` and `rconPassword` set, else `null`; `hasCommandsFor` returns true only when both are set. Players = A2S on `queryPort` if set.

- [ ] **Step 1: Write the failing tests** (temp folders with dummy files; channels faked via the Task 7 fakes): each adapter's `buildLaunch` exact args for default values; Valheim password rules (`"abc"` → error; `"MyServer1"` with name `myserver` → error); Palworld `prepare` copies the default ini when target is missing **and** when it exists but is empty, sets the three keys, is idempotent (second run leaves the file byte-identical), keeps the same generated password; Minecraft `prepare` without EULA → BadRequest, with EULA writes the RCON keys and keeps other lines untouched; Palworld command parser `announce hello world` calls `announce("hello world")`, `foo` returns help; Palworld stop falls back to Ctrl+C when REST rejects; Minecraft `players` parses `There are 3 of a max of 20 players online: a, b, c`; Basic `inspectFolder` picks `ConanSandboxServer.exe` over `UnityCrashHandler64.exe`; `splitArgs('-a "b c" -d\\"e')`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: game adapters for Palworld, Valheim, Minecraft and basic servers`.

---

### Task 9: Log runs and file tailer

**Files:**
- Create: `apps/server/src/logs/runs.ts`, `apps/server/src/logs/tail.ts`
- Test: `apps/server/test/logs/runs.test.ts`, `tail.test.ts`

**Interfaces:**
- `createRun(logsDir: string, serverId: string, now: Date): { runId: string; runDir: string; consolePath: string }` — `runId` = `now.toISOString().replace(/[:.]/g, '-')`; creates the dir and an empty `console.log`.
- `listRuns(logsDir: string, serverId: string): { runId: string; startedAt: string; sizeBytes: number }[]` newest first.
- `pruneRuns(logsDir: string, serverId: string, keep = 30): void` — never deletes the newest.
- `readTail(path: string, maxLines = 500): Promise<string[]>` — reads backwards in 64 KiB chunks from the end; never reads more than needed; decodes UTF-8 at line boundaries.
- `appendSkaliLine(path: string, text: string): Promise<void>` — appends `` `[skali] ${text}\r\n` `` (open with `a`).
- `class FileTailer extends EventEmitter { constructor(path: string, opts?: { fromStart?: boolean; pollMs?: number /*250*/ }); start(): void; stop(): void }` emits `'lines'` with `string[]`; uses `StringDecoder('utf8')`; buffers a trailing partial line; strips `\r`; if the file shrinks (truncated), restarts from 0.

- [ ] **Step 1: Write the failing tests:** tailer emits `["a","b"]` after writing `"a\r\nb\r\nc"` and later `["c"]` once `"\r\n"` arrives; a 4-byte emoji split across two writes arrives intact; `fromStart: false` skips existing content; truncation handled; `readTail` on a generated 50 MB file returns exactly the last 500 lines and (spy on `fs.read`) reads < 1 MB; `listRuns` order and `pruneRuns(keep=2)` on 4 runs leaves the 2 newest; `appendSkaliLine` while another handle appends concurrently interleaves whole lines.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: per-run console logs with tail and history`.

---

### Task 10: Supervisor (process lifecycle, crash policy, re-attach)

**Files:**
- Create: `apps/server/src/proc/crash-policy.ts`, `apps/server/src/proc/supervisor.ts`, `apps/server/src/util/mutex.ts`
- Modify: `packages/shared/src/index.ts` (add `RuntimeState`)
- Test: `apps/server/test/proc/crash-policy.test.ts`, `supervisor.test.ts` (fake `Helper`, fake adapter, fake timers)

**Interfaces:**
- Shared: `RuntimeState { status: ServerStatus; detail?: string; startedAt?: string; cpuPct?: number; memBytes?: number; players?: { online: number; max: number } | null; crashPaused: boolean; runId?: string }`.
- `nextCrashAction(crashTimes: number[], now: number, autoRestart: boolean): { action: 'restart'; delayMs: 10000 } | { action: 'pause' }` — `crashTimes` includes the current crash; pause when `!autoRestart` or ≥3 within the last 600 000 ms.
- `type SupervisorEvent = { type: 'status'; serverId: string; state: RuntimeState } | { type: 'log'; serverId: string; runId: string; lines: string[] }`.
- `class Supervisor { constructor(deps: { repo: ServerRepo; helper: Helper; adapter: (id: GameId) => GameAdapter; logsDir: string; gamesUser: { name: string; password: string } | null; emit: (e: SupervisorEvent) => void; now?: () => number; cpuCount?: number }); boot(): Promise<void>; start(id: string): Promise<void>; stop(id: string): Promise<void>; restart(id: string): Promise<void>; command(id: string, cmd: string): Promise<string>; state(id: string): RuntimeState; forget(id: string): void; tick(): Promise<void>; shutdown(): void }`.

Rules (each pinned by a test):
- Operations per server are serialized with `Mutex`. `start` when status ∉ {stopped, crashed} → `ConflictError("Server is <status>")`. `stop` when stopped → no-op. `command` when not running → `ConflictError`; adapter without commands → `BadRequestError`.
- `start`: `validateLaunch` errors → `BadRequestError(errors.join("; "))`. Set `desired='running'`, status `starting`, clear crash history if `crashPaused`. Run `adapter.prepare` (merge returned secrets into repo). `createRun` + `pruneRuns`, `appendSkaliLine("Starting <exe> <args>")` (mask values of `password`-type fields as `****`), `helper.launch` with `stdoutPath=consolePath`, `env`, `user=gamesUser`. Persist `pid`, `pidStartTime`, `currentRunId`. Start a `FileTailer` (`fromStart: true`) that emits `log` events. Ready: pattern → `running` on first matching line; probe → every 5 s; none → `running` immediately; if not ready after 10 min → `running` with `detail: "No ready signal seen"`.
- Launch or prepare failure: status `crashed`, `detail` = error message, line appended to the run log, `desired='stopped'`, **no** auto-restart.
- `stop`: `desired='stopped'`, status `stopping`, `adapter.stop(s, { ctrlC: () => helper.ctrlC(pid) })` (errors → fall back to `helper.ctrlC`), then poll `helper.stats` every 1 s up to `stopTimeoutSec`; still alive → `helper.kill`, append `Forced stop after <n>s`. Finally status `stopped`, clear `pid`/`pidStartTime`, stop tailer, append `Stopped`. Works from `starting` too.
- `restart` = `stop` then `start` inside one mutex hold. `desired` ends as `running`.
- `tick` (driven by a 2 s interval started in `boot`): one `helper.stats` call for all known pids; compute `cpuPct = ΔcpuMs / (ΔwallMs × cpuCount) × 100`, `memBytes`; every 15 s per running server refresh `players` (errors → `null`). A pid that's dead or has a different `startTime` while status is `starting`/`running` = crash: append `Process exited unexpectedly`, clear pid, apply `nextCrashAction` → schedule `start` after 10 s (status `crashed`, `detail: "Restarting in 10 s"`), or pause (status `crashed`, `crashPaused: true`, `desired='stopped'`).
- `boot`: for every server with `pid`: stats → alive **and** `startTime === pidStartTime` → status `running`, tailer on its `currentRunId` console with `fromStart: false`; otherwise clear pid. Then servers with `desired='running'` and no live pid: `autoStart` → `start`; else set `desired='stopped'`.
- `shutdown`: clear intervals and pending restart timers, stop tailers; never stops or kills games.

- [ ] **Step 1: Write the failing tests** (one `it` per rule above, plus): double `start` concurrently → `helper.launch` called once and the second rejects with Conflict; stop during `starting` with an adapter whose `stop` rejects → `ctrlC` called, then `kill` after timeout, ends `stopped`; three fast crashes → third results in `crashPaused` and no 4th launch; manual `start` after pause clears it; `boot ignores pid whose start time differs` (and never calls `kill` for it); `boot` re-attaches a live matching pid without calling `launch`; launch rejection → `crashed` with detail and no scheduled restart; password masked in the `Starting` line.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: supervisor with graceful stop, crash policy and re-attach`.

---

### Task 11: Survival integration test (real helper, real FakeGame)

**Files:**
- Create: `apps/server/test/integration/survival.test.ts`, `apps/server/test/integration/supervisor-host.ts` (a script that opens a temp DB, builds a `Supervisor` with the real helper and a test adapter launching FakeGame, starts server `X`, prints `STARTED <pid>`, then idles)

- [ ] **Step 1: Write the test:** spawn `supervisor-host.ts` via `tsx` as a **non-detached** child of the test (so it sits inside libuv's kill-on-close job, as in production under NSSM) → read pid → kill the host process tree (`taskkill /T /F /PID <hostPid>`) → wait 2 s → `helper.stats([pid])` says alive → in-process create a new `Supervisor` on the same DB and `boot()` → state `running` → `stop` → FakeGame log ends with `SAVED`, process gone.
- [ ] **Step 2:** Run → it may already pass given Task 2's flags. If it fails, fix the helper (breakaway/detached), not the test.
- [ ] **Step 3:** Commit `test: game servers survive Skali process death`.

---

### Task 12: Firewall, ACLs and adopting an existing folder

**Files:**
- Create: `apps/server/src/system/run.ts`, `firewall.ts`, `acl.ts`, `apps/server/src/servers/adopt.ts`, `apps/server/src/servers/valheim-worlds.ts`
- Test: `apps/server/test/system/firewall.test.ts`, `acl.test.ts`, `apps/server/test/servers/adopt.test.ts`

**Interfaces:**
- `runProcess(exe: string, args: string[], stdin?: string): Promise<{ code: number; stdout: string; stderr: string }>`; `runPowerShell(script: string): Promise<string>` (via `powershell.exe -NoProfile -NonInteractive -Command -`, script on stdin; non-zero → throw).
- `firewallRuleName(serverName: string, p: PortSpec): string`; `ensureFirewallRules(serverName: string, ports: PortSpec[], run?: typeof runPowerShell): Promise<void>` — removes all rules whose DisplayName starts with `Skali - <name> - `, then `New-NetFirewallRule -DisplayName '<name>' -Direction Inbound -Action Allow -Protocol <UDP|TCP> -LocalPort <n> -Profile Any` for each `forward: true` port; single quotes escaped as `''`. `removeFirewallRules(serverName, run?)`.
- `grantModify(folder: string, user: string, run?: typeof runProcess): Promise<void>` → `icacls "<folder>" /grant "<user>:(OI)(CI)M" /Q`; non-zero → throw with stderr.
- `findValheimWorlds(usersRoot = "C:\\Users"): Promise<{ name: string; fwlPath: string; modified: string }[]>` — scans `<usersRoot>\*\AppData\LocalLow\IronGate\Valheim\worlds_local\*.fwl` and `…\worlds\*.fwl`, needs matching `.db`.
- `interface AdoptRequest { game: GameId; name: string; folder: string; launch: LaunchValues; importWorldFrom?: string; acceptEula?: boolean }` (in shared).
- `class Adopter { constructor(deps: { repo: ServerRepo; adapter: (id: GameId) => GameAdapter; gamesUser: string | null; firewall?: typeof ensureFirewallRules; acl?: typeof grantModify; usersRoot?: string }); inspect(game: GameId, folder: string): Promise<InspectResult & { worlds?: Awaited<ReturnType<typeof findValheimWorlds>> }>; adopt(req: AdoptRequest): Promise<ServerRecord>; remove(id: string, supervisorState: RuntimeState): Promise<void> }`.
- `adopt` order: inspect must be ok → `validateLaunch` → folder not already used by another server (`BadRequestError("Folder already managed by <name>")`) → if `importWorldFrom`: copy `<world>.fwl` and `<world>.db` into `<folder>\saves\worlds_local\`, `BadRequestError` if either target exists; set `launch.world` to the world name → if `game==='minecraft' && acceptEula` write `eula.txt` with `eula=true` → `repo.create` with adapter `defaultStopTimeoutSec` → `grantModify(folder, gamesUser)` (skip when null) → `ensureFirewallRules`. On a failure after `repo.create`, delete the record again and rethrow.
- `remove`: status must be `stopped` or `crashed` (`ConflictError`) → `removeFirewallRules` → `repo.delete`. Never touches files.

- [ ] **Step 1: Write the failing tests:** firewall script for Valheim port 2456 contains three `New-NetFirewallRule` with names `Skali - friends - 2456/UDP` … `2458/UDP` and no rule for non-forwarded ports; name `Bob's` is emitted as `'Skali - Bob''s - …'`; `findValheimWorlds` on a fake users tree finds `Dedicated` and ignores an `.fwl` without `.db`; adopt imports the world (both files copied, originals still there, `launch.world` set); adopt refuses to overwrite an existing world; adopt of a folder already in use → BadRequest; firewall failure after create removes the record; remove while running → Conflict; acl skipped when `gamesUser` is null.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: adopt existing server folders with firewall and ACL setup`.

---

### Task 13: HTTP API, allowlist, WebSocket hub, main

**Files:**
- Modify: `apps/server/src/http/allowlist.ts`
- Create: `apps/server/src/http/app.ts`, `apps/server/src/http/views.ts`, `apps/server/src/http/ws-hub.ts`, `apps/server/src/http/fs-browse.ts`, `apps/server/src/main.ts`
- Modify: `packages/shared/src/index.ts` (add `ServerView`, `WsServerMessage`, `WsClientMessage`)
- Test: `apps/server/test/http/allowlist.test.ts`, `app.test.ts`, `ws-hub.test.ts`

**Interfaces:**
- `isValidAllowEntry(s: string): boolean` (IPv4 or IPv4 CIDR `/0–/32`); `isAllowed(remote: string | undefined, list: string[]): boolean`.
- `ServerView = ServerRecordPublic & RuntimeState & { ports: PortSpec[]; connectAddress: string /* `${connectHost}:${first forwarded port}` */; hasCommands: boolean; commandHelp?: string }` — `toView(record, state, adapter, settings): ServerView`; never includes secrets. In `launch`, fields of type `password` are replaced by `"****"` when non-empty.
- `createApp(deps: { repo; supervisor; adopter; settings: SettingsStore; logsDir: string; webDist: string }): express.Express`. Allowlist check runs first on every request: 403 with JSON `{ error: "forbidden" }` for `/api/*`, and for others the text `Skáli: this device (<ip>) is not on the allowed list.`
- Routes (JSON; errors map `BadRequestError`→400, `NotFoundError`→404, `ConflictError`→409, other → 500 `{ error }`):
  - `GET /api/games` → `GameInfo[]`
  - `GET /api/servers` → `ServerView[]`; `GET /api/servers/:id` → `ServerView`
  - `POST /api/servers/inspect` `{ game, folder }` → inspect result
  - `POST /api/servers` `AdoptRequest` → `ServerView` (201)
  - `PATCH /api/servers/:id` `{ name?, autoRestart?, autoStart?, stopTimeoutSec?, launch? }` → `ServerView`. `launch` is merged into the existing values; a `"****"` value for a password field means "keep the current value"; validated by `validateLaunch`; firewall rules re-applied if ports or name changed; changes take effect on the next start (response `detail` unaffected; UI says so).
  - `DELETE /api/servers/:id` → 204
  - `POST /api/servers/:id/start|stop|restart` → 202 `ServerView` (the call returns once the operation has *begun*; it doesn't wait for running/stopped)
  - `POST /api/servers/:id/command` `{ command }` → `{ output }`; also appends `> <command>` and the output lines to the run log via `appendSkaliLine`.
  - `POST /api/servers/:id/eula` → writes `eula=true` (Minecraft only)
  - `GET /api/servers/:id/runs` → runs list; `GET /api/servers/:id/runs/:runId/log` → `text/plain` download of `console.log` (`runId` validated against `listRuns`)
  - `GET /api/fs?path=` → `{ path: string | null; parent: string | null; dirs: string[]; files: string[] }`; without `path`, `dirs` = existing drive roots `C:\`…`Z:\`; unreadable dir → 400.
  - `GET /api/settings`, `PUT /api/settings` `Partial<AppSettings>`; PUT that would remove the caller's own IP from the allowlist → 400 `"This would lock out the device you're using"`.
  - Everything else: static files from `webDist`, SPA fallback to `index.html`.
- WebSocket at `/ws` (`attachWsHub(server: http.Server, deps: { supervisor events: (cb) => void; settings; repo; adapter; logsDir })`): reject the upgrade with 403 when not allowed. Server → client: `{ type: 'status'; server: ServerView }` broadcast on every status event and every 2 s tick (coalesced: at most one per server per tick); `{ type: 'removed'; serverId }`; `{ type: 'logHistory'; serverId; runId; lines }` on subscribe (last 500 lines of the current run, else the newest run); `{ type: 'log'; serverId; runId; lines }` for subscribed servers only. Client → server: `{ type: 'subscribeLogs'; serverId }`, `{ type: 'unsubscribeLogs'; serverId }`.
- `main.ts`: `loadConfig` → mkdir data dirs → `openDb` → `loadOrCreateKey` → repo/settings → `createHelper` → `ensureGamesUser` → `Supervisor` → `boot()` → `http.createServer(createApp(...))` + `attachWsHub` → `listen(port, "0.0.0.0")`. On `SIGINT`/`SIGTERM`/`SIGBREAK`: `supervisor.shutdown()`, close server, exit 0.

- [ ] **Step 1: Write the failing tests:** allowlist (`::ffff:192.168.0.150` allowed for `["192.168.0.150"]`, `192.168.0.77` allowed by `192.168.0.0/24`, `10.0.0.1` denied, `127.0.0.1` and `::1` always allowed, `undefined` denied); `app.test.ts` with supertest and fake supervisor/adopter, faking `remoteAddress` via `X-Test-Remote` only when `NODE_ENV==='test'`: 403 for disallowed IP on `/api/servers` and on `/`; `GET /api/servers` contains no `secrets` key anywhere and masks Valheim `password` as `****`; PATCH with `password: "****"` keeps the stored value; start on running server → 409; command on Valheim → 400; settings PUT removing the caller's IP → 400; runs log with `runId` `../../x` → 404; `ws-hub.test.ts`: disallowed upgrade refused; subscribe gets `logHistory` then only that server's `log` messages.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Manual smoke: `SKALI_RUN_AS_CURRENT_USER=1 SKALI_DATA_DIR=<tmp> pnpm --filter @skali/server dev`; `curl http://127.0.0.1:4100/api/games` → 4 games.
- [ ] **Step 6:** Commit `feat: HTTP API, allowlist and live WebSocket hub`.

---

### Task 14: Web app — shell, live data, servers dashboard

**Files:**
- Create: `apps/web/package.json`, `vite.config.ts` (proxy `/api` and `/ws` to `http://127.0.0.1:4100`), `tsconfig.json`, `index.html`, `src/main.tsx`, `src/App.tsx`, `src/theme.ts`, `src/api.ts`, `src/live.tsx`, `src/pages/ServersPage.tsx`, `src/components/ServerCard.tsx`, `src/components/StatusChip.tsx`
- Test: `apps/web/src/components/ServerCard.test.tsx`, `apps/web/src/live.test.tsx`

**Interfaces:**
- `api.ts`: typed `fetch` wrappers for every route in Task 13 (`getGames`, `getServers`, `startServer(id)`, …), throwing `ApiError(status, message)` with the server's `error` text.
- `live.tsx`: `<LiveProvider>` opens `ws(s)://<host>/ws`, reconnects with backoff 1 s → 10 s, keeps `Map<string, ServerView>`; `useServers(): { servers: ServerView[]; connected: boolean }`; `useServerLogs(serverId: string): { runId?: string; lines: string[] }` (subscribes on mount, unsubscribes on unmount, caps at 5000 lines dropping the oldest).
- Routes: `/` ServersPage, `/servers/:id` ServerPage (Task 15), `/settings` SettingsPage (Task 15). App bar: "Skáli", connection dot, "Add existing server" button, settings icon.
- `ServerCard`: game icon, name (links to detail), `StatusChip` (colours: running green, starting/stopping amber, crashed red, stopped grey), uptime from `startedAt`, players `online/max` when not null, CPU % and RAM GB, `connectAddress` with copy button, buttons: stopped/crashed → **Start**; starting/running → **Restart**, **Stop**; stopping → disabled spinner. Stop with `players.online > 0` opens a confirm dialog "N players are online. Stop anyway?". `crashPaused` shows "Auto-restart paused after repeated crashes" and the card's `detail`. Errors from actions show in a Snackbar.

- [ ] **Step 1: Write the failing tests:** card renders Start only when stopped; Restart+Stop when running; Stop with 2 players online opens confirm and only calls `stopServer` after confirming; Stop with 0 players calls immediately; crashPaused message shown; `live.test.tsx` with a mock WebSocket: status message updates `useServers`; log cap keeps the last 5000 lines.
- [ ] **Step 2:** Run `pnpm --filter @skali/web test` → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat: web dashboard with live server cards`.

---

### Task 15: Web app — server detail (Console, Overview), Add existing, Settings

**Files:**
- Create: `apps/web/src/pages/ServerPage.tsx`, `src/components/Console.tsx`, `src/components/OverviewTab.tsx`, `src/components/LaunchFieldsForm.tsx`, `src/components/AddServerDialog.tsx`, `src/components/FolderPicker.tsx`, `src/pages/SettingsPage.tsx`, `src/components/AllowlistEditor.tsx`
- Add dependency: `ansi_up`
- Test: `Console.test.tsx`, `LaunchFieldsForm.test.tsx`, `AddServerDialog.test.tsx`, `AllowlistEditor.test.tsx`

**Interfaces / behaviour:**
- `ServerPage`: header like the card (status, actions), tabs **Console** | **Overview**.
- `Console`: monospace, lines rendered through `AnsiUp` (`escape_html` on), `[skali] ` lines styled dimmed. Auto-scroll pinned to bottom; scrolling up pauses it and shows a "Jump to latest" chip. Search box filters visible lines. "Previous runs" select (from `GET runs`), which loads a static run log and shows a "Viewing an earlier run" banner. Download button. Command input shown only when `hasCommands`; Enter sends; ↑/↓ walk the last 50 commands this session; `commandHelp` shown as helper text; output arrives through the log stream (no separate display).
- `LaunchFieldsForm({ fields: FieldSpec[]; values: LaunchValues; onChange })`: switch for `switch`, number input with min/max for `number`, masked input with reveal for `password`, text otherwise; shows `help`.
- `OverviewTab`: folder, game, ports table with a "Forward on your router" column (forwarded ports only), launch settings form + Save (PATCH; shows "Takes effect on next start. Restart now?" when running), toggles Auto-restart and Start with Skáli, stop timeout, Minecraft "Accept EULA" button when inspect notes say it's missing, Delete (confirm; disabled unless stopped/crashed; text says game files are not deleted).
- `AddServerDialog`: step 1 pick game (Palworld, Valheim, Minecraft, Other (basic)); step 2 pick folder with `FolderPicker` (browses `GET /api/fs`, drive list at root) → `POST inspect`; shows `reason` on failure and `notes`; step 3 name + `LaunchFieldsForm` prefilled from inspect `launch`; Valheim: if `worlds` found, "Import world" select (default none) listing `name — modified`; Minecraft: EULA checkbox with link to `https://aka.ms/MinecraftEULA`, required; Create → `POST /api/servers` → navigate to detail.
- `SettingsPage`: `AllowlistEditor` (add/remove entries; invalid entries rejected inline using the same rule as `isValidAllowEntry`, exported from `@skali/shared`; a CIDR of `/24` or wider shows a warning "Lets every device in this range control your servers"); connect host field; Save.

- [ ] **Step 1: Write the failing tests:** Console pauses auto-scroll on scroll-up and resumes via chip; `[skali]` lines get the dimmed class; HTML in a log line is escaped; ↑ recalls the last command; command input absent when `hasCommands` false; LaunchFieldsForm renders a switch for `public` and masks `password`; AddServerDialog blocks Create for Minecraft until EULA ticked and shows inspect `reason`; AllowlistEditor rejects `999.1.1.1` and warns on `192.168.0.0/24`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement (move `isValidAllowEntry` into `@skali/shared`, re-export from the server's `allowlist.ts`). **Step 4:** Run → PASS; `pnpm build` succeeds.
- [ ] **Step 5:** Commit `feat: server console, overview, add-existing flow and settings`.

---

### Task 16: Install script, docs, and acceptance on the server PC

**Files:**
- Create: `scripts/lib/common.ps1`, `scripts/lib/acl.ps1`, `scripts/lib/service.ps1` (copied from `../iot/scripts/lib/`, trimmed to the functions used: `Assert-Admin`, `Invoke-Step`, `Get-NodePath`, `Assert-NodeVersion`, `Test-NodeIsSystemWide`, `Protect-RepoDirectory`, `Assert-RepoRootAcl`, `Set-NssmValue`, `Stop-ServiceIfRunning`, `Start-ServiceAndWait`)
- Create: `scripts/install-service.ps1`, `scripts/uninstall-service.ps1`, `docs/RUNNING.md`
- Modify: `README.md`

**install-service.ps1** (`param([string[]]$AllowIp = @('192.168.0.150'), [switch]$DryRun)`), in order:
1. `Assert-Admin`; Node ≥22.12 system-wide; `pnpm`, `dotnet` (SDK 10), `nssm` present, else throw with the install command (`choco install nssm`, `winget install Microsoft.DotNet.SDK.10`).
2. `Protect-RepoDirectory` on the repo (LocalSystem runs code from it, so only admins may change it).
3. `pnpm install --frozen-lockfile`; `pnpm build`.
4. `C:\ProgramData\Skali`: create; ACL = SYSTEM + Administrators full control, inheritance disabled.
5. `Stop-ServiceIfRunning Skali` (games keep running: verified by Task 11 and Step 9 below); `nssm install Skali <node> <repo>\apps\server\dist\main.js` if missing; set `AppDirectory <repo>`, `ObjectName LocalSystem`, `Start SERVICE_AUTO_START`, `AppKillProcessTree 0`, `AppStopMethodConsole 15000`, `AppExit Default Restart`, `AppRestartDelay 5000`, `AppStdout`/`AppStderr` = `C:\ProgramData\Skali\service.log`, `AppRotateFiles 1`, `AppRotateBytes 10485760`, `AppEnvironmentExtra NODE_ENV=production SKALI_INITIAL_ALLOWLIST=<AllowIp -join ','>`.
6. Firewall: replace rule `Skali web (TCP 4100)`: inbound TCP 4100, Profile Private, `RemoteAddress LocalSubnet`, program = node path.
7. `Start-ServiceAndWait Skali`; GET `http://127.0.0.1:4100/api/games` must return 200.

**uninstall-service.ps1:** stop and `nssm remove Skali confirm`, remove the web firewall rule; leaves `C:\ProgramData\Skali`, game folders and `Skali - …` rules alone unless `-Purge` (then also deletes the data dir, all `Skali - *` rules, and the `SkaliGames` user). Running games are never stopped; it prints a warning listing them.

**RUNNING.md:** prerequisites, install, update (`git pull` + rerun installer), uninstall, where logs live, router port-forward table per game, the "locked out" recovery (on the server PC open `http://127.0.0.1:4100/settings`, since localhost is always allowed), troubleshooting (helper errors, Ctrl+C not saving, EULA).

- [ ] **Step 1:** Write scripts; run `install-service.ps1 -DryRun` on the dev PC → prints every step, changes nothing.
- [ ] **Step 2:** On the server PC (`192.168.0.100`): clone/copy the repo, run the installer elevated. **Expected:** service `Skali` running as LocalSystem; `http://192.168.0.100:4100` loads from the owner's PC (`.150`); another device on the LAN gets the 403 text.
- [ ] **Step 3 (acceptance):** Add the existing Valheim folder through the UI, importing its world if it's in a user profile. Start it, watch the console reach `Game server connected`, and check the card shows *running* with CPU/RAM. Join from a game client. Players shows 1 if A2S works; otherwise it shows "—", which is accepted.
- [ ] **Step 4:** Restart from the card → console shows the world save, then a new run starts. Stop → world files' timestamps update.
- [ ] **Step 5:** With Valheim running: `Restart-Service Skali` → after it's back the card shows *running* with the same PID and the console still streams. Kill `valheim_server.exe` in Task Manager → card shows *crashed*, restarts after 10 s.
- [ ] **Step 6:** Reboot the server PC with Valheim *running* → after boot Valheim is running again (desired state restored).
- [ ] **Step 7:** If Palworld/Minecraft are installed by then (manually via SteamCMD / jar download), repeat Steps 3–4 for them plus one command each (`announce hi` / `list`). Otherwise note them as pending in RUNNING.md.
- [ ] **Step 8:** Commit `feat: install script, docs and server PC acceptance`.

---

## Later plans (not part of this one)

- **Plan 2 — Settings editor:** config sources per server, INI/properties/JSON/YAML lossless parsers (building on Task 6), form view with inferred types + template metadata, raw CodeMirror view, config history, locked Skáli-critical keys, restart-pending flow.
- **Plan 3 — Setup & maintenance:** gallery + Steam app-list search, SteamCMD/Temurin/Minecraft downloads, setup dialog with port-conflict checks and live progress, Steam login, update button, world backup/restore with retention.
