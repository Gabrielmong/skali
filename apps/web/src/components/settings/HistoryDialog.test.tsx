import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../../api.ts'
import { fileView } from './fixtures.ts'
import { HistoryDialog } from './HistoryDialog.tsx'

vi.mock('../../api.ts', async (orig) => ({
  ...(await orig<typeof import('../../api.ts')>()),
  configHistory: vi.fn(),
  configHistoryRaw: vi.fn(),
  restoreConfig: vi.fn(),
}))

vi.mock('./codemirror.ts', () => ({
  createEditor: (parent: HTMLElement, opts: { doc: string; readOnly: boolean }) => {
    const ta = document.createElement('textarea')
    ta.readOnly = opts.readOnly
    ta.value = opts.doc
    parent.appendChild(ta)
    return { setDoc: (t: string) => (ta.value = t), setReadOnly: (r: boolean) => (ta.readOnly = r), destroy: () => ta.remove() }
  },
}))

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.configHistory).mockResolvedValue([
    { id: 'old', savedAt: '2026-11-20T10:00:00.000Z', sizeBytes: 100 },
    { id: 'new', savedAt: '2026-11-22T10:00:00.000Z', sizeBytes: 2048 },
  ])
  vi.mocked(api.configHistoryRaw).mockImplementation(async (_s, _f, id) => ({ raw: `raw of ${id}` }))
})

const renderDialog = (onRestored = vi.fn()) =>
  render(<HistoryDialog open serverId="s1" sourceId="server" format="properties" etag="e1" onClose={() => {}} onRestored={onRestored} />)

describe('HistoryDialog', () => {
  it('shows entries newest first; Restore confirms then calls restoreConfig', async () => {
    const result = { file: fileView({ etag: 'e2' }), restartPending: true }
    vi.mocked(api.restoreConfig).mockResolvedValue(result)
    const onRestored = vi.fn()
    renderDialog(onRestored)
    const items = await screen.findAllByRole('button', { name: /B$/ })
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('2.0 KB')
    expect(items[1]).toHaveTextContent('100 B')

    await userEvent.click(items[0]!)
    const box = await screen.findByDisplayValue('raw of new')
    expect(box).toHaveAttribute('readonly')
    expect(screen.getByRole('region', { name: 'Saved version' })).toContainElement(box)
    expect(api.configHistoryRaw).toHaveBeenCalledWith('s1', 'server', 'new')

    await userEvent.click(screen.getByRole('button', { name: 'Restore' }))
    expect(api.restoreConfig).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Restore this version' }))
    await waitFor(() => expect(api.restoreConfig).toHaveBeenCalledWith('s1', 'server', 'new', 'e1'))
    expect(onRestored).toHaveBeenCalledWith(result)
  })

  it('shows the message when restore fails', async () => {
    vi.mocked(api.restoreConfig).mockRejectedValue(new api.ApiError(409, 'The file changed on disk'))
    renderDialog()
    await userEvent.click((await screen.findAllByRole('button', { name: /B$/ }))[0]!)
    await userEvent.click(await screen.findByRole('button', { name: 'Restore' }))
    await userEvent.click(screen.getByRole('button', { name: 'Restore this version' }))
    expect(await screen.findByText('The file changed on disk')).toBeInTheDocument()
  })
})
