import { createTheme } from '@mui/material/styles'

export const theme = createTheme({
  colorSchemes: { dark: true },
  defaultColorScheme: 'dark',
  cssVariables: true,
  shape: { borderRadius: 10 },
  typography: { button: { textTransform: 'none', fontWeight: 600 } },
})
