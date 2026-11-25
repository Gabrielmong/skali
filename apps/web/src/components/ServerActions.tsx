import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Snackbar,
  Tooltip,
} from '@mui/material'
import type { ServerView } from '@skali/shared'
import { useEffect, useState, type ReactNode } from 'react'
import { restartServer, startServer, stopServer } from '../api.ts'

export function formatUptime(startedAt: string, now: number): string {
  const secs = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000))
  const d = Math.floor(secs / 86_400)
  const h = Math.floor((secs % 86_400) / 3_600)
  const m = Math.floor((secs % 3_600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

/** navigator.clipboard only exists in secure contexts; the UI is normally opened over plain http on the LAN. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the textarea fallback
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  try {
    ta.select()
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    document.body.removeChild(ta)
  }
}

export const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1)

export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(t)
  }, [active])
  return now
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function ErrorSnackbar({ error, onClose }: { error: string | null; onClose: () => void }) {
  return (
    <Snackbar open={error !== null} autoHideDuration={8000} onClose={onClose}>
      <Alert severity="error" variant="filled" onClose={onClose}>
        {error}
      </Alert>
    </Snackbar>
  )
}

type Action = 'start' | 'stop' | 'restart'
const ACTIONS = { start: startServer, stop: stopServer, restart: restartServer } as const

export interface ServerActions {
  busy: Action | null
  /** Starts the action now (used for Start, and for Stop/Restart once confirmed). */
  run: (action: Action) => Promise<void>
  /** Stop/Restart: asks first when players are online. */
  ask: (action: 'stop' | 'restart') => void
  copyAddress: () => void
  setError: (message: string) => void
  /** The confirm dialog and the snackbars; render once next to the buttons. */
  ui: ReactNode
}

/** Start/stop/restart with the player confirmation, plus copy-address and error/copied snackbars. */
export function useServerActions(server: ServerView): ServerActions {
  const [busy, setBusy] = useState<Action | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<'stop' | 'restart' | null>(null)
  const [copied, setCopied] = useState(false)

  const run = async (action: Action) => {
    setBusy(action)
    try {
      // 202: the final outcome (running / crashed with a detail) arrives over the WebSocket.
      await ACTIONS[action](server.id)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const ask = (action: 'stop' | 'restart') => {
    if ((server.players?.online ?? 0) > 0) setConfirm(action)
    else void run(action)
  }

  const copyAddress = () => {
    void copyText(server.connectAddress).then((ok) => {
      if (ok) setCopied(true)
      else setError('Could not copy the address; select it and copy it by hand')
    })
  }

  const online = server.players?.online ?? 0
  const ui = (
    <>
      <Dialog open={confirm !== null} onClose={() => setConfirm(null)}>
        <DialogTitle>
          {confirm === 'restart' ? 'Restart' : 'Stop'} {server.name}?
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            {`${online === 1 ? '1 player is' : `${online} players are`} online. ${confirm === 'restart' ? 'Restart' : 'Stop'} anyway?`}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirm(null)}>Cancel</Button>
          <Button
            color="error"
            onClick={() => {
              const action = confirm ?? 'stop'
              setConfirm(null)
              void run(action)
            }}
          >
            {confirm === 'restart' ? 'Restart' : 'Stop'} anyway
          </Button>
        </DialogActions>
      </Dialog>
      <Snackbar open={copied} autoHideDuration={2000} onClose={() => setCopied(false)} message="Copied" />
      <ErrorSnackbar error={error} onClose={() => setError(null)} />
    </>
  )

  return { busy, run, ask, copyAddress, setError, ui }
}

/** Why Start is refused (mirrors the server's start guard), or null when it is allowed. A failed update does not block. */
export function startBlockReason(server: Pick<ServerView, 'job' | 'setupPending'>): string | null {
  const { job } = server
  if (job?.state === 'running') return job.kind === 'install' ? 'Installing…' : 'Updating…'
  if (job?.state === 'failed' && job.kind === 'install') return 'Install failed — retry or remove it'
  if (server.setupPending) return 'Finish setup first'
  return null
}

/** Start, or Restart + Stop, or a disabled "Stopping" button, by status. */
export function ActionButtons({ server, actions }: { server: ServerView; actions: ServerActions }) {
  const { status } = server
  const { busy, run, ask } = actions
  const blocked = startBlockReason(server)
  return (
    <>
      {(status === 'stopped' || status === 'crashed') && (
        <Tooltip title={blocked ?? ''} describeChild>
          {/* A disabled button swallows hover, so the span carries the tooltip. */}
          <span>
            <Button variant="contained" disabled={busy !== null || blocked !== null} onClick={() => void run('start')}>
              Start
            </Button>
          </span>
        </Tooltip>
      )}
      {(status === 'starting' || status === 'running') && (
        <>
          <Button variant="outlined" disabled={busy !== null} onClick={() => ask('restart')}>
            Restart
          </Button>
          <Button variant="outlined" color="error" disabled={busy !== null} onClick={() => ask('stop')}>
            Stop
          </Button>
        </>
      )}
      {status === 'stopping' && (
        <Button disabled variant="outlined" startIcon={<CircularProgress size={16} color="inherit" />}>
          Stopping
        </Button>
      )}
    </>
  )
}
