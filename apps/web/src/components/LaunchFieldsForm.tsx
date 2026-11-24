import Visibility from '@mui/icons-material/Visibility'
import VisibilityOff from '@mui/icons-material/VisibilityOff'
import { FormControlLabel, FormHelperText, IconButton, InputAdornment, Stack, Switch, TextField } from '@mui/material'
import type { FieldSpec, LaunchValues } from '@skali/shared'
import { useRef, useState } from 'react'

const MASK = '****'

function numberProblem(f: FieldSpec, v: string | number | boolean | undefined): string | null {
  if (f.type !== 'number' || v === undefined) return null
  const lo = f.min
  const hi = f.max
  const range = lo !== undefined && hi !== undefined ? ` between ${lo} and ${hi}` : lo !== undefined ? ` of at least ${lo}` : hi !== undefined ? ` of at most ${hi}` : ''
  if (v === '' || typeof v !== 'number' || !Number.isFinite(v)) return `Enter a number${range}`
  if ((lo !== undefined && v < lo) || (hi !== undefined && v > hi)) return `Enter a number${range}`
  return null
}

/** False while any number field is empty or out of range; Save/Create should be disabled then. */
export function launchFormValid(fields: FieldSpec[], values: LaunchValues): boolean {
  return fields.every((f) => numberProblem(f, values[f.key] ?? f.default) === null)
}

interface Props {
  fields: FieldSpec[]
  values: LaunchValues
  onChange: (values: LaunchValues) => void
  disabled?: boolean
}

function PasswordField({
  field,
  value,
  onChange,
  disabled,
}: {
  field: FieldSpec
  value: string
  onChange: (v: string) => void
  disabled?: boolean
}) {
  const [show, setShow] = useState(false)
  // Once the baseline was the masked placeholder, emptying the box means "keep the current password", not "clear it".
  const hadStored = useRef(false)
  if (value === MASK) hadStored.current = true
  return (
    <TextField
      label={field.label}
      type={show ? 'text' : 'password'}
      value={value === MASK ? '' : value}
      placeholder={value === MASK ? 'Unchanged' : undefined}
      onChange={(e) => onChange(e.target.value === '' && hadStored.current ? MASK : e.target.value)}
      helperText={field.help}
      disabled={disabled}
      autoComplete="new-password"
      fullWidth
      slotProps={{
        input: {
          endAdornment: (
            <InputAdornment position="end">
              <IconButton
                size="small"
                aria-label={show ? 'Hide password' : 'Show password'}
                onClick={() => setShow((s) => !s)}
                edge="end"
              >
                {show ? <VisibilityOff fontSize="small" /> : <Visibility fontSize="small" />}
              </IconButton>
            </InputAdornment>
          ),
        },
      }}
    />
  )
}

/** One input per declared launch field: switch, number (min/max), masked password with reveal, or text. */
export function LaunchFieldsForm({ fields, values, onChange, disabled }: Props) {
  const set = (key: string, v: string | number | boolean) => onChange({ ...values, [key]: v })
  return (
    <Stack spacing={2}>
      {fields.map((f) => {
        const current = values[f.key] ?? f.default
        switch (f.type) {
          case 'switch':
            return (
              <div key={f.key}>
                <FormControlLabel
                  label={f.label}
                  disabled={disabled}
                  control={<Switch checked={current === true} onChange={(e) => set(f.key, e.target.checked)} />}
                />
                {f.help && <FormHelperText sx={{ mt: -0.5, ml: 0 }}>{f.help}</FormHelperText>}
              </div>
            )
          case 'number': {
            const problem = numberProblem(f, current)
            return (
              <TextField
                key={f.key}
                label={f.label}
                type="number"
                value={current ?? ''}
                disabled={disabled}
                error={problem !== null}
                helperText={problem ?? f.help}
                fullWidth
                onChange={(e) => set(f.key, e.target.value === '' ? '' : Number(e.target.value))}
                slotProps={{ htmlInput: { min: f.min, max: f.max } }}
              />
            )
          }
          case 'password':
            return (
              <PasswordField
                key={f.key}
                field={f}
                value={current === undefined ? '' : String(current)}
                disabled={disabled}
                onChange={(v) => set(f.key, v)}
              />
            )
          default:
            return (
              <TextField
                key={f.key}
                label={f.label}
                value={current === undefined ? '' : String(current)}
                disabled={disabled}
                helperText={f.help}
                fullWidth
                onChange={(e) => set(f.key, e.target.value)}
              />
            )
        }
      })}
    </Stack>
  )
}
