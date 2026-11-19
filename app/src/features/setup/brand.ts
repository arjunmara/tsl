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

/** Contrast a Graphic text layer needs on the 1080px canvas: 4.5:1, or 3:1 at 70px and up (NFR-11). */
export const needed = (px: number) => (px >= 70 ? 3 : 4.5)

/**
 * Ink for one Graphic text layer (Story 5.2), measured against the worst of the fills behind its box, never saved. In order, the first that
 * passes: the Template's own colour, then navy or white (whichever reads better on the worst fill; brand-secondary stays on rules and
 * chips), else the fill behind the text is darkened in 10% steps until white passes, and adjusted is true.
 */
export function inkFor(fills: string[], px: number, t: TextColours, own?: string): { text: string; fill?: string; adjusted: boolean } {
  const need = needed(px)
  const worst = (c: string) => Math.min(...fills.map((f) => contrast(c, f)))
  if (own && worst(own) >= need) return { text: own, adjusted: false }
  const text = worst(t.navy) >= worst(t.white) ? t.navy : t.white
  if (worst(text) >= need) return { text, adjusted: false }
  // The fill white reads worst on is darkened; 50 steps of 10% reach black from any colour, the cap only guards against a bad value.
  const base = fills.reduce((a, b) => (contrast(t.white, b) < contrast(t.white, a) ? b : a))
  let c = channels(base)
  let fill = base
  for (let i = 0; i < 50 && contrast(t.white, fill) < need; i++) {
    c = c.map((v) => v * 0.9)
    fill = toHex(c)
  }
  return { text: t.white, fill, adjusted: true }
}

/** Text on one brand-colour panel at body size (the setup sample, the Classic field): inkFor with the panel to paint behind the text. */
export function readable(primary: string, t: TextColours): { panel: string; text: string; adjusted: boolean } {
  const r = inkFor([primary], 0, t)
  return { panel: r.fill ?? primary, text: r.text, adjusted: r.adjusted }
}
