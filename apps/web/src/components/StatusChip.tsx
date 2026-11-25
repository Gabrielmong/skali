import { Box, Chip, type SxProps, type Theme } from '@mui/material'
import type { JobView, ServerStatus } from '@skali/shared'

type Tone = 'success' | 'warning' | 'error' | 'info' | 'neutral'

const TONES: Record<ServerStatus, Tone> = {
  running: 'success',
  starting: 'warning',
  stopping: 'warning',
  crashed: 'error',
  stopped: 'neutral',
}

const JOB_LABELS = {
  install: { running: 'Installing…', failed: 'Install failed' },
  update: { running: 'Updating…', failed: 'Update failed' },
} as const

/** Soft pill: tinted background and text in the tone's colour; a glowing dot when `dot` is set. */
function Pill({ tone, label, dot, sx, ...rest }: { tone: Tone; label: string; dot?: boolean; sx?: SxProps<Theme>; 'data-status'?: string }) {
  const color = tone === 'neutral' ? 'var(--mui-palette-text-secondary)' : `var(--mui-palette-${tone}-main)`
  return (
    <Chip
      size="small"
      label={label}
      {...rest}
      icon={
        dot ? (
          <Box
            component="span"
            sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: color, boxShadow: `0 0 6px ${color}`, ml: '8px !important' }}
          />
        ) : undefined
      }
      sx={[
        {
          flexShrink: 0,
          color,
          bgcolor: tone === 'neutral' ? 'transparent' : `color-mix(in srgb, ${color} 14%, transparent)`,
          border: '1px solid',
          borderColor: `color-mix(in srgb, ${color} ${tone === 'neutral' ? 30 : 28}%, transparent)`,
        },
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
    />
  )
}

interface Props {
  status: ServerStatus
  /** A job overrides the supervisor status label. */
  job?: JobView | null
  setupPending?: boolean
}

export function StatusChip({ status, job, setupPending }: Props) {
  if (job) {
    return (
      <Pill
        tone={job.state === 'failed' ? 'error' : 'info'}
        dot={job.state === 'running'}
        label={JOB_LABELS[job.kind][job.state]}
        data-status={`${job.kind}-${job.state}`}
      />
    )
  }
  if (setupPending) {
    return <Pill tone="warning" label="Finish setup" data-status="setup-pending" />
  }
  return (
    <Pill
      tone={TONES[status]}
      dot={status !== 'stopped'}
      label={status.charAt(0).toUpperCase() + status.slice(1)}
      data-status={status}
    />
  )
}

/** Shown beside the status chip while a running server has config changes it has not picked up yet. */
export function RestartPendingChip({ sx }: { sx?: SxProps<Theme> }) {
  return <Pill tone="info" label="Restart pending" {...(sx ? { sx } : {})} />
}
