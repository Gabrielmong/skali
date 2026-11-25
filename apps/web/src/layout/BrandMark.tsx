import { Box } from '@mui/material'

/** A longhouse (skáli) with a lit doorway: the app's mark. Decorative. */
export function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <Box component="svg" viewBox="0 0 24 24" aria-hidden sx={{ width: size, height: size, flexShrink: 0 }}>
      <path
        d="M2.5 11 12 5l9.5 6M4.5 10v10h15V10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.85"
      />
      <Box
        component="rect"
        x="10"
        y="14"
        width="4"
        height="6"
        rx="1"
        sx={{
          fill: 'var(--mui-palette-primary-main)',
          filter: 'drop-shadow(0 0 4px var(--mui-palette-primary-main))',
        }}
      />
    </Box>
  )
}
