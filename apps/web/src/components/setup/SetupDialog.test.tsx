import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CatalogEntry, GameInfo } from '@skali/shared'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../../api.ts'
import { makeServer } from '../../test/fixtures.ts'
import { SetupDialog } from './SetupDialog.tsx'

vi.mock('../../api.ts', async (orig) => ({
  ...(await orig<typeof import('../../api.ts')>()),
  getGames: vi.fn(),
  getSettings: vi.fn(),
  browseFs: vi.fn(),
  minecraftVersions: vi.fn(),
  checkPorts: vi.fn(),
  installServer: vi.fn(),
}))

const games: GameInfo[] = [
  {
    id: 'palworld',
    displayName: 'Palworld',
    hasCommands: true,
    launchFields: [
      { key: 'port', label: 'Port', type: 'number', default: 8211 },
      { key: 'restPort', label: 'REST API port', type: 'number', default: 8212 },
    ],
  },
  {
    id: 'valheim',
    displayName: 'Valheim',
    hasCommands: false,
    launchFields: [
      { key: 'port', label: 'Port', type: 'number', default: 2456 },
      { key: 'world', label: 'World name', type: 'text', default: 'Dedicated' },
    ],
  },
  {
    id: 'minecraft',
    displayName: 'Minecraft',
    hasCommands: true,
    launchFields: [
      { key: 'port', label: 'Port', type: 'number', default: 25565 },
      { key: 'rconPort', label: 'RCON port', type: 'number', default: 25575 },
    ],
  },
  { id: 'basic', displayName: 'Basic', hasCommands: false, launchFields: [] },
]

const palworld: CatalogEntry = { appId: 2394010, game: 'palworld', name: 'Palworld', star: true }
const minecraft: CatalogEntry = { appId: null, game: 'minecraft', name: 'Minecraft', star: true }
const basic: CatalogEntry = {
  appId: 4020,
  game: 'basic',
  name: "Garry's Mod",
  star: false,
  ports: [{ port: 27015, protocol: 'udp', purpose: 'Game', forward: true }],
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.getGames).mockResolvedValue(games)
  vi.mocked(api.getSettings).mockResolvedValue({ allowlist: [], connectHost: 'x', gamesRoot: 'D:\\GameServers' })
  vi.mocked(api.checkPorts).mockResolvedValue({ clashes: [] })
  vi.mocked(api.minecraftVersions).mockResolvedValue({ versions: ['1.21.4', '1.21.3'], latest: '1.21.4' })
  vi.mocked(api.installServer).mockResolvedValue(makeServer({ id: 'new1' }))
  vi.mocked(api.browseFs).mockResolvedValue({ path: 'C:\\', parent: null, dirs: ['mine'], files: [], truncated: false })
})

function renderDialog(entry: CatalogEntry) {
  return render(
    <MemoryRouter initialEntries={['/new']}>
      <Routes>
        <Route path="/new" element={<SetupDialog open entry={entry} onClose={() => {}} />} />
        <Route path="/servers/:id" element={<div>detail page</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

const create = () => screen.getByRole('button', { name: 'Create' })

describe('SetupDialog', () => {
  it('folder follows the name until it is edited', async () => {
    renderDialog(palworld)
    const folder = await screen.findByLabelText('Install folder')
    await waitFor(() => expect(folder).toHaveValue('D:\\GameServers\\'))
    await userEvent.type(screen.getByLabelText(/^Name/), 'Pals')
    expect(folder).toHaveValue('D:\\GameServers\\Pals')
    fireEvent.change(folder, { target: { value: 'E:\\mine' } })
    await userEvent.type(screen.getByLabelText(/^Name/), '2')
    expect(folder).toHaveValue('E:\\mine')
    fireEvent.change(folder, { target: { value: '' } })
    expect(folder).toHaveValue('D:\\GameServers\\Pals2')
    await userEvent.type(screen.getByLabelText(/^Name/), '3')
    expect(folder).toHaveValue('D:\\GameServers\\Pals23')
  })

  it('does not let a stale clash block Create after the port changes or a check fails', async () => {
    vi.mocked(api.checkPorts).mockImplementation(async (ports) => ({
      clashes: ports.some((p) => p.port === 8211) ? [{ port: 8211, protocol: 'udp', reason: 'Used by Survival' }] : [],
    }))
    renderDialog(palworld)
    await userEvent.type(await screen.findByLabelText(/^Name/), 'Pals')
    await userEvent.type(screen.getByLabelText(/^Server name/), 'My Pals')
    expect(await screen.findByText('Used by Survival')).toBeInTheDocument()
    expect(create()).toBeDisabled()
    vi.mocked(api.checkPorts).mockRejectedValue(new api.ApiError(500, 'boom'))
    fireEvent.change(screen.getByLabelText('Port'), { target: { value: '8300' } })
    expect(screen.queryByText('Used by Survival')).toBeNull()
    expect(create()).toBeEnabled()
    await waitFor(() => expect(api.checkPorts).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByText(/Couldn't check the ports/)).toBeInTheDocument())
    expect(create()).toBeEnabled()
  })

  it('disables Create while a port clashes and shows the reason', async () => {
    vi.mocked(api.checkPorts).mockResolvedValue({
      clashes: [{ port: 8211, protocol: 'udp', reason: 'Used by Survival' }],
    })
    renderDialog(palworld)
    await userEvent.type(await screen.findByLabelText(/^Name/), 'Pals')
    await userEvent.type(screen.getByLabelText(/^Server name/), 'My Pals')
    expect(await screen.findByText('Used by Survival')).toBeInTheDocument()
    expect(create()).toBeDisabled()
  })

  it('sends the exact Palworld request and navigates', async () => {
    renderDialog(palworld)
    await userEvent.type(await screen.findByLabelText(/^Name/), 'Pals')
    expect(create()).toBeDisabled()
    await userEvent.type(screen.getByLabelText(/^Server name/), 'My Pals')
    await userEvent.type(screen.getByLabelText(/^Password/), 'secret')
    await waitFor(() => expect(create()).toBeEnabled())
    await userEvent.click(create())
    await waitFor(() => expect(screen.getByText('detail page')).toBeInTheDocument())
    expect(api.installServer).toHaveBeenCalledWith({
      game: 'palworld',
      name: 'Pals',
      folder: 'D:\\GameServers\\Pals',
      launch: { port: 8211, restPort: 8212 },
      palworld: { serverName: 'My Pals', serverPassword: 'secret', maxPlayers: 32 },
    })
  })

  it('blocks Palworld max players outside 1-32', async () => {
    renderDialog(palworld)
    await userEvent.type(await screen.findByLabelText(/^Name/), 'Pals')
    await userEvent.type(screen.getByLabelText(/^Server name/), 'My Pals')
    const max = screen.getByLabelText('Max players')
    await userEvent.clear(max)
    await userEvent.type(max, '33')
    expect(create()).toBeDisabled()
  })

  it('requires the Minecraft EULA and sends flavour, version and acceptEula', async () => {
    renderDialog(minecraft)
    await userEvent.type(await screen.findByLabelText(/^Name/), 'Mc')
    await waitFor(() => expect(api.minecraftVersions).toHaveBeenCalledWith('vanilla'))
    await waitFor(() => expect(screen.getByLabelText('Version')).toHaveValue('1.21.4'))
    expect(create()).toBeDisabled()
    expect(screen.getByRole('link', { name: 'Minecraft EULA' })).toHaveAttribute('href', 'https://aka.ms/MinecraftEULA')
    await userEvent.click(screen.getByRole('checkbox', { name: /Minecraft EULA/ }))
    await waitFor(() => expect(create()).toBeEnabled())
    await userEvent.click(create())
    await waitFor(() => expect(api.installServer).toHaveBeenCalled())
    expect(api.installServer).toHaveBeenCalledWith({
      game: 'minecraft',
      name: 'Mc',
      folder: 'D:\\GameServers\\Mc',
      launch: { port: 25565, rconPort: 25575, memoryMb: 4096 },
      minecraft: { flavour: 'vanilla', version: '1.21.4' },
      acceptEula: true,
    })
  })

  it('sends a basic server with its app ID and catalog ports', async () => {
    renderDialog(basic)
    await userEvent.type(await screen.findByLabelText(/^Name/), 'Gmod')
    expect(await screen.findByDisplayValue('27015')).toBeInTheDocument()
    await waitFor(() => expect(create()).toBeEnabled())
    await userEvent.click(create())
    await waitFor(() => expect(api.installServer).toHaveBeenCalled())
    expect(api.installServer).toHaveBeenCalledWith({
      game: 'basic',
      name: 'Gmod',
      folder: 'D:\\GameServers\\Gmod',
      launch: { ports: '27015/udp' },
      appId: 4020,
    })
  })

  it('shows a server error in the dialog and stays', async () => {
    vi.mocked(api.installServer).mockRejectedValue(new api.ApiError(400, 'Folder must be new or empty'))
    renderDialog(palworld)
    await userEvent.type(await screen.findByLabelText(/^Name/), 'Pals')
    await userEvent.type(screen.getByLabelText(/^Server name/), 'My Pals')
    await waitFor(() => expect(create()).toBeEnabled())
    await userEvent.click(create())
    expect(await screen.findByText('Folder must be new or empty')).toBeInTheDocument()
    expect(screen.queryByText('detail page')).toBeNull()
  })

  it('requires a Valheim password of at least 5 characters', async () => {
    renderDialog({ appId: 896660, game: 'valheim', name: 'Valheim', star: true })
    await userEvent.type(await screen.findByLabelText(/^Name/), 'Val')
    await userEvent.type(screen.getByLabelText(/^Password/), 'abcd')
    expect(create()).toBeDisabled()
    await userEvent.type(screen.getByLabelText(/^Password/), 'e')
    await waitFor(() => expect(create()).toBeEnabled())
  })
})
