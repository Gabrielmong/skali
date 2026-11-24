import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Stack,
  TextField,
} from '@mui/material'
import type { ConfigFormat, ConfigSourceView } from '@skali/shared'
import { useState } from 'react'
import { addConfigSource } from '../../api.ts'
import { errorMessage } from '../ServerActions.tsx'
import { FolderPicker } from '../FolderPicker.tsx'

export const FORMAT_LABELS: Record<ConfigFormat, string> = {
  ini: 'INI',
  palworld: 'Palworld settings',
  properties: 'Properties',
  json: 'JSON',
  yaml: 'YAML',
  raw: 'Plain text',
}

/** Mirrors the server's `detectFormat` (apps/server/src/config-formats/doc.ts): the extension decides, else plain text. */
export function detectFormat(relPath: string): ConfigFormat {
  const m = /\.([^./\\]+)$/.exec(relPath.toLowerCase())
  switch (m?.[1]) {
    case 'ini':
      return 'ini'
    case 'properties':
      return 'properties'
    case 'json':
      return 'json'
    case 'yml':
    case 'yaml':
      return 'yaml'
    default:
      return 'raw'
  }
}

const backslashes = (p: string) => p.replace(/\//g, '\\')

/**
 * The path of `file` relative to `folder`, or null when it is not strictly inside it. Windows paths: case-insensitive,
 * either slash. The result keeps the file's own casing and uses backslashes.
 */
export function relativeInside(folder: string, file: string): string | null {
  const base = backslashes(folder).replace(/\\+$/, '')
  const full = backslashes(file)
  if (full.length <= base.length + 1) return null
  if (full.slice(0, base.length + 1).toLowerCase() !== `${base}\\`.toLowerCase()) return null
  const rest = full.slice(base.length + 1)
  return rest === '' ? null : rest
}

const baseName = (p: string) => p.slice(p.lastIndexOf('\\') + 1)

interface Props {
  open: boolean
  serverId: string
  /** The server folder: browsing starts here and the file must be inside it. */
  folder: string
  onClose: () => void
  onAdded: (source: ConfigSourceView) => void
}

function Body({ serverId, folder, onClose, onAdded }: Omit<Props, 'open'>) {
  const [picked, setPicked] = useState<string | null>(null)
  const [format, setFormat] = useState<ConfigFormat>('raw')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const rel = picked === null ? null : relativeInside(folder, picked)
  const outside = picked !== null && rel === null

  const pick = (file: string) => {
    setPicked(file)
    setError(null)
    const r = relativeInside(folder, file)
    if (r !== null) {
      setFormat(detectFormat(r))
      setLabel(baseName(r))
    }
  }

  const add = async () => {
    if (rel === null) return
    setBusy(true)
    setError(null)
    try {
      const name = label.trim()
      onAdded(await addConfigSource(serverId, { path: rel, format, ...(name !== '' ? { label: name } : {}) }))
      onClose()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <>
      <DialogTitle>Add file</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <FolderPicker mode="file" initialPath={folder} disabled={busy} onSelect={pick} />
          {outside && <Alert severity="warning">Pick a file inside the server folder</Alert>}
          <TextField
            label="Path in the server folder"
            size="small"
            value={rel ?? ''}
            slotProps={{ input: { readOnly: true } }}
            fullWidth
          />
          <TextField
            select
            label="Format"
            size="small"
            value={format}
            onChange={(e) => setFormat(e.target.value as ConfigFormat)}
            fullWidth
          >
            {(Object.keys(FORMAT_LABELS) as ConfigFormat[]).map((f) => (
              <MenuItem key={f} value={f}>
                {FORMAT_LABELS[f]}
              </MenuItem>
            ))}
          </TextField>
          <TextField label="Label" size="small" value={label} onChange={(e) => setLabel(e.target.value)} fullWidth />
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" disabled={rel === null || busy} onClick={() => void add()}>
          Add
        </Button>
      </DialogActions>
    </>
  )
}

export function AddSourceDialog({ open, onClose, ...rest }: Props) {
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <Body {...rest} onClose={onClose} />
    </Dialog>
  )
}
