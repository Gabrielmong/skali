import { Stack, TextField } from '@mui/material'
import type { PortClash } from '@skali/shared'

export interface PortRow {
  /** Stable key (a launch key such as `port`, or `p0` for a catalog port). */
  id: string
  label: string
  protocol: 'udp' | 'tcp'
  /** The text in the box; may be empty or invalid while the owner types. */
  value: string
  /** How many consecutive ports this entry uses starting at `value` (Valheim uses 3). Default 1. */
  span?: number
}

/** The row's port as a number, or null when the text isn't a usable port. */
export function parsePort(row: PortRow): number | null {
  if (!/^\d+$/.test(row.value.trim())) return null
  const n = Number(row.value)
  return n >= 1 && n + (row.span ?? 1) - 1 <= 65535 ? n : null
}

/** One editable box per port the new server will use, each showing any clash `checkPorts` reported for it. */
export function PortsField({
  rows,
  clashes,
  onChange,
  disabled,
}: {
  rows: PortRow[]
  clashes: PortClash[]
  onChange: (id: string, value: string) => void
  disabled?: boolean
}) {
  return (
    <Stack spacing={1.5}>
      {rows.map((r) => {
        const n = parsePort(r)
        const mine = n === null ? [] : clashes.filter((c) => c.protocol === r.protocol && c.port >= n && c.port < n + (r.span ?? 1))
        const invalid = n === null
        const span = r.span ?? 1
        return (
          <TextField
            key={r.id}
            label={r.label}
            value={r.value}
            onChange={(e) => onChange(r.id, e.target.value)}
            disabled={disabled}
            error={invalid || mine.length > 0}
            helperText={
              invalid
                ? 'Enter a port from 1 to 65535'
                : mine.length > 0
                  ? mine.map((c) => c.reason).join('; ')
                  : `${r.protocol.toUpperCase()}${span > 1 ? `, uses ${n}-${n + span - 1}` : ''}`
            }
            slotProps={{ htmlInput: { inputMode: 'numeric' } }}
            fullWidth
          />
        )
      })}
    </Stack>
  )
}
