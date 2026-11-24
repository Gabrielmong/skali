import { Alert, Box, Button, Typography } from '@mui/material'
import { Link } from 'react-router'
import { ServerCard } from '../components/ServerCard.tsx'
import { useServers } from '../live.tsx'

export function ServersPage() {
  const { servers, connected } = useServers()

  if (servers.length === 0) {
    return (
      <Box sx={{ textAlign: 'center', mt: 8 }}>
        <Typography variant="h6" gutterBottom>
          {connected ? 'No servers yet' : 'Connecting to Skáli…'}
        </Typography>
        {connected && (
          <>
            <Typography color="text.secondary" sx={{ mb: 2 }}>
              Add a game server you already have installed to manage it here.
            </Typography>
            <Button component={Link} to="/add" variant="contained">
              Add existing server
            </Button>
          </>
        )}
      </Box>
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
