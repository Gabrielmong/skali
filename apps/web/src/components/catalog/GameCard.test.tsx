import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CatalogEntry } from '@skali/shared'
import { describe, expect, it, vi } from 'vitest'
import { displayName, initials } from './gameName.ts'
import { GameCard } from './GameCard.tsx'

const rust: CatalogEntry = {
  appId: 258550,
  game: 'basic',
  name: 'Rust Dedicated Server',
  star: false,
  art: 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/252490/header.jpg',
  ports: [
    { port: 28015, protocol: 'udp', purpose: 'Game', forward: true },
    { port: 28016, protocol: 'tcp', purpose: 'RCON', forward: false },
  ],
}

describe('displayName', () => {
  it.each([
    ['Rust Dedicated Server', 'Rust'],
    ['Killing Floor 2 - Dedicated Server', 'Killing Floor 2'],
    ['Soulmask Dedicated Server For Linux', 'Soulmask'],
    ['The Front Linux Dedicated Server', 'The Front'],
    ['StickyBots DedicatedServer', 'StickyBots'],
    ['Arma 3 Server', 'Arma 3'],
    ['STAR WARS™ Jedi Knight: Jedi Academy™', 'STAR WARS Jedi Knight: Jedi Academy'],
    ["Garry's Mod", "Garry's Mod"],
    ['HZ_SERVER', 'HZ_SERVER'],
  ])('%s -> %s', (name, shown) => {
    expect(displayName(name)).toBe(shown)
  })
})

describe('initials', () => {
  it.each([
    ['Team Fortress 2', 'TF'],
    ['Rust', 'RU'],
    ["Don't Starve Together", 'DS'],
  ])('%s -> %s', (name, want) => {
    expect(initials(name)).toBe(want)
  })
})

describe('GameCard', () => {
  it('shows the short name, the art and the forwarded ports, named by the full catalog name', async () => {
    const onSelect = vi.fn()
    render(<GameCard entry={rust} onSelect={onSelect} />)
    expect(screen.getByText('Rust')).toBeInTheDocument()
    expect(screen.getByRole('presentation', { hidden: true })).toHaveAttribute('src', rust.art)
    expect(screen.getByText('UDP 28015')).toBeInTheDocument()
    expect(screen.queryByText('TCP 28016')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Rust Dedicated Server' }))
    expect(onSelect).toHaveBeenCalledWith(rust)
  })

  it('falls back to initials when the art fails to load', () => {
    render(<GameCard entry={rust} onSelect={() => {}} />)
    fireEvent.error(screen.getByRole('presentation', { hidden: true }))
    expect(screen.queryByRole('presentation', { hidden: true })).toBeNull()
    expect(screen.getByText('RU')).toBeInTheDocument()
  })

  it('uses initials when there is no art', () => {
    render(<GameCard entry={{ ...rust, art: undefined, name: 'Team Fortress 2 Dedicated Server' }} onSelect={() => {}} />)
    expect(screen.getByText('TF')).toBeInTheDocument()
  })
})
