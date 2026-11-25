import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api.ts'
import * as api from '../api.ts'
import { makeServer } from '../test/fixtures.ts'
import { ServerCard } from './ServerCard.tsx'

vi.mock('../api.ts', async (orig) => ({
  ...(await orig<typeof import('../api.ts')>()),
  startServer: vi.fn(),
  stopServer: vi.fn(),
  restartServer: vi.fn(),
}))

const renderCard = (over = {}) =>
  render(
    <MemoryRouter>
      <ServerCard server={makeServer(over)} />
    </MemoryRouter>,
  )

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.startServer).mockResolvedValue(makeServer())
  vi.mocked(api.stopServer).mockResolvedValue(makeServer())
  vi.mocked(api.restartServer).mockResolvedValue(makeServer())
})

const job = (kind: 'install' | 'update', state: 'running' | 'failed') =>
  ({ kind, state, steps: [], progress: null, runId: 'r1' }) as const

describe('ServerCard job and setup states', () => {
  it.each([
    ['install', 'running', 'Installing…'],
    ['update', 'running', 'Updating…'],
    ['install', 'failed', 'Install failed'],
    ['update', 'failed', 'Update failed'],
  ] as const)('chip for a %s job that is %s reads %s, overriding the status', (kind, state, label) => {
    renderCard({ status: 'running', job: job(kind, state) })
    expect(screen.getByText(label)).toBeInTheDocument()
    expect(screen.queryByText('Running')).toBeNull()
  })

  it('chip says Finish setup when setupPending', () => {
    renderCard({ setupPending: true })
    expect(screen.getByText('Finish setup')).toBeInTheDocument()
  })

  it.each([
    [{ job: job('install', 'running') }, 'Installing…'],
    [{ job: job('update', 'running') }, 'Updating…'],
    [{ job: job('install', 'failed') }, 'Install failed — retry or remove it'],
    [{ setupPending: true }, 'Finish setup first'],
  ])('Start is disabled with its reason (%#)', (over, reason) => {
    renderCard(over)
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled()
    expect(screen.getByTitle(reason)).toBeInTheDocument()
  })

  it('a failed update does not block Start', () => {
    renderCard({ job: job('update', 'failed') })
    expect(screen.getByRole('button', { name: 'Start' })).toBeEnabled()
  })
})

describe('ServerCard', () => {
  it('shows a Restart pending chip only when restartPending', () => {
    const { unmount } = renderCard({ status: 'running', restartPending: false })
    expect(screen.queryByText('Restart pending')).toBeNull()
    unmount()
    renderCard({ status: 'running', restartPending: true })
    expect(screen.getByText('Restart pending')).toBeInTheDocument()
  })

  it('shows only Start when stopped', () => {
    renderCard({ status: 'stopped' })
    expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull()
  })

  it('shows Start when crashed', () => {
    renderCard({ status: 'crashed' })
    expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument()
  })

  it('shows Restart and Stop when running', () => {
    renderCard({ status: 'running', startedAt: new Date().toISOString() })
    expect(screen.getByRole('button', { name: 'Restart' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull()
  })

  it('shows a disabled spinner button while stopping', () => {
    renderCard({ status: 'stopping' })
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Stopping' })).toBeDisabled()
  })

  it('stops immediately when nobody is online', async () => {
    renderCard({ status: 'running', players: { online: 0, max: 10 } })
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(api.stopServer).toHaveBeenCalledWith('s1')
  })

  it('asks for confirmation when players are online, and stops only after confirming', async () => {
    renderCard({ status: 'running', players: { online: 2, max: 10 } })
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(screen.getByText('2 players are online. Stop anyway?')).toBeInTheDocument()
    expect(api.stopServer).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Stop anyway' }))
    expect(api.stopServer).toHaveBeenCalledWith('s1')
  })

  it('does not stop when the confirmation is cancelled', async () => {
    renderCard({ status: 'running', players: { online: 1, max: 10 } })
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(screen.getByText('1 player is online. Stop anyway?')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(api.stopServer).not.toHaveBeenCalled()
  })

  it('shows the crash-pause message and the detail', () => {
    renderCard({ status: 'crashed', crashPaused: true, detail: 'Exited with code 1' })
    expect(screen.getByText('Auto-restart paused after repeated crashes')).toBeInTheDocument()
    expect(screen.getByText('Exited with code 1')).toBeInTheDocument()
  })

  it('shows detail even when not crash-paused', () => {
    renderCard({ status: 'crashed', crashPaused: false, detail: 'Forced stop failed: access denied' })
    expect(screen.getByText('Forced stop failed: access denied')).toBeInTheDocument()
    expect(screen.queryByText('Auto-restart paused after repeated crashes')).toBeNull()
  })

  it('shows server error messages verbatim in a snackbar', async () => {
    vi.mocked(api.startServer).mockRejectedValue(
      new ApiError(409, 'Previous process (pid 42) is still running; stop it first'),
    )
    renderCard({ status: 'stopped' })
    await userEvent.click(screen.getByRole('button', { name: 'Start' }))
    await waitFor(() =>
      expect(screen.getByText('Previous process (pid 42) is still running; stop it first')).toBeInTheDocument(),
    )
  })

  it('shows players, resources and the connect address', () => {
    renderCard({
      status: 'running',
      players: { online: 3, max: 16 },
      cpuPct: 12.4,
      memBytes: 4.1 * 1024 ** 3,
    })
    expect(screen.getByText('3/16')).toBeInTheDocument()
    expect(screen.getByText(/CPU 12%/)).toBeInTheDocument()
    expect(screen.getByText(/RAM 4\.1 GB/)).toBeInTheDocument()
    expect(screen.getByText('192.168.0.100:25565')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Survival' })).toHaveAttribute('href', '/servers/s1')
  })

  it('asks before restarting when players are online', async () => {
    renderCard({ status: 'running', players: { online: 2, max: 10 } })
    await userEvent.click(screen.getByRole('button', { name: 'Restart' }))
    expect(screen.getByText('2 players are online. Restart anyway?')).toBeInTheDocument()
    expect(api.restartServer).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Restart anyway' }))
    expect(api.restartServer).toHaveBeenCalledWith('s1')
  })

  describe('copy address', () => {
    const setClipboard = (v: unknown) => Object.defineProperty(navigator, 'clipboard', { value: v, configurable: true })
    afterEach(() => {
      setClipboard(undefined)
      Reflect.deleteProperty(document, 'execCommand')
    })

    it('uses the clipboard API when available', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined)
      setClipboard({ writeText })
      renderCard()
      fireEvent.click(screen.getByRole('button', { name: 'Copy address' }))
      await screen.findByText('Copied')
      expect(writeText).toHaveBeenCalledWith('192.168.0.100:25565')
    })

    it('falls back to execCommand when navigator.clipboard is missing (plain http)', async () => {
      setClipboard(undefined)
      const exec = vi.fn().mockReturnValue(true)
      Object.defineProperty(document, 'execCommand', { value: exec, configurable: true })
      renderCard()
      fireEvent.click(screen.getByRole('button', { name: 'Copy address' }))
      await screen.findByText('Copied')
      expect(exec).toHaveBeenCalledWith('copy')
      expect(document.querySelector('textarea')).toBeNull()
    })

    it('falls back when the clipboard API rejects, and reports failure if both fail', async () => {
      setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('denied')) })
      Object.defineProperty(document, 'execCommand', { value: vi.fn().mockReturnValue(false), configurable: true })
      renderCard()
      fireEvent.click(screen.getByRole('button', { name: 'Copy address' }))
      await screen.findByText(/Could not copy/)
      expect(screen.queryByText('Copied')).toBeNull()
    })
  })
})
