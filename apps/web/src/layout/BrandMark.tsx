import { Box } from '@mui/material'

const LED_Y = [6, 12, 18] as const

/** A three-unit server rack with lit status lights: the app's mark. Decorative. */
export function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <Box component="svg" viewBox="0 0 24 24" aria-hidden sx={{ width: size, height: size, flexShrink: 0 }}>
      <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" opacity="0.85">
        <rect x="3.5" y="2.5" width="17" height="19" rx="2.5" />
        <path d="M3.5 9h17M3.5 15h17" />
        {LED_Y.map((y) => (
          <path key={y} d={`M11.5 ${y}h5.5`} />
        ))}
      </g>
      {LED_Y.map((y) => (
        <Box
          key={y}
          component="circle"
          cx="7.5"
          cy={y}
          r="1.3"
          sx={{
            fill: 'var(--mui-palette-primary-main)',
            filter: 'drop-shadow(0 0 3px var(--mui-palette-primary-main))',
          }}
        />
      ))}
    </Box>
  )
}
