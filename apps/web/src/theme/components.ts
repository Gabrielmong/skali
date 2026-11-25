import { alpha, type Components, type Theme } from '@mui/material/styles'
import { FONT_DISPLAY, palette } from './tokens.ts'

const hairline = `1px solid ${alpha(palette.line, 0.12)}`
const ease = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

/** Component defaults: soft hairline surfaces, pill tabs and chips, rounder dialogs. */
export const components: Components<Theme> = {
  MuiCssBaseline: {
    styleOverrides: {
      body: {
        backgroundColor: palette.night,
        backgroundImage: `radial-gradient(1200px 600px at 10% -10%, ${alpha('#3a4f9a', 0.22)}, transparent 60%),
          radial-gradient(900px 500px at 110% 0%, ${alpha(palette.frost, 0.07)}, transparent 60%)`,
        backgroundAttachment: 'fixed',
        minHeight: '100vh',
      },
      '::selection': { backgroundColor: alpha(palette.frost, 0.35) },
    },
  },
  MuiPaper: {
    styleOverrides: {
      root: { backgroundImage: 'none' },
      outlined: { border: hairline, backgroundColor: alpha(palette.surface, 0.85) },
    },
  },
  MuiCard: {
    defaultProps: { variant: 'outlined' },
    styleOverrides: { root: { borderRadius: 10 } },
  },
  MuiCardContent: {
    styleOverrides: { root: { padding: 20, '&:last-child': { paddingBottom: 20 } } },
  },
  MuiButton: {
    styleOverrides: {
      root: {
        borderRadius: 8,
        transition: `background-color 160ms ${ease}, border-color 160ms ${ease}, transform 120ms ${ease}`,
        // Default-colour outlined buttons only: Stop/Delete (color="error") keep MUI's red outline.
        variants: [
          {
            props: { variant: 'outlined', color: 'primary' },
            style: { borderColor: alpha(palette.line, 0.2), '&:hover': { borderColor: alpha(palette.frost, 0.6) } },
          },
        ],
      },
      contained: { boxShadow: 'none', '&:hover': { boxShadow: `0 6px 20px ${alpha(palette.frost, 0.25)}` } },
    },
  },
  MuiChip: {
    styleOverrides: { root: { fontWeight: 600, borderRadius: 999 } },
  },
  MuiTabs: {
    styleOverrides: {
      root: { minHeight: 44 },
      indicator: {
        height: '100%',
        borderRadius: 999,
        backgroundColor: alpha(palette.frost, 0.14),
        border: `1px solid ${alpha(palette.frost, 0.35)}`,
        boxSizing: 'border-box',
        transition: `left 320ms ${ease}, width 320ms ${ease}`,
      },
    },
  },
  MuiTab: {
    styleOverrides: {
      root: {
        zIndex: 1,
        minHeight: 44,
        borderRadius: 999,
        paddingInline: 18,
        fontWeight: 600,
        color: palette.muted,
        transition: `color 200ms ${ease}`,
        '&.Mui-selected': { color: palette.frost },
      },
    },
  },
  MuiAppBar: {
    styleOverrides: {
      root: {
        backgroundColor: alpha(palette.night, 0.72),
        backdropFilter: 'blur(14px) saturate(140%)',
        borderBottom: hairline,
      },
    },
  },
  MuiDialog: {
    styleOverrides: { paper: { borderRadius: 14, border: hairline, backgroundColor: palette.surface } },
  },
  MuiDialogTitle: {
    styleOverrides: { root: { fontFamily: FONT_DISPLAY, fontWeight: 650 } },
  },
  MuiSwitch: {
    styleOverrides: {
      switchBase: { '&.Mui-checked + .MuiSwitch-track': { opacity: 0.6 } },
    },
  },
  MuiTooltip: {
    styleOverrides: { tooltip: { backgroundColor: palette.raised, border: hairline, fontSize: 13 } },
  },
}
