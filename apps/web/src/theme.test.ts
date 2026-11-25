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

  it('keeps info (jobs, restart pending) a different hue from the frost accent', () => {
    expect(theme.palette.info.main).toBe(palette.info)
    expect(palette.info).not.toBe(palette.frost)
  })

  it('styles outlined buttons only for the default colour, so Stop/Delete keep their red outline', () => {
    const button = theme.components?.MuiButton?.styleOverrides as Record<string, unknown> | undefined
    expect(button?.outlined).toBeUndefined()
    const variants = (button?.root as { variants?: { props: Record<string, string> }[] } | undefined)?.variants ?? []
    expect(variants.some((v) => v.props.variant === 'outlined' && v.props.color === 'primary')).toBe(true)
  })

  it('uses Figtree for body and Bricolage for headings', () => {
    expect(theme.typography.fontFamily).toBe(FONT_BODY)
    expect(theme.typography.h5.fontFamily).toBe(FONT_DISPLAY)
  })
})
