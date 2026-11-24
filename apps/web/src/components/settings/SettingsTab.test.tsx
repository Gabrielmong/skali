import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { type GameInfo } from '@skali/shared'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import * as api from '../../api.ts'
import { makeServer } from '../../test/fixtures.ts'
import { fileView, SOURCES } from './fixtures.ts'
import { SettingsTab } from './SettingsTab.tsx'

vi.mock('../../api.ts', async (orig) => ({
  ...(await orig<typeof import('../../api.ts')>()),
  patchServer: vi.fn(),
  listConfigSources: vi.fn(),
  readConfig: vi.fn(),
  saveConfig: vi.fn(),
  removeConfigSource: vi.fn(),
  configHistory: vi.fn(),
}))

vi.mock('./codemirror.ts', () => ({
  createEditor: (parent: HTMLElement, opts: { doc: string }) => {
    const ta = document.createElement('textarea')
    ta.value = opts.doc
    parent.appendChild(ta)
    return { setDoc: (x: string) => (ta.value = x), setReadOnly: (r: boolean) => (ta.readOnly = r), destroy: () => ta.remove() }
  },
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

function mockWide(wide: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: wide,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
}

beforeEach(() => {
  vi.resetAllMocks()
  mockWide(true)
  vi.mocked(api.listConfigSources).mockResolvedValue(SOURCES)
  vi.mocked(api.readConfig).mockResolvedValue(fileView())
  vi.mocked(api.configHistory).mockResolvedValue([])
  vi.mocked(api.patchServer).mockImplementation(async (_id, p) =>
    makeServer({ launch: { ...launch, ...p.launch, password: '****' } }),
  )
})
afterEach(() => {
  // @ts-expect-error restore the jsdom default (no matchMedia)
  delete window.matchMedia
  vi.restoreAllMocks()
})

const renderTab = (over = {}, onRestart = vi.fn(), onDirtyChange = vi.fn()) =>
  render(
    <SettingsTab
      server={makeServer({ game: 'valheim', launch, ...over })}
      game={game}
      onRestart={onRestart}
      onDirtyChange={onDirtyChange}
    />,
  )

const openServerConfig = async () => {
  await userEvent.click(await screen.findByRole('button', { name: 'Server config' }))
  await screen.findByRole('switch', { name: 'PvP' })
}

describe('SettingsTab: source list', () => {
  it('lists Launch settings first, then built-ins, then user files', async () => {
    renderTab()
    const list = await screen.findByRole('list', { name: 'Config files' })
    const labels = await waitFor(() => {
      const items = within(list).getAllByRole('listitem')
      expect(items).toHaveLength(3)
      return items.map((i) => i.textContent)
    })
    expect(labels).toEqual(['Launch settings', 'Server config', 'My file'])
    expect(screen.getByRole('button', { name: 'Remove My file' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove Server config' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Add file' })).toBeInTheDocument()
  })

  it('on a narrow screen the list is a select', async () => {
    mockWide(false)
    renderTab()
    await userEvent.click(await screen.findByRole('combobox', { name: 'File' }))
    expect(await screen.findByRole('option', { name: 'Server config' })).toBeInTheDocument()
  })

  it('removing a user source asks first, then calls removeConfigSource', async () => {
    vi.mocked(api.removeConfigSource).mockResolvedValue(undefined)
    renderTab()
    await userEvent.click(await screen.findByRole('button', { name: 'Remove My file' }))
    expect(api.removeConfigSource).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(api.removeConfigSource).toHaveBeenCalledWith('s1', 'u1'))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove My file' })).toBeNull())
  })
})

describe('SettingsTab: launch settings', () => {
  it('sends only declared launch keys, and an untouched password as ****', async () => {
    renderTab()
    await userEvent.type(await screen.findByRole('textbox', { name: 'Server name' }), '2')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.patchServer).toHaveBeenCalled())
    expect(api.patchServer).toHaveBeenCalledWith('s1', { launch: { name: 'Home2', password: '****' } })
  })

  it('after saving a new password the form is clean and does not keep the plaintext', async () => {
    renderTab()
    const pw = await screen.findByLabelText('Password')
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
    await userEvent.type(await screen.findByRole('textbox', { name: 'Server name' }), '2')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Takes effect on next start. Restart now?')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Restart' }))
    expect(onRestart).toHaveBeenCalledTimes(1)
  })
})

describe('SettingsTab: file editing', () => {
  it('editing two fields shows "2 changes"; Reset clears; Save calls saveConfig with {etag, changes} of exactly those ids', async () => {
    vi.mocked(api.saveConfig).mockResolvedValue({ file: fileView({ etag: 'e2' }), restartPending: false })
    const onDirtyChange = vi.fn()
    renderTab({}, vi.fn(), onDirtyChange)
    await openServerConfig()
    expect(screen.queryByText(/changes?$/)).toBeNull()

    const motd = screen.getByRole('textbox', { name: 'Message of the day' })
    await userEvent.type(motd, '!')
    expect(await screen.findByText('1 change')).toBeInTheDocument()
    const port = screen.getByRole('spinbutton', { name: 'Port' })
    await userEvent.clear(port)
    await userEvent.type(port, '25570')
    expect(screen.getByText('2 changes')).toBeInTheDocument()
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)

    await userEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(screen.queryByText('2 changes')).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Message of the day' })).toHaveValue('Welcome')
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)

    await userEvent.type(screen.getByRole('textbox', { name: 'Message of the day' }), '!')
    await userEvent.click(screen.getByRole('switch', { name: 'PvP' }))
    const port2 = screen.getByRole('spinbutton', { name: 'Port' })
    await userEvent.clear(port2)
    await userEvent.type(port2, '25570')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.saveConfig).toHaveBeenCalled())
    expect(api.saveConfig).toHaveBeenCalledWith('s1', 'server', {
      etag: 'e1',
      changes: { motd: 'Welcome!', pvp: false, port: 25570 },
    })
    await waitFor(() => expect(screen.queryByText('3 changes')).toBeNull())
  })

  it('typing a field back to its loaded value is not a change', async () => {
    renderTab()
    await openServerConfig()
    const motd = screen.getByRole('textbox', { name: 'Message of the day' })
    await userEvent.type(motd, '!')
    await userEvent.type(motd, '{Backspace}')
    expect(screen.queryByText('1 change')).toBeNull()
  })

  it('an empty number field blocks Save', async () => {
    renderTab()
    await openServerConfig()
    await userEvent.clear(screen.getByRole('spinbutton', { name: 'Port' }))
    expect(screen.getByText('1 change')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('a "server is starting" 409 shows its message with no Reload', async () => {
    vi.mocked(api.saveConfig).mockRejectedValue(new api.ApiError(409, 'Server is starting or stopping; save again in a moment'))
    renderTab()
    await openServerConfig()
    await userEvent.type(screen.getByRole('textbox', { name: 'Message of the day' }), '!')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Server is starting or stopping; save again in a moment')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull()
  })

  it('409 on save shows the message and Reload re-reads', async () => {
    vi.mocked(api.saveConfig).mockRejectedValue(new api.ApiError(409, 'The file changed on disk since you opened it'))
    renderTab()
    await openServerConfig()
    await userEvent.type(screen.getByRole('textbox', { name: 'Message of the day' }), '!')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('The file changed on disk since you opened it')).toBeInTheDocument()
    expect(api.readConfig).toHaveBeenCalledTimes(1)
    vi.mocked(api.readConfig).mockResolvedValue(fileView({ etag: 'e9' }))
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }))
    await waitFor(() => expect(api.readConfig).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByText('1 change')).toBeNull())
    expect(screen.queryByText('The file changed on disk since you opened it')).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Message of the day' })).toHaveValue('Welcome')
  })

  it('after save with restartPending on a running server, the snackbar offers Restart now', async () => {
    vi.mocked(api.saveConfig).mockResolvedValue({ file: fileView({ etag: 'e2' }), restartPending: true })
    const onRestart = vi.fn()
    renderTab({ status: 'running' }, onRestart)
    await openServerConfig()
    await userEvent.type(screen.getByRole('textbox', { name: 'Message of the day' }), '!')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Saved. Restart now to apply?')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Restart now' }))
    expect(onRestart).toHaveBeenCalledTimes(1)
  })

  it('a stopped server just says Saved', async () => {
    vi.mocked(api.saveConfig).mockResolvedValue({ file: fileView({ etag: 'e2' }), restartPending: false })
    renderTab()
    await openServerConfig()
    await userEvent.type(screen.getByRole('textbox', { name: 'Message of the day' }), '!')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Saved')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Restart now' })).toBeNull()
  })

  it('shows the parse error instead of the form when fields is null', async () => {
    vi.mocked(api.readConfig).mockResolvedValue(fileView({ fields: null, parseError: 'Line 3 is not valid JSON' }))
    renderTab()
    await userEvent.click(await screen.findByRole('button', { name: 'Server config' }))
    expect(await screen.findByText('Line 3 is not valid JSON')).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'PvP' })).toBeNull()
  })

  it('tells the user a missing file will be created, and where defaults came from', async () => {
    vi.mocked(api.readConfig).mockResolvedValue(fileView({ missing: true, seededFrom: 'defaults.ini' }))
    renderTab()
    await openServerConfig()
    expect(screen.getByText("This file doesn't exist yet. Saving creates it.", { exact: false })).toBeInTheDocument()
    expect(screen.getByText('Values shown are the defaults from defaults.ini.', { exact: false })).toBeInTheDocument()
  })
})

describe('SettingsTab: fix round 1', () => {
  const rateFile = (etag = 'e1') =>
    fileView({
      etag,
      fields: [{ id: 'rate', key: 'rate', value: '1.000000', type: 'number', label: 'Rate' }],
    })

  it('a number field loaded as the string "1.000000": retyping 1 is no change, 1.5 is and is sent as 1.5', async () => {
    vi.mocked(api.readConfig).mockResolvedValue(rateFile())
    vi.mocked(api.saveConfig).mockResolvedValue({ file: rateFile('e2'), restartPending: false })
    renderTab()
    await userEvent.click(await screen.findByRole('button', { name: 'Server config' }))
    const rate = await screen.findByRole('spinbutton', { name: 'Rate' })
    await userEvent.clear(rate)
    await userEvent.type(rate, '1')
    expect(screen.queryByText('1 change')).toBeNull()
    await userEvent.clear(rate)
    await userEvent.type(rate, '1.5')
    expect(screen.getByText('1 change')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.saveConfig).toHaveBeenCalledWith('s1', 'server', { etag: 'e1', changes: { rate: 1.5 } }))
  })

  it('a second save sends the etag returned by the first', async () => {
    vi.mocked(api.saveConfig).mockResolvedValue({ file: fileView({ etag: 'e2' }), restartPending: false })
    renderTab()
    await openServerConfig()
    await userEvent.type(screen.getByRole('textbox', { name: 'Message of the day' }), '!')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByText('1 change')).toBeNull())
    vi.mocked(api.saveConfig).mockResolvedValue({ file: fileView({ etag: 'e3' }), restartPending: false })
    await userEvent.type(screen.getByRole('textbox', { name: 'Message of the day' }), '?')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.saveConfig).toHaveBeenCalledTimes(2))
    expect(vi.mocked(api.saveConfig).mock.calls[1]![2]).toMatchObject({ etag: 'e2' })
  })

  it('restartPending on a stopped server shows no restart snackbar', async () => {
    vi.mocked(api.saveConfig).mockResolvedValue({ file: fileView({ etag: 'e2' }), restartPending: true })
    renderTab({ status: 'stopped' })
    await openServerConfig()
    await userEvent.type(screen.getByRole('textbox', { name: 'Message of the day' }), '!')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Saved')).toBeInTheDocument()
    expect(screen.queryByText('Saved. Restart now to apply?')).toBeNull()
  })

  it('the restart snackbar survives switching source after a save', async () => {
    vi.mocked(api.saveConfig).mockResolvedValue({ file: fileView({ etag: 'e2' }), restartPending: true })
    const onRestart = vi.fn()
    renderTab({ status: 'running' }, onRestart)
    await openServerConfig()
    await userEvent.type(screen.getByRole('textbox', { name: 'Message of the day' }), '!')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Saved. Restart now to apply?')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Launch settings' }))
    expect(await screen.findByRole('textbox', { name: 'Server name' })).toBeInTheDocument()
    expect(screen.getByText('Saved. Restart now to apply?')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Restart now' }))
    expect(onRestart).toHaveBeenCalledTimes(1)
  })

  it('an older read resolving after a newer one is ignored', async () => {
    vi.mocked(api.saveConfig).mockRejectedValue(new api.ApiError(409, 'The file changed on disk'))
    renderTab()
    await openServerConfig()
    const edit = () => userEvent.type(screen.getByRole('textbox', { name: 'Message of the day' }), '!')
    await edit()
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    let resolveOld!: (v: ReturnType<typeof fileView>) => void
    vi.mocked(api.readConfig).mockImplementationOnce(() => new Promise((r) => (resolveOld = r)))
    await userEvent.click(await screen.findByRole('button', { name: 'Reload' }))
    // the edits are still there, so save again and reload again; this read is the newer one
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    vi.mocked(api.readConfig).mockResolvedValueOnce(
      fileView({ etag: 'e3', fields: fileView().fields!.map((f) => (f.id === 'motd' ? { ...f, value: 'Newer' } : f)) }),
    )
    await userEvent.click(await screen.findByRole('button', { name: 'Reload' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message of the day' })).toHaveValue('Newer'))
    resolveOld(
      fileView({ etag: 'e2', fields: fileView().fields!.map((f) => (f.id === 'motd' ? { ...f, value: 'Older' } : f)) }),
    )
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.getByRole('textbox', { name: 'Message of the day' })).toHaveValue('Newer')
  })

  it('a save error does not come back after the changes were undone', async () => {
    vi.mocked(api.saveConfig).mockRejectedValue(new api.ApiError(409, 'The file changed on disk'))
    renderTab()
    await openServerConfig()
    const motd = screen.getByRole('textbox', { name: 'Message of the day' })
    await userEvent.type(motd, '!')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('The file changed on disk')).toBeInTheDocument()
    await userEvent.type(motd, '{Backspace}')
    expect(screen.queryByText('The file changed on disk')).toBeNull()
    await userEvent.type(motd, '?')
    expect(screen.getByText('1 change')).toBeInTheDocument()
    expect(screen.queryByText('The file changed on disk')).toBeNull()
  })
})

describe('SettingsTab: discard guard', () => {
  it('switching source with unsaved changes asks to discard', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    renderTab()
    await openServerConfig()
    await userEvent.type(screen.getByRole('textbox', { name: 'Message of the day' }), '!')
    await userEvent.click(screen.getByRole('button', { name: 'Launch settings' }))
    expect(confirm).toHaveBeenCalledWith('Discard unsaved changes?')
    expect(screen.getByRole('textbox', { name: 'Message of the day' })).toHaveValue('Welcome!')

    confirm.mockReturnValue(true)
    await userEvent.click(screen.getByRole('button', { name: 'Launch settings' }))
    expect(await screen.findByRole('textbox', { name: 'Server name' })).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Message of the day' })).toBeNull()
  })

  it('switching source without changes does not ask', async () => {
    const confirm = vi.spyOn(window, 'confirm')
    renderTab()
    await openServerConfig()
    await userEvent.click(screen.getByRole('button', { name: 'Launch settings' }))
    expect(confirm).not.toHaveBeenCalled()
  })

  it('while dirty, beforeunload is blocked', async () => {
    renderTab()
    await openServerConfig()
    const clean = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(clean)
    expect(clean.defaultPrevented).toBe(false)
    await userEvent.type(screen.getByRole('textbox', { name: 'Message of the day' }), '!')
    const dirty = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(dirty)
    expect(dirty.defaultPrevented).toBe(true)
  })
})
