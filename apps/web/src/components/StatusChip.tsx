import { Chip, type ChipProps } from '@mui/material'
import type { ServerStatus } from '@skali/shared'

const COLORS: Record<ServerStatus, ChipProps['color']> = {
  running: 'success',
  starting: 'warning',
  stopping: 'warning',
  crashed: 'error',
  stopped: 'default',
}

export function StatusChip({ status }: { status: ServerStatus }) {
  return (
    <Chip
      size="small"
      color={COLORS[status]}
      variant={status === 'stopped' ? 'outlined' : 'filled'}
      label={status.charAt(0).toUpperCase() + status.slice(1)}
      data-status={status}
    />
  )
}
