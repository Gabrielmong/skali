import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward'
import FolderIcon from '@mui/icons-material/Folder'
import StorageIcon from '@mui/icons-material/Storage'
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Stack,
  Typography,
} from '@mui/material'
import type { FsListing } from '@skali/shared'
import { useEffect, useState } from 'react'
import { browseFs } from '../api.ts'

interface Props {
  /** Called with the folder currently shown. */
  onSelect: (folder: string) => void
  disabled?: boolean
}

const join = (base: string, name: string) => (base.endsWith('\\') ? base + name : `${base}\\${name}`)

/** Browses folders on the server PC (drive list at the top). An unreadable folder shows an error and keeps the last listing. */
export function FolderPicker({ onSelect, disabled }: Props) {
  const [listing, setListing] = useState<FsListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [target, setTarget] = useState<string | undefined>(undefined)

  useEffect(() => {
    let alive = true
    setLoading(true)
    browseFs(target).then(
      (l) => {
        if (!alive) return
        setListing(l)
        setError(null)
        setLoading(false)
      },
      (e: unknown) => {
        if (!alive) return
        setError(e instanceof Error ? e.message : String(e))
        setLoading(false)
      },
    )
    return () => {
      alive = false
    }
  }, [target])

  const path = listing?.path ?? null
  const childOf = (name: string) => (path === null ? name : join(path, name))

  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <Button
          size="small"
          startIcon={<ArrowUpwardIcon />}
          disabled={path === null || loading}
          onClick={() => setTarget(listing?.parent ?? undefined)}
          aria-label="Up"
        >
          Up
        </Button>
        <Typography variant="body2" sx={{ fontFamily: 'monospace', flexGrow: 1, wordBreak: 'break-all' }}>
          {path ?? 'This PC'}
        </Typography>
        {loading && <CircularProgress size={18} />}
      </Stack>
      {error && <Alert severity="error">{error}</Alert>}
      <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, height: 280, overflow: 'auto' }}>
        <List dense disablePadding>
          {listing?.dirs.map((d) => (
            <ListItemButton key={d} disabled={loading} onClick={() => setTarget(childOf(d))}>
              <ListItemIcon sx={{ minWidth: 36 }}>{path === null ? <StorageIcon /> : <FolderIcon />}</ListItemIcon>
              <ListItemText primary={d} />
            </ListItemButton>
          ))}
          {listing && listing.dirs.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
              No subfolders
            </Typography>
          )}
        </List>
      </Box>
      {listing?.truncated && (
        <Typography variant="caption" color="text.secondary">
          This folder has more entries than can be listed.
        </Typography>
      )}
      <Box>
        <Button
          variant="contained"
          disabled={disabled || path === null || loading}
          onClick={() => path !== null && onSelect(path)}
        >
          Use this folder
        </Button>
      </Box>
    </Stack>
  )
}
