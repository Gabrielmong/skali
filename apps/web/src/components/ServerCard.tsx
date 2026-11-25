import { Alert, Card, CardActions, CardContent, Link as MuiLink, Stack, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'
import type { ServerView } from '@skali/shared'
import { Link } from 'react-router'
import { palette } from '../theme/tokens.ts'
import { AddressChip } from './AddressChip.tsx'
import { GameIcon } from './GameIcon.tsx'
import { ActionButtons, useNow, useServerActions } from './ServerActions.tsx'
import { ServerStats } from './ServerStats.tsx'
import { RestartPendingChip, StatusChip } from './StatusChip.tsx'

export function ServerCard({ server }: { server: ServerView }) {
  const { status } = server
  const live = status === 'running' || status === 'starting'
  const now = useNow(live && !!server.startedAt)
  const actions = useServerActions(server)

  return (
    <Card
      sx={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        transition: 'border-color 160ms cubic-bezier(0.2, 0.8, 0.2, 1)',
        '&:hover': { borderColor: alpha(palette.frost, 0.35) },
      }}
    >
      <CardContent sx={{ flexGrow: 1 }}>
        <Stack spacing={1.75}>
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', minWidth: 0 }}>
            <GameIcon game={server.game} />
            <MuiLink
              component={Link}
              to={`/servers/${encodeURIComponent(server.id)}`}
              variant="h6"
              color="inherit"
              underline="hover"
              sx={{ flexGrow: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {server.name}
            </MuiLink>
            <StatusChip status={status} job={server.job} setupPending={server.setupPending} />
          </Stack>

          {server.restartPending && <RestartPendingChip sx={{ alignSelf: 'flex-start' }} />}

          <ServerStats server={server} now={now} />

          {server.crashPaused && (
            <Typography variant="body2" color="error">
              Auto-restart paused after repeated crashes
            </Typography>
          )}
          {server.detail && (
            <Alert severity={status === 'crashed' ? 'error' : 'warning'} variant="outlined" sx={{ py: 0 }}>
              {server.detail}
            </Alert>
          )}

          <AddressChip address={server.connectAddress} onCopy={actions.copyAddress} />
        </Stack>
      </CardContent>

      <CardActions sx={{ px: 2.5, pb: 2.5, pt: 0, gap: 1 }}>
        <ActionButtons server={server} actions={actions} />
      </CardActions>

      {actions.ui}
    </Card>
  )
}
