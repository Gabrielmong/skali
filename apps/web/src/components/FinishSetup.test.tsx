import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { GameInfo } from '@skali/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api.ts'
import { makeServer } from '../test/fixtures.ts'
import { FinishSetup } from './FinishSetup.tsx'

vi.mock('../api.ts', async (orig) => ({
  ...(await orig<typeof import('../api.ts')>()),
  patchServer: vi.fn(),
}))

const game: GameInfo = {
  id: 'basic',
  displayName: 'Other Steam game',
  hasCommands: false,
  launchFields: [
    { key: 'exe', label: 'Program', type: 'text' },
    { key: 'args', label: 'Arguments', type: 'text' },
  ],
}
const server = makeServer({ game: 'basic', setupPending: true, launch: { exe: 'srv.exe', args: '-a' } })

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.patchServer).mockResolvedValue(makeServer())
})

describe('FinishSetup', () => {
  it('pre-fills the launch form and saves it with patchServer', async () => {
    render(<FinishSetup server={server} game={game} />)
    expect(screen.getByRole('textbox', { name: 'Program' })).toHaveValue('srv.exe')
    const args = screen.getByRole('textbox', { name: 'Arguments' })
    await userEvent.clear(args)
    await userEvent.type(args, '-b')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(api.patchServer).toHaveBeenCalledWith('s1', { launch: { exe: 'srv.exe', args: '-b' } })
  })

  it('shows the server refusal', async () => {
    vi.mocked(api.patchServer).mockRejectedValue(new api.ApiError(400, 'exe must be a file in the server folder'))
    render(<FinishSetup server={server} game={game} />)
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('exe must be a file in the server folder')).toBeInTheDocument()
  })

  it('is disabled while a job runs', () => {
    const running = makeServer({ ...server, job: { kind: 'install', state: 'running', steps: [], progress: null, runId: 'r' } })
    render(<FinishSetup server={running} game={game} />)
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })
})
