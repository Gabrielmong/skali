import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api.ts'
import { SettingsPage } from './SettingsPage.tsx'

vi.mock('../api.ts', async (orig) => ({
  ...(await orig<typeof import('../api.ts')>()),
  getSettings: vi.fn(),
  putSettings: vi.fn(),
  getTools: vi.fn(),
}))

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.getSettings).mockResolvedValue({ allowlist: ['192.168.0.5'], connectHost: '192.168.0.100', gamesRoot: 'D:\\GameServers' })
  vi.mocked(api.getTools).mockResolvedValue({ steamcmd: false, java: [] })
})

describe('SettingsPage', () => {
  it('shows the lockout refusal verbatim', async () => {
    vi.mocked(api.putSettings).mockRejectedValue(new api.ApiError(400, "This would lock out the device you're using"))
    render(<SettingsPage />)
    await userEvent.click(await screen.findByRole('button', { name: 'Remove 192.168.0.5' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText("This would lock out the device you're using")).toBeInTheDocument()
  })

  it('saves the games folder', async () => {
    vi.mocked(api.putSettings).mockResolvedValue({
      allowlist: ['192.168.0.5'],
      connectHost: '192.168.0.100',
      gamesRoot: 'E:\\Games',
    })
    render(<SettingsPage />)
    const field = await screen.findByRole('textbox', { name: 'Games folder' })
    expect(field).toHaveValue('D:\\GameServers')
    await userEvent.clear(field)
    await userEvent.type(field, 'E:\\Games')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(api.putSettings).toHaveBeenCalledWith({
      allowlist: ['192.168.0.5'],
      connectHost: '192.168.0.100',
      gamesRoot: 'E:\\Games',
    })
  })

  it('lists the downloaded tools', async () => {
    vi.mocked(api.getTools).mockResolvedValue({ steamcmd: true, java: [21, 17] })
    const { unmount } = render(<SettingsPage />)
    expect(await screen.findByText('SteamCMD: installed')).toBeInTheDocument()
    expect(screen.getByText('Java: 21, 17')).toBeInTheDocument()
    unmount()
    vi.mocked(api.getTools).mockResolvedValue({ steamcmd: false, java: [] })
    render(<SettingsPage />)
    expect(await screen.findByText('SteamCMD: not installed yet (downloaded on first install)')).toBeInTheDocument()
    expect(screen.getByText('Java: none yet')).toBeInTheDocument()
  })

  it('still renders when the tools lookup fails', async () => {
    vi.mocked(api.getTools).mockRejectedValue(new api.ApiError(500, 'boom'))
    render(<SettingsPage />)
    expect(await screen.findByRole('textbox', { name: 'Games folder' })).toBeInTheDocument()
  })

  it('rejects a connect host with a scheme', async () => {
    render(<SettingsPage />)
    const host = await screen.findByRole('textbox', { name: 'Connect host' })
    await userEvent.clear(host)
    await userEvent.type(host, 'http://x')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })
})
