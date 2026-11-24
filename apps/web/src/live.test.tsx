import { act, render } from '@testing-library/react'
import type { ServerView, WsServerMessage } from '@skali/shared'
import { StrictMode, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LiveProvider, useServerLogs, useServers } from './live.tsx'
import { makeServer } from './test/fixtures.ts'

class MockWebSocket {
  static instances: MockWebSocket[] = []
  static OPEN = 1
  static CLOSED = 3
  readyState = 0
  sent: unknown[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  url: string
  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close() {
    this.readyState = 3
    this.onclose?.()
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  push(msg: WsServerMessage) {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
  drop() {
    this.readyState = 3
    this.onclose?.()
  }
}
const last = () => MockWebSocket.instances[MockWebSocket.instances.length - 1]!

let servers: ServerView[] = []
let connected = false
function Probe() {
  const s = useServers()
  servers = s.servers
  connected = s.connected
  return null
}
let logs: { runId?: string; lines: string[] } = { lines: [] }
function LogProbe({ id }: { id: string }) {
  logs = useServerLogs(id)
  return null
}
const wrap = (children: ReactNode) => <LiveProvider>{children}</LiveProvider>

const status = (over: Partial<ServerView>): WsServerMessage => ({ type: 'status', server: makeServer(over) })
const sentOf = (ws: MockWebSocket, type: string) => ws.sent.filter((m) => (m as { type: string }).type === type)

beforeEach(() => {
  vi.useFakeTimers()
  MockWebSocket.instances = []
  servers = []
  connected = false
  logs = { lines: [] }
  vi.stubGlobal('WebSocket', MockWebSocket)
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('LiveProvider', () => {
  it('connects to /ws and applies status and removed messages', () => {
    render(wrap(<Probe />))
    const ws = last()
    expect(ws.url).toMatch(/^ws:\/\/[^/]+\/ws$/)
    expect(connected).toBe(false)
    act(() => ws.open())
    expect(connected).toBe(true)
    act(() => ws.push(status({ id: 'a', name: 'A', status: 'running' })))
    expect(servers.map((s) => [s.id, s.status])).toEqual([['a', 'running']])
    act(() => ws.push(status({ id: 'a', name: 'A', status: 'stopped' })))
    expect(servers[0]!.status).toBe('stopped')
    act(() => ws.push({ type: 'removed', serverId: 'a' }))
    expect(servers).toEqual([])
  })

  it('reconnects with backoff from 1s up to 10s', () => {
    render(wrap(<Probe />))
    act(() => last().drop())
    expect(connected).toBe(false)
    expect(MockWebSocket.instances).toHaveLength(1)
    act(() => vi.advanceTimersByTime(999))
    expect(MockWebSocket.instances).toHaveLength(1)
    act(() => vi.advanceTimersByTime(1))
    expect(MockWebSocket.instances).toHaveLength(2)
    act(() => last().drop())
    act(() => vi.advanceTimersByTime(1999))
    expect(MockWebSocket.instances).toHaveLength(2)
    act(() => vi.advanceTimersByTime(1))
    expect(MockWebSocket.instances).toHaveLength(3)
    for (let i = 0; i < 6; i++) {
      act(() => last().drop())
      act(() => vi.advanceTimersByTime(10_000))
    }
    const n = MockWebSocket.instances.length
    act(() => last().drop())
    act(() => vi.advanceTimersByTime(9_999))
    expect(MockWebSocket.instances).toHaveLength(n)
    act(() => vi.advanceTimersByTime(1))
    expect(MockWebSocket.instances).toHaveLength(n + 1) // capped at 10 s
  })

  it('after a reconnect, replaces the map with GET /api/servers and drops servers that are gone', async () => {
    vi.useRealTimers()
    render(wrap(<Probe />))
    const ws = last()
    act(() => ws.open())
    act(() => ws.push(status({ id: 'a', name: 'A' })))
    act(() => ws.push(status({ id: 'b', name: 'B' })))
    expect(servers).toHaveLength(2)
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify([makeServer({ id: 'a', name: 'A2' })]), { status: 200 }),
    )
    act(() => ws.drop())
    await new Promise((r) => setTimeout(r, 1100))
    const ws2 = last()
    expect(ws2).not.toBe(ws)
    await act(async () => {
      ws2.open()
      await new Promise((r) => setTimeout(r, 30))
    })
    expect(fetch).toHaveBeenCalledWith('/api/servers', expect.anything())
    expect(servers.map((s) => [s.id, s.name])).toEqual([['a', 'A2']])
  })
})

describe('reconnect refresh', () => {
  it('lets a WS status that arrived during the fetch win over the response', async () => {
    vi.useRealTimers()
    render(wrap(<Probe />))
    const ws = last()
    act(() => ws.open())
    let resolve!: (r: Response) => void
    vi.mocked(fetch).mockReturnValue(new Promise<Response>((r) => (resolve = r)))
    act(() => ws.drop())
    await new Promise((r) => setTimeout(r, 1100))
    const ws2 = last()
    act(() => ws2.open())
    act(() => ws2.push(status({ id: 'a', name: 'fresh', status: 'running' })))
    await act(async () => {
      resolve(new Response(JSON.stringify([makeServer({ id: 'a', name: 'stale' }), makeServer({ id: 'b', name: 'B' })])))
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(servers.map((s) => [s.id, s.name])).toEqual([
      ['b', 'B'],
      ['a', 'fresh'],
    ])
  })

  it('retries once after 2s when the refresh fails', async () => {
    render(wrap(<Probe />))
    act(() => last().open())
    vi.mocked(fetch).mockRejectedValueOnce(new Error('down')).mockResolvedValue(new Response('[]'))
    act(() => last().drop())
    act(() => vi.advanceTimersByTime(1000))
    await act(async () => {
      last().open()
      await Promise.resolve()
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})

describe('useServerLogs', () => {
  it('subscribes on mount, unsubscribes on unmount, ref-counted per server', () => {
    const { rerender } = render(
      wrap(
        <>
          <LogProbe id="a" />
          <LogProbe id="a" />
        </>,
      ),
    )
    const ws = last()
    act(() => ws.open())
    expect(sentOf(ws, 'subscribeLogs')).toEqual([{ type: 'subscribeLogs', serverId: 'a' }])
    rerender(wrap(<LogProbe id="a" />))
    expect(sentOf(ws, 'unsubscribeLogs')).toHaveLength(0)
    rerender(wrap(null))
    expect(sentOf(ws, 'unsubscribeLogs')).toEqual([{ type: 'unsubscribeLogs', serverId: 'a' }])
  })

  it('re-subscribes after a reconnect', () => {
    render(wrap(<LogProbe id="a" />))
    const ws = last()
    act(() => ws.open())
    act(() => ws.drop())
    act(() => vi.advanceTimersByTime(1000))
    const ws2 = last()
    act(() => ws2.open())
    expect(sentOf(ws2, 'subscribeLogs')).toEqual([{ type: 'subscribeLogs', serverId: 'a' }])
  })

  describe('history/live overlap', () => {
    const setup = (history: string[]) => {
      render(wrap(<LogProbe id="a" />))
      const ws = last()
      act(() => ws.open())
      act(() => ws.push({ type: 'logHistory', serverId: 'a', runId: 'r1', lines: history }))
      const log = (lines: string[]) => act(() => ws.push({ type: 'log', serverId: 'a', runId: 'r1', lines }))
      const settle = () => act(() => vi.advanceTimersByTime(50))
      return { log, settle }
    }

    it('drops a true suffix/prefix overlap', () => {
      const { log, settle } = setup(['1', '2', '3'])
      expect(logs).toEqual({ runId: 'r1', lines: ['1', '2', '3'] })
      log(['2', '3', '4'])
      settle()
      expect(logs.lines).toEqual(['1', '2', '3', '4'])
    })

    it('keeps a new line that equals a mid-history line', () => {
      const { log, settle } = setup(['1', '2', '3'])
      log(['1'])
      settle()
      expect(logs.lines).toEqual(['1', '2', '3', '1'])
    })

    it('drops an overlap split across 3 messages', () => {
      const { log, settle } = setup(['1', '2', '3', '4', '5'])
      log(['3'])
      log(['4'])
      log(['5', '6'])
      settle()
      expect(logs.lines).toEqual(['1', '2', '3', '4', '5', '6'])
    })

    it('keeps new lines after a partial overlap in the same batch', () => {
      const { log, settle } = setup(['a', 'b', 'c'])
      log(['c', 'd', 'e'])
      settle()
      expect(logs.lines).toEqual(['a', 'b', 'c', 'd', 'e'])
    })

    it('keeps everything when there is no overlap', () => {
      const { log, settle } = setup(['a', 'b'])
      log(['x'])
      log(['y'])
      settle()
      expect(logs.lines).toEqual(['a', 'b', 'x', 'y'])
    })

    it('does not dedupe lines arriving after the window', () => {
      const { log, settle } = setup(['1', '2', '3'])
      settle()
      log(['3'])
      expect(logs.lines).toEqual(['1', '2', '3', '3'])
    })
  })

  it('sends one subscribeLogs for a probe mounted after the socket opened, none for a second probe', () => {
    const { rerender } = render(wrap(<Probe />))
    const ws = last()
    act(() => ws.open())
    rerender(wrap(<LogProbe id="a" />))
    expect(sentOf(ws, 'subscribeLogs')).toHaveLength(1)
    rerender(
      wrap(
        <>
          <LogProbe id="a" />
          <LogProbe id="a" />
        </>,
      ),
    )
    expect(sentOf(ws, 'subscribeLogs')).toHaveLength(1)
  })

  it('keeps one live socket under StrictMode', () => {
    render(
      <StrictMode>
        <LiveProvider>
          <Probe />
        </LiveProvider>
      </StrictMode>,
    )
    const open = MockWebSocket.instances.filter((w) => w.readyState !== 3)
    expect(open).toHaveLength(1)
  })

  it('resets the lines on a new runId', () => {
    render(wrap(<LogProbe id="a" />))
    const ws = last()
    act(() => ws.open())
    act(() => ws.push({ type: 'logHistory', serverId: 'a', runId: 'r1', lines: ['old'] }))
    act(() => ws.push({ type: 'log', serverId: 'a', runId: 'r2', lines: ['new'] }))
    expect(logs).toEqual({ runId: 'r2', lines: ['new'] })
  })

  it('keeps the last 5000 lines, dropping the oldest', () => {
    render(wrap(<LogProbe id="a" />))
    const ws = last()
    act(() => ws.open())
    act(() => ws.push({ type: 'logHistory', serverId: 'a', runId: 'r1', lines: [] }))
    act(() => vi.advanceTimersByTime(50))
    const batch = (from: number, n: number) => Array.from({ length: n }, (_, i) => `line ${from + i}`)
    act(() => ws.push({ type: 'log', serverId: 'a', runId: 'r1', lines: batch(0, 4000) }))
    act(() => ws.push({ type: 'log', serverId: 'a', runId: 'r1', lines: batch(4000, 2000) }))
    expect(logs.lines).toHaveLength(5000)
    expect(logs.lines[0]).toBe('line 1000')
    expect(logs.lines[4999]).toBe('line 5999')
  })
})
