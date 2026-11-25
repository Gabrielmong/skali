/** Core colours of the "server room at night" palette (shared base with the IoT app, own accent). */
export const palette = {
  /** Page background: a deep indigo night. */
  night: '#0c1120',
  /** Cards and tiles. */
  surface: '#141b2d',
  /** Hovered / raised surfaces. */
  raised: '#1c2540',
  /** Hairlines (used with alpha). */
  line: '#9fb0dd',
  text: '#eef1f8',
  muted: '#8e98b3',
  /** Accent: frost, the rack's status lights. Never used for status. */
  frost: '#5cc8ff',
  /** Status "info" (jobs, restart pending): violet, so it never reads as the frost accent. */
  info: '#9d8cff',
  /** Running servers. */
  on: '#2fd38a',
  alarm: '#ff6b6b',
} as const

export const FONT_DISPLAY = '"Bricolage Grotesque Variable", "Figtree Variable", system-ui, sans-serif'
export const FONT_BODY = '"Figtree Variable", system-ui, -apple-system, "Segoe UI", sans-serif'
