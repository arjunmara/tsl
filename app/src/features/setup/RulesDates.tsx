import { useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { send } from '../../domain/commands'
import { BS_RANGE, formatDate, toBs } from '../../domain/format'
import { messages } from '../../domain/messages'
import type { SeasonAnswers } from '../../domain/tournaments'
import { Field } from '../../ui/Field'
import { useForm } from '../auth/form'
import { Frame, useLeave } from './Frame'

type Props = { tournamentId: string; seasonId: string; initial: SeasonAnswers }
type Key = keyof SeasonAnswers

/**
 * One wizard step that edits the Season: each field saves when it is left, sending only what differs from the last
 * saved value as one versioned edit (the outbox fills in expected_version). Next saves every field, records the step
 * as finished and opens the next one.
 */
function useSeasonStep({ tournamentId, seasonId, initial }: Props, step: number, command: string, keys: readonly Key[]) {
  const navigate = useNavigate()
  const leave = useLeave(tournamentId, step)
  const { ref, showErrors, values } = useForm()
  const [saved, setSaved] = useState(initial)
  const last = useRef(initial)

  function save(fields: Partial<SeasonAnswers>) {
    const changed = Object.fromEntries(Object.entries(fields).filter(([k, v]) => v !== undefined && v !== last.current[k as Key]))
    if (!Object.keys(changed).length) return
    last.current = { ...last.current, ...changed }
    setSaved(last.current)
    void send(command, { season_id: seasonId, ...changed }, { scope: tournamentId, versionOf: seasonId })
  }

  function next() {
    const v = values()
    if (!v) return
    save(Object.fromEntries(keys.map((k) => [k, v[k] ?? ''])))
    void send('set_setup_step', { season_id: seasonId, step }, { scope: tournamentId })
    navigate(`/t/${tournamentId}/setup/${step + 1}`, { replace: true })
  }

  // A value that became valid after it was left (another date moved) is saved too; shown problems are not.
  function back() {
    const els = ref.current?.elements
    save(Object.fromEntries(keys.flatMap((k) => {
      const el = els?.namedItem(k) as HTMLInputElement | HTMLTextAreaElement | null
      const v = el?.value.trim() ?? ''
      return el && el.getAttribute('aria-invalid') !== 'true' && (v || !(DATES as readonly string[]).includes(k)) ? [[k, v]] : []
    })))
    leave()
  }
  const field = (k: Key) => ({ name: k, value: saved[k], onSave: (v: string) => save({ [k]: v }), showErrors })
  return { ref, saved, next, back, field }
}

// Code points, as the server's char_length counts them.
const atMost = (n: number, message: string) => (v: string) => ([...v].length <= n ? null : message)
const RULES = ['description', 'rules', 'photo_consent'] as const

/** Step 2, Description & rules. The photo-consent statement is needed before Next. */
export function StepTwo(props: Props) {
  const { ref, next, back, field } = useSeasonStep(props, 2, 'set_season_rules', RULES)
  return (
    <Frame step={2} onBack={back} onNext={next}>
      <form ref={ref} noValidate className="wizard-fields wizard-single" onSubmit={(e) => (e.preventDefault(), next())}>
        <Field label="Description" multiline {...field('description')} validate={atMost(1000, messages.description_long)} />
        <Field label="Rules" multiline {...field('rules')} validate={atMost(10000, messages.rules_long)} />
        <Field label="Photo-consent statement" multiline required requiredMessage={messages.consent_required}
          {...field('photo_consent')} validate={atMost(2000, messages.consent_long)} />
      </form>
    </Frame>
  )
}

const DATES = ['starts_on', 'ends_on', 'registration_deadline'] as const

/** Step 3, Dates. Each date shows in BS and AD; a deadline after the start or an end before it says why and isn't saved. */
export function StepThree(props: Props) {
  const { ref, saved, next, back, field } = useSeasonStep(props, 3, 'set_season_dates', DATES)
  // Checked against the other dates as last saved, as the server checks them.
  const order = (k: Key) => (v: string) => {
    if (!toBs(v)) return messages.date_out_of_range
    const d = { ...saved, [k]: v }
    if (d.registration_deadline && d.starts_on && d.registration_deadline > d.starts_on) return messages.deadline_after_start
    if (d.ends_on && d.starts_on && d.ends_on < d.starts_on) return messages.end_before_start
    return null
  }
  const date = (k: Key, required: string) => ({
    ...field(k), type: 'date' as const, min: BS_RANGE.min, max: BS_RANGE.max, required: true, requiredMessage: required,
    validate: order(k), hint: (v: string) => formatDate(v) || null,
  })
  return (
    <Frame step={3} onBack={back} onNext={next}>
      <form ref={ref} noValidate className="wizard-fields wizard-single" onSubmit={(e) => (e.preventDefault(), next())}>
        <Field label="Season starts" {...date('starts_on', messages.start_required)} />
        <Field label="Season ends" {...date('ends_on', messages.end_required)} />
        <Field label="Registration deadline" {...date('registration_deadline', messages.deadline_required)} />
        <p className="meta">Teams can register until the end of the deadline day.</p>
      </form>
    </Frame>
  )
}
