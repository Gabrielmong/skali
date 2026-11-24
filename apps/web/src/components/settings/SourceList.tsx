import AddIcon from '@mui/icons-material/Add'
import DeleteIcon from '@mui/icons-material/Delete'
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  MenuItem,
  Stack,
  TextField,
} from '@mui/material'
import type { ConfigSourceView } from '@skali/shared'
import { useState } from 'react'

interface Props {
  sources: ConfigSourceView[]
  selectedId: string
  /** md and up: a list on the left; below that a select above the editor. */
  wide: boolean
  onSelect: (id: string) => void
  onAdd: () => void
  onRemove: (source: ConfigSourceView) => Promise<void>
}

export function SourceList({ sources, selectedId, wide, onSelect, onAdd, onRemove }: Props) {
  const [removing, setRemoving] = useState<ConfigSourceView | null>(null)
  const [busy, setBusy] = useState(false)
  const selected = sources.find((s) => s.id === selectedId)

  const confirmRemove = async () => {
    if (!removing) return
    setBusy(true)
    try {
      await onRemove(removing)
    } finally {
      setBusy(false)
      setRemoving(null)
    }
  }

  const removeButton = (s: ConfigSourceView) => (
    <IconButton edge="end" size="small" aria-label={`Remove ${s.label}`} onClick={() => setRemoving(s)}>
      <DeleteIcon fontSize="small" />
    </IconButton>
  )

  return (
    <Stack spacing={1}>
      {wide ? (
        <List dense disablePadding aria-label="Config files">
          {sources.map((s) => (
            <ListItem key={s.id} disablePadding secondaryAction={s.builtin ? undefined : removeButton(s)}>
              <ListItemButton selected={s.id === selectedId} onClick={() => onSelect(s.id)}>
                <ListItemText primary={s.label} slotProps={{ primary: { noWrap: true } }} />
              </ListItemButton>
            </ListItem>
          ))}
        </List>
      ) : (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <TextField
            select
            label="File"
            size="small"
            value={selectedId}
            onChange={(e) => onSelect(e.target.value)}
            sx={{ flexGrow: 1 }}
          >
            {sources.map((s) => (
              <MenuItem key={s.id} value={s.id}>
                {s.label}
              </MenuItem>
            ))}
          </TextField>
          {selected && !selected.builtin && removeButton(selected)}
        </Stack>
      )}
      <Button size="small" startIcon={<AddIcon />} onClick={onAdd} sx={{ alignSelf: 'flex-start' }}>
        Add file
      </Button>
      <Dialog open={removing !== null} onClose={() => !busy && setRemoving(null)}>
        <DialogTitle>Remove {removing?.label}?</DialogTitle>
        <DialogContent>
          <DialogContentText>Skáli stops listing this file. The file itself is not deleted.</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRemoving(null)} disabled={busy}>
            Cancel
          </Button>
          <Button color="error" disabled={busy} onClick={() => void confirmRemove()}>
            Remove
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}
