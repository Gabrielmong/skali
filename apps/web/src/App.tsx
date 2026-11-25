import { Button, Container } from '@mui/material'
import { Link, Route, Routes, useNavigate } from 'react-router'
import { EmptyState } from './components/EmptyState.tsx'
import { TopBar } from './layout/TopBar.tsx'
import { useServers } from './live.tsx'
import { AddServerDialog } from './components/AddServerDialog.tsx'
import { NewServerPage } from './pages/NewServerPage.tsx'
import { DeploysPage } from './pages/DeploysPage.tsx'
import { ServerPage } from './pages/ServerPage.tsx'
import { ServersPage } from './pages/ServersPage.tsx'
import { SettingsPage } from './pages/SettingsPage.tsx'

const NotFound = ({ title }: { title: string }) => (
  <EmptyState title={title}>
    <Button component={Link} to="/" variant="contained">
      All servers
    </Button>
  </EmptyState>
)

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
      <TopBar connected={connected} />
      <Container maxWidth="lg" sx={{ py: 3 }}>
        <Routes>
          <Route path="/" element={<ServersPage />} />
          <Route path="/servers/:id" element={<ServerPage />} />
          <Route path="/new" element={<NewServerPage />} />
          <Route path="/add" element={<AddRoute />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/deploys" element={<DeploysPage />} />
          <Route path="*" element={<NotFound title="Not found" />} />
        </Routes>
      </Container>
    </>
  )
}
