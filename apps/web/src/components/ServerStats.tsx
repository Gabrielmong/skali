import GroupIcon from '@mui/icons-material/Group'
import MemoryIcon from '@mui/icons-material/Memory'
import ScheduleIcon from '@mui/icons-material/Schedule'
import SpeedIcon from '@mui/icons-material/Speed'
import { Box, Stack, Tooltip, Typography } from '@mui/material'
import type { ServerView } from '@skali/shared'
import type { ReactElement, ReactNode } from 'react'
import { formatUptime, gb } from './ServerActions.tsx'

function Stat({ icon, title, children }: { icon: ReactElement; title: string; children: ReactNode }) {
  return (
    <Tooltip title={title}>
      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', '& svg': { fontSize: 16, color: 'text.secondary' } }}>
        {icon}
        <Typography variant="body2" component="span" sx={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
          {children}
        </Typography>
      </Stack>
    </Tooltip>
  )
}

/** Players, uptime, CPU and RAM. Uptime and resources only while live; the row keeps its height when empty. */
export function ServerStats({ server, now }: { server: ServerView; now: number }) {
  const live = server.status === 'running' || server.status === 'starting'
  return (
    <Stack direction="row" useFlexGap sx={{ flexWrap: 'wrap', columnGap: 2, rowGap: 0.5, alignItems: 'center', minHeight: 24 }}>
      {server.players && (
        <Stat icon={<GroupIcon />} title="Players online">
          {`${server.players.online}/${server.players.max}`}
          <Box component="span" sx={{ color: 'text.secondary', fontWeight: 400 }}>
            {' players'}
          </Box>
        </Stat>
      )}
      {live && server.startedAt && (
        <Stat icon={<ScheduleIcon />} title="Uptime">
          {formatUptime(server.startedAt, now)}
        </Stat>
      )}
      {live && server.cpuPct !== undefined && (
        <Stat icon={<SpeedIcon />} title="CPU">{`CPU ${Math.round(server.cpuPct)}%`}</Stat>
      )}
      {live && server.memBytes !== undefined && (
        <Stat icon={<MemoryIcon />} title="Memory">{`RAM ${gb(server.memBytes)} GB`}</Stat>
      )}
    </Stack>
  )
}
