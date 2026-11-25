import { Alert, Box, Card, CardActions, CardContent, Link as MuiLink, Stack, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'
import type { ServerView } from '@skali/shared'
import { Link } from 'react-router'
import { palette } from '../theme/tokens.ts'
import { AddressChip } from './AddressChip.tsx'
import { GameArt } from './catalog/GameArt.tsx'
import { GameIcon } from './GameIcon.tsx'
import { ActionButtons, useNow, useServerActions } from './ServerActions.tsx'
import { ServerStats } from './ServerStats.tsx'
import { RestartPendingChip, StatusChip } from './StatusChip.tsx'

const ease = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

interface Props {
  server: ServerView
  /** The game's Steam header image; without it the banner shows the server's initials. */
  art?: string | undefined
}

export function ServerCard({ server, art }: Props) {
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
        overflow: 'hidden',
        transition: `border-color 180ms ${ease}, box-shadow 180ms ${ease}`,
        '&:hover': {
          borderColor: alpha(palette.frost, 0.35),
          boxShadow: `0 10px 30px ${alpha('#000', 0.3)}`,
        },
        '&:hover [data-art]': { transform: 'scale(1.03)' },
      }}
    >
      <Box data-testid="server-banner" data-live={String(live)} sx={{ position: 'relative', height: 132, overflow: 'hidden' }}>
        <Box
          data-art
          sx={{
            height: '100%',
            transition: `transform 400ms ${ease}, filter 300ms ${ease}`,
            // Stopped servers read as "off" at a glance: muted art; running ones in full colour.
            filter: live ? 'none' : 'grayscale(0.85) brightness(0.55)',
          }}
        >
          <GameArt name={server.name} art={art} fill />
        </Box>
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            background: `linear-gradient(to top, ${palette.surface} 0%, ${alpha(palette.surface, 0.55)} 45%, transparent 100%)`,
          }}
        />
        <Stack
          direction="row"
          spacing={1.5}
          sx={{ position: 'absolute', left: 20, right: 20, bottom: 12, alignItems: 'center', minWidth: 0 }}
        >
          <GameIcon game={server.game} />
          <MuiLink
            component={Link}
            to={`/servers/${encodeURIComponent(server.id)}`}
            variant="h6"
            color="inherit"
            underline="hover"
            sx={{
              flexGrow: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              textShadow: `0 1px 8px ${alpha('#000', 0.6)}`,
            }}
          >
            {server.name}
          </MuiLink>
          <StatusChip status={status} job={server.job} setupPending={server.setupPending} />
        </Stack>
      </Box>

      <CardContent sx={{ flexGrow: 1, pt: 1.5 }}>
        <Stack spacing={1.75}>
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
