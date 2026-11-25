import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

  describe('Update button', () => {
    const running = { kind: 'update', state: 'running', steps: [], progress: null, runId: 'r' } as const
    const failedInstall = { kind: 'install', state: 'failed', steps: [], progress: null, runId: 'r' } as const
    it('shows for an ordinary server and opens the dialog', async () => {
      renderTab({ game: 'valheim' })
      await userEvent.click(screen.getByRole('button', { name: 'Update' }))
      expect(screen.getByText(/backs up the world, updates/)).toBeInTheDocument()
    })
    it.each([
      ['a job is running', { job: running }],
      ['the install failed', { job: failedInstall }],
      ['setup is pending', { setupPending: true }],
      ['the server is starting', { status: 'starting' }],
      ['basic without a Steam app ID', { game: 'basic', steamAppId: null }],
    ] as const)('is hidden when %s', (_n, over) => {
      renderTab(over)
      expect(screen.queryByRole('button', { name: 'Update' })).toBeNull()
    })
    it('shows for basic with a Steam app ID', () => {
      renderTab({ game: 'basic', steamAppId: 123 })
      expect(screen.getByRole('button', { name: 'Update' })).toBeInTheDocument()
    })
  })

  describe('Steam app ID (basic)', () => {
    it('saves a new id; not shown for other games', async () => {
      const { unmount } = renderTab({ game: 'basic', steamAppId: null })
      await userEvent.type(screen.getByLabelText('Steam app ID'), '4000')
      await userEvent.tab()
      expect(api.patchServer).toHaveBeenCalledWith('s1', { steamAppId: 4000 })
      unmount()
      renderTab({ game: 'valheim' })
      expect(screen.queryByLabelText('Steam app ID')).toBeNull()
    })
    it('clears the id with null', async () => {
      renderTab({ game: 'basic', steamAppId: 4000 })
      await userEvent.clear(screen.getByLabelText('Steam app ID'))
      await userEvent.tab()
      expect(api.patchServer).toHaveBeenCalledWith('s1', { steamAppId: null })
    })
    it('is disabled while a job runs', () => {
      const j = { kind: 'update', state: 'running', steps: [], progress: null, runId: 'r' } as const
      renderTab({ game: 'basic', steamAppId: 1, job: j })
      expect(screen.getByLabelText('Steam app ID')).toBeDisabled()
      expect(screen.getByLabelText('Stop timeout (seconds)')).toBeDisabled()
    })
  })

  describe('Finish setup', () => {
    it('shows the launch form only while setupPending', () => {
      const { unmount } = renderTab({ game: 'valheim', setupPending: true })
      expect(screen.getByText('Finish setup')).toBeInTheDocument()
      expect(screen.getByRole('textbox', { name: 'Server name' })).toBeInTheDocument()
      unmount()
      renderTab({ game: 'valheim' })
      expect(screen.queryByText('Finish setup')).toBeNull()
    })
  })

  describe('remove dialog', () => {
    const failedInstall = { kind: 'install', state: 'failed', steps: [], progress: null, runId: 'r' } as const
    const openDialog = async () => userEvent.click(screen.getByRole('button', { name: 'Delete' }))
    it('offers deleting the folder only for a failed install in a folder Skáli created', async () => {
      const { unmount } = renderTab({ createdFolder: true, job: failedInstall })
      await openDialog()
      expect(screen.getByRole('checkbox', { name: 'Also delete C:\\Games\\mc' })).not.toBeChecked()
      unmount()
      renderTab({ createdFolder: false, job: failedInstall })
      await openDialog()
      expect(screen.queryByRole('checkbox')).toBeNull()
    })
    it('no checkbox for a failed update or a healthy server', async () => {
      const { unmount } = renderTab({ createdFolder: true, job: { ...failedInstall, kind: 'update' } })
      await openDialog()
      expect(screen.queryByRole('checkbox')).toBeNull()
      unmount()
      renderTab({ createdFolder: true })
      await openDialog()
      expect(screen.queryByRole('checkbox')).toBeNull()
    })
    it('passes the flag when ticked, and not otherwise', async () => {
      vi.mocked(api.deleteServer).mockResolvedValue(undefined)
      renderTab({ createdFolder: true, job: failedInstall })
      await openDialog()
      await userEvent.click(screen.getByRole('checkbox', { name: 'Also delete C:\\Games\\mc' }))
      await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
      expect(api.deleteServer).toHaveBeenCalledWith('s1', true)
    })
    it('unticked sends no flag', async () => {
      vi.mocked(api.deleteServer).mockResolvedValue(undefined)
      renderTab({ createdFolder: true, job: failedInstall })
      await openDialog()
      await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
      expect(api.deleteServer).toHaveBeenCalledWith('s1', false)
    })
    it('resets the checkbox after cancel, and says the files are kept while unticked', async () => {
      renderTab({ createdFolder: true, job: failedInstall })
      await openDialog()
      expect(screen.getByText(/The game files in C:\\Games\\mc are not deleted/)).toBeInTheDocument()
      await userEvent.click(screen.getByRole('checkbox', { name: 'Also delete C:\\Games\\mc' }))
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      await openDialog()
      expect(screen.getByRole('checkbox', { name: 'Also delete C:\\Games\\mc' })).not.toBeChecked()
    })
    it('shows the server message when removal fails', async () => {
      vi.mocked(api.deleteServer).mockRejectedValue(new api.ApiError(409, 'Another server uses that folder'))
      renderTab({ createdFolder: true, job: failedInstall })
      await openDialog()
      await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
      expect(await screen.findByText('Another server uses that folder')).toBeInTheDocument()
    })
  })

  it('shows Accept EULA when the inspect notes carry the EULA note', async () => {
    vi.mocked(api.inspectFolder).mockResolvedValue({ ok: true, exe: 'java', launch: {}, notes: [MINECRAFT_EULA_NOTE] })
    renderTab({}, { id: 'minecraft', displayName: 'Minecraft', hasCommands: true, launchFields: [] })
    expect(await screen.findByRole('button', { name: 'Accept EULA' })).toBeInTheDocument()
  })
})
