import DeleteIcon from '@mui/icons-material/Delete'
import WarningAmberIcon from '@mui/icons-material/WarningAmber'
import { Button, IconButton, List, ListItem, ListItemText, Stack, TextField, Typography } from '@mui/material'
import { isValidAllowEntry } from '@skali/shared'
import { useState } from 'react'

export const WIDE_RANGE_WARNING = 'Lets every device in this range control your servers'
const INVALID = 'Enter an IPv4 address or CIDR range, like 192.168.0.5 or 192.168.0.0/25'

/** A valid CIDR whose prefix is /24 or wider (a /32 or a bare address is one device). */
export function isWideRange(entry: string): boolean {
  if (!isValidAllowEntry(entry)) return false
  const prefix = entry.split('/')[1]
  return prefix !== undefined && Number(prefix) <= 24
}

interface Props {
  value: string[]
  onChange: (value: string[]) => void
}

export function AllowlistEditor({ value, onChange }: Props) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const entry = text.trim()

  const add = () => {
    if (!isValidAllowEntry(entry)) return setError(INVALID)
    if (value.includes(entry)) return setError('Already in the list')
    onChange([...value, entry])
    setText('')
    setError(null)
  }

  const typedWarning = error === null && isWideRange(entry) ? WIDE_RANGE_WARNING : undefined

  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
        <TextField
          label="Address or range"
          size="small"
          value={text}
          error={error !== null}
          helperText={error ?? typedWarning ?? ' '}
          slotProps={{ formHelperText: { sx: typedWarning ? { color: 'warning.main' } : undefined } }}
          onChange={(e) => {
            setText(e.target.value)
            setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
          sx={{ flexGrow: 1 }}
        />
        <Button variant="outlined" onClick={add} sx={{ mt: 0.25 }}>
          Add
        </Button>
      </Stack>
      <List dense disablePadding>
        {value.map((e) => (
          <ListItem
            key={e}
            divider
            secondaryAction={
              <IconButton edge="end" aria-label={`Remove ${e}`} onClick={() => onChange(value.filter((x) => x !== e))}>
                <DeleteIcon fontSize="small" />
              </IconButton>
            }
          >
            <ListItemText
              primary={<span style={{ fontFamily: 'monospace' }}>{e}</span>}
              secondary={
                isWideRange(e) ? (
                  <Typography
                    component="span"
                    variant="caption"
                    color="warning.main"
                    sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}
                  >
                    <WarningAmberIcon sx={{ fontSize: 14 }} />
                    {WIDE_RANGE_WARNING}
                  </Typography>
                ) : undefined
              }
            />
          </ListItem>
        ))}
      </List>
    </Stack>
  )
}
