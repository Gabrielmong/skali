import { Box, Typography } from '@mui/material'
import { useState } from 'react'
import { hueOf, initials } from './gameName.ts'

/** Steam header images are 460x215. */
export const ART_RATIO = '460 / 215'

/**
 * The game's Steam header art, or (no art, offline, broken link) a tinted tile with its initials. Decorative.
 * `fill`: cover the parent box instead of keeping the 460x215 ratio.
 */
export function GameArt({ name, art, fill = false }: { name: string; art?: string | undefined; fill?: boolean }) {
  const [failed, setFailed] = useState(false)
  const size = fill ? { width: '100%', height: '100%' } : { width: '100%', aspectRatio: ART_RATIO }
  if (art && !failed) {
    return (
      <Box
        component="img"
        src={art}
        alt=""
        role="presentation"
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        sx={{ display: 'block', ...size, objectFit: 'cover' }}
      />
    )
  }
  const hue = hueOf(name)
  return (
    <Box
      aria-hidden
      sx={{
        ...size,
        display: 'grid',
        placeItems: 'center',
        background: `radial-gradient(120% 90% at 20% 10%, hsl(${hue} 55% 34%), hsl(${(hue + 40) % 360} 45% 14%))`,
      }}
    >
      <Typography
        component="span"
        sx={{ fontFamily: (t) => t.typography.h3.fontFamily, fontWeight: 700, fontSize: 34, letterSpacing: '0.04em', color: 'rgb(255 255 255 / 0.85)' }}
      >
        {initials(name)}
      </Typography>
    </Box>
  )
}
