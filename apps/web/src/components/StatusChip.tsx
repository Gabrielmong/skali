import { Chip, type ChipProps } from '@mui/material'
import type { JobView, ServerStatus } from '@skali/shared'

const COLORS: Record<ServerStatus, ChipProps['color']> = {
  running: 'success',
  starting: 'warning',
  stopping: 'warning',
  crashed: 'error',
  stopped: 'default',
}

const JOB_LABELS = {
  install: { running: 'Installing…', failed: 'Install failed' },
  update: { running: 'Updating…', failed: 'Update failed' },
} as const

interface Props {
  status: ServerStatus
  /** A job overrides the supervisor status label. */
  job?: JobView | null
  setupPending?: boolean
}

export function StatusChip({ status, job, setupPending }: Props) {
  if (job) {
    return (
      <Chip
        size="small"
        color={job.state === 'failed' ? 'error' : 'info'}
        label={JOB_LABELS[job.kind][job.state]}
        data-status={`${job.kind}-${job.state}`}
      />
    )
  }
  if (setupPending) {
    return <Chip size="small" color="warning" variant="outlined" label="Finish setup" data-status="setup-pending" />
  }
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

/** Shown beside the status chip while a running server has config changes it has not picked up yet. */
export function RestartPendingChip() {
  return <Chip size="small" color="info" variant="outlined" label="Restart pending" />
}
