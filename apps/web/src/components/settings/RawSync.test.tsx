import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../../api.ts'
import { FileEditor } from './FileEditor.tsx'
import { fileView, FIELDS, SOURCES } from './fixtures.ts'

vi.mock('../../api.ts', async (orig) => ({
  ...(await orig<typeof import('../../api.ts')>()),
  readConfig: vi.fn(),
  previewConfig: vi.fn(),
  saveConfig: vi.fn(),
  configHistory: vi.fn(),
}))

// A textarea-backed stand-in for the lazy CodeMirror module; like CodeMirror it normalises line breaks to \n.
vi.mock('./codemirror.ts', () => ({
  createEditor: (parent: HTMLElement, opts: { doc: string; readOnly: boolean; onChange: (t: string) => void }) => {
    const ta = document.createElement('textarea')
    ta.setAttribute('aria-label', 'Raw text')
    ta.readOnly = opts.readOnly
    ta.value = opts.doc.replace(/\r\n/g, '\n')
    ta.addEventListener('input', () => opts.onChange(ta.value))
    parent.appendChild(ta)
    return {
      setDoc: (t: string) => {
        ta.value = t.replace(/\r\n/g, '\n')
      },
      setReadOnly: (r: boolean) => {
        ta.readOnly = r
      },
      destroy: () => ta.remove(),
    }
  },
}))

const source = SOURCES[1]!
const onSaved = vi.fn()
const onDirtyChange = vi.fn()

const renderEditor = () =>
  render(<FileEditor serverId="s1" source={source} running={false} onSaved={onSaved} onDirtyChange={onDirtyChange} />)

const rawBox = async () => (await screen.findByRole('textbox', { name: 'Raw text' })) as HTMLTextAreaElement
const type = (el: HTMLTextAreaElement, text: string) => fireEvent.input(el, { target: { value: text } })
const toRaw = () => userEvent.click(screen.getByRole('button', { name: 'Raw' }))
const toForm = () => userEvent.click(screen.getByRole('button', { name: 'Form' }))

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.readConfig).mockResolvedValue(fileView())
  vi.mocked(api.configHistory).mockResolvedValue([])
})

const pvpOff = () => ({ ...FIELDS[0]!, value: false })

describe('RawSync', () => {
  it("form edits then Raw shows previewConfig's text", async () => {
    vi.mocked(api.previewConfig).mockResolvedValue(fileView({ raw: 'pvp=false\n' }))
    renderEditor()
    await userEvent.click(await screen.findByRole('switch', { name: 'PvP' }))
    await toRaw()
    expect((await rawBox()).value).toBe('pvp=false\n')
    expect(api.previewConfig).toHaveBeenCalledWith('s1', 'server', { changes: { pvp: false } })
    expect(screen.getByText('Raw text edited')).toBeInTheDocument()
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
  })

  it('without form changes Raw shows file.raw directly and nothing is dirty', async () => {
    renderEditor()
    await screen.findByRole('switch', { name: 'PvP' })
    await toRaw()
    expect((await rawBox()).value).toBe('pvp=true\n')
    expect(api.previewConfig).not.toHaveBeenCalled()
    expect(screen.queryByText('Raw text edited')).toBeNull()
    await toForm()
    expect(await screen.findByRole('switch', { name: 'PvP' })).toBeInTheDocument()
    expect(api.previewConfig).not.toHaveBeenCalled()
    expect(onDirtyChange).not.toHaveBeenCalledWith(true)
  })

  it('a CRLF file is not dirty just from opening Raw, but is once the text really changes', async () => {
    vi.mocked(api.readConfig).mockResolvedValue(fileView({ raw: 'pvp=true\r\nport=1\r\n' }))
    renderEditor()
    await screen.findByRole('switch', { name: 'PvP' })
    await toRaw()
    const box = await rawBox()
    type(box, 'pvp=true\nport=1\n')
    expect(screen.queryByText('Raw text edited')).toBeNull()
    type(box, 'pvp=true\nport=2\n')
    expect(await screen.findByText('Raw text edited')).toBeInTheDocument()
  })

  it("raw edit then Form shows previewConfig's fields as changes", async () => {
    vi.mocked(api.previewConfig).mockImplementation(async (_s, _f, edit) =>
      'raw' in edit
        ? fileView({ raw: edit.raw, fields: FIELDS.map((f) => (f.id === 'pvp' ? pvpOff() : f)) })
        : fileView({ raw: 'pvp=false\n' }),
    )
    renderEditor()
    await screen.findByRole('switch', { name: 'PvP' })
    await toRaw()
    type(await rawBox(), 'pvp=false\n')
    await toForm()
    await waitFor(() => expect(screen.getByRole('switch', { name: 'PvP' })).not.toBeChecked())
    expect(api.previewConfig).toHaveBeenCalledWith('s1', 'server', { raw: 'pvp=false\n' })
    expect(api.previewConfig).toHaveBeenCalledWith('s1', 'server', { changes: { pvp: false } })
    expect(screen.getByText('1 change')).toBeInTheDocument()
  })

  it('a parse error keeps Raw and shows the error', async () => {
    vi.mocked(api.previewConfig).mockResolvedValue(fileView({ fields: null, parseError: 'Unexpected token at line 2' }))
    renderEditor()
    await screen.findByRole('switch', { name: 'PvP' })
    await toRaw()
    type(await rawBox(), 'pvp=bad')
    await toForm()
    expect(await screen.findByText('Unexpected token at line 2')).toBeInTheDocument()
    expect(await rawBox()).toBeInTheDocument()
  })

  it("raw edits the form can't express are shown read-only and still save as raw", async () => {
    vi.mocked(api.previewConfig).mockImplementation(async (_s, _f, edit) =>
      'raw' in edit ? fileView({ raw: edit.raw }) : fileView({ raw: 'pvp=true\n' }),
    )
    vi.mocked(api.saveConfig).mockResolvedValue({ file: fileView({ etag: 'e2' }), restartPending: false })
    renderEditor()
    await screen.findByRole('switch', { name: 'PvP' })
    await toRaw()
    type(await rawBox(), '# a comment\npvp=true\n')
    await toForm()
    expect(await screen.findByText(/include changes the form can't show/)).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'PvP' })).toBeDisabled()
    expect(screen.getByText('Raw text edited')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(api.saveConfig).toHaveBeenCalledWith('s1', 'server', { etag: 'e1', raw: '# a comment\npvp=true\n' }),
    )
  })

  it('fields:null disables Form and shows the raw-only note', async () => {
    vi.mocked(api.readConfig).mockResolvedValue(fileView({ fields: null, parseError: 'Bad JSON', raw: '{oops' }))
    renderEditor()
    expect((await rawBox()).value).toBe('{oops')
    expect(screen.getByRole('button', { name: 'Form' })).toBeDisabled()
    expect(screen.getByText(/Bad JSON/)).toBeInTheDocument()
    expect(screen.getByText(/This file can only be edited as raw text until it parses/)).toBeInTheDocument()
  })

  it('Save in raw sends {etag, raw}', async () => {
    vi.mocked(api.saveConfig).mockResolvedValue({ file: fileView({ etag: 'e2', raw: 'pvp=no\n' }), restartPending: true })
    renderEditor()
    await screen.findByRole('switch', { name: 'PvP' })
    await toRaw()
    type(await rawBox(), 'pvp=no\n')
    await userEvent.click(await screen.findByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.saveConfig).toHaveBeenCalledWith('s1', 'server', { etag: 'e1', raw: 'pvp=no\n' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByText('Raw text edited')).toBeNull())
  })

  it('a raw save that conflicts offers Reload', async () => {
    vi.mocked(api.saveConfig).mockRejectedValue(new api.ApiError(409, 'The file changed on disk'))
    renderEditor()
    await screen.findByRole('switch', { name: 'PvP' })
    await toRaw()
    type(await rawBox(), 'x\n')
    await userEvent.click(await screen.findByRole('button', { name: 'Save' }))
    expect(await screen.findByText('The file changed on disk')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
  })

  it('a save whose result no longer parses leaves the file raw-only', async () => {
    vi.mocked(api.saveConfig).mockResolvedValue({
      file: fileView({ etag: 'e2', raw: '{', fields: null, parseError: 'Bad JSON' }),
      restartPending: false,
    })
    renderEditor()
    await screen.findByRole('switch', { name: 'PvP' })
    await toRaw()
    type(await rawBox(), '{')
    await userEvent.click(await screen.findByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/Bad JSON/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Form' })).toBeDisabled()
  })

  it('typing during the raw-to-form preview keeps the new text and stays in Raw', async () => {
    let release: (v: ReturnType<typeof fileView>) => void = () => {}
    vi.mocked(api.previewConfig).mockImplementation(
      () => new Promise((res) => (release = res as typeof release)),
    )
    renderEditor()
    await screen.findByRole('switch', { name: 'PvP' })
    await toRaw()
    type(await rawBox(), 'A\n')
    await toForm()
    await waitFor(() => expect(api.previewConfig).toHaveBeenCalledWith('s1', 'server', { raw: 'A\n' }))
    type(await rawBox(), 'B\n')
    release(fileView({ raw: 'A\n', fields: FIELDS }))
    await new Promise((r) => setTimeout(r, 20))
    expect(api.previewConfig).toHaveBeenCalledTimes(1)
    expect((await rawBox()).value).toBe('B\n')
    expect(screen.getByText('Raw text edited')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.saveConfig).toHaveBeenCalledWith('s1', 'server', { etag: 'e1', raw: 'B\n' }))
  })

  it('a preview that resolves after Reload is ignored', async () => {
    let release: (v: ReturnType<typeof fileView>) => void = () => {}
    vi.mocked(api.previewConfig).mockImplementation(
      () => new Promise((res) => (release = res as typeof release)),
    )
    vi.mocked(api.saveConfig).mockRejectedValue(new api.ApiError(409, 'The file changed on disk'))
    renderEditor()
    await userEvent.click(await screen.findByRole('switch', { name: 'PvP' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    const reload = await screen.findByRole('button', { name: 'Reload' })
    await toRaw()
    await waitFor(() => expect(api.previewConfig).toHaveBeenCalled())
    vi.mocked(api.readConfig).mockResolvedValue(fileView({ etag: 'e9', raw: 'fresh=1\n' }))
    fireEvent.click(reload)
    await waitFor(() => expect(api.readConfig).toHaveBeenCalledTimes(2))
    release(fileView({ raw: 'pvp=false\n' }))
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByRole('textbox', { name: 'Raw text' })).toBeNull()
    expect(screen.getByRole('switch', { name: 'PvP' })).toBeChecked()
    expect(screen.queryByText('Raw text edited')).toBeNull()
  })

  it('leaving a locked form for Raw, undoing the edit, then Form unlocks the form', async () => {
    vi.mocked(api.previewConfig).mockImplementation(async (_s, _f, edit) =>
      'raw' in edit ? fileView({ raw: edit.raw }) : fileView({ raw: 'pvp=true\n' }),
    )
    renderEditor()
    await screen.findByRole('switch', { name: 'PvP' })
    await toRaw()
    type(await rawBox(), '# c\npvp=true\n')
    await toForm()
    await screen.findByText(/include changes the form can't show/)
    await toRaw()
    type(await rawBox(), 'pvp=true\n')
    await toForm()
    const sw = await screen.findByRole('switch', { name: 'PvP' })
    expect(sw).not.toBeDisabled()
    expect(screen.queryByText(/include changes the form can't show/)).toBeNull()
  })

  it('after a raw save of a raw-only file that now parses, it stays in Raw', async () => {
    vi.mocked(api.readConfig).mockResolvedValue(fileView({ fields: null, parseError: 'Bad', raw: '{' }))
    vi.mocked(api.saveConfig).mockResolvedValue({ file: fileView({ etag: 'e2', raw: '{}' }), restartPending: false })
    renderEditor()
    type(await rawBox(), '{}')
    await userEvent.click(await screen.findByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.saveConfig).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Form' })).toBeEnabled())
    expect(await rawBox()).toBeInTheDocument()
  })

  it('the raw editor is read-only while a save is in flight, so nothing typed is lost', async () => {
    let finish: (v: { file: ReturnType<typeof fileView>; restartPending: boolean }) => void = () => {}
    vi.mocked(api.saveConfig).mockImplementation(() => new Promise((res) => (finish = res)))
    renderEditor()
    await screen.findByRole('switch', { name: 'PvP' })
    await toRaw()
    type(await rawBox(), 'x\n')
    await userEvent.click(await screen.findByRole('button', { name: 'Save' }))
    await waitFor(() => expect(api.saveConfig).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Raw text' })).toHaveAttribute('readonly'))
    finish({ file: fileView({ etag: 'e2', raw: 'x\n' }), restartPending: false })
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Raw text' })).not.toHaveAttribute('readonly'))
    expect((await rawBox()).value).toBe('x\n')
  })
})
