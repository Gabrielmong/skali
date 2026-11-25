# Skáli UI Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Skáli web UI the IoT sister app's look and feel with its own Frost identity, and refine the frame, server cards, server page header and empty states.

**Architecture:** A token + component-override theme split mirroring `../iot/apps/web/src/theme/`, plus a few small presentational components (`BrandMark`, `TopBar`, `GameIcon`, `ServerStats`, `AddressChip`, `EmptyState`) that the existing pages compose. No behaviour, API or route changes.

**Tech Stack:** React 19, MUI 9 (CSS variables, dark scheme), react-router 8, Vitest + Testing Library, `@fontsource-variable/*`.

**Spec:** `docs/superpowers/specs/2026-11-25-ui-refresh-design.md`

## Global Constraints

- Accent (`primary.main`): Frost `#5cc8ff`, `contrastText` = night `#0c1120`.
- Palette: `night #0c1120`, `surface #141b2d`, `raised #1c2540`, `line #9fb0dd`, `text #eef1f8`, `muted #8e98b3`, `on #2fd38a` (success), `alarm #ff6b6b` (error).
- Fonts: `@fontsource-variable/bricolage-grotesque@5.3.0` (headings h3–h6, dialog titles), `@fontsource-variable/figtree@5.3.0` (body).
- Dark only: `colorSchemes: { dark: {...} }`, `defaultColorScheme: 'dark'`, `cssVariables: true`. No light scheme.
- Accent never encodes status: success = running, warning = starting/stopping/setup, error = crashed/failed, info = jobs/restart pending, as today.
- Keep every existing accessible name, visible status label, `data-status` attribute and test string (`Start`, `Stop`, `Restart`, `Copy address`, `Settings`, `All servers`, `3/16`, `CPU 12%`, `RAM 4.1 GB`, `Auto-restart paused after repeated crashes`, …). All existing web tests must pass unchanged.
- No changes to dialogs, settings/setup forms, config editor, Console internals or Deploys page beyond what the theme applies.
- Run web tests with `pnpm --filter @skali/web test` and typecheck with `pnpm --filter @skali/web typecheck` from the repo root (use `node scripts/run-pnpm.mjs` in place of `pnpm` if `pnpm` is not on PATH).

## Review Focus

- Phone width (~360px): the card stats row and the server page header must wrap, never overflow horizontally; actions drop to their own line.
- Long server names (60+ chars) truncate with an ellipsis in cards and the top of the server page; they never push the status pill off the card.
- Stopped server: no stats, the card keeps the same height as running neighbours (stats row keeps `minHeight`).
- Disconnected: the connection dot in the top bar turns red with "Disconnected" title; the existing "Connection lost" alert still shows on the servers page.
- Active nav: `/servers/:id` highlights **Servers**; `/deploys` and `/settings` highlight their own pill; `/new` highlights none.

---

### Task 1: Theme port with Frost accent and fonts

**Files:**
- Create: `apps/web/src/theme/tokens.ts`, `apps/web/src/theme/components.ts`, `apps/web/src/theme.test.ts`
- Modify: `apps/web/src/theme.ts`, `apps/web/src/main.tsx`, `apps/web/package.json`

**Interfaces:**
- Produces: `palette` (const object with keys `night, surface, raised, line, text, muted, frost, on, alarm`), `FONT_DISPLAY`, `FONT_BODY` from `theme/tokens.ts`; `components: Components<Theme>` from `theme/components.ts`; `theme` from `theme.ts` (unchanged export name).

- [ ] **Step 1: Write the failing test** `apps/web/src/theme.test.ts`

```ts
import { theme } from './theme.ts'
import { FONT_BODY, FONT_DISPLAY, palette } from './theme/tokens.ts'

describe('theme', () => {
  it('uses the Frost accent on the night palette, dark only', () => {
    const dark = theme.colorSchemes.dark!.palette
    expect(dark.primary.main).toBe('#5cc8ff')
    expect(dark.primary.contrastText).toBe(palette.night)
    expect(dark.success.main).toBe('#2fd38a')
    expect(dark.background.default).toBe('#0c1120')
    expect(theme.colorSchemes.light).toBeUndefined()
  })
  it('uses Figtree for body and Bricolage for headings', () => {
    expect(theme.typography.fontFamily).toBe(FONT_BODY)
    expect(theme.typography.h5.fontFamily).toBe(FONT_DISPLAY)
  })
})
```

- [ ] **Step 2: Run it, expect FAIL** (`Cannot find module './theme/tokens.ts'`): `pnpm --filter @skali/web test -- theme.test`

- [ ] **Step 3: Implement**
  - `theme/tokens.ts`: copy IoT's `tokens.ts`, replacing `lamp: '#ffb547'` with `frost: '#5cc8ff'` (doc comment: "Accent: frost on the longhouse roof").
  - `theme/components.ts`: copy IoT's `components.ts` with every `palette.lamp` → `palette.frost`. Body glow: second radial gradient uses `alpha(palette.frost, 0.07)`. Drop the `MuiSlider`/`MuiSwitch` entries only if unused (keep them; harmless).
  - `theme.ts`: IoT's `theme.ts` shape with `primary: { main: palette.frost, contrastText: palette.night }`; keep `shape.borderRadius: 8`.
  - `package.json` deps: `"@fontsource-variable/bricolage-grotesque": "5.3.0"`, `"@fontsource-variable/figtree": "5.3.0"`; run `pnpm install`.
  - `main.tsx`: import both fontsource packages as the first two lines.

- [ ] **Step 4: Run** `pnpm --filter @skali/web test` and `pnpm --filter @skali/web typecheck`. Expected: all PASS.

- [ ] **Step 5: Commit** `feat(web): night theme with frost accent`

### Task 2: Brand mark and top bar

**Files:**
- Create: `apps/web/src/layout/BrandMark.tsx`, `apps/web/src/layout/TopBar.tsx`, `apps/web/src/layout/TopBar.test.tsx`
- Modify: `apps/web/src/App.tsx` (replace the inline `AppBar` with `<TopBar connected={connected} />`), `apps/web/index.html` (inline SVG favicon of the mark)

**Interfaces:**
- Produces: `BrandMark({ size?: number }): JSX` (decorative, `aria-hidden`, default 26); `TopBar({ connected: boolean }): JSX`.

- [ ] **Step 1: Write failing tests** `TopBar.test.tsx` (render inside `MemoryRouter initialEntries={[path]}`):
  - `it.each([['/', 'Servers'], ['/servers/s1', 'Servers'], ['/deploys', 'Deploys'], ['/settings', 'Settings']])('marks %s nav as %s', …)`: `getByRole('link', { name })` has `aria-current="page"`; the other two nav links do not.
  - `'/new' marks no nav link current`: none of the three has `aria-current`.
  - `'shows connection state'`: `connected` → `getByTitle('Connected')`; `!connected` → `getByTitle('Disconnected')`.
  - `'links home and to new server'`: link named `Skáli` → `href="/"`; link named `New server` → `href="/new"`.

- [ ] **Step 2: Run, expect FAIL** (module not found).

- [ ] **Step 3: Implement**
  - `BrandMark`: IoT's mark structure, 24×24 viewBox: a longhouse outline (gable roof `M2.5 11 12 5l9.5 6`, walls `M4.5 10v10h15V10`, stroke `currentColor`, width 1.8, opacity .85) and a doorway `rect x=10 y=14 w=4 h=6 rx=1` filled `var(--mui-palette-primary-main)` with a `drop-shadow(0 0 4px …)` glow.
  - `TopBar`: sticky transparent `AppBar` (theme frosts it), `Toolbar` with: brand link (`BrandMark` + "Skáli" in h6 display font), connection dot (existing `CircleIcon`, `titleAccess` Connected/Disconnected), spacer, nav pills **Servers** (`/`), **Deploys**, **Settings** as `Button component={NavLink}`; Servers is active for `/` and `/servers/*` (use `useLocation` + `matchPath`), and active pills get `aria-current="page"` plus `color: primary.main`, `bgcolor: alpha(frost, .12)`, `border: 1px solid alpha(frost, .4)`, radius 999. Then `New server` as `variant="contained"` with `AddIcon`. Settings becomes a text pill like the others (replacing today's icon-only button); its accessible name stays "Settings".
  - Below `sm`, nav pills show icons only (`DnsIcon`, `RocketLaunchIcon`, `SettingsIcon`) with `aria-label` = the same names; `New server` shows the `+` icon only with `aria-label="New server"`.
  - `index.html`: `<link rel="icon" href="data:image/svg+xml,…">` of the mark (stroke `#eef1f8`, door `#5cc8ff`).

- [ ] **Step 4: Run all web tests + typecheck.** Expected PASS.

- [ ] **Step 5: Commit** `feat(web): branded top bar with nav pills`

### Task 3: Server card refresh

**Files:**
- Create: `apps/web/src/components/GameIcon.tsx`, `apps/web/src/components/ServerStats.tsx`, `apps/web/src/components/AddressChip.tsx`, `apps/web/src/components/ServerStats.test.tsx`
- Modify: `apps/web/src/components/ServerCard.tsx`, `apps/web/src/components/StatusChip.tsx`
- Test: `apps/web/src/components/ServerCard.test.tsx` (unchanged, must pass)

**Interfaces:**
- Produces:
  - `GameIcon({ game: GameId, size?: 'small' | 'large' }): JSX`: tinted rounded tile (`bgcolor: alpha(frost, .12)`, `color: primary.main`, radius 8; small = 34px, large = 48px) holding the existing `GAME_ICONS` mapping (moved here from `ServerCard.tsx`).
  - `ServerStats({ server: ServerView, now: number }): JSX`: row (`flexWrap: 'wrap'`, `columnGap: 2`, `minHeight: 24`) of stat items, each a single text node: players `"3/16"` (with `Tooltip "Players online"` and a muted "players" suffix in a separate element), uptime via `formatUptime`, `"CPU 12%"`, `"RAM 4.1 GB"`. Shown only while live (running/starting), same rules as today's `ServerCard`; players whenever `server.players` exists.
  - `AddressChip({ address: string, onCopy: () => void }): JSX`: mono text in a subtle box (`bgcolor: alpha(line, .07)`, radius 6, `px: 1`) plus the existing `Copy address` icon button.

- [ ] **Step 1: Write failing test** `ServerStats.test.tsx`:
  - running with `players {3,16}`, `cpuPct 12.4`, `memBytes 4.1 GiB`, `startedAt` 2h ago: `getByText('3/16')`, `getByText('CPU 12%')`, `getByText('RAM 4.1 GB')`, `getByText(/^2h/)`.
  - stopped with `cpuPct` set: `queryByText(/CPU/)` is null.

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement**
  - Components above; `ServerCard` composes: header row `GameIcon` · name link (`h6`, ellipsis, `minWidth: 0`) · `StatusChip` (+ `RestartPendingChip`); `ServerStats`; crash/detail messages as today; `AddressChip`; `CardActions` with `ActionButtons`. Card hover: border colour `alpha(frost, .35)` with a 160ms transition.
  - `StatusChip`: for `running` render a glowing dot `icon` (6px circle, `bgcolor: success.main`, `boxShadow: 0 0 6px` same colour) and use the soft style (`variant="filled"` with `bgcolor: alpha(success, .14)`, `color: success.main`); other statuses keep their colours, using the same soft style. Labels and `data-status` unchanged.

- [ ] **Step 4: Run all web tests + typecheck.** Expected PASS (incl. existing `ServerCard.test.tsx` `3/16`, `/CPU 12%/`, `/RAM 4\.1 GB/`).

- [ ] **Step 5: Commit** `feat(web): refined server cards`

### Task 4: Server page header card

**Files:**
- Modify: `apps/web/src/pages/ServerPage.tsx`
- Test: `apps/web/src/pages/ServerPage.test.tsx`

**Interfaces:**
- Consumes: `GameIcon`, `ServerStats`, `AddressChip` (Task 3).

- [ ] **Step 1: Add failing test** to `ServerPage.test.tsx`: `'groups name, status and actions in a header'`: `getByRole('region', { name: 'Survival' })`, then assert `within(region)` contains `getByText('Running')`, `getByRole('button', { name: 'Copy address' })`, `getByRole('button', { name: 'Stop' })`.

- [ ] **Step 2: Run, expect FAIL** (no region).

- [ ] **Step 3: Implement**: keep the `All servers` back button above. Replace the header `Stack` with a `Card component="section" aria-labelledby={id}` containing: `GameIcon size="large"`, name as `Typography variant="h5" component="h1" id={id}` (ellipsis), `StatusChip` (+ `RestartPendingChip`), below it `ServerStats` and `AddressChip`; `ActionButtons` aligned right on `md+`, wrapping below on small screens. Crash-paused and detail messages move inside the card. Tabs stay below the card, unchanged.

- [ ] **Step 4: Run all web tests + typecheck.** Expected PASS.

- [ ] **Step 5: Commit** `feat(web): server page header card`

### Task 5: Empty, connecting and not-found states

**Files:**
- Create: `apps/web/src/components/EmptyState.tsx`, `apps/web/src/components/EmptyState.test.tsx`
- Modify: `apps/web/src/pages/ServersPage.tsx`, `apps/web/src/pages/ServerPage.tsx` (not-found branch), `apps/web/src/App.tsx` (`NotFound`)

**Interfaces:**
- Consumes: `BrandMark` (Task 2).
- Produces: `EmptyState({ title: string, icon?: ReactNode, busy?: boolean, children?: ReactNode }): JSX`: centred column (`mt: 10`, `maxWidth: 420`, `mx: 'auto'`), icon defaults to `<BrandMark size={48} />`, title `h5` `component="h1"`, children (text + actions) beneath. `busy` shows a small `LinearProgress` (frost) under the title and sets `aria-busy`.

- [ ] **Step 1: Write failing test** `EmptyState.test.tsx`: renders `getByRole('heading', { level: 1, name: 'No servers yet' })` and its children; with `busy`, `getByRole('progressbar')` exists.

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement** and use it: servers page (`Connecting to Skáli…` with `busy`; `No servers yet` with the existing text and `Add existing server` button), server page not found (`Server not found` + `All servers` button; `Connecting to Skáli…` busy), App `NotFound` (`Not found` + `All servers` button). Keep all strings verbatim.

- [ ] **Step 4: Run all web tests + typecheck, then `pnpm build` from the repo root.** Expected PASS / build succeeds.

- [ ] **Step 5: Manual check** with `pnpm dev`: servers grid, a server page, `/deploys`, `/settings`, a dialog, at desktop and 360px width, against the Review Focus list.

- [ ] **Step 6: Commit** `feat(web): empty and connecting states`
