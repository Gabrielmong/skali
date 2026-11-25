import DnsIcon from '@mui/icons-material/Dns'
import PetsIcon from '@mui/icons-material/Pets'
import SecurityIcon from '@mui/icons-material/Security'
import ViewInArIcon from '@mui/icons-material/ViewInAr'
import { Box } from '@mui/material'
import { alpha } from '@mui/material/styles'
import type { GameId } from '@skali/shared'
import type { ReactElement } from 'react'
import { palette } from '../theme/tokens.ts'

const GAME_ICONS: Record<GameId, ReactElement> = {
  palworld: <PetsIcon fontSize="inherit" />,
  valheim: <SecurityIcon fontSize="inherit" />,
  minecraft: <ViewInArIcon fontSize="inherit" />,
  basic: <DnsIcon fontSize="inherit" />,
}

const SIZES = { small: { box: 34, icon: 20 }, large: { box: 48, icon: 26 } } as const

/** The game's icon on a frost-tinted tile. Decorative: the server name says what it is. */
export function GameIcon({ game, size = 'small' }: { game: GameId; size?: keyof typeof SIZES }) {
  const s = SIZES[size]
  return (
    <Box
      aria-hidden
      sx={{
        width: s.box,
        height: s.box,
        fontSize: s.icon,
        flexShrink: 0,
        display: 'grid',
        placeItems: 'center',
        borderRadius: 2,
        color: 'primary.main',
        bgcolor: alpha(palette.frost, 0.12),
        border: `1px solid ${alpha(palette.frost, 0.18)}`,
      }}
    >
      {GAME_ICONS[game]}
    </Box>
  )
}
