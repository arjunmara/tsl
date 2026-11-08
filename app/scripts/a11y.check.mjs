// Story 1.2 accessibility check: contrast pairs, colour literals, lang, themes, 200% text, reduced motion.
// `npm run check:a11y` after `npm run build`. Needs Google Chrome installed (playwright channel 'chrome').
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
import { preview } from 'vite'

for (const f of ['dist/index.html', 'dist/tokens.html']) {
  if (!existsSync(f)) throw new Error(`${f} is missing: run npm run build first`)
}

// --- Contrast, from tokens.css ---
const css = readFileSync('src/ui/tokens.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
function block(selector) {
  const at = css.indexOf(selector + ' {')
  assert.ok(at >= 0, `tokens.css: no "${selector} {" block`)
  const start = at + selector.length + 2
  return css.slice(start, css.indexOf('}', start))
}
function decls(body) {
  return Object.fromEntries([...body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]))
}
const light = decls(block(':root'))
const darkMedia = decls(block(':root:not([data-theme="light"])'))
const darkAttr = decls(block(':root[data-theme="dark"]'))
assert.deepEqual(darkMedia, darkAttr, 'tokens.css: the prefers-color-scheme dark block and the data-theme="dark" block differ')
const themes = { light, dark: { ...light, ...darkAttr } }

function resolve(theme, name, seen = new Set()) {
  const v = themes[theme][name]
  assert.ok(v, `tokens.css: --${name} is not defined in the ${theme} theme`)
  assert.ok(!seen.has(name), `tokens.css: --${name} refers to itself`)
  const ref = v.match(/^var\(--([\w-]+)\)$/)
  return ref ? resolve(theme, ref[1], seen.add(name)) : v
}
function luminance(hex) {
  const m = hex.match(/^#([0-9a-f]{6})$/i)
  assert.ok(m, `expected a #rrggbb colour, got ${hex}`)
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
const pairs = []
for (const fg of ['ink', 'ink-muted', 'action-ink', 'saved', 'live']) for (const bg of ['bg', 'surface']) pairs.push([fg, bg, 4.5])
pairs.push(['on-action', 'action', 4.5], ['on-highlight', 'highlight', 4.5])
for (const fg of ['ink-muted', 'focus']) for (const bg of ['bg', 'surface']) pairs.push([fg, bg, 3])
const failures = []
for (const theme of Object.keys(themes)) {
  for (const [fg, bg, min] of pairs) {
    const r = ratio(resolve(theme, fg), resolve(theme, bg))
    if (r < min) failures.push(`${theme}: --${fg} on --${bg} is ${r.toFixed(2)}:1, needs ${min}:1`)
  }
}
// .on-ink surfaces wear dark values in both themes.
for (const [fg, bg, min] of [['ink-dark', 'bg-dark', 4.5], ['highlight-dark', 'bg-dark', 4.5]]) {
  const r = ratio(resolve('light', fg), resolve('light', bg))
  if (r < min) failures.push(`.on-ink: --${fg} on --${bg} is ${r.toFixed(2)}:1, needs ${min}:1`)
}
assert.deepEqual(failures, [], 'contrast below AA')

// --- Colour literals only in tokens.css ---
const literal = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i
function walk(dir) {
  return readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]))
}
const stray = walk('src').filter((f) => /\.(css|tsx?|jsx?|html)$/.test(f) && f !== join('src', 'ui', 'tokens.css') && literal.test(readFileSync(f, 'utf8')))
assert.deepEqual(stray, [], 'colour literal outside src/ui/tokens.css')

// --- lang ---
for (const f of ['index.html', 'tokens.html']) {
  assert.match(readFileSync(f, 'utf8'), /<html[^>]*\slang="en"/, `${f} needs <html lang="en">`)
}

// --- In the browser, against vite preview of dist/ ---
const server = await preview({ logLevel: 'silent', preview: { port: 4179 } })
const base = server.resolvedUrls.local[0]
const browser = await chromium.launch({ channel: 'chrome' })
try {
  const context = await browser.newContext({ serviceWorkers: 'block' })
  // Fonts are left to their fallbacks so the run is offline-safe and deterministic.
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort())
  const page = await context.newPage()

  // Themes: device setting plus data-theme override.
  const navy = 'rgb(10, 26, 63)'
  const ground = 'rgb(245, 246, 250)'
  const roles = Object.keys(darkAttr).filter((k) => !k.endsWith('-dark'))
  async function theme(scheme, override) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.goto(base)
    await page.evaluate((t) => (t ? document.documentElement.setAttribute('data-theme', t) : null), override)
    return page.evaluate((names) => {
      const root = getComputedStyle(document.documentElement)
      const body = getComputedStyle(document.body)
      return {
        tokens: Object.fromEntries(names.map((n) => [n, root.getPropertyValue(`--${n}`).trim()])),
        bg: body.backgroundColor, color: body.color, font: body.fontFamily, scheme: root.colorScheme,
      }
    }, roles)
  }
  const darkDevice = await theme('dark', null)
  assert.equal(darkDevice.tokens.bg, '#0a1a3f', 'device dark: --bg')
  assert.equal(darkDevice.bg, navy, 'device dark: body background')
  assert.equal(darkDevice.color, 'rgb(255, 255, 255)', 'device dark: body text')
  assert.match(darkDevice.font, /^Barlow/, 'device dark: body font')
  assert.equal(darkDevice.scheme, 'dark', 'device dark: color-scheme')
  const lightDevice = {}
  for (const scheme of ['light', 'no-preference']) {
    const t = (lightDevice[scheme] = await theme(scheme, null))
    assert.equal(t.tokens.bg, '#f5f6fa', `device ${scheme}: --bg`)
    assert.equal(t.bg, ground, `device ${scheme}: body background`)
  }
  const lightOverride = await theme('dark', 'light')
  assert.equal(lightOverride.bg, ground, 'data-theme light on a dark device')
  assert.equal(lightOverride.scheme, 'light', 'data-theme light: color-scheme')
  assert.deepEqual(lightOverride.tokens, lightDevice.light.tokens, 'data-theme light and device light resolve differently')
  const darkOverride = await theme('light', 'dark')
  assert.equal(darkOverride.bg, navy, 'data-theme dark on a light device')
  assert.equal(darkOverride.scheme, 'dark', 'data-theme dark: color-scheme')
  assert.deepEqual(darkOverride.tokens, darkDevice.tokens, 'data-theme dark and device dark resolve differently')

  // Text at 200%, 360px wide: no horizontal overflow, every button inside the viewport.
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' })
  await page.setViewportSize({ width: 360, height: 800 })
  for (const path of ['', 'tokens.html']) {
    await page.goto(base + path)
    await page.evaluate(() => (document.documentElement.style.fontSize = '200%'))
    const bad = await page.evaluate(() => {
      const w = document.documentElement.clientWidth
      const out = []
      if (document.documentElement.scrollWidth > w) out.push(`page scrolls sideways (${document.documentElement.scrollWidth}px > ${w}px)`)
      for (const b of document.querySelectorAll('button, select')) {
        const r = b.getBoundingClientRect()
        if (r.left < 0 || r.right > w) out.push(`<${b.tagName.toLowerCase()}> "${b.textContent.trim().slice(0, 30)}" spans ${r.left}-${r.right}px`)
      }
      return out
    })
    assert.deepEqual(bad, [], `/${path} at 200% text, 360px wide`)
  }

  // Reduced motion: a sample control's transition goes to 0s.
  const duration = () => page.$eval('.sample-button', (b) => getComputedStyle(b).transitionDuration)
  await page.goto(base + 'tokens.html')
  assert.notEqual(await duration(), '0s', 'sample button should have a transition without reduced motion')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  assert.equal(await duration(), '0s', 'reduced motion: transition-duration')
} finally {
  await browser.close()
  await server.close()
}
console.log('ok')
