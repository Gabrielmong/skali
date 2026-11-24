import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import DnsIcon from '@mui/icons-material/Dns'
import PetsIcon from '@mui/icons-material/Pets'
import SecurityIcon from '@mui/icons-material/Security'
import ViewInArIcon from '@mui/icons-material/ViewInAr'
import {
  Alert,
  Box,
  Card,
  CardActions,
  CardContent,
  IconButton,
  Link as MuiLink,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material'
import type { GameId, ServerView } from '@skali/shared'
import type { ReactElement } from 'react'
import { Link } from 'react-router'
import { ActionButtons, formatUptime, gb, useNow, useServerActions } from './ServerActions.tsx'
import { StatusChip } from './StatusChip.tsx'

const GAME_ICONS: Record<GameId, ReactElement> = {
  palworld: <PetsIcon />,
  valheim: <SecurityIcon />,
  minecraft: <ViewInArIcon />,
  basic: <DnsIcon />,
}

export function ServerCard({ server }: { server: ServerView }) {
  const { status } = server
  const live = status === 'running' || status === 'starting'
  const now = useNow(live && !!server.startedAt)
  const actions = useServerActions(server)

  const stats: string[] = []
  if (live) {
    if (server.cpuPct !== undefined) stats.push(`CPU ${Math.round(server.cpuPct)}%`)
    if (server.memBytes !== undefined) stats.push(`RAM ${gb(server.memBytes)} GB`)
  }

  return (
    <Card variant="outlined" sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <CardContent sx={{ flexGrow: 1 }}>
        <Stack spacing={1.25}>
          <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
            <Box sx={{ color: 'text.secondary', display: 'flex' }}>{GAME_ICONS[server.game]}</Box>
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
            <StatusChip status={status} />
          </Stack>

          <Stack direction="row" spacing={2} sx={{ alignItems: "center", minHeight: 24 }}>
            {live && server.startedAt && (
              <Typography variant="body2" color="text.secondary">
                {formatUptime(server.startedAt, now)}
              </Typography>
            )}
            {server.players && (
              <Tooltip title="Players online">
                <Typography variant="body2">{`${server.players.online}/${server.players.max}`}</Typography>
              </Tooltip>
            )}
            {stats.length > 0 && (
              <Typography variant="body2" color="text.secondary">
                {stats.join(' · ')}
              </Typography>
            )}
          </Stack>

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

          <Stack direction="row" sx={{ alignItems: "center" }}>
            <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
              {server.connectAddress}
            </Typography>
            <Tooltip title="Copy address">
              <IconButton size="small" aria-label="Copy address" onClick={actions.copyAddress}>
                <ContentCopyIcon fontSize="inherit" />
              </IconButton>
            </Tooltip>
          </Stack>
        </Stack>
      </CardContent>

      <CardActions sx={{ px: 2, pb: 2, gap: 1 }}>
        <ActionButtons server={server} actions={actions} />
      </CardActions>

      {actions.ui}
    </Card>
  )
}
