import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import ErrorIcon from '@mui/icons-material/Error'
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked'
import BlockIcon from '@mui/icons-material/Block'
import { Alert, Button, CircularProgress, LinearProgress, Paper, Stack, Typography } from '@mui/material'
import type { JobStepState, ServerView } from '@skali/shared'
import { useState, type ReactElement } from 'react'
import { retryInstall } from '../api.ts'
import { errorMessage } from './ServerActions.tsx'

const ICONS: Record<JobStepState, ReactElement> = {
  pending: <RadioButtonUncheckedIcon fontSize="small" color="disabled" />,
  running: <CircularProgress size={18} />,
  done: <CheckCircleIcon fontSize="small" color="success" />,
  failed: <ErrorIcon fontSize="small" color="error" />,
  skipped: <BlockIcon fontSize="small" color="disabled" />,
}

const TITLES = {
  install: { running: 'Installing', failed: 'Install failed' },
  update: { running: 'Updating', failed: 'Update failed' },
} as const

/** The install/update in progress (or the failure it stopped at); the job's output streams in the Console below. */
export function JobPanel({ server }: { server: ServerView }) {
  const { job } = server
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState<string | null>(null)
  if (!job) return null

  const retry = async () => {
    setRetrying(true)
    setRetryError(null)
    try {
      await retryInstall(server.id)
    } catch (e) {
      setRetryError(errorMessage(e))
    } finally {
      setRetrying(false)
    }
  }

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={1.5}>
        <Typography variant="subtitle1">{TITLES[job.kind][job.state]}</Typography>
        <Stack component="ul" spacing={0.75} sx={{ listStyle: 'none', m: 0, p: 0 }}>
          {job.steps.map((s) => (
            <Stack
              component="li"
              key={s.id}
              direction="row"
              spacing={1}
              data-step-state={s.state}
              sx={{ alignItems: 'center', color: s.state === 'pending' || s.state === 'skipped' ? 'text.secondary' : 'text.primary' }}
            >
              {ICONS[s.state]}
              <Typography variant="body2">{s.label}</Typography>
            </Stack>
          ))}
        </Stack>
        {job.progress !== null && (
          <LinearProgress variant="determinate" value={Math.round(Math.min(100, Math.max(0, job.progress)))} aria-label="Progress" />
        )}
        {job.error && <Alert severity="error">{job.error}</Alert>}
        {retryError && <Alert severity="error">{retryError}</Alert>}
        {job.kind === 'install' && job.state === 'failed' && (
          <div>
            <Button variant="contained" disabled={retrying} onClick={() => void retry()}>
              Retry
            </Button>
          </div>
        )}
      </Stack>
    </Paper>
  )
}
