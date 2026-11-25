import { alpha, createTheme } from '@mui/material/styles'
import { components } from './theme/components.ts'
import { FONT_BODY, FONT_DISPLAY, palette } from './theme/tokens.ts'

/**
 * "Longhouse at night": the IoT app's deep indigo surfaces with a frost accent, green for running servers.
 * Headings use Bricolage Grotesque; everything else uses Figtree.
 * Dark only: with a light scheme too, MUI follows the OS setting and a light-mode PC gets dark text on the night background.
 */
export const theme = createTheme({
  colorSchemes: {
    dark: {
      palette: {
        primary: { main: palette.frost, contrastText: palette.night },
        success: { main: palette.on, contrastText: palette.night },
        error: { main: palette.alarm },
        background: { default: palette.night, paper: palette.surface },
        text: { primary: palette.text, secondary: palette.muted },
        divider: alpha(palette.line, 0.14),
      },
    },
  },
  defaultColorScheme: 'dark',
  cssVariables: true,
  shape: { borderRadius: 8 },
  typography: {
    fontFamily: FONT_BODY,
    h3: { fontFamily: FONT_DISPLAY, fontWeight: 700, letterSpacing: '-0.02em' },
    h4: { fontFamily: FONT_DISPLAY, fontWeight: 700, letterSpacing: '-0.02em' },
    h5: { fontFamily: FONT_DISPLAY, fontWeight: 650, letterSpacing: '-0.015em' },
    h6: { fontFamily: FONT_DISPLAY, fontWeight: 650, letterSpacing: '-0.01em' },
    subtitle1: { fontWeight: 600 },
    button: { textTransform: 'none', fontWeight: 600 },
  },
  components,
})
