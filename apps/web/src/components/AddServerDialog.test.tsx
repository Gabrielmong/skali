import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { GameInfo } from '@skali/shared'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api.ts'
import { makeServer } from '../test/fixtures.ts'
import { AddServerDialog } from './AddServerDialog.tsx'

vi.mock('../api.ts', async (orig) => ({
  ...(await orig<typeof import('../api.ts')>()),
  getGames: vi.fn(),
  browseFs: vi.fn(),
  inspectFolder: vi.fn(),
  adoptServer: vi.fn(),
}))

const games: GameInfo[] = [
  { id: 'palworld', displayName: 'Palworld', launchFields: [], hasCommands: true },
  {
    id: 'valheim',
    displayName: 'Valheim',
    launchFields: [{ key: 'password', label: 'Password', type: 'password' }],
    hasCommands: false,
  },
  {
    id: 'minecraft',
    displayName: 'Minecraft',
    launchFields: [{ key: 'maxPlayers', label: 'Max players', type: 'number', default: 20 }],
    hasCommands: true,
  },
  { id: 'basic', displayName: 'Basic', launchFields: [], hasCommands: false },
]

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.getGames).mockResolvedValue(games)
  vi.mocked(api.browseFs).mockImplementation(async (p) => {
    if (p === undefined) return { path: null, parent: null, dirs: ['C:\\'], files: [], truncated: false }
    if (p === 'C:\\') return { path: 'C:\\', parent: null, dirs: ['mc'], files: [], truncated: false }
    if (p === 'C:\\mc') return { path: 'C:\\mc', parent: 'C:\\', dirs: [], files: ['server.jar'], truncated: false }
    throw new api.ApiError(400, 'Cannot read this folder')
  })
})

function renderDialog() {
  return render(
    <MemoryRouter initialEntries={['/add']}>
      <Routes>
        <Route path="/add" element={<AddServerDialog open onClose={() => {}} />} />
        <Route path="/servers/:id" element={<div>detail page</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

async function pickFolder(game: string) {
  await userEvent.click(await screen.findByRole('button', { name: game }))
  await userEvent.click(await screen.findByRole('button', { name: 'C:\\' }))
  await userEvent.click(await screen.findByRole('button', { name: 'mc' }))
  await userEvent.click(await screen.findByRole('button', { name: 'Use this folder' }))
}

describe('AddServerDialog', () => {
  it('shows the inspect reason and stays on the folder step', async () => {
    vi.mocked(api.inspectFolder).mockResolvedValue({ ok: false, reason: 'No server jar found in this folder' })
    renderDialog()
    await pickFolder('Minecraft')
    expect(await screen.findByText('No server jar found in this folder')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Create' })).toBeNull()
    expect(api.inspectFolder).toHaveBeenCalledWith('minecraft', 'C:\\mc')
  })

  it('blocks Create for Minecraft until the EULA is ticked, then adopts and navigates', async () => {
    vi.mocked(api.inspectFolder).mockResolvedValue({
      ok: true,
      exe: 'java',
      launch: { maxPlayers: 12 },
      notes: ['Accept the Minecraft EULA before the first start (server Overview)'],
    })
    vi.mocked(api.adoptServer).mockResolvedValue(makeServer({ id: 'new1' }))
    renderDialog()
    await pickFolder('Minecraft')
    expect(await screen.findByText(/Accept the Minecraft EULA before/)).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'Max players' })).toHaveValue(12)
    const create = screen.getByRole('button', { name: 'Create' })
    expect(create).toBeDisabled()
    expect(screen.getByRole('link', { name: /Minecraft EULA/ })).toHaveAttribute('href', 'https://aka.ms/MinecraftEULA')
    await userEvent.click(screen.getByRole('checkbox', { name: /I accept the Minecraft EULA/ }))
    expect(create).toBeEnabled()
    await userEvent.click(create)
    await waitFor(() => expect(screen.getByText('detail page')).toBeInTheDocument())
    expect(api.adoptServer).toHaveBeenCalledWith({
      game: 'minecraft',
      name: 'mc',
      folder: 'C:\\mc',
      launch: { maxPlayers: 12 },
      acceptEula: true,
    })
  })

  it('shows a server refusal verbatim', async () => {
    vi.mocked(api.inspectFolder).mockResolvedValue({ ok: true, exe: 'x', launch: {}, notes: [] })
    vi.mocked(api.adoptServer).mockRejectedValue(
      new api.ApiError(400, "This folder can't be adopted: it is a system folder"),
    )
    renderDialog()
    await pickFolder('Palworld')
    await userEvent.click(await screen.findByRole('button', { name: 'Create' }))
    expect(await screen.findByText("This folder can't be adopted: it is a system folder")).toBeInTheDocument()
  })

  it('offers Valheim world import (default none) and sends the world name', async () => {
    vi.mocked(api.inspectFolder).mockResolvedValue({
      ok: true,
      exe: 'x',
      launch: {},
      notes: [],
      worlds: [{ name: 'Midgard', fwlPath: 'C:\\Users\\a\\Midgard.fwl', modified: '2026-01-02T00:00:00.000Z' }],
    })
    vi.mocked(api.adoptServer).mockResolvedValue(makeServer({ id: 'v1' }))
    renderDialog()
    await pickFolder('Valheim')
    const select = await screen.findByRole('combobox', { name: 'Import world' })
    expect(select).toHaveValue('')
    await userEvent.selectOptions(select, 'Midgard')
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(api.adoptServer).toHaveBeenCalled())
    expect(vi.mocked(api.adoptServer).mock.calls[0]![0].importWorldFrom).toBe('Midgard')
  })

  it('shows an unreadable folder error inline without breaking navigation', async () => {
    vi.mocked(api.browseFs).mockImplementation(async (p) => {
      if (p === undefined) return { path: null, parent: null, dirs: ['C:\\'], files: [], truncated: false }
      throw new api.ApiError(400, 'Cannot read this folder')
    })
    renderDialog()
    await userEvent.click(await screen.findByRole('button', { name: 'Minecraft' }))
    await userEvent.click(await screen.findByRole('button', { name: 'C:\\' }))
    expect(await screen.findByText('Cannot read this folder')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'C:\\' })).toBeInTheDocument()
  })
})
