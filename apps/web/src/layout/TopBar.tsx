import AddIcon from '@mui/icons-material/Add'
import CircleIcon from '@mui/icons-material/Circle'
import DnsIcon from '@mui/icons-material/Dns'
import RocketLaunchIcon from '@mui/icons-material/RocketLaunch'
import SettingsIcon from '@mui/icons-material/Settings'
import { AppBar, Box, Button, Stack, Toolbar, Tooltip, Typography } from '@mui/material'
import { alpha } from '@mui/material/styles'
import type { ReactElement } from 'react'
import { Link, useLocation } from 'react-router'
import { palette } from '../theme/tokens.ts'
import { BrandMark } from './BrandMark.tsx'

interface NavLinkDef {
  to: string
  label: string
  icon: ReactElement
  isActive: (path: string) => boolean
}

const NAV: NavLinkDef[] = [
  { to: '/', label: 'Servers', icon: <DnsIcon />, isActive: (p) => p === '/' || p.startsWith('/servers/') },
  { to: '/deploys', label: 'Deploys', icon: <RocketLaunchIcon />, isActive: (p) => p.startsWith('/deploys') },
  { to: '/settings', label: 'Settings', icon: <SettingsIcon />, isActive: (p) => p.startsWith('/settings') },
]

/** Hidden below `sm`: there the pills and New server show only their icons (the accessible name stays). */
const Label = ({ children }: { children: string }) => (
  <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>
    {children}
  </Box>
)

const iconOnlyBelowSm = { minWidth: 0, '& .MuiButton-startIcon': { mr: { xs: 0, sm: 1 }, ml: { xs: 0, sm: -0.5 } } }

/** Sticky, frosted app bar: brand, connection dot, page pills and the New server action. */
export function TopBar({ connected }: { connected: boolean }) {
  const { pathname } = useLocation()
  const status = connected ? 'Connected' : 'Disconnected'

  return (
    <AppBar position="sticky" color="transparent" elevation={0}>
      <Toolbar sx={{ gap: { xs: 1, sm: 1.5 } }}>
        <Typography
          variant="h6"
          component={Link}
          to="/"
          sx={{ display: 'flex', alignItems: 'center', gap: 1.25, color: 'text.primary', textDecoration: 'none' }}
        >
          <BrandMark />
          Skáli
        </Typography>
        <Tooltip title={status}>
          <CircleIcon
            titleAccess={status}
            sx={{
              fontSize: 10,
              color: connected ? 'success.main' : 'error.main',
              filter: connected ? `drop-shadow(0 0 4px ${palette.on})` : 'none',
            }}
          />
        </Tooltip>
        <Box sx={{ flexGrow: 1 }} />
        <Stack component="nav" aria-label="Main" direction="row" spacing={0.5}>
          {NAV.map(({ to, label, icon, isActive }) => {
            const active = isActive(pathname)
            return (
              <Button
                key={to}
                component={Link}
                to={to}
                aria-label={label}
                aria-current={active ? 'page' : undefined}
                startIcon={icon}
                sx={{
                  ...iconOnlyBelowSm,
                  borderRadius: 999,
                  px: { xs: 1.25, sm: 2 },
                  border: '1px solid',
                  color: active ? 'primary.main' : 'text.secondary',
                  borderColor: active ? alpha(palette.frost, 0.4) : 'transparent',
                  bgcolor: active ? alpha(palette.frost, 0.12) : 'transparent',
                  '&:hover': { color: 'text.primary', bgcolor: alpha(palette.line, 0.08) },
                }}
              >
                <Label>{label}</Label>
              </Button>
            )
          })}
        </Stack>
        <Button
          component={Link}
          to="/new"
          variant="contained"
          aria-label="New server"
          startIcon={<AddIcon />}
          sx={{ ...iconOnlyBelowSm, px: { xs: 1.25, sm: 2 } }}
        >
          <Label>New server</Label>
        </Button>
      </Toolbar>
    </AppBar>
  )
}
