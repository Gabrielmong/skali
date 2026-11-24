import Visibility from '@mui/icons-material/Visibility'
import VisibilityOff from '@mui/icons-material/VisibilityOff'
import { FormControlLabel, FormHelperText, IconButton, InputAdornment, Stack, Switch, TextField } from '@mui/material'
import type { FieldSpec, LaunchValues } from '@skali/shared'
import { useState } from 'react'

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
  return (
    <TextField
      label={field.label}
      type={show ? 'text' : 'password'}
      value={value}
      onChange={(e) => onChange(e.target.value)}
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
          case 'number':
            return (
              <TextField
                key={f.key}
                label={f.label}
                type="number"
                value={current ?? ''}
                disabled={disabled}
                helperText={f.help}
                fullWidth
                onChange={(e) => set(f.key, e.target.value === '' ? '' : Number(e.target.value))}
                slotProps={{ htmlInput: { min: f.min, max: f.max } }}
              />
            )
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
