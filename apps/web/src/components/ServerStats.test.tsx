import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { makeServer } from '../test/fixtures.ts'
import { ServerStats } from './ServerStats.tsx'

const NOW = Date.parse('2026-06-01T12:00:00.000Z')
const TWO_HOURS_AGO = new Date(NOW - 2 * 3_600_000 - 5 * 60_000).toISOString()

describe('ServerStats', () => {
  it('shows players, uptime, CPU and RAM for a running server', () => {
    render(
      <ServerStats
        now={NOW}
        server={makeServer({
          status: 'running',
          startedAt: TWO_HOURS_AGO,
          players: { online: 3, max: 16 },
          cpuPct: 12.4,
          memBytes: 4.1 * 1024 ** 3,
        })}
      />,
    )
    expect(screen.getByText('3/16')).toBeInTheDocument()
    expect(screen.getByText('2h 5m')).toBeInTheDocument()
    expect(screen.getByText('CPU 12%')).toBeInTheDocument()
    expect(screen.getByText('RAM 4.1 GB')).toBeInTheDocument()
  })

  it('hides uptime and resources while stopped', () => {
    render(
      <ServerStats
        now={NOW}
        server={makeServer({ status: 'stopped', startedAt: TWO_HOURS_AGO, cpuPct: 5, memBytes: 1024 ** 3 })}
      />,
    )
    expect(screen.queryByText(/CPU/)).toBeNull()
    expect(screen.queryByText(/RAM/)).toBeNull()
    expect(screen.queryByText('2h 5m')).toBeNull()
  })
})
