# Skáli UI refresh: design

## Intent

The web UI was built for function, not looks, and feels unrefined. Give it the same look and feel as the IoT sister app
(`../iot/apps/web`) while keeping it recognisably its own: related, not identical. Layout changes beyond the ones listed
here come later, in a separate pass.

## Goals

- Port IoT's visual system: night-indigo surfaces with a soft radial glow, Bricolage Grotesque headings + Figtree body,
  hairline borders, pill tabs and chips, frosted app bar, rounder dialogs, tooltip styling.
- Give Skáli its own identity: **Frost** accent `#5cc8ff` (replaces IoT's lamp amber) and a longhouse brand mark with a
  lit doorway in the accent.
- Refine the most-seen screens: app frame, server cards, server page header, empty/connecting states.

## Non-goals

- No redesign of dialogs, setup/settings forms, the config editor, the console internals or the Deploys page beyond what
  the theme gives them for free.
- No navigation restructure (e.g. IoT's side menu); that belongs to the later layout pass.
- No light mode (IoT is dark only, for the same reason: OS light mode gave dark text on the night background).

## Anti-goals

- Looking like a copy of IoT (same amber, same house mark).
- Breaking behaviour or the existing tests: accessible names (`Start`, `Stop`, `Restart`, `Copy address`, `Settings`),
  status texts and `data-status` attributes stay as they are.
- Using the accent for status: green = running, warning = starting/stopping, red = crashed, as today.

## Approaches considered

- A. Theme-only reskin: cheapest, but layouts that make it feel unrefined stay.
- **B. Reskin + pass on main screens (picked).** Theme plus the frame, server cards, server page header and empty states.
- C. Full overhaul incl. every dialog/form/console and page transitions: most consistent, most work and risk to tested
  screens.

## The how (decided)

- `apps/web/src/theme/tokens.ts` + `theme/components.ts`, mirroring IoT's split; `theme.ts` assembles them. Palette as IoT
  (`night #0c1120`, `surface #141b2d`, `raised #1c2540`, `line #9fb0dd`, `text #eef1f8`, `muted #8e98b3`, `on #2fd38a`,
  `alarm #ff6b6b`) with `frost #5cc8ff` as primary. Body glow uses the frost tint in place of amber.
- Fonts via `@fontsource-variable/bricolage-grotesque` and `@fontsource-variable/figtree` (same versions as IoT),
  imported in `main.tsx`.
- App frame: keep the sticky top bar, now frosted, with `BrandMark` + "Skáli", connection dot, and nav as pill links
  (Servers, Deploys, Settings) with the active one highlighted; "New server" as the contained primary button.
- Server card (as in the approved mockup): tinted game-icon tile, display-font name, status pill with a glowing dot,
  a stats row (players, uptime, CPU, RAM) with values emphasised, the connect address in a subtle mono chip with copy,
  actions at the bottom.
- Server page: name, status, stats, address and actions grouped in a header card above the pill tabs.
- Empty / connecting / not-found states: centred, with the brand mark or game icon, heading in the display font.

## Left to the builder

Exact spacing, the longhouse SVG path, how stats wrap at narrow widths, whether a `PageSection`-style helper is worth
adding, and minor colour alphas.
