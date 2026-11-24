import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  Paper,
  Snackbar,
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
import { MINECRAFT_EULA_NOTE, type FieldSpec, type GameInfo, type LaunchValues, type ServerView } from '@skali/shared'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { acceptEula, deleteServer, inspectFolder, patchServer, type ServerPatch } from '../api.ts'
import { ErrorSnackbar, errorMessage } from './ServerActions.tsx'
import { LaunchFieldsForm, launchFormValid } from './LaunchFieldsForm.tsx'

interface Props {
  server: ServerView
  game: GameInfo | undefined
  /** Restart with the same player confirmation as the card. */
  onRestart: () => void
}

/** Only the keys the game declares: the server rejects any other launch key. */
function declaredOnly(launch: LaunchValues, fields: FieldSpec[]): LaunchValues {
  const out: LaunchValues = {}
  for (const f of fields) if (launch[f.key] !== undefined) out[f.key] = launch[f.key]!
  return out
}

const sameLaunch = (a: LaunchValues, b: LaunchValues) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b))
const sortKeys = (o: LaunchValues) => Object.fromEntries(Object.entries(o).sort(([x], [y]) => x.localeCompare(y)))

export function OverviewTab({ server, game, onRestart }: Props) {
  const navigate = useNavigate()
  const fields = useMemo(() => game?.launchFields ?? [], [game])
  const saved = useMemo(() => declaredOnly(server.launch, fields), [server.launch, fields])
  const [values, setValues] = useState<LaunchValues>(saved)
  const [stopTimeout, setStopTimeout] = useState(String(server.stopTimeoutSec))
  const [timeoutError, setTimeoutError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [needsRestart, setNeedsRestart] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [eulaMissing, setEulaMissing] = useState(false)

  // `baseline` is the last server copy the form was reconciled with; unsaved edits survive server updates.
  const [baseline, setBaseline] = useState(saved)
  const [seen, setSeen] = useState(saved)
  if (seen !== saved) {
    if (sameLaunch(values, baseline)) setValues(saved)
    setBaseline(saved)
    setSeen(saved)
  }
  useEffect(() => setStopTimeout(String(server.stopTimeoutSec)), [server.stopTimeoutSec])

  const dirty = !sameLaunch(values, baseline)
  const valid = launchFormValid(fields, values)
  const running = server.status === 'running' || server.status === 'starting' || server.status === 'stopping'
  const canDelete = server.status === 'stopped' || server.status === 'crashed'

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

  const save = async () => {
    setSaving(true)
    const view = await patch({ launch: values })
    setSaving(false)
    if (!view) return
    // The view masks passwords again; drop any plaintext the user typed.
    const next = declaredOnly(view.launch, fields)
    setValues(next)
    setBaseline(next)
    if (running) setNeedsRestart(true)
    else setToast('Saved')
  }

  const commitTimeout = async () => {
    const n = Number(stopTimeout)
    if (!Number.isInteger(n) || n < 5 || n > 3600) {
      setTimeoutError('Enter a whole number of seconds between 5 and 3600')
      return
    }
    setTimeoutError(null)
    if (n !== server.stopTimeoutSec) await patch({ stopTimeoutSec: n })
  }

  const doDelete = async () => {
    setDeleting(true)
    setDeleteError(null)
    try {
      await deleteServer(server.id)
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
          Launch settings
        </Typography>
        <Stack spacing={2} sx={{ maxWidth: 480 }}>
          {fields.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              This game has no launch settings.
            </Typography>
          ) : (
            <LaunchFieldsForm fields={fields} values={values} onChange={setValues} disabled={saving} />
          )}
          {needsRestart && (
            <Alert
              severity="info"
              action={
                <Button
                  color="inherit"
                  size="small"
                  onClick={() => {
                    setNeedsRestart(false)
                    onRestart()
                  }}
                >
                  Restart
                </Button>
              }
              onClose={() => setNeedsRestart(false)}
            >
              Takes effect on next start. Restart now?
            </Alert>
          )}
          {fields.length > 0 && (
            <Box>
              <Button variant="contained" disabled={!dirty || !valid || saving} onClick={() => void save()}>
                Save
              </Button>
            </Box>
          )}
        </Stack>
      </Box>

      <Box>
        <Typography variant="subtitle1" gutterBottom>
          Behaviour
        </Typography>
        <Stack sx={{ maxWidth: 480 }}>
          <FormControlLabel
            label="Auto-restart after a crash"
            control={
              <Switch checked={server.autoRestart} onChange={(e) => void patch({ autoRestart: e.target.checked })} />
            }
          />
          <FormControlLabel
            label="Start with Skáli"
            control={
              <Switch checked={server.autoStart} onChange={(e) => void patch({ autoStart: e.target.checked })} />
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
            slotProps={{ htmlInput: { min: 5, max: 3600 } }}
            sx={{ mt: 2 }}
          />
        </Stack>
      </Box>

      <Box>
        <Button color="error" variant="outlined" disabled={!canDelete} onClick={() => setConfirmDelete(true)}>
          Delete
        </Button>
        {!canDelete && (
          <Typography variant="caption" color="text.secondary" sx={{ ml: 1.5 }}>
            Stop the server first
          </Typography>
        )}
      </Box>

      <Dialog open={confirmDelete} onClose={() => !deleting && setConfirmDelete(false)}>
        <DialogTitle>Delete {server.name}?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Skáli will stop managing this server. The game files in {server.folder} are not deleted.
          </DialogContentText>
          {deleteError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {deleteError}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmDelete(false)} disabled={deleting}>
            Cancel
          </Button>
          <Button color="error" disabled={deleting} onClick={() => void doDelete()}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      <Snackbar open={toast !== null} autoHideDuration={2500} onClose={() => setToast(null)} message={toast} />
      <ErrorSnackbar error={error} onClose={() => setError(null)} />
    </Stack>
  )
}
