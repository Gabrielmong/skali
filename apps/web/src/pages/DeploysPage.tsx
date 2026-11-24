import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Link,
  Paper,
  Stack,
  Typography,
} from '@mui/material'
import type { DeployEventView, DeployStatusView } from '@skali/shared'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ApiError,
  deployNow,
  getDeployLog,
  getDeployStatus,
  HELPER_NOT_RUNNING,
  pauseDeploys,
  restartSkali,
  resumeDeploys,
  rollbackDeploy,
} from '../api.ts'
import { DeployEventList, shortSha } from '../components/DeployEventList.tsx'
import { DeployLog } from '../components/DeployLog.tsx'
import { ErrorSnackbar, errorMessage } from '../components/ServerActions.tsx'

type Conn = 'ok' | 'notInstalled' | 'restarting'

const RUNNING_AUTO_DEPLOY = 'https://github.com/Gabrielmong/skali/blob/main/docs/RUNNING.md#auto-deploy'

export interface DeploysPageProps {
  /** Poll intervals (ms); tests shorten them. */
  statusMs?: number
  logMs?: number
}

export function DeploysPage({ statusMs = 5000, logMs = 1000 }: DeploysPageProps) {
  const [status, setStatus] = useState<DeployStatusView | null>(null)
  const [conn, setConn] = useState<Conn>('ok')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [log, setLog] = useState<string | null>(null)
  const [logEmpty, setLogEmpty] = useState<string | undefined>()
  const [confirm, setConfirm] = useState<DeployEventView | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const s = await getDeployStatus()
      setStatus(s)
      setConn('ok')
      setLoadError(null)
    } catch (e) {
      if (e instanceof ApiError && e.message === HELPER_NOT_RUNNING) setConn('notInstalled')
      else if (e instanceof ApiError && e.status === 0) setConn('restarting')
      else setLoadError(errorMessage(e))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), statusMs)
    return () => clearInterval(t)
  }, [refresh, statusMs])

  const events = status?.events
  useEffect(() => {
    if (selectedId === null && events && events.length > 0) setSelectedId(events[0]!.id)
  }, [events, selectedId])

  const selected = events?.find((e) => e.id === selectedId)
  const running = selected?.status === 'RUNNING'

  // Log: a RUNNING event is followed with from=<offset>; any other is read whole once.
  const nextRef = useRef(0)
  const loggedId = useRef<string | null>(null)
  useEffect(() => {
    if (!selectedId) return
    let alive = true
    setLogEmpty(undefined)
    const fail = (e: unknown) => {
      if (e instanceof ApiError && e.status === 404) setLogEmpty('No log for this event.')
      else if (e instanceof ApiError && e.status === 0) setConn('restarting')
    }
    nextRef.current = 0
    // Keep the shown log while the same event finishes (the full re-read replaces it); clear it for a new selection.
    if (loggedId.current !== selectedId) setLog(null)
    loggedId.current = selectedId
    if (!running) {
      getDeployLog(selectedId).then(
        (r) => alive && setLog(r.log),
        (e: unknown) => alive && fail(e),
      )
      return () => {
        alive = false
      }
    }
    let inFlight = false
    const poll = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const from = nextRef.current
        const r = await getDeployLog(selectedId, from)
        if (!alive) return
        if (from === 0) setLog(r.log)
        else if (r.log) setLog((cur) => (cur ?? '') + r.log)
        if (r.next !== undefined) nextRef.current = r.next
      } catch (e) {
        if (alive) fail(e)
      } finally {
        inFlight = false
      }
    }
    void poll()
    const t = setInterval(() => void poll(), logMs)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [selectedId, running, logMs])

  const act = async (fn: () => Promise<unknown>) => {
    setPending(true)
    try {
      await fn()
      setActionError(null)
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) setConn('restarting')
      else if (e instanceof ApiError && e.status === 409) setActionError('Another operation is already running.')
      else if (e instanceof ApiError && e.message === HELPER_NOT_RUNNING) setConn('notInstalled')
      else setActionError(errorMessage(e))
    } finally {
      setPending(false)
      void refresh()
    }
  }

  if (conn === 'notInstalled') {
    return (
      <Alert severity="info">
        The deploy helper isn't running, or isn't installed on this PC. See{' '}
        <Link href={RUNNING_AUTO_DEPLOY} target="_blank" rel="noreferrer">
          RUNNING.md → Auto-deploy
        </Link>
        .
      </Alert>
    )
  }
  if (!status) {
    return conn === 'restarting' ? (
      <Alert severity="warning">Skáli is restarting…</Alert>
    ) : loadError ? (
      <Alert severity="error">{loadError}</Alert>
    ) : (
      <CircularProgress aria-label="Loading deploys" />
    )
  }

  const busy = status.busy !== undefined || pending
  const on = status.autoDeploy.on
  return (
    <Stack spacing={2}>
      {conn === 'restarting' && <Alert severity="warning">Skáli is restarting…</Alert>}
      {loadError && <Alert severity="error">{loadError}</Alert>}
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ alignItems: { md: 'center' } }}>
          <Stack spacing={0.5} sx={{ flexGrow: 1, minWidth: 0 }}>
            <Typography variant="h6">
              {status.running ? `Running ${shortSha(status.running.sha)}` : 'No release running'}
            </Typography>
            {status.running?.message && (
              <Typography variant="body2" color="text.secondary" noWrap>
                {status.running.message}
              </Typography>
            )}
            {status.running && (
              <Typography variant="body2" color="text.secondary">
                Deployed {new Date(status.running.deployedAt).toLocaleString()}
              </Typography>
            )}
            <Typography variant="body2">
              {on ? 'Auto-deploy on' : `Auto-deploy paused${status.autoDeploy.reason ? ` (${status.autoDeploy.reason})` : ''}`}
              {status.busy ? ` · ${status.busy}` : ''}
            </Typography>
            <Typography variant="caption" color={status.lastCheck?.error ? 'error' : 'text.secondary'}>
              {status.lastCheck
                ? `Last GitHub check ${new Date(status.lastCheck.at).toLocaleString()}${
                    status.lastCheck.error ? ` failed: ${status.lastCheck.error}` : ''
                  }`
                : 'GitHub not checked yet'}
            </Typography>
            {status.helperUpdateAvailable && (
              <Typography variant="caption" color="warning.main">
                Helper update available
              </Typography>
            )}
          </Stack>
          <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 1 }}>
            <Button variant="contained" disabled={busy} onClick={() => void act(deployNow)}>
              Deploy now
            </Button>
            <Button variant="outlined" disabled={busy} onClick={() => void act(restartSkali)}>
              Restart Skáli
            </Button>
            <Button variant="outlined" disabled={pending} onClick={() => void act(on ? pauseDeploys : resumeDeploys)}>
              {on ? 'Pause' : 'Resume'}
            </Button>
          </Stack>
        </Stack>
      </Paper>

      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1fr) minmax(0, 1.4fr)' } }}>
        <Paper variant="outlined">
          <DeployEventList
            events={status.events}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onRollback={setConfirm}
            disabled={busy}
          />
        </Paper>
        <Paper variant="outlined" sx={{ p: 2, minWidth: 0 }}>
          <DeployLog text={log} empty={logEmpty} />
        </Paper>
      </Box>

      <Dialog open={confirm !== null} onClose={() => setConfirm(null)}>
        <DialogTitle>Roll back?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Roll back to {confirm?.sha ? shortSha(confirm.sha) : ''}
            {confirm?.message ? ` (${confirm.message})` : ''}? Skáli restarts on{' '}
            {confirm?.sha ? shortSha(confirm.sha) : ''}; game servers keep running. Auto-deploy is paused afterwards
            if the rollback succeeds.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirm(null)}>Cancel</Button>
          <Button
            color="warning"
            variant="contained"
            onClick={() => {
              const sha = confirm?.sha
              setConfirm(null)
              if (sha) void act(() => rollbackDeploy(sha))
            }}
          >
            Confirm roll back
          </Button>
        </DialogActions>
      </Dialog>
      <ErrorSnackbar error={actionError} onClose={() => setActionError(null)} />
    </Stack>
  )
}
