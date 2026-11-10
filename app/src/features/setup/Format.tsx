import { useId, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { send } from '../../domain/commands'
import { messages, numberRange } from '../../domain/messages'
import { SETTINGS, type FormatPreset, type MatchSettings } from '../../domain/tournaments'
import { ConfirmSheet } from '../../ui/ConfirmSheet'
import { Field } from '../../ui/Field'
import { useForm } from '../auth/form'
import { Frame } from './Frame'

type Props = { tournamentId: string; seasonId: string; initial: MatchSettings; presets: FormatPreset[] }
type NumKey = 'periods' | 'period_minutes' | 'half_time_minutes' | 'extra_time_periods' | 'extra_time_minutes' | 'max_substitutions'
  | 'foul_warning' | 'timeouts_per_period' | 'power_play_minutes'

// The ranges app.season's check allows.
const RANGES: Record<NumKey, [number, number]> = {
  periods: [1, 4], period_minutes: [1, 60], half_time_minutes: [0, 30], extra_time_periods: [1, 2], extra_time_minutes: [1, 30],
  max_substitutions: [1, 50], foul_warning: [1, 20], timeouts_per_period: [0, 3], power_play_minutes: [1, 5],
}
const NUMS = Object.keys(RANGES) as NumKey[]
const KEYS = SETTINGS.filter((k) => k !== 'format_preset')

const checkNumber = (k: NumKey) => (v: string) => {
  const [min, max] = RANGES[k]
  const n = /^\d+$/.test(v) ? Number(v) : NaN
  if (k === 'max_substitutions' && !(n >= 1)) return messages.substitutions_max_needed
  return n >= min && n <= max ? null : numberRange(min, max)
}

/** "Futsal: 2 × 20 min, stopped clock, half-time 15, extra time 2 × 5, …" for the Confirm sheet: every setting. */
const summary = (label: string, s: MatchSettings) => [
  `${label}: ${s.periods} × ${s.period_minutes} min`, `${s.clock} clock`, `half-time ${s.half_time_minutes}`,
  s.extra_time ? `extra time ${s.extra_time_periods} × ${s.extra_time_minutes}` : 'no extra time',
  s.shootout ? 'shootout' : 'no shootout',
  s.substitutions === 'limited' ? `at most ${s.max_substitutions ?? '?'} substitutions` : 'rolling substitutions',
  ...(s.foul_warning != null ? [`foul warning at ${s.foul_warning}`, `timeouts per period ${s.timeouts_per_period}`, `power play ${s.power_play_minutes} min`] : []),
].join(', ')

/**
 * Step 4, Format. Picking a preset sends only its key (the server copies its row); each setting then saves on its
 * own, numbers when the field is left, choices when they change. Switching preset after edits asks first.
 */
export function StepFour({ tournamentId, seasonId, initial, presets }: Props) {
  const navigate = useNavigate()
  const { ref, showErrors, values } = useForm()
  const [s, setS] = useState(initial)
  // What is shown (read by handlers in the same tick) and what was last sent.
  const shown = useRef(initial)
  const last = useRef(initial)
  const [asking, setAsking] = useState<FormatPreset | null>(null)
  const [presetError, setPresetError] = useState(false)
  const errorId = useId()
  const etId = useId()
  const soId = useId()
  const preset = presets.find((p) => p.key === s.format_preset) ?? null

  function show(v: MatchSettings) {
    shown.current = v
    setS(v)
  }

  function save(fields: Partial<MatchSettings>) {
    const v = { ...shown.current, ...fields }
    show(v)
    const changed = Object.fromEntries(KEYS.filter((k) => v[k] !== last.current[k]).map((k) => [k, v[k]])) as Partial<MatchSettings>
    // Limited waits for a valid maximum: the server refuses it without one.
    if (v.substitutions === 'limited' && v.max_substitutions == null) delete changed.substitutions
    if (!Object.keys(changed).length) return
    last.current = { ...last.current, ...changed }
    void send('set_match_settings', { season_id: seasonId, ...changed }, { scope: tournamentId, versionOf: seasonId })
  }

  function apply(p: FormatPreset) {
    show(p.settings)
    last.current = p.settings
    setPresetError(false)
    void send('set_match_settings', { season_id: seasonId, format_preset: p.key }, { scope: tournamentId, versionOf: seasonId })
  }

  function pick(p: FormatPreset) {
    if (p.key === shown.current.format_preset) return
    const now = presets.find((x) => x.key === shown.current.format_preset)
    if (now && KEYS.some((k) => shown.current[k] !== now.settings[k])) setAsking(p)
    else apply(p)
  }

  /** The number fields as typed, where valid. */
  function typed(): Partial<MatchSettings> {
    const els = ref.current?.elements
    return Object.fromEntries(NUMS.flatMap((k) => {
      const v = (els?.namedItem(k) as HTMLInputElement | null)?.value.trim()
      return v != null && checkNumber(k)(v) === null ? [[k, Number(v)]] : []
    }))
  }

  function next() {
    if (!shown.current.format_preset) {
      setPresetError(true)
      ref.current?.querySelector<HTMLInputElement>('input[name="format_preset"]')?.focus()
      return
    }
    if (!values()) return
    save(typed())
    void send('set_setup_step', { season_id: seasonId, step: 4 }, { scope: tournamentId })
    navigate(`/t/${tournamentId}/setup/5`, { replace: true })
  }

  function back() {
    if (shown.current.format_preset) save(typed())
    navigate(`/t/${tournamentId}/setup/3`, { replace: true })
  }

  const num = (k: NumKey, label: string, hint?: string) => (
    <Field label={label} name={k} inputMode="numeric" autoComplete="off" value={s[k] == null ? '' : String(s[k])}
      required requiredMessage={k === 'max_substitutions' ? messages.substitutions_max_needed : numberRange(...RANGES[k])}
      validate={checkNumber(k)} showErrors={showErrors || (k === 'max_substitutions' && s.max_substitutions == null)}
      onSave={(v) => save({ [k]: Number(v) })} hint={hint ? () => hint : undefined} />
  )
  const radio = <K extends 'clock' | 'substitutions'>(k: K, value: MatchSettings[K] & string, label: string) => (
    <label className="choice body">
      <input type="radio" name={k} value={value} checked={s[k] === value} onChange={() => save({ [k]: value })} />
      {label}
    </label>
  )

  return (
    <Frame step={4} onBack={back} onNext={next}>
      <form ref={ref} noValidate className="wizard-fields wizard-single" onSubmit={(e) => (e.preventDefault(), next())}>
        <p className="body">Pick the closest preset, then change anything below.</p>
        <fieldset className="choices" aria-describedby={presetError ? errorId : undefined}>
          <legend className="body-strong">Format preset</legend>
          <div className="presets">
            {presets.map((p) => (
              <label key={p.key} className="choice body">
                <input type="radio" name="format_preset" value={p.key} checked={s.format_preset === p.key} onChange={() => pick(p)} />
                {p.label}
              </label>
            ))}
          </div>
          {presetError && <p id={errorId} className="meta ui-error">{messages.preset_required}</p>}
        </fieldset>
        {preset && (
          <>
            <h2 className="body-strong">Match settings · {preset.label}</h2>
            {num('periods', 'Periods')}
            {num('period_minutes', 'Minutes per period')}
            <fieldset className="choices">
              <legend className="body-strong">Clock</legend>
              {radio('clock', 'stopped', 'Stopped clock')}
              {radio('clock', 'running', 'Running clock')}
            </fieldset>
            {num('half_time_minutes', 'Half-time (minutes)')}
            <div>
              <label className="choice body">
                <input type="checkbox" name="extra_time" checked={!!s.extra_time} aria-describedby={etId}
                  onChange={(e) => save({ extra_time: e.target.checked })} />
                Extra time
              </label>
              <p id={etId} className="meta">If a knockout match is level</p>
            </div>
            {s.extra_time && num('extra_time_periods', 'Extra-time periods')}
            {s.extra_time && num('extra_time_minutes', 'Minutes per extra-time period')}
            <div>
              <label className="choice body">
                <input type="checkbox" name="shootout" checked={!!s.shootout} aria-describedby={soId}
                  onChange={(e) => save({ shootout: e.target.checked })} />
                Shootout
              </label>
              <p id={soId} className="meta">{s.extra_time ? 'If still level after extra time' : 'If a knockout match is level at full time'}</p>
            </div>
            <fieldset className="choices">
              <legend className="body-strong">Substitutions</legend>
              {radio('substitutions', 'rolling', 'Rolling')}
              {radio('substitutions', 'limited', 'Limited')}
            </fieldset>
            {s.substitutions === 'limited' && num('max_substitutions', 'Maximum substitutions')}
            {preset.futsalRules && (
              <>
                {num('foul_warning', 'Accumulated-foul warning',
                  'The console warns when a team reaches this many fouls in a period. Fouls reset at half-time and carry into extra time.')}
                {num('timeouts_per_period', 'Timeouts per team per period', "Unused timeouts don't carry over. None in extra time.")}
                {num('power_play_minutes', 'Power play (minutes)', 'After a sending-off. Ends early if the opponent scores.')}
              </>
            )}
          </>
        )}
      </form>
      <ConfirmSheet open={!!asking} title={`Replace your Match settings with the ${asking?.label ?? ''} defaults?`}
        before={preset ? summary(`${preset.label} (changed)`, s) : ''} after={asking ? summary(asking.label, asking.settings) : ''}
        actionLabel="Replace Match settings" destructive onConfirm={() => asking && apply(asking)} onClose={() => setAsking(null)} />
    </Frame>
  )
}
