import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import { Alert, Box, Button, Card, CardContent, Stack, Tab, Tabs, Typography } from '@mui/material'
import type { GameInfo } from '@skali/shared'
import { useEffect, useId, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { getGames } from '../api.ts'
import { Console } from '../components/Console.tsx'
import { EmptyState } from '../components/EmptyState.tsx'
import { JobPanel } from '../components/JobPanel.tsx'
import { OverviewTab } from '../components/OverviewTab.tsx'
import { AddressChip } from '../components/AddressChip.tsx'
import { GameIcon } from '../components/GameIcon.tsx'
import { ActionButtons, useNow, useServerActions } from '../components/ServerActions.tsx'
import { ServerStats } from '../components/ServerStats.tsx'
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
  const headingId = useId()

  // A job writes to its own console run: show it when one begins (or when the page opens mid-job).
  const jobRunId = server.job?.runId
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  useEffect(() => {
    if (jobRunId && !dirtyRef.current) setTab('console')
  }, [jobRunId])

  return (
    <Stack spacing={2}>
      <Box>
        <Button component={Link} to="/" size="small" startIcon={<ArrowBackIcon />}>
          All servers
        </Button>
      </Box>
      <Card component="section" aria-labelledby={headingId}>
        <CardContent>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ alignItems: { md: 'center' } }}>
            <Stack direction="row" spacing={2} sx={{ alignItems: 'center', flexGrow: 1, minWidth: 0 }}>
              <GameIcon game={server.game} size="large" />
              <Stack spacing={1} sx={{ minWidth: 0, flexGrow: 1 }}>
                <Stack direction="row" spacing={1.25} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
                  <Typography
                    id={headingId}
                    variant="h5"
                    component="h1"
                    sx={{ minWidth: 0, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {server.name}
                  </Typography>
                  <StatusChip status={server.status} job={server.job} setupPending={server.setupPending} />
                  {server.restartPending && <RestartPendingChip />}
                </Stack>
                <Stack direction="row" useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap', columnGap: 2, rowGap: 1 }}>
                  <ServerStats server={server} now={now} />
                  <AddressChip address={server.connectAddress} onCopy={actions.copyAddress} />
                </Stack>
              </Stack>
            </Stack>
            <Stack direction="row" spacing={1} sx={{ flexShrink: 0, flexWrap: 'wrap' }}>
              <ActionButtons server={server} actions={actions} />
            </Stack>
          </Stack>
          {server.crashPaused && (
            <Typography variant="body2" color="error" sx={{ mt: 2 }}>
              Auto-restart paused after repeated crashes
            </Typography>
          )}
          {server.detail && (
            <Alert severity={server.status === 'crashed' ? 'error' : 'warning'} variant="outlined" sx={{ py: 0, mt: 2 }}>
              {server.detail}
            </Alert>
          )}
        </CardContent>
      </Card>

      {server.job && <JobPanel server={server} />}

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
      <EmptyState title={connected ? 'Server not found' : 'Connecting to Skáli…'} busy={!connected}>
        {connected && (
          <Button component={Link} to="/" variant="contained">
            All servers
          </Button>
        )}
      </EmptyState>
    )
  }
  return <Detail key={server.id} server={server} game={games.find((g) => g.id === server.game)} />
}
