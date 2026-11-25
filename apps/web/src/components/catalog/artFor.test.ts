import type { CatalogEntry } from '@skali/shared'
import { describe, expect, it } from 'vitest'
import { artFor } from './artFor.ts'

const catalog: CatalogEntry[] = [
  { appId: 2394010, game: 'palworld', name: 'Palworld', star: true, art: 'https://x.steamstatic.com/pal.jpg' },
  { appId: null, game: 'minecraft', name: 'Minecraft', star: true },
  { appId: 258550, game: 'basic', name: 'Rust Dedicated Server', star: false, art: 'https://x.steamstatic.com/rust.jpg' },
]

describe('artFor', () => {
  it('matches a server by its Steam app id', () => {
    expect(artFor(catalog, { game: 'basic', steamAppId: 258550 })).toBe('https://x.steamstatic.com/rust.jpg')
  })

  it('falls back to the built-in entry for the server game', () => {
    expect(artFor(catalog, { game: 'palworld', steamAppId: null })).toBe('https://x.steamstatic.com/pal.jpg')
  })

  it('has no art for unknown basic servers, Minecraft, or before the catalog loads', () => {
    expect(artFor(catalog, { game: 'basic', steamAppId: null })).toBeUndefined()
    expect(artFor(catalog, { game: 'basic', steamAppId: 1 })).toBeUndefined()
    expect(artFor(catalog, { game: 'minecraft', steamAppId: null })).toBeUndefined()
    expect(artFor(null, { game: 'palworld', steamAppId: 2394010 })).toBeUndefined()
  })
})
