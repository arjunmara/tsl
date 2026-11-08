import { useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { DestructiveButton, PrimaryButton, SecondaryButton } from '../ui/Button'
import { ConfirmSheet } from '../ui/ConfirmSheet'
import { Field, focusFirstInvalid } from '../ui/Field'
import { StatusPill } from '../ui/StatusPill'

const code = (v: string) => (/^[A-Za-z]{2,5}$/.test(v) ? null : 'Use 2 to 5 letters.')

// Component sample (components.html). The log is read by scripts/ui.check.mjs.
export function ComponentSample() {
  const [log, setLog] = useState<string[]>([])
  const [showErrors, setShowErrors] = useState(false)
  const [kickOff, setKickOff] = useState(false)
  const form = useRef<HTMLDivElement>(null)
  const add = (line: string) => setLog((l) => [...l, line])

  function next() {
    flushSync(() => setShowErrors(true))
    if (form.current && !focusFirstInvalid(form.current)) add('next')
  }

  return (
    <main className="sample" tabIndex={-1}>
      <h1 className="title">Components</h1>

      <section>
        <h2 className="label">Buttons</h2>
        <div className="sample-row">
          <PrimaryButton label="Score this match" onClick={() => add('primary')} />
          <SecondaryButton label="Back" onClick={() => add('secondary')} />
          <SecondaryButton label="Change kick-off" onClick={() => setKickOff(true)} />
          <DestructiveButton
            label="Delete team"
            sheetTitle="Delete Gulmi Stars?"
            before="Gulmi Stars in Group A"
            after="No team"
            actionLabel="Delete team"
            onConfirm={() => add('onConfirm: Delete team')}
          />
        </div>
        <PrimaryButton label="Create tournament" disabled disabledReason="Add the tournament's name first." />
      </section>

      <section>
        <h2 className="label">Fields</h2>
        <div ref={form} style={{ display: 'grid', gap: 'var(--spacing-4)', maxWidth: '30rem' }}>
          <Field label="Venue" value="" onSave={(v) => add(`onSave: Venue = ${v}`)} />
          <Field label="Team code" value="" required validate={code} showErrors={showErrors} onSave={(v) => add(`onSave: Team code = ${v}`)} />
          <PrimaryButton label="Next" onClick={next} />
        </div>
      </section>

      <section>
        <h2 className="label">Status pills</h2>
        <div className="sample-row">
          <StatusPill state="done" label="Approved" />
          <StatusPill state="pending" label="Submitted" />
        </div>
      </section>

      <section>
        <h2 className="label">Log</h2>
        <ol id="log" className="meta">
          {log.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ol>
      </section>

      <ConfirmSheet
        open={kickOff}
        title="Change the kick-off time?"
        before="Saturday · Kartik 21, 2083 BS (7 Nov 2026) · 2:00 PM"
        after="4:00 PM"
        actionLabel="Move match"
        onConfirm={() => add('onConfirm: Change kick-off')}
        onClose={() => setKickOff(false)}
      />
    </main>
  )
}
