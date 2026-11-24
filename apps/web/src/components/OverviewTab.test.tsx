import { render, screen, waitFor } from '@testing-library/react'
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

const renderTab = (over = {}, onRestart = vi.fn(), g: GameInfo = game) =>
  render(
    <MemoryRouter>
      <OverviewTab server={makeServer({ game: g.id, launch, ...over })} game={g} onRestart={onRestart} />
    </MemoryRouter>,
  )

describe('OverviewTab', () => {
  it('sends only declared launch keys, and an untouched password as ****', async () => {
    renderTab()
    await userEvent.type(screen.getByRole('textbox', { name: 'Server name' }), '2')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.patchServer).toHaveBeenCalled())
    expect(api.patchServer).toHaveBeenCalledWith('s1', { launch: { name: 'Home2', password: '****' } })
  })

  it('after saving a new password the form is clean and does not keep the plaintext', async () => {
    renderTab()
    const pw = screen.getByLabelText('Password')
    expect(pw).toHaveValue('')
    await userEvent.type(pw, 'secret')
    expect(pw).toHaveValue('secret')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByLabelText('Password')).toHaveValue(''))
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(api.patchServer).toHaveBeenCalledWith('s1', { launch: { name: 'Home', password: 'secret' } })
  })

  it('on a running server offers Restart now and calls the restart path', async () => {
    const onRestart = vi.fn()
    renderTab({ status: 'running' }, onRestart)
    await userEvent.type(screen.getByRole('textbox', { name: 'Server name' }), '2')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Takes effect on next start. Restart now?')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Restart' }))
    expect(onRestart).toHaveBeenCalledTimes(1)
  })

  it('shows Accept EULA when the inspect notes carry the EULA note', async () => {
    vi.mocked(api.inspectFolder).mockResolvedValue({ ok: true, exe: 'java', launch: {}, notes: [MINECRAFT_EULA_NOTE] })
    renderTab({}, vi.fn(), { id: 'minecraft', displayName: 'Minecraft', hasCommands: true, launchFields: [] })
    expect(await screen.findByRole('button', { name: 'Accept EULA' })).toBeInTheDocument()
  })
})
