import { Box, Button, Link as MuiLink, List, ListItem, ListItemButton, Stack, Tooltip, Typography } from '@mui/material'
import type { DeployEventView } from '@skali/shared'

export const shortSha = (sha: string) => sha.slice(0, 7)

/** The helper stores a status and a bare detail; FAILED and SKIPPED show the detail in brackets. */
export function statusText(e: Pick<DeployEventView, 'status' | 'detail'>): string {
  const s = e.status.toLowerCase()
  return (e.status === 'FAILED' || e.status === 'SKIPPED') && e.detail ? `${s} (${e.detail})` : s
}

const KIND: Record<DeployEventView['kind'], string> = {
  DEPLOY: 'Deploy',
  ROLLBACK: 'Rollback',
  RESTART: 'Restart',
  PAUSE: 'Pause',
  RESUME: 'Resume',
}

export interface DeployEventListProps {
  events: DeployEventView[]
  selectedId: string | null
  onSelect: (id: string) => void
  onRollback: (e: DeployEventView) => void
  disabled?: boolean
}

export function DeployEventList({ events, selectedId, onSelect, onRollback, disabled }: DeployEventListProps) {
  if (events.length === 0) return <Typography sx={{ p: 2 }} color="text.secondary">No deploys yet.</Typography>
  return (
    <List disablePadding aria-label="Deploy history">
      {events.map((e) => {
        const showRollback = e.canRollback || e.rollbackBlockedReason !== undefined
        const blocked = !e.canRollback
        const selected = e.id === selectedId
        // Split row: the selectable part is one ListItemButton; the CI link and the rollback button sit beside it,
        // never inside it (no interactive element nested in another).
        return (
          <ListItem
            key={e.id}
            disablePadding
            sx={{
              flexDirection: 'column',
              alignItems: 'stretch',
              borderBottom: 1,
              borderColor: 'divider',
              bgcolor: selected ? 'action.selected' : undefined,
            }}
          >
            {/* The whole row (ListItem) carries the selected background, so the button itself doesn't tint twice. */}
            <ListItemButton
              aria-current={selected || undefined}
              onClick={() => onSelect(e.id)}
              sx={{ alignItems: 'flex-start' }}
            >
              <Stack spacing={0.25} sx={{ width: '100%', minWidth: 0 }}>
                <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <Typography variant="subtitle2">
                    {KIND[e.kind]}
                    {e.sha ? ` ${shortSha(e.sha)}` : ''}
                  </Typography>
                  <Typography
                    variant="body2"
                    color={e.status === 'FAILED' ? 'error' : e.status === 'SUCCEEDED' ? 'success.main' : 'text.secondary'}
                  >
                    {statusText(e)}
                  </Typography>
                </Stack>
                {e.message && (
                  <Typography variant="body2" noWrap>
                    {e.message}
                  </Typography>
                )}
                <Typography variant="caption" color="text.secondary">
                  {new Date(e.startedAt).toLocaleString()} · by {e.by}
                </Typography>
              </Stack>
            </ListItemButton>
            {(e.ciRunUrl || showRollback) && (
              <Stack spacing={0.5} sx={{ px: 2, pb: 1, alignItems: 'flex-start' }}>
                {e.ciRunUrl && (
                  <Typography variant="caption">
                    <MuiLink href={e.ciRunUrl} target="_blank" rel="noreferrer">
                      CI run
                    </MuiLink>
                  </Typography>
                )}
                {showRollback && (
                  <Box>
                    <Tooltip title={blocked ? (e.rollbackBlockedReason ?? '') : ''}>
                      <span>
                        <Button size="small" variant="outlined" disabled={blocked || disabled} onClick={() => onRollback(e)}>
                          Roll back
                        </Button>
                      </span>
                    </Tooltip>
                    {blocked && e.rollbackBlockedReason && (
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                        {e.rollbackBlockedReason}
                      </Typography>
                    )}
                  </Box>
                )}
              </Stack>
            )}
          </ListItem>
        )
      })}
    </List>
  )
}
