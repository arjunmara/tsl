import { useState } from 'react'

const colours = [
  'bg', 'surface', 'ink', 'ink-muted', 'line', 'action', 'on-action', 'action-ink',
  'highlight', 'on-highlight', 'saved', 'live', 'brand-primary', 'brand-secondary',
]
const type = ['display-xl', 'display-lg', 'display-md', 'title', 'body', 'body-strong', 'meta', 'label']
const spacing = ['1', '2', '3', '4', '5', '6', 'gutter', 'touch-min', 'touch-console']
const rounded = ['sm', 'md', 'lg', 'xl', 'full']

type Theme = 'device' | 'light' | 'dark'

export function TokenSample() {
  const [theme, setTheme] = useState<Theme>('device')

  function pick(next: Theme) {
    setTheme(next)
    // Local viewing only; the real per-device override is a later story.
    if (next === 'device') document.documentElement.removeAttribute('data-theme')
    else document.documentElement.setAttribute('data-theme', next)
  }

  return (
    <main className="sample">
      <h1 className="title">Design tokens</h1>
      <p className="meta">
        Theme follows the device.{' '}
        <label>
          Preview:{' '}
          <select className="sample-select" value={theme} onChange={(e) => pick(e.target.value as Theme)}>
            <option value="device">Device</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
      </p>

      <section>
        <h2 className="label">Colours</h2>
        <div className="sample-grid">
          {colours.map((c) => (
            <div key={c} className="sample-swatch">
              <div className="sample-chip" style={{ background: `var(--${c})` }} />
              <span className="meta sample-name">--{c}</span>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="label">Type</h2>
        {type.map((t) => (
          <p key={t} className={t}>
            {t.startsWith('display') ? <span className="num">2 – 3 · 27′</span> : `${t} · Saturday · Kartik 21, 2083 BS (7 Nov 2026)`}
          </p>
        ))}
      </section>

      <section>
        <h2 className="label">Spacing</h2>
        {spacing.map((s) => (
          <div key={s} className="sample-row">
            <span className="meta sample-name">--spacing-{s}</span>
            <div className="sample-bar" style={{ width: `var(--spacing-${s})` }} />
          </div>
        ))}
      </section>

      <section>
        <h2 className="label">Radii</h2>
        <div className="sample-row">
          {rounded.map((r) => (
            <div key={r}>
              <div className="sample-radius" style={{ borderRadius: `var(--rounded-${r})` }} />
              <span className="meta sample-name">--rounded-{r}</span>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="label">Buttons</h2>
        <div className="sample-row">
          <button type="button" className="sample-button primary">Score this match</button>
          <button type="button" className="sample-button secondary">Back</button>
          <button type="button" className="sample-button secondary">Cancel</button>
        </div>
      </section>

      <section>
        <h2 className="label">On ink</h2>
        <div className="on-ink sample-panel">
          <p className="body-strong">Goal · Ramesh Chudara 26′ · FSW</p>
          <button type="button" className="sample-button undo">Undo</button>
        </div>
      </section>
    </main>
  )
}
