import type { ServerView, WsClientMessage, WsServerMessage } from '@skali/shared'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { getServers } from './api.ts'

const BACKOFF_START_MS = 1_000
const BACKOFF_MAX_MS = 10_000
export const MAX_LOG_LINES = 5_000

export interface LogSnapshot {
  runId?: string
  lines: string[]
}

interface LogEntry {
  snap: LogSnapshot
  /** The history, and the live lines gathered since it arrived while the overlap window is open (else null). */
  history: string[]
  pending: string[] | null
  timer?: ReturnType<typeof setTimeout>
}

interface LiveContextValue {
  servers: ServerView[]
  connected: boolean
  subscribeLogs: (serverId: string, listener: () => void) => () => void
  getLogs: (serverId: string) => LogSnapshot
}

const EMPTY_LOGS: LogSnapshot = { lines: [] }
const LiveContext = createContext<LiveContextValue | null>(null)

const cap = (lines: string[]) => (lines.length > MAX_LOG_LINES ? lines.slice(lines.length - MAX_LOG_LINES) : lines)

/** The hub flushes buffered live lines right after the history; wait this long to gather them all. */
const OVERLAP_WINDOW_MS = 50

/** Drops the longest prefix of `batch` that equals the tail of `history` (a true suffix/prefix overlap). */
function dropOverlap(history: string[], batch: string[]): string[] {
  for (let k = Math.min(history.length, batch.length); k > 0; k--) {
    let same = true
    for (let i = 0; i < k; i++) {
      if (history[history.length - k + i] !== batch[i]) {
        same = false
        break
      }
    }
    if (same) return batch.slice(k)
  }
  return batch
}

export function LiveProvider({ children }: { children: ReactNode }) {
  const [serverMap, setServerMap] = useState<ReadonlyMap<string, ServerView>>(() => new Map())
  const [connected, setConnected] = useState(false)

  const wsRef = useRef<WebSocket | null>(null)
  const subCounts = useRef(new Map<string, number>())
  const logs = useRef(new Map<string, LogEntry>())
  const listeners = useRef(new Map<string, Set<() => void>>())
  /** While a reconnect refresh is in flight: servers changed over the WS meanwhile (null = removed). */
  const touched = useRef<Map<string, ServerView | null> | null>(null)

  const sendMsg = useCallback((msg: WsClientMessage) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }, [])

  const notifyLogs = useCallback((id: string) => {
    listeners.current.get(id)?.forEach((l) => l())
  }, [])

  const handle = useCallback(
    (msg: WsServerMessage) => {
      switch (msg.type) {
        case 'status': {
          touched.current?.set(msg.server.id, msg.server)
          setServerMap((prev) => new Map(prev).set(msg.server.id, msg.server))
          break
        }
        case 'removed': {
          touched.current?.set(msg.serverId, null)
          setServerMap((prev) => {
            if (!prev.has(msg.serverId)) return prev
            const next = new Map(prev)
            next.delete(msg.serverId)
            return next
          })
          break
        }
        case 'logHistory': {
          const old = logs.current.get(msg.serverId)
          if (!old) break // unsubscribed meanwhile
          clearTimeout(old.timer)
          const lines = cap(msg.lines)
          const entry: LogEntry = {
            snap: { ...(msg.runId ? { runId: msg.runId } : {}), lines },
            history: lines,
            pending: [],
          }
          entry.timer = setTimeout(() => {
            if (logs.current.get(msg.serverId) !== entry) return
            const batch = entry.pending ?? []
            entry.pending = null
            if (batch.length === 0) return
            entry.snap = { ...entry.snap, lines: cap([...entry.snap.lines, ...dropOverlap(entry.history, batch)]) }
            notifyLogs(msg.serverId)
          }, OVERLAP_WINDOW_MS)
          logs.current.set(msg.serverId, entry)
          notifyLogs(msg.serverId)
          break
        }
        case 'log': {
          const entry = logs.current.get(msg.serverId)
          if (!entry) break
          if (entry.snap.runId === msg.runId && entry.pending) {
            entry.pending.push(...msg.lines)
            break
          }
          clearTimeout(entry.timer)
          const next = entry.snap.runId === msg.runId ? [...entry.snap.lines, ...msg.lines] : msg.lines
          logs.current.set(msg.serverId, { snap: { runId: msg.runId, lines: cap(next) }, history: [], pending: null })
          notifyLogs(msg.serverId)
          break
        }
      }
    },
    [notifyLogs],
  )

  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let delay = BACKOFF_START_MS
    let everConnected = false

    /** The hub sends no end-of-snapshot marker, so after a reconnect the REST list is the authority. */
    const refresh = (retry = true) => {
      clearTimeout(retryTimer)
      const seen = new Map<string, ServerView | null>()
      touched.current = seen
      getServers().then(
        (list) => {
          if (disposed || touched.current !== seen) return
          touched.current = null
          const next = new Map(list.map((s) => [s.id, s] as const))
          // WS messages that arrived while the request was in flight are newer than the response.
          for (const [id, v] of seen) {
            if (v) next.set(id, v)
            else next.delete(id)
          }
          setServerMap(next)
        },
        () => {
          if (touched.current === seen) touched.current = null
          if (retry && !disposed) retryTimer = setTimeout(() => refresh(false), 2_000)
        },
      )
    }

    const connect = () => {
      if (disposed) return
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const ws = new WebSocket(`${proto}://${window.location.host}/ws`)
      wsRef.current = ws
      ws.onopen = () => {
        if (disposed || wsRef.current !== ws) return
        delay = BACKOFF_START_MS
        setConnected(true)
        for (const id of subCounts.current.keys()) sendMsg({ type: 'subscribeLogs', serverId: id })
        if (everConnected) refresh()
        everConnected = true
      }
      ws.onmessage = (e) => {
        if (wsRef.current !== ws) return
        try {
          handle(JSON.parse(String(e.data)) as WsServerMessage)
        } catch {
          // ignore malformed messages
        }
      }
      ws.onclose = () => {
        if (wsRef.current !== ws) return
        wsRef.current = null
        setConnected(false)
        if (disposed) return
        timer = setTimeout(connect, delay)
        delay = Math.min(delay * 2, BACKOFF_MAX_MS)
      }
      ws.onerror = () => {
        // a close event follows
      }
    }
    connect()

    return () => {
      disposed = true
      clearTimeout(timer)
      clearTimeout(retryTimer)
      touched.current = null
      const ws = wsRef.current
      wsRef.current = null
      ws?.close()
    }
  }, [handle, sendMsg])

  const subscribeLogs = useCallback(
    (serverId: string, listener: () => void) => {
      let set = listeners.current.get(serverId)
      if (!set) listeners.current.set(serverId, (set = new Set()))
      set.add(listener)
      const n = (subCounts.current.get(serverId) ?? 0) + 1
      subCounts.current.set(serverId, n)
      if (n === 1) {
        logs.current.set(serverId, { snap: EMPTY_LOGS, history: [], pending: null })
        sendMsg({ type: 'subscribeLogs', serverId })
      }
      return () => {
        set.delete(listener)
        if (set.size === 0) listeners.current.delete(serverId)
        const left = (subCounts.current.get(serverId) ?? 1) - 1
        if (left > 0) {
          subCounts.current.set(serverId, left)
          return
        }
        subCounts.current.delete(serverId)
        clearTimeout(logs.current.get(serverId)?.timer)
        logs.current.delete(serverId)
        sendMsg({ type: 'unsubscribeLogs', serverId })
      }
    },
    [sendMsg],
  )

  const getLogs = useCallback((serverId: string) => logs.current.get(serverId)?.snap ?? EMPTY_LOGS, [])

  const servers = useMemo(
    () => [...serverMap.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    [serverMap],
  )
  const value = useMemo<LiveContextValue>(
    () => ({ servers, connected, subscribeLogs, getLogs }),
    [servers, connected, subscribeLogs, getLogs],
  )
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>
}

function useLive(): LiveContextValue {
  const v = useContext(LiveContext)
  if (!v) throw new Error('LiveProvider is missing')
  return v
}

export function useServers(): { servers: ServerView[]; connected: boolean } {
  const { servers, connected } = useLive()
  return { servers, connected }
}

/** Subscribes to a server's console log while mounted; lines are capped at 5000 (oldest dropped). */
export function useServerLogs(serverId: string): LogSnapshot {
  const { subscribeLogs, getLogs } = useLive()
  const subscribe = useCallback((l: () => void) => subscribeLogs(serverId, l), [subscribeLogs, serverId])
  const snapshot = useCallback(() => getLogs(serverId), [getLogs, serverId])
  return useSyncExternalStore(subscribe, snapshot)
}
