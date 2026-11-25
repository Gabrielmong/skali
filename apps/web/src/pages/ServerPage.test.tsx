import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api.ts'
import { makeServer } from '../test/fixtures.ts'
import { ServerPage } from './ServerPage.tsx'

const state = vi.hoisted(() => ({ servers: [] as import('@skali/shared').ServerView[] }))

vi.mock('../live.tsx', () => ({
  useServers: () => ({ servers: state.servers, connected: true }),
  useServerLogs: () => ({ lines: [], runId: null }),
}))
vi.mock('../api.ts', async (orig) => ({
  ...(await orig<typeof import('../api.ts')>()),
  getGames: vi.fn(),
  listConfigSources: vi.fn(),
  readConfig: vi.fn(),
  getRuns: vi.fn(),
  configHistory: vi.fn(),
}))

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.getGames).mockResolvedValue([])
  vi.mocked(api.getRuns).mockResolvedValue([])
  vi.mocked(api.listConfigSources).mockResolvedValue([
    { id: 'launch', kind: 'launch', label: 'Launch settings', builtin: true },
    { id: 'server', kind: 'file', label: 'Server config', builtin: true, format: 'properties', path: 'server.properties' },
  ])
})

const renderPage = (over = {}) => {
  state.servers = [makeServer(over)]
  return render(
    <MemoryRouter initialEntries={['/servers/s1']}>
      <Routes>
        <Route path="/servers/:id" element={<ServerPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('ServerPage', () => {
  it('shows a Restart pending chip next to the status chip when restartPending', () => {
    renderPage({ status: 'running', restartPending: true })
    expect(screen.getByText('Restart pending')).toBeInTheDocument()
  })

  it('groups name, status, address and actions in a header region', () => {
    renderPage({ status: 'running' })
    const header = screen.getByRole('region', { name: 'Survival' })
    expect(within(header).getByRole('heading', { level: 1, name: 'Survival' })).toBeInTheDocument()
    expect(within(header).getByText('Running')).toBeInTheDocument()
    expect(within(header).getByRole('button', { name: 'Copy address' })).toBeInTheDocument()
    expect(within(header).getByRole('button', { name: 'Stop' })).toBeInTheDocument()
  })

  it('has Console, Settings and Overview tabs in that order', () => {
    renderPage()
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Console', 'Settings', 'Overview'])
  })

  it('opens the Settings tab', async () => {
    renderPage()
    await userEvent.click(screen.getByRole('tab', { name: 'Settings' }))
    expect(await screen.findByRole('combobox', { name: 'File' })).toBeInTheDocument()
  })

  it('switching tabs with unsaved Settings edits asks to discard', async () => {
    vi.mocked(api.getGames).mockResolvedValue([
      { id: 'valheim', displayName: 'Valheim', hasCommands: false, launchFields: [{ key: 'name', label: 'Server name', type: 'text' }] },
    ])
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    renderPage({ game: 'valheim', launch: { name: 'Home' } })
    await userEvent.click(screen.getByRole('tab', { name: 'Settings' }))
    await userEvent.type(await screen.findByRole('textbox', { name: 'Server name' }), '2')
    await userEvent.click(screen.getByRole('tab', { name: 'Console' }))
    expect(confirm).toHaveBeenCalledWith('Discard unsaved changes?')
    expect(screen.getByRole('textbox', { name: 'Server name' })).toHaveValue('Home2')
    confirm.mockReturnValue(true)
    await userEvent.click(screen.getByRole('tab', { name: 'Console' }))
    expect(screen.queryByRole('textbox', { name: 'Server name' })).toBeNull()
    confirm.mockRestore()
  })
})
