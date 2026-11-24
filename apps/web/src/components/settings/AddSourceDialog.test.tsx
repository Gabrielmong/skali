import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../../api.ts'
import { AddSourceDialog, relativeInside } from './AddSourceDialog.tsx'

vi.mock('../../api.ts', async (orig) => ({
  ...(await orig<typeof import('../../api.ts')>()),
  browseFs: vi.fn(),
  addConfigSource: vi.fn(),
}))

const FOLDER = 'C:\\Games\\mc'

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.browseFs).mockImplementation(async (p) => {
    if (p?.endsWith('config')) return { path: p, parent: 'c:\\games\\MC', dirs: [], files: ['a.yml', 'b.txt'], truncated: false }
    return { path: 'c:\\games\\MC', parent: null, dirs: ['config'], files: [], truncated: false }
  })
})

const renderDialog = (onAdded = vi.fn()) =>
  render(<AddSourceDialog open serverId="s1" folder={FOLDER} onClose={() => {}} onAdded={onAdded} />)

describe('AddSourceDialog', () => {
  it('picks a file, computes the relative path, presets format from the extension', async () => {
    const added = { id: 'u9', kind: 'file' as const, label: 'a.yml', path: 'config\\a.yml', format: 'yaml' as const, builtin: false }
    vi.mocked(api.addConfigSource).mockResolvedValue(added)
    const onAdded = vi.fn()
    renderDialog(onAdded)
    await userEvent.click(await screen.findByRole('button', { name: 'config' }))
    expect(api.browseFs).toHaveBeenCalledWith(FOLDER)
    await userEvent.click(await screen.findByRole('button', { name: 'a.yml' }))
    expect(screen.getByRole('textbox', { name: 'Path in the server folder' })).toHaveValue('config\\a.yml')
    expect(screen.getByRole('combobox', { name: 'Format' })).toHaveTextContent('YAML')
    expect(screen.getByRole('textbox', { name: 'Label' })).toHaveValue('a.yml')
    await userEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() =>
      expect(api.addConfigSource).toHaveBeenCalledWith('s1', { path: 'config\\a.yml', format: 'yaml', label: 'a.yml' }),
    )
    expect(onAdded).toHaveBeenCalledWith(added)
  })

  it('a file outside the server folder cannot be added', async () => {
    vi.mocked(api.browseFs).mockResolvedValue({ path: 'D:\\other', parent: null, dirs: [], files: ['x.ini'], truncated: false })
    renderDialog()
    await userEvent.click(await screen.findByRole('button', { name: 'x.ini' }))
    expect(screen.getByText('Pick a file inside the server folder')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()
  })

  it('shows the server error', async () => {
    vi.mocked(api.addConfigSource).mockRejectedValue(new api.ApiError(409, 'That file is already in the list'))
    renderDialog()
    await userEvent.click(await screen.findByRole('button', { name: 'config' }))
    await userEvent.click(await screen.findByRole('button', { name: 'a.yml' }))
    await userEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(await screen.findByText('That file is already in the list')).toBeInTheDocument()
  })
})

describe('relativeInside', () => {
  it('compares case-insensitively and tolerates slash style and a trailing slash', () => {
    expect(relativeInside('C:\\Games\\mc\\', 'c:/games/MC/config/A.yml')).toBe('config\\A.yml')
    expect(relativeInside('C:\\Games\\mc', 'C:\\Games\\mc2\\a.yml')).toBeNull()
    expect(relativeInside('C:\\Games\\mc', 'C:\\Games\\mc')).toBeNull()
    expect(relativeInside('C:\\Games\\mc', 'D:\\x.ini')).toBeNull()
  })
})
