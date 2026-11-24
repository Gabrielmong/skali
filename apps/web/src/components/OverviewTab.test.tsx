import { render, screen } from '@testing-library/react'
import { MINECRAFT_EULA_NOTE, type GameInfo } from '@skali/shared'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api.ts'
import { makeServer } from '../test/fixtures.ts'
import { OverviewTab } from './OverviewTab.tsx'

vi.mock('../api.ts', async (orig) => ({
  ...(await orig<typeof import('../api.ts')>()),
  patchServer: vi.fn(),
  inspectFolder: vi.fn(),
  acceptEula: vi.fn(),
  deleteServer: vi.fn(),
}))

const game: GameInfo = {
  id: 'valheim',
  displayName: 'Valheim',
  hasCommands: false,
  launchFields: [
    { key: 'name', label: 'Server name', type: 'text' },
    { key: 'password', label: 'Password', type: 'password' },
  ],
}
const launch = { name: 'Home', password: '****', legacy: 'old' }

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.patchServer).mockImplementation(async (_id, p) =>
    makeServer({ launch: { ...launch, ...p.launch, password: '****' } }),
  )
})

const renderTab = (over = {}, g: GameInfo = game) =>
  render(
    <MemoryRouter>
      <OverviewTab server={makeServer({ game: g.id, launch, ...over })} game={g} />
    </MemoryRouter>,
  )

describe('OverviewTab', () => {
  it('no launch fields any more: they live in the Settings tab', () => {
    renderTab()
    expect(screen.queryByRole('textbox', { name: 'Server name' })).toBeNull()
    expect(screen.queryByText('Launch settings')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    expect(screen.getByLabelText('Stop timeout (seconds)')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
  })

  it('shows Accept EULA when the inspect notes carry the EULA note', async () => {
    vi.mocked(api.inspectFolder).mockResolvedValue({ ok: true, exe: 'java', launch: {}, notes: [MINECRAFT_EULA_NOTE] })
    renderTab({}, { id: 'minecraft', displayName: 'Minecraft', hasCommands: true, launchFields: [] })
    expect(await screen.findByRole('button', { name: 'Accept EULA' })).toBeInTheDocument()
  })
})
