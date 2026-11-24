import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { DeployEventView, DeployStatusView } from '@skali/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api.ts'
import { DeploysPage } from './DeploysPage.tsx'

vi.mock('../api.ts', async (orig) => ({
  ...(await orig<typeof import('../api.ts')>()),
  getDeployStatus: vi.fn(),
  getDeployLog: vi.fn(),
  deployNow: vi.fn(),
  restartSkali: vi.fn(),
  pauseDeploys: vi.fn(),
  resumeDeploys: vi.fn(),
  rollbackDeploy: vi.fn(),
}))

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const SHA_C = 'c'.repeat(40)

const ev = (o: Partial<DeployEventView> & { id: string }): DeployEventView => ({
  kind: 'DEPLOY',
  status: 'SUCCEEDED',
  by: 'auto',
  startedAt: '2026-11-24T10:00:00Z',
  canRollback: false,
  ...o,
})

const status = (events: DeployEventView[], o: Partial<DeployStatusView> = {}): DeployStatusView => ({
  running: { sha: SHA_A, message: 'Current release', deployedAt: '2026-11-24T10:00:00Z' },
  autoDeploy: { on: true },
  lastCheck: { at: '2026-11-24T10:05:00Z' },
  helperUpdateAvailable: false,
  events,
  ...o,
})

const fast = { statusMs: 60_000, logMs: 20 }

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.getDeployLog).mockResolvedValue({ log: '' })
})

describe('DeploysPage', () => {
  it('renders the status and events, with failure details in brackets', async () => {
    vi.mocked(api.getDeployStatus).mockResolvedValue(
      status(
        [
          ev({ id: 'e1', sha: SHA_A, message: 'Fix things', ciRunUrl: 'https://github.com/x/actions/runs/1' }),
          ev({ id: 'e2', sha: SHA_B, status: 'FAILED', detail: 'rolled back automatically' }),
          ev({ id: 'e3', sha: SHA_C, status: 'SKIPPED', detail: 'tests failed' }),
        ],
        { helperUpdateAvailable: true, autoDeploy: { on: false, reason: 'tests failed on bbbbbbb' } },
      ),
    )
    render(<DeploysPage {...fast} />)
    expect(await screen.findByText('Running aaaaaaa')).toBeInTheDocument()
    expect(screen.getByText(/Auto-deploy paused \(tests failed on bbbbbbb\)/)).toBeInTheDocument()
    expect(screen.getByText('failed (rolled back automatically)')).toBeInTheDocument()
    expect(screen.getByText('skipped (tests failed)')).toBeInTheDocument()
    expect(screen.getByText('Helper update available')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'CI run' })).toHaveAttribute('href', 'https://github.com/x/actions/runs/1')
    expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument()
  })

  it('confirms a rollback naming the release, then sends it', async () => {
    vi.mocked(api.getDeployStatus).mockResolvedValue(
      status([ev({ id: 'e1', sha: SHA_A }), ev({ id: 'e2', sha: SHA_B, message: 'Older one', canRollback: true })]),
    )
    vi.mocked(api.rollbackDeploy).mockResolvedValue({})
    render(<DeploysPage {...fast} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Roll back' }))
    expect(await screen.findByText(/Roll back to bbbbbbb \(Older one\)/)).toBeInTheDocument()
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveTextContent('Skáli restarts on bbbbbbb; game servers keep running.')
    expect(dialog).toHaveTextContent('Auto-deploy is paused afterwards if the rollback succeeds.')
    expect(dialog).not.toHaveTextContent(/stopped/)
    await userEvent.click(screen.getByRole('button', { name: 'Confirm roll back' }))
    await waitFor(() => expect(api.rollbackDeploy).toHaveBeenCalledWith(SHA_B))
  })

  it('shows why a blocked release cannot be rolled back', async () => {
    vi.mocked(api.getDeployStatus).mockResolvedValue(
      status([
        ev({
          id: 'e2',
          sha: SHA_B,
          rollbackBlockedReason: "Can't roll back past a database change; push a fix instead.",
        }),
      ]),
    )
    render(<DeploysPage {...fast} />)
    expect(await screen.findByText(/past a database change/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Roll back' })).toBeDisabled()
  })

  it('shows the not-installed message on helper-not-running', async () => {
    vi.mocked(api.getDeployStatus).mockRejectedValue(new api.ApiError(503, 'helper-not-running'))
    render(<DeploysPage {...fast} />)
    const link = await screen.findByRole('link', { name: 'RUNNING.md → Auto-deploy' })
    expect(link).toHaveAttribute('href', 'https://github.com/Gabrielmong/skali/blob/main/docs/RUNNING.md#auto-deploy')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noreferrer')
  })

  it('shows when the running release was deployed, in local time', async () => {
    vi.mocked(api.getDeployStatus).mockResolvedValue(status([ev({ id: 'e1', sha: SHA_A })]))
    render(<DeploysPage {...fast} />)
    expect(await screen.findByText(`Deployed ${new Date('2026-11-24T10:00:00Z').toLocaleString()}`)).toBeInTheDocument()
  })

  it('keeps the rollback button out of the selectable event row', async () => {
    vi.mocked(api.getDeployStatus).mockResolvedValue(
      status([ev({ id: 'e1', sha: SHA_A }), ev({ id: 'e2', sha: SHA_B, canRollback: true, ciRunUrl: 'https://x/run/2' })]),
    )
    render(<DeploysPage {...fast} />)
    const rollback = await screen.findByRole('button', { name: 'Roll back' })
    // No interactive element nests another (the rows are role=button).
    for (const el of [rollback, screen.getByRole('link', { name: 'CI run' })]) {
      expect(el.parentElement?.closest('[role="button"], button, a')).toBeNull()
    }
  })

  it('appends log lines from successive from= polls of a running event', async () => {
    vi.mocked(api.getDeployStatus).mockResolvedValue(status([ev({ id: 'e1', sha: SHA_A, status: 'RUNNING' })]))
    vi.mocked(api.getDeployLog)
      .mockResolvedValueOnce({ log: 'line one\n', next: 9 })
      .mockResolvedValueOnce({ log: 'line two\n', next: 18 })
      .mockResolvedValue({ log: '', next: 18 })
    render(<DeploysPage {...fast} />)
    await waitFor(() => expect(screen.getByLabelText('Deploy log').textContent).toBe('line one\nline two\n'))
    expect(api.getDeployLog).toHaveBeenNthCalledWith(1, 'e1', 0)
    expect(api.getDeployLog).toHaveBeenNthCalledWith(2, 'e1', 9)
  })

  it('shows "restarting" on a fetch failure and recovers silently', async () => {
    vi.mocked(api.getDeployStatus)
      .mockResolvedValueOnce(status([ev({ id: 'e1', sha: SHA_A })]))
      .mockRejectedValueOnce(new api.ApiError(0, 'Cannot reach Skáli'))
      .mockResolvedValue(status([ev({ id: 'e1', sha: SHA_A })]))
    render(<DeploysPage statusMs={30} logMs={20} />)
    expect(await screen.findByText(/restarting/)).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByText(/restarting/)).not.toBeInTheDocument())
    expect(screen.getByText('Running aaaaaaa')).toBeInTheDocument()
  })
})
