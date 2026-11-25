import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { JobView } from '@skali/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api.ts'
import { makeServer } from '../test/fixtures.ts'
import { JobPanel } from './JobPanel.tsx'

vi.mock('../api.ts', async (orig) => ({
  ...(await orig<typeof import('../api.ts')>()),
  retryInstall: vi.fn(),
}))

const job = (over: Partial<JobView> = {}): JobView => ({
  kind: 'install',
  state: 'running',
  progress: null,
  runId: 'r1',
  steps: [
    { id: 'a', label: 'Download SteamCMD', state: 'done' },
    { id: 'b', label: 'Install game files', state: 'running' },
    { id: 'c', label: 'Open firewall ports', state: 'pending' },
  ],
  ...over,
})
const renderPanel = (j: JobView) => render(<JobPanel server={makeServer({ job: j })} />)

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.retryInstall).mockResolvedValue(makeServer())
})

describe('JobPanel', () => {
  it('lists the steps and shows a progress bar only when progress is known', () => {
    const { unmount } = renderPanel(job())
    expect(screen.getByText('Download SteamCMD')).toBeInTheDocument()
    expect(screen.getByText('Install game files')).toBeInTheDocument()
    expect(screen.getByText('Open firewall ports')).toBeInTheDocument()
    expect(screen.queryByRole('progressbar', { name: 'Progress' })).toBeNull()
    unmount()
    renderPanel(job({ progress: 45.12 }))
    expect(screen.getByRole('progressbar', { name: 'Progress' })).toHaveAttribute('aria-valuenow', '45')
  })

  it('treats progress as 0-100 and clamps it', () => {
    const { unmount } = renderPanel(job({ progress: 140 }))
    expect(screen.getByRole('progressbar', { name: 'Progress' })).toHaveAttribute('aria-valuenow', '100')
    unmount()
    renderPanel(job({ progress: -5 }))
    expect(screen.getByRole('progressbar', { name: 'Progress' })).toHaveAttribute('aria-valuenow', '0')
  })

  it('shows the error and Retry for a failed install, and Retry calls the api', async () => {
    renderPanel(job({ state: 'failed', error: 'Disk full' }))
    expect(screen.getByText('Disk full')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(api.retryInstall).toHaveBeenCalledWith('s1')
  })

  it('shows a retry failure from the server', async () => {
    vi.mocked(api.retryInstall).mockRejectedValue(new api.ApiError(409, 'Already running'))
    renderPanel(job({ state: 'failed', error: 'x' }))
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Already running')).toBeInTheDocument()
  })

  it('has no Retry while running or for a failed update', () => {
    const { unmount } = renderPanel(job())
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    unmount()
    renderPanel(job({ kind: 'update', state: 'failed', error: 'Nope' }))
    expect(screen.getByText('Nope')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })
})
