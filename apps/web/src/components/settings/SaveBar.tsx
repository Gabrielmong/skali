import { Alert, Button, Paper, Stack, Typography } from '@mui/material'

export interface SaveError {
  message: string
  /** The file changed on disk since it was read (HTTP 409): offer Reload. */
  conflict: boolean
}

interface Props {
  count: number
  /** The pending change is an edit of the raw text, which has no meaningful count. */
  rawEdited?: boolean
  saving: boolean
  canSave: boolean
  error: SaveError | null
  onReset: () => void
  onSave: () => void
  onReload: () => void
}

/** Sticky at the bottom; visible only while there are unsaved changes. */
export function SaveBar({ count, rawEdited, saving, canSave, error, onReset, onSave, onReload }: Props) {
  if (count === 0) return null
  return (
    <Paper
      elevation={6}
      sx={{ position: 'sticky', bottom: 0, zIndex: 2, mt: 3, p: 1.5, borderTop: 1, borderColor: 'divider' }}
    >
      <Stack spacing={1}>
        {error && (
          <Alert
            severity="error"
            action={
              error.conflict ? (
                <Button color="inherit" size="small" onClick={onReload}>
                  Reload
                </Button>
              ) : undefined
            }
          >
            {error.message}
          </Alert>
        )}
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Typography variant="body2" sx={{ flexGrow: 1 }}>
            {rawEdited ? 'Raw text edited' : count === 1 ? '1 change' : `${count} changes`}
          </Typography>
          <Button disabled={saving} onClick={onReset}>
            Reset
          </Button>
          <Button variant="contained" disabled={!canSave || saving} onClick={onSave}>
            Save
          </Button>
        </Stack>
      </Stack>
    </Paper>
  )
}
