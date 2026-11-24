import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api.ts'
import { FolderPicker } from './FolderPicker.tsx'

vi.mock('../api.ts', async (orig) => ({ ...(await orig<typeof import('../api.ts')>()), browseFs: vi.fn() }))

beforeEach(() => vi.resetAllMocks())

describe('FolderPicker', () => {
  it('retrying a folder that just failed asks the server again', async () => {
    let fail = true
    vi.mocked(api.browseFs).mockImplementation(async (p) => {
      if (p === undefined) return { path: null, parent: null, dirs: ['C:\\'], files: [], truncated: false }
      if (fail) throw new api.ApiError(400, 'Cannot read this folder')
      return { path: p, parent: null, dirs: ['sub'], files: [], truncated: false }
    })
    render(<FolderPicker onSelect={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: 'C:\\' }))
    expect(await screen.findByText('Cannot read this folder')).toBeInTheDocument()
    fail = false
    await userEvent.click(screen.getByRole('button', { name: 'C:\\' }))
    expect(await screen.findByRole('button', { name: 'sub' })).toBeInTheDocument()
    expect(screen.queryByText('Cannot read this folder')).toBeNull()
  })
})
