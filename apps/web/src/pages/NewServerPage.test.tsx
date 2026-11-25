import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CatalogEntry } from '@skali/shared'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api.ts'
import { NewServerPage } from './NewServerPage.tsx'

vi.mock('../api.ts', async (orig) => ({
  ...(await orig<typeof import('../api.ts')>()),
  getCatalog: vi.fn(),
  steamAppInfo: vi.fn(),
  getGames: vi.fn(),
  getSettings: vi.fn(),
  checkPorts: vi.fn(),
  minecraftVersions: vi.fn(),
  browseFs: vi.fn(),
}))

const entries: CatalogEntry[] = [
  { appId: 2394010, game: 'palworld', name: 'Palworld', star: true },
  { appId: null, game: 'minecraft', name: 'Minecraft', star: true },
  { appId: 4020, game: 'basic', name: "Garry's Mod", star: false },
  { appId: 232250, game: 'basic', name: 'Team Fortress 2', star: false },
]

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.getCatalog).mockResolvedValue(entries)
  vi.mocked(api.getGames).mockResolvedValue([])
  vi.mocked(api.getSettings).mockResolvedValue({ allowlist: [], connectHost: 'x', gamesRoot: 'D:\\GameServers' })
  vi.mocked(api.checkPorts).mockResolvedValue({ clashes: [] })
})

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/new']}>
      <Routes>
        <Route path="/new" element={<NewServerPage />} />
        <Route path="/add" element={<div>add page</div>} />
      </Routes>
    </MemoryRouter>,
  )

describe('NewServerPage', () => {
  it('lists star cards and basic entries, and filters by name case-insensitively', async () => {
    renderPage()
    expect(await screen.findByText('Palworld')).toBeInTheDocument()
    expect(screen.getByText('Team Fortress 2')).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Search games'), 'GARRY')
    expect(screen.getByText("Garry's Mod")).toBeInTheDocument()
    expect(screen.queryByText('Palworld')).toBeNull()
    expect(screen.queryByText('Team Fortress 2')).toBeNull()
  })

  it('links to adding an existing folder', async () => {
    renderPage()
    await userEvent.click(await screen.findByRole('link', { name: 'Add an existing folder instead' }))
    expect(screen.getByText('add page')).toBeInTheDocument()
  })

  it('shows the app name and enables Set up for a Windows app', async () => {
    vi.mocked(api.steamAppInfo).mockResolvedValue({ appId: 740, name: 'CS Dedicated', windows: true })
    renderPage()
    await userEvent.type(await screen.findByLabelText('Other Steam app ID'), '740')
    await userEvent.click(screen.getByRole('button', { name: 'Look up' }))
    expect(await screen.findByText('CS Dedicated')).toBeInTheDocument()
    expect(api.steamAppInfo).toHaveBeenCalledWith(740)
    const setUp = screen.getByRole('button', { name: 'Set up' })
    expect(setUp).toBeEnabled()
    await userEvent.click(setUp)
    expect(await screen.findByLabelText(/^Name/)).toBeInTheDocument()
  })

  it('refuses an app with no Windows build', async () => {
    vi.mocked(api.steamAppInfo).mockResolvedValue({ appId: 5, name: 'Linux Only', windows: false })
    renderPage()
    await userEvent.type(await screen.findByLabelText('Other Steam app ID'), '5')
    await userEvent.click(screen.getByRole('button', { name: 'Look up' }))
    expect(await screen.findByText("No Windows build — this server can't run here")).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Set up' })).toBeDisabled()
  })

  it('says when no Steam app has that ID', async () => {
    vi.mocked(api.steamAppInfo).mockRejectedValue(new api.ApiError(404, 'No Steam app with that ID'))
    renderPage()
    await userEvent.type(await screen.findByLabelText('Other Steam app ID'), '99')
    await userEvent.click(screen.getByRole('button', { name: 'Look up' }))
    expect(await screen.findByText('No Steam app with that ID')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Set up' })).toBeDisabled())
  })

  it.each([
    [409, 'SteamCMD is busy with an install or update; try again when it finishes'],
    [502, 'Steam lookup failed: ERROR! Timed out waiting for app info'],
  ])('shows the server message for a %i lookup failure', async (status, message) => {
    vi.mocked(api.steamAppInfo).mockRejectedValue(new api.ApiError(status, message))
    renderPage()
    await userEvent.type(await screen.findByLabelText('Other Steam app ID'), '740')
    await userEvent.click(screen.getByRole('button', { name: 'Look up' }))
    expect(await screen.findByText(message)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Set up' })).toBeDisabled()
  })

  it('ignores a lookup response after the ID was edited', async () => {
    let resolveFirst!: (v: { appId: number; name: string; windows: boolean }) => void
    vi.mocked(api.steamAppInfo).mockReturnValueOnce(new Promise((r) => (resolveFirst = r)))
    renderPage()
    const field = await screen.findByLabelText('Other Steam app ID')
    await userEvent.type(field, '740')
    await userEvent.click(screen.getByRole('button', { name: 'Look up' }))
    await userEvent.type(field, '1')
    resolveFirst({ appId: 740, name: 'Old App', windows: true })
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByText('Old App')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Set up' })).toBeNull()
  })

  it('rejects an app ID above 2^31', async () => {
    renderPage()
    await userEvent.type(await screen.findByLabelText('Other Steam app ID'), '3000000000')
    expect(screen.getByRole('button', { name: 'Look up' })).toBeDisabled()
  })
})
