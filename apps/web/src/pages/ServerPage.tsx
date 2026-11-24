import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import { Alert, Box, Button, IconButton, Stack, Tab, Tabs, Tooltip, Typography } from '@mui/material'
import type { GameInfo } from '@skali/shared'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { getGames } from '../api.ts'
import { Console } from '../components/Console.tsx'
import { OverviewTab } from '../components/OverviewTab.tsx'
import { ActionButtons, formatUptime, useNow, useServerActions } from '../components/ServerActions.tsx'
import { SettingsTab } from '../components/settings/SettingsTab.tsx'
import { RestartPendingChip, StatusChip } from '../components/StatusChip.tsx'
import { useServerLogs, useServers } from '../live.tsx'
import type { ServerView } from '@skali/shared'

type TabId = 'console' | 'settings' | 'overview'

function Detail({ server, game }: { server: ServerView; game: GameInfo | undefined }) {
  const [tab, setTab] = useState<TabId>('console')
  const [dirty, setDirty] = useState(false)
  const actions = useServerActions(server)
  const logs = useServerLogs(server.id)
  const live = server.status === 'running' || server.status === 'starting'
  const now = useNow(live && !!server.startedAt)

  return (
    <Stack spacing={2}>
      <Box>
        <Button component={Link} to="/" size="small" startIcon={<ArrowBackIcon />}>
          All servers
        </Button>
      </Box>
      <Stack direction="row" spacing={1.5} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <Typography variant="h5" sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {server.name}
        </Typography>
        <StatusChip status={server.status} />
        {server.restartPending && <RestartPendingChip />}
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
        <Stack direction="row" sx={{ alignItems: 'center' }}>
          <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
            {server.connectAddress}
          </Typography>
          <Tooltip title="Copy address">
            <IconButton size="small" aria-label="Copy address" onClick={actions.copyAddress}>
              <ContentCopyIcon fontSize="inherit" />
            </IconButton>
          </Tooltip>
        </Stack>
        <Box sx={{ flexGrow: 1 }} />
        <Stack direction="row" spacing={1}>
          <ActionButtons server={server} actions={actions} />
        </Stack>
      </Stack>
      {server.crashPaused && (
        <Typography variant="body2" color="error">
          Auto-restart paused after repeated crashes
        </Typography>
      )}
      {server.detail && (
        <Alert severity={server.status === 'crashed' ? 'error' : 'warning'} variant="outlined" sx={{ py: 0 }}>
          {server.detail}
        </Alert>
      )}

      <Tabs
        value={tab}
        onChange={(_, v: TabId) => {
          if (v === tab) return
          // Leaving Settings drops its unsaved edits.
          if (dirty && !window.confirm('Discard unsaved changes?')) return
          setDirty(false)
          setTab(v)
        }}
      >
        <Tab value="console" label="Console" />
        <Tab value="settings" label="Settings" />
        <Tab value="overview" label="Overview" />
      </Tabs>
      {tab === 'console' ? (
        <Console
          serverId={server.id}
          lines={logs.lines}
          liveRunId={logs.runId}
          hasCommands={server.hasCommands}
          {...(server.commandHelp ? { commandHelp: server.commandHelp } : {})}
        />
      ) : tab === 'settings' ? (
        <SettingsTab
          server={server}
          game={game}
          onRestart={() => actions.ask('restart')}
          onDirtyChange={setDirty}
        />
      ) : (
        <OverviewTab server={server} game={game} />
      )}
      {actions.ui}
    </Stack>
  )
}

export function ServerPage() {
  const { id = '' } = useParams()
  const { servers, connected } = useServers()
  const [games, setGames] = useState<GameInfo[]>([])

  useEffect(() => {
    let alive = true
    getGames().then(
      (g) => alive && setGames(g),
      () => undefined,
    )
    return () => {
      alive = false
    }
  }, [])

  const server = servers.find((s) => s.id === id)
  if (!server) {
    return (
      <Box sx={{ textAlign: 'center', mt: 8 }}>
        <Typography variant="h6" gutterBottom>
          {connected ? 'Server not found' : 'Connecting to Skáli…'}
        </Typography>
        {connected && (
          <Button component={Link} to="/" variant="contained">
            All servers
          </Button>
        )}
      </Box>
    )
  }
  return <Detail key={server.id} server={server} game={games.find((g) => g.id === server.game)} />
}
