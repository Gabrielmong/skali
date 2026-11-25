import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api.ts'
import { makeServer } from '../test/fixtures.ts'
import { UpdateDialog } from './UpdateDialog.tsx'

vi.mock('../api.ts', async (orig) => ({
  ...(await orig<typeof import('../api.ts')>()),
  updateServer: vi.fn(),
  minecraftVersions: vi.fn(),
}))

const onClose = vi.fn()

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.updateServer).mockResolvedValue({ warnings: [] })
  vi.mocked(api.minecraftVersions).mockResolvedValue({ versions: ['1.21.4', '1.20.1'], latest: '1.21.4' })
})

describe('UpdateDialog', () => {
  it('Steam: confirms with the exact copy and posts an empty request', async () => {
    render(<UpdateDialog open server={makeServer({ game: 'valheim' })} onClose={onClose} />)
    expect(
      screen.getByText('Stops the server, backs up the world, updates, and starts it again if it was running'),
    ).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Update' }))
    expect(api.updateServer).toHaveBeenCalledWith('s1', {})
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('Minecraft: shows the current version, offers pickers and sends the choice', async () => {
    render(
      <UpdateDialog open server={makeServer({ launch: { mcFlavour: 'paper', mcVersion: '1.20.4' } })} onClose={onClose} />,
    )
    expect(screen.getByText('Current: Paper 1.20.4')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByLabelText('Version')).toHaveValue('1.21.4'))
    await userEvent.selectOptions(screen.getByLabelText('Version'), '1.20.1')
    await userEvent.click(screen.getByRole('button', { name: 'Update' }))
    expect(api.updateServer).toHaveBeenCalledWith('s1', { minecraft: { flavour: 'paper', version: '1.20.1' } })
  })

  it('Minecraft: an adopted server shows unknown', async () => {
    render(<UpdateDialog open server={makeServer()} onClose={onClose} />)
    expect(screen.getByText('Current: unknown')).toBeInTheDocument()
  })

  it('shows the downgrade warning from the response and stays open', async () => {
    vi.mocked(api.updateServer).mockResolvedValue({ warnings: ['Minecraft 1.20.1 is older than 1.21.4. Worlds may break.'] })
    render(<UpdateDialog open server={makeServer()} onClose={onClose} />)
    await waitFor(() => expect(screen.getByLabelText('Version')).toHaveValue('1.21.4'))
    await userEvent.click(screen.getByRole('button', { name: 'Update' }))
    expect(await screen.findByText('Minecraft 1.20.1 is older than 1.21.4. Worlds may break.')).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('reopening after a warned update starts fresh', async () => {
    vi.mocked(api.updateServer).mockResolvedValueOnce({ warnings: ['Downgrade!'] })
    const server = makeServer()
    const { rerender } = render(<UpdateDialog open server={server} onClose={onClose} />)
    await waitFor(() => expect(screen.getByLabelText('Version')).toHaveValue('1.21.4'))
    await userEvent.click(screen.getByRole('button', { name: 'Update' }))
    expect(await screen.findByText('Downgrade!')).toBeInTheDocument()
    rerender(<UpdateDialog open={false} server={server} onClose={onClose} />)
    rerender(<UpdateDialog open server={server} onClose={onClose} />)
    expect(screen.queryByText('Downgrade!')).toBeNull()
    expect(screen.queryByText('The update has started.')).toBeNull()
    expect(await screen.findByRole('button', { name: 'Update' })).toBeInTheDocument()
  })

  it('shows a server refusal in the dialog', async () => {
    vi.mocked(api.updateServer).mockRejectedValue(new api.ApiError(409, 'Wait for the update to finish'))
    render(<UpdateDialog open server={makeServer({ game: 'valheim' })} onClose={onClose} />)
    await userEvent.click(screen.getByRole('button', { name: 'Update' }))
    expect(await screen.findByText('Wait for the update to finish')).toBeInTheDocument()
  })
})
