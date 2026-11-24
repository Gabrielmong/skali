import LockIcon from '@mui/icons-material/Lock'
import Visibility from '@mui/icons-material/Visibility'
import VisibilityOff from '@mui/icons-material/VisibilityOff'
import {
  Box,
  FormControlLabel,
  FormHelperText,
  IconButton,
  InputAdornment,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import type { ConfigFieldView } from '@skali/shared'
import { useMemo, useState } from 'react'
import { isChanged, numberProblem, type EditValue, type Edits } from './changes.ts'

interface Props {
  fields: ConfigFieldView[]
  edits: Edits
  onChange: (id: string, value: EditValue) => void
  disabled?: boolean
}

const labelOf = (f: ConfigFieldView) => f.label ?? f.key

function matches(f: ConfigFieldView, q: string): boolean {
  return [f.key, f.label, f.help].some((s) => s !== undefined && s.toLowerCase().includes(q))
}

interface FieldProps {
  field: ConfigFieldView
  edit: EditValue | undefined
  onChange: (value: EditValue) => void
  disabled: boolean
}

function Field({ field: f, edit, onChange, disabled }: FieldProps) {
  const [show, setShow] = useState(false)
  const label = labelOf(f)
  const locked = f.locked !== undefined
  const off = disabled || locked
  const value = edit ?? f.value
  const helper = locked ? f.locked : f.help
  const lockIcon = locked ? (
    <Tooltip title={f.locked}>
      <LockIcon fontSize="small" color="action" aria-label="Locked" />
    </Tooltip>
  ) : null
  const unit = f.unit ? <InputAdornment position="end">{f.unit}</InputAdornment> : undefined

  switch (f.type) {
    case 'switch':
      return (
        <div>
          <Stack direction="row" sx={{ alignItems: 'center' }}>
            <FormControlLabel
              label={label}
              disabled={off}
              control={
                <Switch
                  checked={value === true || value === 'true'}
                  onChange={(e) => onChange(e.target.checked)}
                />
              }
            />
            {lockIcon}
          </Stack>
          {helper && <FormHelperText sx={{ mt: -0.5, ml: 0 }}>{helper}</FormHelperText>}
        </div>
      )
    case 'number': {
      const problem = numberProblem(f, edit)
      return (
        <TextField
          label={label}
          type="number"
          value={typeof value === 'boolean' ? '' : value}
          disabled={off}
          error={problem !== null}
          helperText={problem ?? helper}
          fullWidth
          onChange={(e) => onChange(e.target.value)}
          slotProps={{
            htmlInput: { min: f.min, max: f.max, step: f.step },
            input: { endAdornment: unit ?? (lockIcon ? <InputAdornment position="end">{lockIcon}</InputAdornment> : undefined) },
          }}
        />
      )
    }
    case 'select': {
      const current = String(value)
      const options = f.options?.includes(current) ? f.options : [current, ...(f.options ?? [])]
      return (
        <TextField
          select
          label={label}
          value={current}
          disabled={off}
          helperText={helper}
          fullWidth
          onChange={(e) => onChange(e.target.value)}
        >
          {options.map((o) => (
            <MenuItem key={o} value={o}>
              {o === '' ? '(empty)' : o}
            </MenuItem>
          ))}
        </TextField>
      )
    }
    case 'secret':
      return (
        <TextField
          label={label}
          type={show ? 'text' : 'password'}
          value={String(value)}
          disabled={off}
          helperText={helper}
          fullWidth
          autoComplete="new-password"
          onChange={(e) => onChange(e.target.value)}
          slotProps={{
            input: {
              endAdornment: (
                <InputAdornment position="end">
                  {lockIcon}
                  <IconButton
                    size="small"
                    edge="end"
                    aria-label={`${show ? 'Hide' : 'Show'} ${label}`}
                    onClick={() => setShow((s) => !s)}
                  >
                    {show ? <VisibilityOff fontSize="small" /> : <Visibility fontSize="small" />}
                  </IconButton>
                </InputAdornment>
              ),
            },
          }}
        />
      )
    default:
      return (
        <TextField
          label={label}
          value={String(value)}
          disabled={off}
          helperText={helper}
          fullWidth
          onChange={(e) => onChange(e.target.value)}
          slotProps={{
            input: { endAdornment: unit ?? (lockIcon ? <InputAdornment position="end">{lockIcon}</InputAdornment> : undefined) },
          }}
        />
      )
  }
}

/** The settings of one file, grouped, filterable, one input per field by type. */
export function ConfigForm({ fields, edits, onChange, disabled = false }: Props) {
  const [filter, setFilter] = useState('')
  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const out = new Map<string, ConfigFieldView[]>()
    for (const f of fields) {
      if (q !== '' && !matches(f, q)) continue
      const g = f.group ?? f.section ?? ''
      const list = out.get(g)
      if (list) list.push(f)
      else out.set(g, [f])
    }
    return [...out.entries()]
  }, [fields, filter])

  return (
    <Stack spacing={2}>
      <TextField
        label="Filter settings"
        size="small"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        sx={{ maxWidth: 360 }}
      />
      {groups.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          {fields.length === 0 ? 'This file has no settings the form can show.' : 'No settings match the filter.'}
        </Typography>
      )}
      {groups.map(([name, list]) => (
        <Stack key={name} spacing={2}>
          {name !== '' && (
            <Typography variant="subtitle2" color="text.secondary">
              {name}
            </Typography>
          )}
          {list.map((f) => {
            const changed = isChanged(f, edits[f.id])
            return (
              <Box
                key={f.id}
                sx={{
                  maxWidth: 560,
                  pl: 1.5,
                  borderLeft: 3,
                  borderColor: changed ? 'primary.main' : 'transparent',
                }}
              >
                <Field field={f} edit={edits[f.id]} disabled={disabled} onChange={(v) => onChange(f.id, v)} />
              </Box>
            )
          })}
        </Stack>
      ))}
    </Stack>
  )
}
