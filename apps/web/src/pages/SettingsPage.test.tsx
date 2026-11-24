import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api.ts'
import { SettingsPage } from './SettingsPage.tsx'

vi.mock('../api.ts', async (orig) => ({
  ...(await orig<typeof import('../api.ts')>()),
  getSettings: vi.fn(),
  putSettings: vi.fn(),
}))

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.getSettings).mockResolvedValue({ allowlist: ['192.168.0.5'], connectHost: '192.168.0.100' })
})

describe('SettingsPage', () => {
  it('shows the lockout refusal verbatim', async () => {
    vi.mocked(api.putSettings).mockRejectedValue(new api.ApiError(400, "This would lock out the device you're using"))
    render(<SettingsPage />)
    await userEvent.click(await screen.findByRole('button', { name: 'Remove 192.168.0.5' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText("This would lock out the device you're using")).toBeInTheDocument()
  })

  it('rejects a connect host with a scheme', async () => {
    render(<SettingsPage />)
    const host = await screen.findByRole('textbox', { name: 'Connect host' })
    await userEvent.clear(host)
    await userEvent.type(host, 'http://x')
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })
})
