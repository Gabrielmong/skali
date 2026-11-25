import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import type { MinecraftFlavour, ServerView, UpdateRequest } from '@skali/shared'
import { useEffect, useState } from 'react'
import { minecraftVersions, updateServer } from '../api.ts'
import { errorMessage } from './ServerActions.tsx'

interface Props {
  open: boolean
  server: ServerView
  onClose: () => void
}

const FLAVOUR_NAMES: Record<MinecraftFlavour, string> = { vanilla: 'Vanilla', paper: 'Paper' }
const isFlavour = (v: unknown): v is MinecraftFlavour => v === 'vanilla' || v === 'paper'
const CONFIRM = 'Stops the server, backs up the world, updates, and starts it again if it was running'

export function UpdateDialog({ open, server, onClose }: Props) {
  const isMinecraft = server.game === 'minecraft'
  const curFlavour = server.launch.mcFlavour
  const curVersion = server.launch.mcVersion
  const current =
    isFlavour(curFlavour) && typeof curVersion === 'string' && curVersion
      ? `${FLAVOUR_NAMES[curFlavour]} ${curVersion}`
      : 'unknown'

  const [flavour, setFlavour] = useState<MinecraftFlavour>(isFlavour(curFlavour) ? curFlavour : 'vanilla')
  const [versions, setVersions] = useState<string[]>([])
  const [version, setVersion] = useState('')
  const [versionsError, setVersionsError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[] | null>(null)

  // The dialog stays mounted: every open starts clean.
  useEffect(() => {
    if (!open) return
    setWarnings(null)
    setError(null)
    setBusy(false)
  }, [open])

  useEffect(() => {
    if (!open || !isMinecraft) return
    let alive = true
    setVersions([])
    setVersion('')
    setVersionsError(null)
    minecraftVersions(flavour).then(
      (v) => {
        if (!alive) return
        setVersions(v.versions)
        setVersion(v.latest || v.versions[0] || '')
      },
      (e: unknown) => alive && setVersionsError(errorMessage(e)),
    )
    return () => {
      alive = false
    }
  }, [open, isMinecraft, flavour])

  const start = async () => {
    setBusy(true)
    setError(null)
    const req: UpdateRequest = isMinecraft ? { minecraft: { flavour, version } } : {}
    try {
      const out = await updateServer(server.id, req)
      if (out.warnings.length > 0) setWarnings(out.warnings)
      else onClose()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onClose={() => !busy && onClose()} fullWidth maxWidth="xs">
      <DialogTitle>Update {server.name}</DialogTitle>
      <DialogContent>
        <Stack spacing={2}>
          {warnings !== null ? (
            <>
              <DialogContentText>The update has started.</DialogContentText>
              {warnings.map((w) => (
                <Alert key={w} severity="warning">
                  {w}
                </Alert>
              ))}
            </>
          ) : isMinecraft ? (
            <>
              <Typography variant="body2">{`Current: ${current}`}</Typography>
              <TextField
                select
                label="Flavour"
                value={flavour}
                onChange={(e) => setFlavour(e.target.value as MinecraftFlavour)}
                slotProps={{ select: { native: true } }}
                fullWidth
              >
                <option value="vanilla">Vanilla</option>
                <option value="paper">Paper</option>
              </TextField>
              <TextField
                select
                label="Version"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}
                error={!!versionsError}
                helperText={versionsError ?? (versions.length === 0 ? 'Loading versions…' : undefined)}
                fullWidth
              >
                {versions.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </TextField>
              <DialogContentText>{CONFIRM}</DialogContentText>
            </>
          ) : (
            <DialogContentText>{CONFIRM}</DialogContentText>
          )}
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        {warnings !== null ? (
          <Button onClick={onClose}>Close</Button>
        ) : (
          <>
            <Button onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="contained" disabled={busy || (isMinecraft && version === '')} onClick={() => void start()}>
              Update
            </Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  )
}
