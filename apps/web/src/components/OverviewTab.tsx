import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  Paper,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material'
import { MINECRAFT_EULA_NOTE, type GameInfo, type ServerView } from '@skali/shared'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { acceptEula, deleteServer, inspectFolder, patchServer, type ServerPatch } from '../api.ts'
import { FinishSetup } from './FinishSetup.tsx'
import { ErrorSnackbar, errorMessage } from './ServerActions.tsx'
import { UpdateDialog } from './UpdateDialog.tsx'

interface Props {
  server: ServerView
  game: GameInfo | undefined
}

export function OverviewTab({ server, game }: Props) {
  const navigate = useNavigate()
  const [stopTimeout, setStopTimeout] = useState(String(server.stopTimeoutSec))
  const [timeoutError, setTimeoutError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [eulaMissing, setEulaMissing] = useState(false)
  const [deleteFolder, setDeleteFolder] = useState(false)
  const [updateOpen, setUpdateOpen] = useState(false)
  const [appId, setAppId] = useState(server.steamAppId === null ? '' : String(server.steamAppId))
  const [appIdError, setAppIdError] = useState<string | null>(null)

  useEffect(() => setStopTimeout(String(server.stopTimeoutSec)), [server.stopTimeoutSec])
  useEffect(() => setAppId(server.steamAppId === null ? '' : String(server.steamAppId)), [server.steamAppId])

  const { job } = server
  const jobRunning = job?.state === 'running'
  const failedInstall = job?.kind === 'install' && job.state === 'failed'
  // Skáli made this folder for an install that never finished: offer to remove it along with the server.
  const offerDeleteFolder = server.createdFolder && failedInstall
  const canDelete = (server.status === 'stopped' || server.status === 'crashed') && !jobRunning
  const canUpdate =
    !jobRunning &&
    !failedInstall &&
    !server.setupPending &&
    (server.status === 'stopped' || server.status === 'running' || server.status === 'crashed') &&
    (server.game !== 'basic' || server.steamAppId !== null)


  const patch = useCallback(
    async (p: ServerPatch): Promise<ServerView | null> => {
      try {
        return await patchServer(server.id, p)
      } catch (e) {
        setError(errorMessage(e))
        return null
      }
    },
    [server.id],
  )

  const checkEula = useCallback(() => {
    if (server.game !== 'minecraft') return
    inspectFolder(server.game, server.folder).then(
      (r) => setEulaMissing(r.ok && r.notes.includes(MINECRAFT_EULA_NOTE)),
      () => setEulaMissing(false),
    )
  }, [server.game, server.folder])
  useEffect(checkEula, [checkEula])

  const commitTimeout = async () => {
    const n = Number(stopTimeout)
    if (!Number.isInteger(n) || n < 5 || n > 3600) {
      setTimeoutError('Enter a whole number of seconds between 5 and 3600')
      return
    }
    setTimeoutError(null)
    if (n !== server.stopTimeoutSec) await patch({ stopTimeoutSec: n })
  }

  const commitAppId = async () => {
    const t = appId.trim()
    const n = t === '' ? null : Number(t)
    if (n !== null && (!Number.isInteger(n) || n < 1)) {
      setAppIdError('Enter the whole-number Steam app ID, or leave it empty')
      return
    }
    setAppIdError(null)
    if (n !== server.steamAppId) await patch({ steamAppId: n })
  }

  const closeDelete = () => {
    setConfirmDelete(false)
    setDeleteFolder(false)
  }

  const doDelete = async () => {
    setDeleting(true)
    setDeleteError(null)
    try {
      await deleteServer(server.id, offerDeleteFolder && deleteFolder)
      navigate('/')
    } catch (e) {
      setDeleteError(errorMessage(e))
      setDeleting(false)
    }
  }

  const doAcceptEula = async () => {
    try {
      await acceptEula(server.id)
      setEulaMissing(false)
      checkEula()
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <Stack spacing={3}>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack spacing={0.5}>
          <Typography variant="body2">
            <b>Game:</b> {game?.displayName ?? server.game}
          </Typography>
          <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>
            <b>Folder:</b> <span style={{ fontFamily: 'monospace' }}>{server.folder}</span>
          </Typography>
        </Stack>
      </Paper>

      {server.setupPending && <FinishSetup server={server} game={game} />}

      {eulaMissing && (
        <Alert
          severity="warning"
          action={
            <Button color="inherit" size="small" onClick={() => void doAcceptEula()}>
              Accept EULA
            </Button>
          }
        >
          The Minecraft EULA has not been accepted yet; the server will not start until it is.
        </Alert>
      )}

      <Box>
        <Typography variant="subtitle1" gutterBottom>
          Ports
        </Typography>
        {server.ports.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No ports
          </Typography>
        ) : (
          <Table size="small" sx={{ maxWidth: 560 }}>
            <TableHead>
              <TableRow>
                <TableCell>Port</TableCell>
                <TableCell>Protocol</TableCell>
                <TableCell>Purpose</TableCell>
                <TableCell>Forward on your router</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {server.ports.map((p) => (
                <TableRow key={`${p.port}/${p.protocol}`}>
                  <TableCell>{p.port}</TableCell>
                  <TableCell>{p.protocol.toUpperCase()}</TableCell>
                  <TableCell>{p.purpose}</TableCell>
                  <TableCell>{p.forward ? `${p.port}/${p.protocol.toUpperCase()}` : ''}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Box>

      <Box>
        <Typography variant="subtitle1" gutterBottom>
          Behaviour
        </Typography>
        <Stack sx={{ maxWidth: 480 }}>
          <FormControlLabel
            label="Auto-restart after a crash"
            control={
              <Switch checked={server.autoRestart} disabled={jobRunning} onChange={(e) => void patch({ autoRestart: e.target.checked })} />
            }
          />
          <FormControlLabel
            label="Start with Skáli"
            control={
              <Switch checked={server.autoStart} disabled={jobRunning} onChange={(e) => void patch({ autoStart: e.target.checked })} />
            }
          />
          <TextField
            label="Stop timeout (seconds)"
            type="number"
            size="small"
            value={stopTimeout}
            error={timeoutError !== null}
            helperText={timeoutError ?? 'How long to wait for a graceful stop before forcing it'}
            onChange={(e) => setStopTimeout(e.target.value)}
            onBlur={() => void commitTimeout()}
            disabled={jobRunning}
            slotProps={{ htmlInput: { min: 5, max: 3600 } }}
            sx={{ mt: 2 }}
          />
          {server.game === 'basic' && (
            <TextField
              label="Steam app ID"
              size="small"
              value={appId}
              disabled={jobRunning}
              error={appIdError !== null}
              helperText={appIdError ?? 'Lets Skáli update this server through SteamCMD'}
              onChange={(e) => setAppId(e.target.value)}
              onBlur={() => void commitAppId()}
              slotProps={{ htmlInput: { inputMode: 'numeric' } }}
              sx={{ mt: 2 }}
            />
          )}
        </Stack>
      </Box>

      {canUpdate && (
        <Box>
          <Button variant="outlined" onClick={() => setUpdateOpen(true)}>
            Update
          </Button>
        </Box>
      )}

      <Box>
        <Button color="error" variant="outlined" disabled={!canDelete} onClick={() => {
            setDeleteFolder(false)
            setConfirmDelete(true)
          }}>
          Delete
        </Button>
        {!canDelete && (
          <Typography variant="caption" color="text.secondary" sx={{ ml: 1.5 }}>
            {jobRunning ? `Wait for the ${job.kind} to finish` : 'Stop the server first'}
          </Typography>
        )}
      </Box>

      <Dialog open={confirmDelete} onClose={() => !deleting && closeDelete()}>
        <DialogTitle>Delete {server.name}?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {offerDeleteFolder && deleteFolder
              ? 'Skáli will stop managing this server.'
              : `Skáli will stop managing this server. The game files in ${server.folder} are not deleted.`}
          </DialogContentText>
          {offerDeleteFolder && (
            <FormControlLabel
              label={`Also delete ${server.folder}`}
              control={<Checkbox checked={deleteFolder} disabled={deleting} onChange={(e) => setDeleteFolder(e.target.checked)} />}
            />
          )}
          {deleteError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {deleteError}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => closeDelete()} disabled={deleting}>
            Cancel
          </Button>
          <Button color="error" disabled={deleting} onClick={() => void doDelete()}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      <UpdateDialog open={updateOpen} server={server} onClose={() => setUpdateOpen(false)} />

      <ErrorSnackbar error={error} onClose={() => setError(null)} />
    </Stack>
  )
}
