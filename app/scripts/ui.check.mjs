// Story 1.3 component check: buttons, fields, pills and the Confirm sheet, driven by keyboard in real Chrome.
// `npm run check:ui` after `npm run build`. Needs Google Chrome installed (playwright channel 'chrome').
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { chromium } from 'playwright-core'
import { preview } from 'vite'

if (!existsSync('dist/components.html')) throw new Error('dist/components.html is missing: run npm run build first')

const server = await preview({ logLevel: 'silent', preview: { port: 4180 } })
const base = server.resolvedUrls.local[0]
const browser = await chromium.launch({ channel: 'chrome' })
try {
  const context = await browser.newContext({ serviceWorkers: 'block' })
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort())
  const page = await context.newPage()
  await page.emulateMedia({ colorScheme: 'light' })
  const load = () => page.goto(base + 'components.html')
  const log = () => page.$$eval('#log li', (lis) => lis.map((li) => li.textContent))
  const active = () => page.evaluate(() => {
    const a = document.activeElement
    return { tag: a?.tagName.toLowerCase(), text: a?.textContent?.trim(), inDialog: !!a?.closest('dialog[open]') }
  })
  const openDialogs = () => page.$$eval('dialog[open]', (d) => d.length)
  const button = (name) => page.getByRole('button', { name, exact: true })
  const venue = page.getByLabel('Venue')
  const teamCode = page.getByLabel('Team code')

  await load()

  // Tab order follows DOM order; pills and closed sheets are not in it.
  const expected = await page.evaluate(() => {
    const all = [...document.querySelectorAll('button, input, select, textarea, a[href], [tabindex]')]
      .filter((e) => !e.disabled && e.tabIndex >= 0 && !e.closest('dialog:not([open])'))
    return all.map((e, i) => ((e.dataset.order = String(i)), e.textContent.trim() || e.id))
  })
  assert.ok(expected.length > 0, 'Tab order: no focusable elements found')
  const seen = []
  for (let i = 0; i < expected.length; i++) {
    await page.keyboard.press('Tab')
    seen.push(await page.evaluate(() => document.activeElement?.dataset.order))
  }
  assert.deepEqual(seen, expected.map((_, i) => String(i)), `Tab order differs from DOM order: ${expected}`)

  // Every button has an accessible name.
  const nameless = await page.$$eval('button', (bs) => bs.filter((b) => !(b.textContent.trim() || b.getAttribute('aria-label'))).length)
  assert.equal(nameless, 0, 'button without an accessible name')

  // Pills: spans with text, never focusable, gold vs surface.
  const pills = await page.$$eval('.ui-pill', (ps) => ps.map((p) => {
    const s = getComputedStyle(p)
    return { tag: p.tagName, text: p.textContent.trim(), tab: p.tabIndex, bg: s.backgroundColor, border: s.borderTopWidth + ' ' + s.borderTopColor }
  }))
  assert.equal(pills.length, 2)
  for (const p of pills) {
    assert.equal(p.tag, 'SPAN')
    assert.ok(p.text, 'pill without a text label')
    assert.equal(p.tab, -1, 'pill is focusable')
  }
  assert.equal(pills[0].bg, 'rgb(246, 196, 83)', 'done pill: gold fill')
  assert.equal(pills[1].bg, 'rgb(255, 255, 255)', 'pending pill: surface fill')
  assert.equal(pills[1].border, '2px rgb(88, 100, 130)', 'pending pill: 2px muted border')

  // Button styles, against the root's tokens resolved to computed colours.
  const styles = await page.evaluate(() => {
    const probe = document.createElement('i')
    document.body.append(probe)
    const tok = (n) => ((probe.style.color = `var(--${n})`), getComputedStyle(probe).color)
    const css = (sel) => {
      const s = getComputedStyle(document.querySelector(sel))
      return { bg: s.backgroundColor, color: s.color, minH: s.minHeight, border: s.borderTopWidth + ' ' + s.borderTopColor }
    }
    const out = {
      tokens: Object.fromEntries(['action', 'on-action', 'line', 'ink-muted', 'live'].map((n) => [n, tok(n)])),
      primary: css('.ui-primary:not(:disabled)'),
      disabled: css('.ui-primary:disabled'),
      secondary: css('.ui-secondary:not(.ui-destructive)'),
      destructive: css('.ui-destructive'),
    }
    probe.remove()
    return out
  })
  const t = styles.tokens
  assert.deepEqual([styles.primary.bg, styles.primary.color, styles.primary.minH], [t.action, t['on-action'], '48px'], 'Primary styles')
  assert.deepEqual([styles.disabled.bg, styles.disabled.color], [t.line, t['ink-muted']], 'disabled Primary styles')
  assert.equal(styles.secondary.border, `2px ${t['ink-muted']}`, 'Secondary border')
  assert.deepEqual([styles.destructive.color, styles.destructive.border], [t.live, `2px ${t.live}`], 'Destructive text and border')

  // Disabled Primary: reason visible beneath and linked.
  const disabled = button('Create tournament')
  assert.ok(await disabled.isDisabled())
  const reasonId = await disabled.getAttribute('aria-describedby')
  assert.ok(reasonId, 'disabled Primary has no aria-describedby')
  const reason = page.locator(`[id="${reasonId}"]`)
  assert.ok(await reason.isVisible())
  assert.equal((await reason.textContent()).trim(), "Add the tournament's name first.")

  // Field: changed + valid saves once on blur.
  await venue.focus()
  await page.keyboard.type('Gulmi')
  await page.keyboard.press('Tab')
  assert.deepEqual(await log(), ['onSave: Venue = Gulmi'], 'Field blur, changed + valid')
  // Unchanged: focus then Tab away.
  await venue.focus()
  await page.keyboard.press('Tab')
  assert.deepEqual(await log(), ['onSave: Venue = Gulmi'], 'Field blur, unchanged')

  // Required, untouched: no message.
  assert.equal(await teamCode.getAttribute('aria-invalid'), null, 'required untouched: aria-invalid')
  assert.equal(await page.locator('.ui-error').count(), 0, 'required untouched: message shown')

  // Required, Next pressed: message shown, focus on the field.
  await button('Next').focus()
  await page.keyboard.press('Enter')
  assert.equal(await teamCode.getAttribute('aria-invalid'), 'true', 'Next: aria-invalid')
  assert.ok(await teamCode.evaluate((e) => e === document.activeElement), 'Next: focus on first invalid field')
  const reqId = await teamCode.getAttribute('aria-describedby')
  assert.match(await page.locator(`[id="${reqId}"]`).textContent(), /required/, 'Next: required message')

  // Required after an edit: type, clear, Tab away.
  await load()
  await teamCode.focus()
  await page.keyboard.type('AB')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Tab')
  assert.equal(await teamCode.getAttribute('aria-invalid'), 'true', 'required after edit: aria-invalid')
  const editId = await teamCode.getAttribute('aria-describedby')
  assert.match(await page.locator(`[id="${editId}"]`).textContent(), /required/, 'required after edit: message')

  // Invalid: message in words, red border, no save.
  await load()
  await teamCode.focus()
  await page.keyboard.type('G')
  await page.keyboard.press('Tab')
  assert.equal(await teamCode.getAttribute('aria-invalid'), 'true', 'invalid: aria-invalid')
  const errId = await teamCode.getAttribute('aria-describedby')
  assert.equal((await page.locator(`[id="${errId}"]`).textContent()).trim(), 'Use 2 to 5 letters.')
  assert.equal(await teamCode.evaluate((e) => getComputedStyle(e).borderTopColor), 'rgb(215, 25, 32)', 'invalid: red border')
  assert.deepEqual(await log(), [], 'invalid: onSave called')

  // Sheet open: dialog named by its title, focus on the title.
  const kickOff = button('Change kick-off')
  await kickOff.focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Change the kick-off time?' })
  assert.ok(await dialog.isVisible(), 'sheet: role=dialog named by its title')
  assert.match(await dialog.textContent(), /2:00 PM\s*→\s*to\s*4:00 PM/, 'sheet: before → after line')
  const descId = await dialog.getAttribute('aria-describedby')
  assert.match(await page.locator(`[id="${descId}"]`).textContent(), / to 4:00 PM/, 'sheet: change line not described')
  assert.deepEqual(await active(), { tag: 'h2', text: 'Change the kick-off time?', inDialog: true }, 'sheet: focus on title')

  // Tab and Shift+Tab stay inside.
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Tab')
    assert.ok((await active()).inDialog, `Tab ${i + 1} left the sheet`)
  }
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Shift+Tab')
    assert.ok((await active()).inDialog, `Shift+Tab ${i + 1} left the sheet`)
  }

  // Second sheet: requesting another while one is open does not open it.
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Delete team').click())
  assert.equal(await openDialogs(), 1, 'Second sheet: more than one open dialog')

  // Escape closes without confirming, focus back on the opener.
  await page.keyboard.press('Escape')
  assert.equal(await openDialogs(), 0, 'Escape: sheet still open')
  assert.ok(await kickOff.evaluate((e) => e === document.activeElement), 'Escape: focus not back on opener')

  // Enter on Cancel closes without confirming.
  await page.keyboard.press('Enter')
  assert.equal(await openDialogs(), 1)
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  assert.equal((await active()).text, 'Cancel')
  await page.keyboard.press('Enter')
  assert.equal(await openDialogs(), 0, 'Enter on Cancel: sheet still open')
  assert.ok(await kickOff.evaluate((e) => e === document.activeElement), 'Cancel: focus not back on opener')
  assert.deepEqual(await log(), [], 'Escape/Cancel called onConfirm')

  // Confirm: onConfirm once, sheet closes.
  await page.keyboard.press('Enter')
  await page.keyboard.press('Tab')
  assert.equal((await active()).text, 'Move match')
  await page.keyboard.press('Enter')
  assert.equal(await openDialogs(), 0, 'Confirm: sheet still open')
  assert.deepEqual(await log(), ['onConfirm: Change kick-off'], 'Confirm: onConfirm once')

  // Destructive: focus on Cancel; Escape closes without confirming.
  const del = button('Delete team')
  await del.focus()
  await page.keyboard.press('Enter')
  assert.deepEqual(await active(), { tag: 'button', text: 'Cancel', inDialog: true }, 'Destructive: focus on Cancel')
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Change kick-off').click())
  assert.equal(await openDialogs(), 1, 'Second sheet (from destructive): more than one open dialog')
  await page.keyboard.press('Escape')
  assert.equal(await openDialogs(), 0)
  assert.ok(await del.evaluate((e) => e === document.activeElement), 'Destructive: focus not back on opener')
  assert.deepEqual(await log(), ['onConfirm: Change kick-off'], 'Destructive Escape called onConfirm')

  // Destructive confirm: onConfirm once, sheet closes.
  await del.focus()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Shift+Tab')
  assert.equal((await active()).text, 'Delete team', 'Destructive: action button')
  await page.keyboard.press('Enter')
  assert.equal(await openDialogs(), 0, 'Destructive confirm: sheet still open')
  assert.deepEqual(await log(), ['onConfirm: Change kick-off', 'onConfirm: Delete team'], 'Destructive confirm: onConfirm once')

  // Sheet styles: top corners and backdrop from tokens.
  await kickOff.focus()
  await page.keyboard.press('Enter')
  const sheet = await page.$eval('dialog[open]', (d) => {
    const s = getComputedStyle(d)
    return { tl: s.borderTopLeftRadius, bl: s.borderBottomLeftRadius, backdrop: getComputedStyle(d, '::backdrop').backgroundColor }
  })
  assert.deepEqual(sheet, { tl: '18px', bl: '0px', backdrop: 'rgba(10, 26, 63, 0.4)' }, 'sheet styles')
  await page.keyboard.press('Escape')

  // 360px wide, 200% text: no sideways scroll (sheet closed and open), buttons inside, Primary full width.
  await page.setViewportSize({ width: 360, height: 800 })
  await load()
  await page.evaluate(() => (document.documentElement.style.fontSize = '200%'))
  const layout = () => page.evaluate(() => {
    const w = document.documentElement.clientWidth
    const out = []
    if (document.documentElement.scrollWidth > w) out.push(`page scrolls sideways (${document.documentElement.scrollWidth}px > ${w}px)`)
    for (const b of document.querySelectorAll('button')) {
      if (!b.checkVisibility()) continue
      const r = b.getBoundingClientRect()
      if (r.left < 0 || r.right > w) out.push(`"${b.textContent.trim()}" spans ${r.left}-${r.right}px`)
    }
    return out
  })
  assert.deepEqual(await layout(), [], '200% text, 360px, sheet closed')
  const primaryWidth = await page.$eval('.ui-primary:not(:disabled)', (b) => [b.getBoundingClientRect().width, b.parentElement.parentElement.clientWidth])
  assert.equal(primaryWidth[0], primaryWidth[1], 'Primary is not full width below 600px')
  await kickOff.focus()
  await page.keyboard.press('Enter')
  assert.equal(await openDialogs(), 1)
  assert.deepEqual(await layout(), [], '200% text, 360px, sheet open')
} finally {
  await browser.close()
  await server.close()
}
console.log('ok')
