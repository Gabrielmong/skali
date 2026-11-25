import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { TopBar } from './TopBar.tsx'

const NAV = ['Servers', 'Deploys', 'Settings'] as const

const renderAt = (path: string, connected = true) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <TopBar connected={connected} />
    </MemoryRouter>,
  )

describe('TopBar', () => {
  it.each([
    ['/', 'Servers'],
    ['/servers/s1', 'Servers'],
    ['/deploys', 'Deploys'],
    ['/settings', 'Settings'],
  ])('at %s marks %s as the current page', (path, current) => {
    renderAt(path)
    for (const name of NAV) {
      const link = screen.getByRole('link', { name })
      if (name === current) expect(link).toHaveAttribute('aria-current', 'page')
      else expect(link).not.toHaveAttribute('aria-current')
    }
  })

  it('marks no nav link current on /new', () => {
    renderAt('/new')
    for (const name of NAV) expect(screen.getByRole('link', { name })).not.toHaveAttribute('aria-current')
  })

  it('shows the connection state', () => {
    renderAt('/', true)
    expect(screen.getByTitle('Connected')).toBeInTheDocument()
  })

  it('shows when disconnected', () => {
    renderAt('/', false)
    expect(screen.getByTitle('Disconnected')).toBeInTheDocument()
  })

  it('links home and to a new server', () => {
    renderAt('/deploys')
    expect(screen.getByRole('link', { name: 'Skáli' })).toHaveAttribute('href', '/')
    expect(screen.getByRole('link', { name: 'New server' })).toHaveAttribute('href', '/new')
  })
})
