import { theme } from './theme.ts'
import { FONT_BODY, FONT_DISPLAY, palette } from './theme/tokens.ts'

describe('theme', () => {
  it('uses the Frost accent on the night palette, dark only', () => {
    const { colorSchemes } = theme as unknown as { colorSchemes: Record<string, unknown> }
    const dark = theme.palette
    expect(dark.mode).toBe('dark')
    expect(dark.primary.main).toBe('#5cc8ff')
    expect(dark.primary.contrastText).toBe(palette.night)
    expect(dark.success.main).toBe('#2fd38a')
    expect(dark.background.default).toBe('#0c1120')
    expect(Object.keys(colorSchemes)).toEqual(['dark'])
  })

  it('uses Figtree for body and Bricolage for headings', () => {
    expect(theme.typography.fontFamily).toBe(FONT_BODY)
    expect(theme.typography.h5.fontFamily).toBe(FONT_DISPLAY)
  })
})
