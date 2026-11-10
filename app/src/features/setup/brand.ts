// Brand colours for the sample Graphic: defaults and text colours come from the tokens, never literals.

// A token as #rrggbb (the build may shorten six-digit hex to three): a 2D canvas normalises any opaque CSS colour.
let ctx: CanvasRenderingContext2D | null = null
export function token(name: string) {
  ctx ??= document.createElement('canvas').getContext('2d')
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  if (!ctx || !value) return ''
  // An unparsable value leaves fillStyle unchanged, so start from a known one.
  ctx.fillStyle = 'black'
  ctx.fillStyle = value
  return String(ctx.fillStyle).toLowerCase()
}
/** The default brand colours (--brand-primary, --brand-secondary). */
export const brandDefaults = () => ({ primary: token('--brand-primary'), secondary: token('--brand-secondary') })
/** The two text colours a Graphic may use: TSL navy (--bg-dark) and white (--ink-dark). */
export type TextColours = { navy: string; white: string }
export const textColours = (): TextColours => ({ navy: token('--bg-dark'), white: token('--ink-dark') })

const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
const toHex = (c: number[]) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')

function luminance(hex: string) {
  const [r = 0, g = 0, b = 0] = channels(hex).map((v) => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio of two #rrggbb colours. */
export function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** Whichever of navy and white reads better on bg. */
export const textOn = (bg: string, t: TextColours) => (contrast(t.navy, bg) >= contrast(t.white, bg) ? t.navy : t.white)

/**
 * Text on a brand-colour panel (the main colour's panel, the second colour's chip): navy or white when one reaches 4.5:1. Otherwise the panel behind the text is
 * darkened in 10% steps until white reaches 4.5:1, and adjusted is true.
 */
export function readable(primary: string, t: TextColours): { panel: string; text: string; adjusted: boolean } {
  if (Math.max(contrast(t.navy, primary), contrast(t.white, primary)) >= 4.5) {
    return { panel: primary, text: textOn(primary, t), adjusted: false }
  }
  let c = channels(primary)
  let panel = primary
  // 50 steps of 10% reach black from any colour; the cap only guards against a bad value.
  for (let i = 0; i < 50 && contrast(t.white, panel) < 4.5; i++) {
    c = c.map((v) => v * 0.9)
    panel = toHex(c)
  }
  return { panel, text: t.white, adjusted: true }
}
