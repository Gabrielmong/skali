# Skáli Settings Editor (Plan 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every config file a server has, plus its launch settings, can be edited from the server page. Files open in a form (switches, number fields, dropdowns, text fields) or a raw editor. Saves never mangle a file, keep a history, and offer a restart.

**Architecture:** On the server, a format layer (`config-formats/`) gives every supported format one lossless `ConfigDoc` interface. A config service, under a new `/api/servers/:id/config/*` route group, owns:
- the sources (built-in per adapter, plus files the owner adds, stored in SQLite)
- reads and writes (with an etag guard, encoding preserved and no writes through links)
- history

The web gets a **Settings** tab with a list of sources, a form view, and a lazily loaded CodeMirror raw view. Form↔raw conversion happens on the server through a preview endpoint, so the parsers live in one place.

**Tech Stack:**
- Server: Node 22, TypeScript, Express 5, better-sqlite3, Vitest, and the `yaml` package (its CST API).
- Web: React 19, MUI, Vite, and CodeMirror 6 (`codemirror`, `@codemirror/lang-json`, `@codemirror/lang-yaml`, `@codemirror/legacy-modes`).

**Spec:** `docs/superpowers/specs/2026-11-23-skali-design.md`, section "Settings (config) — the configurable part" (plus Anti-goals, Game adapters, UI). The spec is approved.

## Global Constraints

- Owner directive: work on `main`, and never commit, push, `git add`, stash, reset or checkout. The owner handles git. The "Commit" steps below mean **stop and report**. Never set `SKALI_ADMIN_TESTS=1`, and never run the install, uninstall or apply scripts except with `-DryRun`.
- Run pnpm as `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm …` from the repo root. Root `pnpm typecheck` and `pnpm test` must stay green, and CI (`.github/workflows/ci.yml`) runs them.
- Anti-goal, verbatim: "Saving settings mangles a config file (lost comments, reordered keys, dropped unknown keys, broken formatting the game then rejects)." Every parser round-trips **byte-identically** when nothing changed. A change rewrites only the edited value's token.
- Formats: INI (`[section]` + `key=value`, including Unreal-style INI and Palworld's `OptionSettings=(…)` tuple), Java `.properties`, JSON, YAML, and raw text only for anything else.
- Inference, verbatim: "`true/false/True/False` → switch; integers/decimals → number field; everything else → text field." Template metadata overrides it.
- History: keep the **last 20** versions per file, under `C:\ProgramData\Skali\config-history\<serverId>\<sourceId>\`, as `path.join(config.dataDir, "config-history", …)`.
- Raw text the parser can't read: show the parse error, **still allow saving**, and that file is then raw-only until it is fixed.
- Skáli-managed keys (RCON and REST enabled, their passwords, ports) are shown but locked, with a note saying why.
- The service runs as SYSTEM, and server folders are writable by the games user. Every config read and write inside a server folder goes through `assertNoReparsePoints(folder, file)` (`apps/server/src/util/files.ts`).
- The DB schema goes from v1 to **v2** in this plan, as exactly one new `MIGRATIONS` entry in `apps/server/src/db.ts`. (Auto-deploy blocks automatic rollback across a version change by design.)
- Every mutating request already needs `X-Skali: 1` and passes the IP allowlist (the global middleware). New routes add nothing for this.
- Web bundle: CodeMirror must be loaded with `React.lazy` or a dynamic `import()`, never in the main chunk.

## Review Focus

1. **The file changes on disk while the editor is open.** The game, the owner over RDP, or `prepare()` on start rewrites it. Expected: the save is refused with 409 and "reload". The newer file is never overwritten silently. Tested in Task 8.
2. **UTF-16LE, UTF-8-BOM and CRLF files** (common for Unreal and Windows tools). Expected: they round-trip byte-identically and keep their encoding after a save. Tested in Tasks 2 and 3.
3. **Saving while the server is starting**, which races `prepare()` writing managed keys. Expected: 409 "Server is starting". Tested in Task 8.
4. **Hostile or odd paths** when adding a file:
   - `..`, an absolute path, or a different drive
   - a junction inside the server folder
   - a file over 1 MiB, or a binary file

   Expected: each is refused with a clear message, and nothing is read or written through a link. Tested in Task 8.
5. **INI files with repeated keys** (`+Paths=`), keys before any section, `;` and `#` comments, and blank lines. Expected: all preserved, and each occurrence is editable on its own. Tested in Task 3.

---

## File structure

**Server (`apps/server/src`)**

| Path | Change | What it holds |
|---|---|---|
| `config-formats/text-codec.ts` | new | Detect and keep the encoding (utf8, utf8 with BOM, utf16le) |
| `config-formats/doc.ts` | new | `ConfigDoc`, `RawField`, `ConfigParseError`, `parseConfig()`, `detectFormat()` |
| `config-formats/infer.ts` | new | Type inference |
| `config-formats/ini.ts` | new | INI parser |
| `config-formats/json.ts` | new | JSON parser |
| `config-formats/yaml.ts` | new | YAML parser |
| `config-formats/properties.ts` | changed | Fixes, plus a `ConfigDoc` adapter |
| `config-formats/palworld-options.ts` | changed | Fixes, plus a `ConfigDoc` adapter |
| `channels/rcon.ts` | changed | Parked fixes |
| `games/config-templates.ts` | new | Palworld and Minecraft metadata and locked keys |
| `games/types.ts` | changed | `configSources` |
| `games/palworld.ts`, `games/minecraft.ts` | changed | Built-in sources |
| `config/sources-repo.ts` | new | The `config_sources` table |
| `config/history.ts` | new | History files |
| `config/service.ts` | new | Read, preview, save, restore, locks |
| `http/config-routes.ts` | new | The routes |
| `db.ts` | changed | Migration v2 |
| `servers/repo.ts` | changed | `configChangedAt` |
| `http/views.ts` | changed | `restartPending` |
| `http/app.ts` | changed | Mount the routes, launch PATCH sets `configChangedAt`, delete cleans up |

**Shared (`packages/shared/src/index.ts`):** the config view types and `ServerView.restartPending`.

**Web (`apps/web/src`)**

| Path | Change |
|---|---|
| `api.ts` | changed |
| `components/settings/SettingsTab.tsx` | new |
| `components/settings/SourceList.tsx` | new |
| `components/settings/ConfigForm.tsx` | new |
| `components/settings/SaveBar.tsx` | new |
| `components/settings/HistoryDialog.tsx` | new |
| `components/settings/AddSourceDialog.tsx` | new |
| `components/settings/RawEditor.tsx` | new, lazy |
| `components/settings/codemirror.ts` | new, lazy chunk |
| `components/FolderPicker.tsx` | changed: file mode |
| `components/OverviewTab.tsx` | changed: the launch form moves out |
| `components/ServerCard.tsx`, `pages/ServerPage.tsx` | changed: Settings tab and "Restart pending" chip |

**Docs:** `docs/RUNNING.md` (acceptance items) and `docs/NICE-TO-HAVES.md`.

---

### Task 1: Parked fixes in RCON and the existing parsers

These were parked from Plan 1 into this plan (`docs/NICE-TO-HAVES.md`).

**Files:**
- Modify: `apps/server/src/channels/rcon.ts`, `apps/server/src/config-formats/palworld-options.ts`, `apps/server/src/config-formats/properties.ts`
- Test: `apps/server/test/channels/rcon.test.ts`, `apps/server/test/config-formats/palworld-options.test.ts`, `apps/server/test/config-formats/properties.test.ts`. Extend the fake in `apps/server/test/fakes/rcon-server.ts` so it can split a long response into several packets and close without an error.

**Interfaces:**
- Produces the same public API as today (`withRcon`, `parseProperties`, `parsePalworldIni`, `quotePal`, `unquotePal`), with the fixed behaviour below.

- [ ] **Step 1: Write the failing tests**
  - `rcon: connect rejects when the socket closes before auth without an error event`. Expect a rejection with a message containing `closed`, within 1 s.
  - `rcon: each exec has its own timeout`. The fake answers the first command and never the second. The second rejects with `timed out` after the per-command timeout (5000 ms default, injectable for the test). The first already resolved.
  - `rcon: a response split over several packets is joined`. The fake splits a 10 000-byte body over 3 packets, and `exec` returns all 10 000 bytes. Mechanism: after each command, send an empty `SERVERDATA_RESPONSE_VALUE` probe with its own id, and join the bodies until the probe's echo arrives.
  - `rcon: non-ASCII bodies round-trip as UTF-8`. A command and response containing `Skáli ✓` come back identical. Packet length counts **bytes**, not characters.
  - `palworld: a trailing comma inside OptionSettings is tolerated and preserved`. `(A=1,B=2,)` parses with keys `A` and `B`, and `toString()` is byte-identical.
  - `palworld: a BOM before the first line is tolerated and preserved`.
  - `properties: \t and \f separate key and value`. `key\tvalue` and `key\fvalue` give `get("key") === "value"`, and the round trip is identical.
- [ ] **Step 2: Run them and see them fail.** Run `corepack pnpm --filter @skali/server exec vitest run test/channels/rcon.test.ts test/config-formats`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement the fixes** in the three files.
- [ ] **Step 4: Run them again.** Expected: all PASS, including the existing tests.
- [ ] **Step 5: Stop and report.** Do not commit.

---

### Task 2: Format layer core (encoding, `ConfigDoc`, inference, and the two existing formats)

**Files:**
- Create: `apps/server/src/config-formats/text-codec.ts`, `doc.ts` and `infer.ts`
- Modify: `properties.ts` and `palworld-options.ts`, to add `ConfigDoc` adapters
- Test: `apps/server/test/config-formats/text-codec.test.ts`, `doc.test.ts` and `infer.test.ts`

**Interfaces:**
- Produces, in `text-codec.ts`:
  - `type TextEncoding = "utf8" | "utf8bom" | "utf16le"`
  - `decodeText(buf: Buffer): { text: string; encoding: TextEncoding }`. A UTF-16LE BOM `FF FE` gives `utf16le`, and `EF BB BF` gives `utf8bom`. The BOM is stripped from `text`.
  - `encodeText(text: string, enc: TextEncoding): Buffer`, which re-adds the BOM.
  - `isProbablyBinary(buf: Buffer): boolean`: true when a non-UTF-16 buffer contains a NUL in its first 8 KiB.
- Produces, in `doc.ts`:
  - `type ConfigFormat = "ini" | "palworld" | "properties" | "json" | "yaml" | "raw"`. Define it in `packages/shared/src/index.ts` in this task and import it from `@skali/shared`.
  - `interface RawField`, with these members:
    - `id: string`: opaque, unique within the doc, and stable across re-parses of the same text.
    - `key: string`
    - `section?: string`
    - `value: string | number | boolean`: the decoded value. JSON keeps the JSON type; text formats give strings.
  - `interface ConfigDoc { fields(): RawField[]; set(id: string, value: string | number | boolean): void; toString(): string }`
  - `class ConfigParseError extends Error { line?: number }`
  - `parseConfig(format: ConfigFormat, text: string): ConfigDoc`. It dispatches to the format's parser. `raw` returns a doc with no fields whose `toString()` returns the text unchanged. An unknown field id in `set` throws `ConfigParseError("Unknown setting")`.
  - `detectFormat(relPath: string): ConfigFormat`, by extension (case-insensitive):
    - `.ini` → `ini`
    - `.properties` → `properties`
    - `.json` → `json`
    - `.yml` and `.yaml` → `yaml`
    - anything else → `raw`
- `set` encodes in the **original token's style**:
  - A boolean keeps its case (`True` and `False` vs `true` and `false`).
  - A Palworld value that was quoted stays quoted (through `quotePal`).
  - A number is written with `String(n)`.
  - The text formats write a string as is.
- Produces, in `infer.ts`: `inferType(value: string | number | boolean): "switch" | "number" | "text"`.
  - `switch` for booleans and the strings `true`, `false`, `True` and `False`.
  - `number` for numbers and strings matching `/^-?\d+(\.\d+)?$/`.
  - `text` for everything else.

- [ ] **Step 1: Write the failing tests**
  - `codec: utf16le with BOM decodes and re-encodes byte-identically`
  - `codec: utf8bom round-trips; plain utf8 round-trips`
  - `codec: isProbablyBinary is true for a buffer with NUL, false for utf16le text`
  - `doc: properties and palworld fixtures round-trip byte-identically through parseConfig(...).toString()`. Use the existing fixtures `apps/server/test/fixtures/server.properties` and `DefaultPalWorldSettings.ini`.
  - `doc: palworld set keeps quoting and bool case`:
    - `set(id("ServerName"), 'a, "b"')` re-parses to the same value
    - `set(id("bIsPvP"), true)` writes `True`
  - `doc: unknown field id throws ConfigParseError`
  - `doc: detectFormat maps the extensions above; Foo.CFG → raw`
  - `infer: the table above`. Also: `"1.000000"` is `number`, `"None"` is `text`, and `"TRUE"` is `text`.
- [ ] **Step 2: Run them and see them fail.** `corepack pnpm --filter @skali/server exec vitest run test/config-formats`
- [ ] **Step 3: Implement** `text-codec.ts`, `doc.ts` and `infer.ts`, plus the `ConfigDoc` adapters over the existing `PropertiesDoc` and `PalworldDoc`. Field ids are the key for both of those formats.
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Stop and report.**

---

### Task 3: INI parser (generic and Unreal-style)

**Files:**
- Create: `apps/server/src/config-formats/ini.ts`. Register it in `parseConfig` for `"ini"`.
- Create fixtures:
  - `apps/server/test/fixtures/Engine.ini`: Unreal style, CRLF, with `+Paths=` repeats, `;` comments and `[/Script/…]` sections.
  - `apps/server/test/fixtures/generic.ini`: `#` comments, keys before any section, blank lines, and `key = value` with spaces.
- Test: `apps/server/test/config-formats/ini.test.ts`

**Interfaces:**
- Produces `parseIni(text: string): ConfigDoc`, used through `parseConfig("ini", …)`.
  - Field id: `${section}\u0000${key}`, with `\u0000${n}` appended for the n-th repeat of the same key in the same section (n ≥ 2). Keys before any section have `section` undefined, and an empty section part in the id.
  - A line with no `=`, that isn't a comment or a section header, is kept as is and is not a field. It is never an error: INI files in the wild are messy.
  - `ConfigParseError` is never thrown for INI.

- [ ] **Step 1: Write the failing tests**
  - `ini: both fixtures round-trip byte-identically`
  - `ini: set changes only the value token`. In `key = value ; trailing`, the spaces around `=` and anything after the value stay exactly as they were. Treat everything after the first `=` as the value (Unreal has no inline comments).
  - `ini: repeated +Paths entries are separate fields with distinct ids; setting the 2nd changes only line 2 of them`
  - `ini: keys before the first section are fields with section undefined`
  - `ini: CRLF is preserved after a set`
  - `ini: a UTF-16LE Engine.ini decoded via decodeText, edited, and re-encoded keeps its BOM and encoding`
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement** `ini.ts` as a line scanner that keeps the original lines and replaces only the value span.
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Stop and report.**

---

### Task 4: JSON parser (lossless)

**Files:**
- Create: `apps/server/src/config-formats/json.ts`. Register it for `"json"`.
- Create fixtures: `apps/server/test/fixtures/ops.json` and `whitelist.json` (real Minecraft shape, 2-space indent), and `apps/server/test/fixtures/odd.json` (tabs, a nested object, an array of scalars, `null`, unicode escapes).
- Test: `apps/server/test/config-formats/json.test.ts`

**Interfaces:**
- Produces `parseJsonDoc(text: string): ConfigDoc`.
  - Every scalar leaf (string, number, boolean or null), including leaves inside arrays, is a field.
  - The field id is the leaf's JSON Pointer (`/0/name`).
  - `key` is the last segment, and `section` is the first segment. That groups `ops.json` entries as "0", "1" and so on.
  - `set` replaces only the leaf's token span:
    - A string leaf is written with `JSON.stringify(String(v))`.
    - A number leaf accepts a number or a numeric string. Anything else throws `ConfigParseError("<key> must be a number")`.
    - A boolean leaf accepts booleans.
    - `null` accepts anything and writes it as a JSON string.
  - Invalid JSON throws `ConfigParseError` with `line` set. JSON with comments is invalid here (raw-only).

- [ ] **Step 1: Write the failing tests**
  - `json: fixtures round-trip byte-identically`
  - `json: set /0/level to 3 changes only that number token`
  - `json: a string with quotes and unicode is escaped validly and re-parses to the same value`
  - `json: a number field rejects "abc"`
  - `json: invalid JSON throws ConfigParseError with a line number`
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement** a hand-written tokenizer that records each leaf's `[start, end)` span. Do not use `JSON.parse` followed by `JSON.stringify`, because that is not lossless.
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Stop and report.**

---

### Task 5: YAML parser (lossless through the `yaml` CST)

**Files:**
- Modify: `apps/server/package.json` to add the dependency `yaml` (^2).
- Create: `apps/server/src/config-formats/yaml.ts`. Register it for `"yaml"`.
- Create fixture: `apps/server/test/fixtures/paper-global.yml`, a Paper-style config with comments, nested maps, a block sequence and quoted strings.
- Test: `apps/server/test/config-formats/yaml.test.ts`

**Interfaces:**
- Produces `parseYamlDoc(text: string): ConfigDoc`.
  - Every scalar in a block or flow map or sequence is a field. The id is a JSON Pointer of the path, `key` is the last segment, and `section` is the first segment.
  - `set` uses `CST.setScalarValue` on the scalar's CST token, which keeps the scalar's quoting style.
  - The output is `CST.stringify` over the tokens.
  - A parse error (`Document.errors` non-empty) throws `ConfigParseError` with `line`.

- [ ] **Step 1: Write the failing tests**
  - `yaml: fixture round-trips byte-identically`
  - `yaml: set a nested number changes only that token; comments on the same line survive`
  - `yaml: set a single-quoted string keeps single quotes`
  - `yaml: invalid indentation throws ConfigParseError with a line`
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement** using `new Parser().parse(text)` for the CST tokens and `Composer` or `parseDocument` for the error check.
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Stop and report.**

---

### Task 6: Templates, built-in sources and locked keys

**Files:**
- Create: `apps/server/src/games/config-templates.ts`
- Modify: `apps/server/src/games/types.ts`, `palworld.ts`, `minecraft.ts`, `valheim.ts` and `basic.ts`. The last two get `configSources: []`.
- Test: `apps/server/test/games/config-templates.test.ts`

**Interfaces:**
- Produces, in `games/types.ts`:
  - `interface FieldMeta { label?: string; help?: string; group?: string; type?: "switch" | "number" | "text" | "select" | "secret"; options?: string[]; min?: number; max?: number; step?: number; unit?: string }`
  - `interface ConfigTemplate { fields: Record<string, FieldMeta>; locked: Record<string, string> }`. Both are keyed by field `key`. The locked value is the note shown to the owner.
  - `interface BuiltinSource { id: string; label: string; path: string; format: ConfigFormat; template?: ConfigTemplate; seedFrom?: string }`. `path` and `seedFrom` are relative to the server folder.
  - `GameAdapter.configSources: BuiltinSource[]`
- Palworld has one source: `{ id: "palworld-settings", label: "PalWorldSettings.ini", path: "Pal\\Saved\\Config\\WindowsServer\\PalWorldSettings.ini", format: "palworld", seedFrom: "DefaultPalWorldSettings.ini", template: PALWORLD_TEMPLATE }`.
  - Locked: `RESTAPIEnabled`, `RESTAPIPort` ("Skáli uses the REST API to control the server. Change the REST port in Launch settings.") and `AdminPassword` ("Generated by Skáli for its control channel.").
  - Template fields cover at least these keys:
    - `ServerName`, `ServerDescription`, `ServerPassword` (secret), `ServerPlayerMaxNum`
    - `Difficulty` (select: `None`, `Normal`, `Difficult`)
    - `DeathPenalty` (select: `None`, `Item`, `ItemAndEquipment`, `All`)
    - `ExpRate`, `PalCaptureRate`, `PalSpawnNumRate`, `DayTimeSpeedRate`, `NightTimeSpeedRate` (number, step 0.1)
    - `bIsPvP`, `bEnableFriendlyFire`, `CoopPlayerMaxNum`
  - Groups: "Server", "Gameplay", "Rates".
- Minecraft has three sources:
  - `{ id: "server-properties", label: "server.properties", path: "server.properties", format: "properties", template: MINECRAFT_TEMPLATE }`
  - `{ id: "ops", label: "Operators (ops.json)", path: "ops.json", format: "json" }`
  - `{ id: "whitelist", label: "Whitelist (whitelist.json)", path: "whitelist.json", format: "json" }`

  Locked keys and notes:
  - `server-port`: "Set the port in Launch settings."
  - `enable-rcon`, `rcon.port` and `broadcast-rcon-to-ops`: "Skáli uses RCON to control the server."
  - `rcon.password`: "Generated by Skáli for its control channel."

  Template fields cover at least these keys:
  - `motd`, `max-players`, `pvp`, `online-mode`, `white-list`, `view-distance` (min 2, max 32), `simulation-distance`, `spawn-protection`
  - `difficulty` (select: `peaceful`, `easy`, `normal`, `hard`)
  - `gamemode` (select: `survival`, `creative`, `adventure`, `spectator`)
  - `hardcore`, `level-seed`, `level-name`

  Groups: "Server", "World", "Gameplay".
- The template's `locked` keys must match exactly the keys each adapter's `prepare()` sets. Export `MANAGED_KEYS` per adapter from the template, and have `prepare()` use the template's `locked` key list in a test assertion.

- [ ] **Step 1: Write the failing tests**
  - `templates: palworld locked keys equal the keys prepare() sets`. Run `prepare` on a temp folder seeded with the Default ini fixture, diff the old and new docs' changed keys, and expect them to be ⊆ the locked keys.
  - `templates: minecraft locked keys equal the keys prepare() sets`. Same approach, with a temp folder, `eula.txt` set to true, and the server.properties fixture.
  - `templates: every select field has ≥2 options; every key exists in the matching fixture file`. Template keys absent from the fixture are allowed only when listed in an `OPTIONAL_KEYS` set in the test, with a comment.
  - `adapters: valheim and basic have no built-in config sources`
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement** the templates and wire up `configSources`.
- [ ] **Step 4: Run them again.** Expected: PASS. Also run the existing `test/games` tests.
- [ ] **Step 5: Stop and report.**

---

### Task 7: Storage — migration v2, the sources repo, history and `restartPending`

**Files:**
- Modify:
  - `apps/server/src/db.ts`: v2 migration.
  - `apps/server/src/servers/repo.ts`: `configChangedAt`.
  - `apps/server/src/http/views.ts`: `restartPending`.
  - `packages/shared/src/index.ts`: the types below.
  - `apps/server/src/http/app.ts`:
    - A launch PATCH that changes `launch` sets `configChangedAt`.
    - `DELETE /api/servers/:id` also deletes the server's sources rows and `config-history/<id>`.
- Create: `apps/server/src/config/sources-repo.ts`, `apps/server/src/config/history.ts`
- Test: `apps/server/test/config/sources-repo.test.ts`, `apps/server/test/config/history.test.ts`. Also update `apps/server/test/schema-version.test.ts` and the view tests.

**Interfaces:**
- The v2 migration SQL:
  ```sql
  ALTER TABLE servers ADD COLUMN config_changed_at TEXT;
  CREATE TABLE config_sources (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    path TEXT NOT NULL,
    format TEXT NOT NULL,
    label TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (server_id, path COLLATE NOCASE)
  );
  ```
- Shared types (`packages/shared`):
  - `ConfigFormat` (already added to shared in Task 2)
  - `interface ConfigSourceView`:
    ```ts
    {
      id: string;
      kind: "launch" | "file";
      label: string;
      path?: string;
      format?: ConfigFormat;
      builtin: boolean;
    }
    ```
    The launch source has `id: "launch"`, `kind: "launch"`, `label: "Launch settings"` and `builtin: true`.
  - `interface ConfigFieldView`:
    ```ts
    {
      id: string;
      key: string;
      section?: string;
      value: string | number | boolean;
      type: "switch" | "number" | "text" | "select" | "secret";
      label?: string;
      help?: string;
      group?: string;
      options?: string[];
      min?: number;
      max?: number;
      step?: number;
      unit?: string;
      locked?: string;
    }
    ```
  - `interface ConfigFileView`:
    ```ts
    {
      sourceId: string;
      format: ConfigFormat;
      etag: string;
      raw: string;
      fields: ConfigFieldView[] | null;
      parseError?: string;
      missing?: boolean;
      seededFrom?: string;
    }
    ```
  - `interface ConfigSaveRequest { etag: string; changes?: Record<string, string | number | boolean>; raw?: string }`. Exactly one of `changes` and `raw` is present.
  - `interface ConfigSaveResult { file: ConfigFileView; restartPending: boolean }`
  - `interface ConfigHistoryEntry { id: string; savedAt: string; sizeBytes: number }`
  - `ServerView` gains `restartPending: boolean`.
- `ServerRecord` gains `configChangedAt: string | null`. Also add `ServerRepo.touchConfig(id: string, at: string): void`.
- `restartPending` is true when all of these hold:
  - `status` is `running` or `starting`
  - `configChangedAt` is set
  - `state.startedAt` is set
  - `configChangedAt > state.startedAt` (ISO string comparison)
- `sources-repo.ts`: `class ConfigSourcesRepo` with:
  - `list(serverId): UserSource[]`
  - `add(serverId, {path, format, label}): UserSource`. A duplicate path throws `ConflictError("That file is already in the list")`.
  - `update(id, {format?, label?})`
  - `remove(id)`
  - `removeAll(serverId)`

  `UserSource` is `{ id, serverId, path, format, label, createdAt }`. Ids are `randomUUID()`.
- `history.ts`: `class ConfigHistory(root: string)` with:
  - `push(serverId, sourceId, bytes: Buffer): void`. It writes `<root>/<serverId>/<sourceId>/<iso-with-colons-replaced>.bak` and prunes to the newest 20.
  - `list(serverId, sourceId): ConfigHistoryEntry[]`, newest first. The id is the file name.
  - `read(serverId, sourceId, entryId): Buffer`. The entry id is validated against `/^[0-9TZ.-]+\.bak$/`; anything else throws `NotFoundError`.
  - `removeServer(serverId)` and `removeSource(serverId, sourceId)`

- [ ] **Step 1: Write the failing tests**
  - `db: SCHEMA_VERSION is 2; a v1 database migrates and keeps its servers`
  - `sources-repo: add/list/update/remove; duplicate path (different case) → ConflictError`
  - `history: push 22 versions → list returns 20, newest first; read returns the bytes; entry id "../x" → NotFoundError`
  - `views: restartPending true only when running and configChangedAt > startedAt`
  - `app: PATCH launch on a running server sets configChangedAt; PATCH autoRestart alone does not`
  - `app: DELETE server removes its config_sources rows and history folder`
- [ ] **Step 2: Run them and see them fail.** `corepack pnpm --filter @skali/server exec vitest run`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again.** Expected: PASS, with the whole server suite green.
- [ ] **Step 5: Stop and report.**

---

### Task 8: Config service and HTTP routes

**Files:**
- Create: `apps/server/src/config/service.ts`, `apps/server/src/http/config-routes.ts`
- Modify: `apps/server/src/http/app.ts` to mount the routes and wire up `ConfigService`. Use the existing error classes and the `notify({type:"changed"})` pattern so the WS pushes `restartPending`.
- Test: `apps/server/test/config/service.test.ts`, `apps/server/test/http/config-routes.test.ts`

**Interfaces:**
- `class ConfigService` is built from `{ repo, sources, history, adapterOf, runtimeStatus(serverId): ServerStatus, now(): string }`. It has these methods:
  - `listSources(serverId): ConfigSourceView[]`. The launch source comes first, then the adapter's built-ins, then user sources in creation order.
  - `read(serverId, sourceId): ConfigFileView`
  - `preview(serverId, sourceId, req: Omit<ConfigSaveRequest, "etag">): ConfigFileView`. It applies the request in memory and writes nothing. With `changes`, it returns the new raw text and fields. With `raw`, it returns the parsed fields, or `fields: null` and `parseError`.
  - `save(serverId, sourceId, req: ConfigSaveRequest): ConfigSaveResult`
  - `history(serverId, sourceId): ConfigHistoryEntry[]`
  - `historyRaw(serverId, sourceId, entryId): string`
  - `restore(serverId, sourceId, entryId, etag): ConfigSaveResult`. It runs `save` with the entry's decoded text as `raw`.
  - `addSource(serverId, {path, format?, label?}): ConfigSourceView`
  - `updateSource(serverId, sourceId, {format?, label?}): ConfigSourceView`
  - `removeSource(serverId, sourceId): void`. It refuses built-in sources with `BadRequestError("Built-in files can't be removed")`. It also removes that source's history.
- **Read rules:**
  - The path is resolved under `rec.folder` and checked with `assertNoReparsePoints`.
  - Over 1 MiB gives `BadRequestError("File is larger than 1 MB; edit it outside Skáli")`.
  - `isProbablyBinary` gives `BadRequestError("Not a text file")`.
  - The etag is the sha256 hex of the file's bytes. A missing file's etag is `"missing"`.
  - A missing built-in with `seedFrom` present returns the seed's text, with `missing: true` and `seededFrom`. A missing file with no seed returns `raw: ""`, `fields: []` (or `null` for raw format) and `missing: true`.
  - Each field is built from the doc's `RawField` plus the template's `FieldMeta`. The type is the template's `type`, or else `inferType`. `locked` comes from the template.
- **Save rules, in this order:**
  1. Refuse while `runtimeStatus` is `starting` or `stopping`, with `ConflictError("Server is starting or stopping; save again in a moment")`.
  2. Re-read the bytes. If the etag differs, throw `ConflictError("The file changed on disk since you opened it. Reload to see the new version.")`.
  3. With `changes`:
     - the file must parse, else `BadRequestError("This file can only be edited as raw text until it parses")`
     - every id must exist
     - no locked field may change: `BadRequestError("<key> is managed by Skáli: <note>")`
     - then `doc.set` for each change
  4. With `raw`: if it parses, compare every locked key's value with the current file's value. A change gives the same BadRequest. If it doesn't parse, save anyway: the owner's call, per the spec.
  5. If the new text equals the old, return without writing, without a history entry, and without touching `configChangedAt`.
  6. Otherwise:
     - `history.push(old bytes)` when the file existed
     - write `encodeText(newText, originalEncoding)` (`utf8` for a new file) with the parent folder created, through `writeIfChanged`-style reparse checks
     - `repo.touchConfig(id, now)`
  7. Return the fresh read and `restartPending` from the view.
- All of `save`, `restore`, `addSource`, `updateSource` and `removeSource` for one server run under a per-server `Mutex` (from `util/mutex.ts`).
- **`addSource` rules:**
  - `path` is relative, normalized with `path.normalize`, and must not be absolute, start with a drive or `\\`, or contain `..` segments. Violations give `BadRequestError("Pick a file inside the server folder")`.
  - The file must exist and be a regular file, with no reparse points (via `lstat` on each component).
  - The file is read once to apply the size and binary checks.
  - `format` defaults to `detectFormat(path)`, and `label` defaults to the file's base name.
  - A path equal to a built-in's path gives `ConflictError`.
- **Routes**, in `config-routes.ts`, mounted at `/api/servers/:id/config`. Unknown server or source gives 404, via the existing errors.

| Route | Returns |
|---|---|
| `GET /sources` | `ConfigSourceView[]` |
| `POST /sources` `{path, format?, label?}` | `ConfigSourceView` |
| `PATCH /sources/:sourceId` `{format?, label?}` | `ConfigSourceView` |
| `DELETE /sources/:sourceId` | 204 |
| `GET /files/:sourceId` | `ConfigFileView` |
| `POST /files/:sourceId/preview` `{changes?|raw?}` | `ConfigFileView` |
| `PUT /files/:sourceId` `ConfigSaveRequest` | `ConfigSaveResult` |
| `GET /files/:sourceId/history` | `ConfigHistoryEntry[]` |
| `GET /files/:sourceId/history/:entryId` | `{ raw: string }` |
| `POST /files/:sourceId/history/:entryId/restore` `{etag}` | `ConfigSaveResult` |

  - Body validation uses the app's `bodyObject` and `onlyKeys` style.
  - `raw` must be a string of 1 MiB or less.
  - `changes` must be an object of at most 2000 entries, with string, number or boolean values.
  - `format` must be a `ConfigFormat`.
  - The `launch` source id is refused on every `/files` route with `BadRequestError("Launch settings are edited through the server settings")`.

- [ ] **Step 1: Write the failing tests** (temp folders, the in-memory DB and repo test helpers, as the existing `test/http` tests do)
  - `service: read palworld built-in missing → seeded from DefaultPalWorldSettings.ini with missing:true; save creates the file`
  - `service: form save changes one value; old version is in history; configChangedAt set`
  - `service: etag mismatch → 409 and file untouched` (Review Focus 1)
  - `service: save while starting → 409` (Review Focus 3)
  - `service: changing a locked key via changes or via parseable raw → 400 naming the key; unparseable raw is saved and read back with fields:null and parseError`
  - `service: identical save writes nothing and adds no history`
  - `service: UTF-16LE file stays UTF-16LE with BOM after a save` (Review Focus 2)
  - `service: addSource refuses ../x, C:\\x, \\\\host\\x, a junction component, a 2 MiB file, a binary file` (Review Focus 4). Create the junction with `fs.symlinkSync(target, link, "junction")`, and skip that case when it throws `EPERM`.
  - `service: removeSource refuses built-ins; removes user source and its history`
  - `service: restore puts back an old version and pushes the current one to history`
  - `routes: each route's happy path; launch source on /files → 400; unknown source → 404; missing X-Skali on PUT → 403` (the existing middleware)
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again.** Expected: PASS, with the whole server suite green and `corepack pnpm typecheck` clean.
- [ ] **Step 5: Stop and report.**

---

### Task 9: Web — Settings tab, form view, sources, history and restart pending

**Files:**
- Modify:
  - `apps/web/src/api.ts`: one function per Task 8 route, with the same names as the service methods (`listConfigSources`, `readConfig`, `previewConfig`, `saveConfig`, `configHistory`, `configHistoryRaw`, `restoreConfig`, `addConfigSource`, `updateConfigSource`, `removeConfigSource`).
  - `apps/web/src/pages/ServerPage.tsx`: a third tab, `settings`, labelled "Settings", between Console and Overview. Add a "Restart pending" chip next to the status chip when `server.restartPending`.
  - `apps/web/src/components/ServerCard.tsx`: the same chip.
  - `apps/web/src/components/OverviewTab.tsx`: remove the launch-fields block and its needs-restart prompt. The launch fields move to the Settings tab's "Launch settings" source. Overview keeps the folder, ports, the toggles, stop timeout and delete.
  - `apps/web/src/components/FolderPicker.tsx`: add the prop `mode?: "folder" | "file"` (default `folder`). In file mode, files are listed and selectable, and `onSelect` receives the full file path.
- Create: `apps/web/src/components/settings/SettingsTab.tsx`, `SourceList.tsx`, `ConfigForm.tsx`, `SaveBar.tsx`, `HistoryDialog.tsx` and `AddSourceDialog.tsx`
- Test: `apps/web/src/components/settings/SettingsTab.test.tsx` and `ConfigForm.test.tsx`. Update the existing Overview and ServerCard tests.

**Behaviour:**
- **Layout.** On wide screens (`md` and up), the source list is on the left (240 px) and the editor on the right. On narrow screens, the list becomes a `Select` above the editor.
- **Source list.** Each built-in and user source shows its label. A user source has a remove icon behind a confirm dialog. An **Add file** button opens `AddSourceDialog`:
  - `FolderPicker` in file mode, starting at the server folder
  - the relative path, computed on the client
  - a format `Select`, preset from the extension (same rule as `detectFormat`)
  - a label
- **Launch settings.** This source renders the existing `LaunchFieldsForm` and saves through the existing `PATCH /api/servers/:id`.
- **File source.** `ConfigForm` renders the fields:
  - **Grouping.** Fields are grouped by `group`, else `section`, else one unnamed group.
  - **Filter.** A box matches key, label or help, case-insensitively.
  - **Field types:**
    - `switch` → `Switch`. Its value keeps the original type: a string `"True"` toggles to `"False"`, a boolean to a boolean.
    - `number` → `TextField type=number` with min, max and step.
    - `select` → `Select`.
    - `secret` → a password field with a show/hide icon.
    - `text` → `TextField`.
  - **Locked fields** are disabled, with a lock icon and the note as a tooltip and helper text.
  - **Changed fields** are highlighted with a left border in the primary colour.
- **SaveBar.** It is sticky at the bottom and visible only while changes exist. It shows "N changes" with **Reset** and **Save** buttons.
  - Save sends `{etag, changes}`.
  - On 409, it shows the message with a **Reload** button. Reload re-reads the file and drops the local changes.
  - On success with `restartPending` and a running server, a Snackbar says "Saved. Restart now to apply?" with **Restart now** (the existing `useServerActions` restart, including its player confirm) and **Later**.
- **History** button. It opens `HistoryDialog`:
  - the list shows each entry's local time and size
  - selecting one shows its raw text, read-only and monospace
  - **Restore** asks for confirmation, then calls restore with the current etag
- **Guard.** Switching source, switching tab, or leaving the page with unsaved changes asks "Discard unsaved changes?". Leaving the page uses `useBlocker` from react-router plus `beforeunload`.
- **Missing file.** A notice reads "This file doesn't exist yet. Saving creates it." When the file is seeded, it adds: "Values shown are the defaults from `<seededFrom>`."

- [ ] **Step 1: Write the failing tests** (mock `api.ts`, as the existing page tests do)
  - `SettingsTab: lists Launch settings first, then built-ins, then user files`
  - `ConfigForm: renders switch/number/select/secret/text from types; locked field is disabled and shows its note`
  - `ConfigForm: filter hides non-matching fields`
  - `SettingsTab: editing two fields shows "2 changes"; Reset clears; Save calls saveConfig with {etag, changes} of exactly those ids`
  - `SettingsTab: 409 on save shows the message and Reload re-reads`
  - `SettingsTab: after save with restartPending on a running server, the snackbar offers Restart now`
  - `SettingsTab: switching source with unsaved changes asks to discard`
  - `ServerCard/ServerPage: "Restart pending" chip appears when restartPending`
  - `OverviewTab: no launch fields any more` (update the existing test)
  - `HistoryDialog: shows entries newest first; Restore confirms then calls restoreConfig`
  - `AddSourceDialog: picks a file, computes the relative path, presets format from the extension`
- [ ] **Step 2: Run them and see them fail.** `corepack pnpm --filter @skali/web exec vitest run`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again.** Expected: PASS, with `corepack pnpm typecheck` clean.
- [ ] **Step 5: Stop and report.**

---

### Task 10: Web — raw view (lazy CodeMirror) and form↔raw sync

**Files:**
- Modify: `apps/web/package.json` to add `codemirror` (^6), `@codemirror/lang-json`, `@codemirror/lang-yaml`, `@codemirror/legacy-modes` and `@codemirror/language`.
- Create:
  - `apps/web/src/components/settings/codemirror.ts`: the only module that imports `@codemirror/*`. It exports `createEditor(parent: HTMLElement, opts: { doc: string; format: ConfigFormat; readOnly: boolean; dark: boolean; onChange(text: string): void }): { setDoc(text: string): void; destroy(): void }`. Language by format:
    - `json` → lang-json
    - `yaml` → lang-yaml
    - `ini` and `palworld` → legacy-modes `properties`
    - `properties` → legacy-modes `properties`
    - `raw` → none
  - `apps/web/src/components/settings/RawEditor.tsx`, which loads `codemirror.ts` with `import()` inside an effect and shows a `LinearProgress` while it loads.
- Modify: `SettingsTab.tsx` to add a **Form / Raw** `ToggleButtonGroup`, and `HistoryDialog.tsx` to use `RawEditor` read-only.
- Test: `apps/web/src/components/settings/RawSync.test.tsx`. Mock the `codemirror.ts` module with a textarea-backed fake that has the same interface.

**Behaviour:**
- **Form → Raw** with unsaved form changes: call `previewConfig({changes})`, show the returned raw text, and the pending state becomes "raw edited" (dirty).
- **Raw → Form** with a dirty raw buffer: call `previewConfig({raw})`.
  - If it returns fields, show them, and the dirty state becomes the field differences against the last read.
  - If it returns `parseError`, stay in Raw and show the error in an `Alert`.
- **A raw-only file** (`fields === null`) disables the Form toggle and shows `parseError` with the note "This file can only be edited as raw text until it parses".
- **Saving raw** sends `{etag, raw}`. If the server reports a parse error after a save, the file is raw-only from then on (the same UI state).
- **Bundle.** After `corepack pnpm --filter @skali/web build`, no file in `dist/assets` other than the lazy chunk contains `@codemirror`. Check with `grep -l "EditorView" apps/web/dist/assets/*.js`: exactly one file, not `index-*.js`.

- [ ] **Step 1: Write the failing tests**
  - `RawSync: form edits then Raw shows previewConfig's text`
  - `RawSync: raw edit then Form shows previewConfig's fields; parse error keeps Raw and shows the error`
  - `RawSync: fields:null disables Form and shows the raw-only note`
  - `RawSync: Save in raw sends {etag, raw}`
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again** and do the bundle check. Expected: the tests PASS, and the build's `EditorView` grep returns exactly one non-`index` chunk.
- [ ] **Step 5: Stop and report.**

---

### Task 11: Docs

**Files:**
- Modify: `docs/RUNNING.md`. Add an acceptance subsection, "Settings editor (server PC)", with these items:
  - Edit Palworld `ExpRate` in the form, save, then restart. The game shows the new rate, and the ini's other lines are unchanged (compare with the History entry).
  - Edit Minecraft `motd` in raw view.
  - A locked key can't be changed.
  - Editing the file in Notepad while the page is open gives "changed on disk" on save.
  - Restore an older version from History.
  - Add `Engine.ini`, or any other file, through **Add file**.
- Modify: `docs/NICE-TO-HAVES.md`.
  - Move Plan 2 to "In progress".
  - Remove its three parked fixes, which are now done.
  - Add these parked items:
    - A form for Basic servers' argument string (`-flag`, `-key value`). Today it is one text field.
    - Add and remove entries in `ops.json` and `whitelist.json` from the form. Today the form edits existing entries, and you add players with the console's `op` and `whitelist add` commands or in raw view.
    - Per-key "requires restart". Today any saved config change on a running server marks a restart as pending.

- [ ] **Step 1: Make the edits.** Keep RUNNING.md's line endings as they are.
- [ ] **Step 2: Verify.** Run `corepack pnpm typecheck` and `corepack pnpm test` for the whole repo. Expected: all green.
- [ ] **Step 3: Stop and report.**

---

## Decided in this plan (owner should check)

- **The raw view shows the file exactly as it is on disk, secrets included.** Skáli-generated values such as `AdminPassword` and `rcon.password` are visible in raw view and in History, though masked in the form. Masking them in raw text would need text rewriting that can corrupt an unparseable file. Access is already limited to your PC.
- **Any config save while a server is running marks it "restart pending"** (no per-key restart flags). Games read their config at start.
- **`ops.json` and `whitelist.json`:** the form edits existing entries, and adding players is done with `op <name>` and `whitelist add <name>` in the console (Minecraft looks up their IDs) or in raw view.
- **The launch-argument format is parked.** Basic servers keep one Arguments text field. Valheim, Palworld and Minecraft already have proper launch fields.
- **Files over 1 MB, and binary files, aren't editable in Skáli.**
- **Launch settings move from Overview to the Settings tab.**
