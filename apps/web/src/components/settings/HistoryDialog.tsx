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
  List,
  ListItemButton,
  ListItemText,
  Stack,
  Typography,
} from '@mui/material'
import type { ConfigFormat, ConfigHistoryEntry, ConfigSaveResult } from '@skali/shared'
import { useEffect, useRef, useState } from 'react'
import { configHistory, configHistoryRaw, restoreConfig } from '../../api.ts'
import { errorMessage } from '../ServerActions.tsx'
import { RawEditor } from './RawEditor.tsx'

interface Props {
  open: boolean
  serverId: string
  sourceId: string
  /** Picks the syntax highlighting for the saved text. */
  format: ConfigFormat
  /** The etag of the file as last read; restore is refused when the file has changed since. */
  etag: string
  onClose: () => void
  onRestored: (result: ConfigSaveResult) => void
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function Body({ serverId, sourceId, format, etag, onClose, onRestored }: Omit<Props, 'open'>) {
  const [entries, setEntries] = useState<ConfigHistoryEntry[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [raw, setRaw] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  /** The entry whose text was asked for last; a slower earlier answer must not replace it. */
  const latest = useRef<string | null>(null)

  useEffect(() => {
    let alive = true
    configHistory(serverId, sourceId).then(
      (list) => alive && setEntries([...list].sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt))),
      (e: unknown) => {
        if (!alive) return
        setEntries([])
        setError(errorMessage(e))
      },
    )
    return () => {
      alive = false
    }
  }, [serverId, sourceId])

  const pick = (id: string) => {
    latest.current = id
    setSelected(id)
    setRaw(null)
    setError(null)
    configHistoryRaw(serverId, sourceId, id).then(
      (r) => {
        if (latest.current === id) setRaw(r.raw)
      },
      (e: unknown) => {
        if (latest.current === id) setError(errorMessage(e))
      },
    )
  }

  const restore = async () => {
    if (selected === null) return
    setBusy(true)
    try {
      const result = await restoreConfig(serverId, sourceId, selected, etag)
      onRestored(result)
      onClose()
    } catch (e) {
      setConfirm(false)
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <>
      <DialogTitle>History</DialogTitle>
      <DialogContent>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        {entries === null ? (
          <CircularProgress size={24} />
        ) : entries.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No earlier versions yet. Each save keeps the version it replaced.
          </Typography>
        ) : (
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
            <List dense sx={{ width: { md: 240 }, flexShrink: 0, maxHeight: 360, overflow: 'auto' }}>
              {entries.map((e) => (
                <ListItemButton key={e.id} selected={e.id === selected} onClick={() => pick(e.id)}>
                  <ListItemText primary={new Date(e.savedAt).toLocaleString()} secondary={formatSize(e.sizeBytes)} />
                </ListItemButton>
              ))}
            </List>
            <Box sx={{ flexGrow: 1, minWidth: 0 }} role="region" aria-label="Saved version">
              {selected === null || raw === null ? (
                <Typography variant="body2" color="text.secondary">
                  {selected === null ? 'Pick a version to see its text.' : 'Loading…'}
                </Typography>
              ) : (
                <RawEditor value={raw} format={format} readOnly />
              )}
            </Box>
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Close
        </Button>
        <Button variant="contained" disabled={selected === null || raw === null || busy} onClick={() => setConfirm(true)}>
          Restore
        </Button>
      </DialogActions>
      <Dialog open={confirm} onClose={() => !busy && setConfirm(false)}>
        <DialogTitle>Restore this version?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            The file is replaced with the selected version. Unsaved edits in the form are dropped, and the version being
            replaced is kept in the history.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirm(false)} disabled={busy}>
            Cancel
          </Button>
          <Button color="error" disabled={busy} onClick={() => void restore()}>
            Restore this version
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}

export function HistoryDialog({ open, onClose, ...rest }: Props) {
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
      <Body {...rest} onClose={onClose} />
    </Dialog>
  )
}
