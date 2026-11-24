import AddIcon from '@mui/icons-material/Add'
import CircleIcon from '@mui/icons-material/Circle'
import SettingsIcon from '@mui/icons-material/Settings'
import { AppBar, Box, Button, Container, IconButton, Toolbar, Tooltip, Typography } from '@mui/material'
import { Link, Route, Routes, useNavigate } from 'react-router'
import { useServers } from './live.tsx'
import { AddServerDialog } from './components/AddServerDialog.tsx'
import { DeploysPage } from './pages/DeploysPage.tsx'
import { ServerPage } from './pages/ServerPage.tsx'
import { ServersPage } from './pages/ServersPage.tsx'
import { SettingsPage } from './pages/SettingsPage.tsx'

const NotFound = ({ title }: { title: string }) => <Typography variant="h6">{title}</Typography>

function AddRoute() {
  const navigate = useNavigate()
  return (
    <>
      <ServersPage />
      <AddServerDialog open onClose={() => navigate('/')} />
    </>
  )
}

export function App() {
  const { connected } = useServers()
  return (
    <>
      <AppBar position="sticky" color="default" elevation={0} sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <Toolbar sx={{ gap: 1.5 }}>
          <Typography variant="h6" component={Link} to="/" sx={{ color: 'inherit', textDecoration: 'none' }}>
            Skáli
          </Typography>
          <Tooltip title={connected ? 'Connected' : 'Disconnected'}>
            <CircleIcon
              titleAccess={connected ? 'Connected' : 'Disconnected'}
              sx={{ fontSize: 12 }}
              color={connected ? 'success' : 'error'}
            />
          </Tooltip>
          <Box sx={{ flexGrow: 1 }} />
          <Button component={Link} to="/add" startIcon={<AddIcon />}>
            Add existing server
          </Button>
          <Button component={Link} to="/deploys">
            Deploys
          </Button>
          <Tooltip title="Settings">
            <IconButton component={Link} to="/settings" aria-label="Settings">
              <SettingsIcon />
            </IconButton>
          </Tooltip>
        </Toolbar>
      </AppBar>
      <Container maxWidth="lg" sx={{ py: 3 }}>
        <Routes>
          <Route path="/" element={<ServersPage />} />
          <Route path="/servers/:id" element={<ServerPage />} />
          <Route path="/add" element={<AddRoute />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/deploys" element={<DeploysPage />} />
          <Route path="*" element={<NotFound title="Not found" />} />
        </Routes>
      </Container>
    </>
  )
}
