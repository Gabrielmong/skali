/** A catalog name without the "Dedicated Server" / "Server" / "For Linux" suffixes and trademark signs. */
export function displayName(name: string): string {
  const short = name
    .replace(/[™®]/g, '')
    .replace(/\s*[-:]?\s*(Linux\s+)?Dedicated\s*Server(\s+For\s+Linux)?$/i, '')
    .replace(/\s+-?\s*Server$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return short || name
}

/** Two letters for an art-less tile: the first letters of the first two words, or the first two of a single word. */
export function initials(name: string): string {
  const words = name.match(/[A-Za-z0-9][A-Za-z0-9']*/g) ?? []
  const [first = name, second] = words
  const letters = second ? first.charAt(0) + second.charAt(0) : first.slice(0, 2)
  return letters.toUpperCase()
}

/** A stable hue (0-359) for a name, so a game's fallback tile keeps its colour. */
export function hueOf(name: string): number {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360
  return h
}
