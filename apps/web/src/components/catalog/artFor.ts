import type { CatalogEntry, GameId } from '@skali/shared'
import { useEffect, useState } from 'react'
import { getCatalog } from '../../api.ts'

/** A server's game art: the catalog entry with its Steam app id, else the built-in entry for its game. */
export function artFor(
  catalog: CatalogEntry[] | null,
  server: { game: GameId; steamAppId: number | null },
): string | undefined {
  if (!catalog) return undefined
  const byApp = server.steamAppId !== null ? catalog.find((e) => e.appId === server.steamAppId) : undefined
  return (byApp ?? catalog.find((e) => e.star && e.game === server.game))?.art
}

let cached: Promise<CatalogEntry[]> | null = null

/** The New server catalog, fetched once per page load and shared; null until it arrives (or if it fails). */
export function useCatalog(): CatalogEntry[] | null {
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null)
  useEffect(() => {
    let alive = true
    cached ??= getCatalog().catch((e: unknown) => {
      cached = null // retry on the next mount
      throw e
    })
    cached.then(
      (c) => alive && setCatalog(c),
      () => undefined,
    )
    return () => {
      alive = false
    }
  }, [])
  return catalog
}
