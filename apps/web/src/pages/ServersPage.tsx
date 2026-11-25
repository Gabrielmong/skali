import { Alert, Box, Button, Typography } from '@mui/material'
import { Link } from 'react-router'
import { EmptyState } from '../components/EmptyState.tsx'
import { ServerCard } from '../components/ServerCard.tsx'
import { useServers } from '../live.tsx'

export function ServersPage() {
  const { servers, connected } = useServers()

  if (servers.length === 0) {
    return (
      <EmptyState title={connected ? 'No servers yet' : 'Connecting to Skáli…'} busy={!connected}>
        {connected && (
          <>
            <Typography color="text.secondary">Add a game server you already have installed to manage it here.</Typography>
            <Button component={Link} to="/add" variant="contained">
              Add existing server
            </Button>
          </>
        )}
      </EmptyState>
    )
  }

  return (
    <>
      {!connected && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          Connection lost. Trying to reconnect; what you see may be out of date.
        </Alert>
      )}
      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 340px), 1fr))',
        }}
      >
        {servers.map((s) => (
          <ServerCard key={s.id} server={s} />
        ))}
      </Box>
    </>
  )
}
