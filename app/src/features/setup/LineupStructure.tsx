import { useEffect, useId, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { send } from '../../domain/commands'
import { messages, numberRange, qualifiersRange, teamsAboveQualifiers } from '../../domain/messages'
import { STAFF_ROLES, STRUCTURES, TIEBREAKS, type LineupRules, type Structure } from '../../domain/tournaments'
import { Field } from '../../ui/Field'
import { useForm } from '../auth/form'
import { Frame } from './Frame'

type Ids = { tournamentId: string; seasonId: string }
type Check = (v: string) => string | null

const whole = (min: number, max: number): Check => (v) => {
  const n = /^\d+$/.test(v) ? Number(v) : NaN
  return n >= min && n <= max ? null : numberRange(min, max)
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * The values shown and an edit that sends only what differs from what was last sent, as one versioned edit (the outbox
 * fills in expected_version). sent: the Season's values, which can differ from the shown ones (step 5's preset defaults).
 */
function useSeasonEdit<T extends object>(command: string, { tournamentId, seasonId }: Ids, initial: T, sent: T) {
  const [v, setV] = useState(initial)
  const shown = useRef(initial)
  const last = useRef(sent)
  function save(fields: Partial<T>) {
    shown.current = { ...shown.current, ...fields }
    setV(shown.current)
    const changed = Object.fromEntries(Object.entries(fields).filter(([k, x]) => x !== undefined && !same(x, last.current[k as keyof T])))
    if (!Object.keys(changed).length) return
    last.current = { ...last.current, ...changed }
    void send(command, { season_id: seasonId, ...changed }, { scope: tournamentId, versionOf: seasonId })
  }
  return { v, shown, save }
}

/** The number fields as typed, where valid and not shown as a problem. */
function typed(form: HTMLFormElement | null, checks: Record<string, Check>) {
  return Object.fromEntries(Object.entries(checks).flatMap(([k, check]) => {
    const el = form?.elements.namedItem(k) as HTMLInputElement | null
    const v = el?.value.trim()
    return el && v && el.getAttribute('aria-invalid') !== 'true' && check(v) === null ? [[k, Number(v)]] : []
  }))
}

/**
 * Step 5, Line-up rules. Starters and the maximum bench start from the Format preset's defaults until the Season has
 * its own, and save when the field is left (Next saves them too); each Staff role saves when ticked.
 */
export function StepFive({ initial, defaults, ...ids }: Ids & { initial: LineupRules; defaults?: { starters: number | null; max_bench: number | null } }) {
  const navigate = useNavigate()
  const { ref, showErrors, values } = useForm()
  const { v, shown, save } = useSeasonEdit('set_lineup_rules', ids, {
    ...initial, starters: initial.starters ?? defaults?.starters ?? null, max_bench: initial.max_bench ?? defaults?.max_bench ?? null,
  }, initial)
  const checks = { starters: whole(1, 11), max_bench: whole(0, 20) }
  const rolesHint = useId()

  function next() {
    if (!values()) return
    save(typed(ref.current, checks))
    void send('set_setup_step', { season_id: ids.seasonId, step: 5 }, { scope: ids.tournamentId })
    navigate(`/t/${ids.tournamentId}/setup/6`, { replace: true })
  }
  function back() {
    save(typed(ref.current, checks))
    navigate(`/t/${ids.tournamentId}/setup/4`, { replace: true })
  }
  const num = (k: keyof typeof checks, label: string, [min, max]: [number, number]) => (
    <Field label={label} name={k} inputMode="numeric" autoComplete="off" value={v[k] == null ? '' : String(v[k])} required
      requiredMessage={numberRange(min, max)} validate={checks[k]} showErrors={showErrors} onSave={(x) => save({ [k]: Number(x) })} />
  )

  return (
    <Frame step={5} onBack={back} onNext={next}>
      <form ref={ref} noValidate className="wizard-fields wizard-single" onSubmit={(e) => (e.preventDefault(), next())}>
        <p className="body">How many Players start a match, how many can wait on the bench, and which Staff a Team can register.</p>
        {num('starters', 'Starters', [1, 11])}
        {num('max_bench', 'Maximum bench', [0, 20])}
        <fieldset className="choices" aria-describedby={rolesHint}>
          <legend className="body-strong">Allowed Staff roles</legend>
          <p id={rolesHint} className="meta">Teams can register Staff only in these roles.</p>
          {STAFF_ROLES.map(([k, label]) => (
            <label key={k} className="choice body">
              <input type="checkbox" name="staff_roles" value={k} checked={v.staff_roles.includes(k)}
                onChange={(e) => save({ staff_roles: STAFF_ROLES.map(([r]) => r)
                  .filter((r) => (r === k ? e.target.checked : shown.current.staff_roles.includes(r))) })} />
              {label}
            </label>
          ))}
        </fieldset>
      </form>
    </Frame>
  )
}

const words = Object.fromEntries(TIEBREAKS)

/**
 * Step 6, Structure. The Structure saves when picked; numbers when their field is left. Groups then knockout asks for the
 * groups; a table (groups or league) has points and the tie-break order, changed with Move up / Move down / Remove /
 * Add back, each change saved at once.
 */
export function StepSix({ initial, ...ids }: Ids & { initial: Structure }) {
  const navigate = useNavigate()
  const { ref, showErrors, values } = useForm()
  const { v, shown, save } = useSeasonEdit('set_structure', ids, initial, initial)
  const [structureError, setStructureError] = useState(false)
  const [announce, setAnnounce] = useState('')
  const errorId = useId()
  const tiebreakHint = useId()
  // After a reorder: the item's buttons to focus, first one that is enabled (React moves the node, which drops focus).
  const focus = useRef<{ key: string; acts: string[] } | null>(null)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const f = focus.current
    if (!f) return
    focus.current = null
    for (const act of f.acts) {
      const el = list.current?.querySelector<HTMLButtonElement>(`[data-key="${f.key}"] [data-act="${act}"]`)
      if (el && !el.disabled) return el.focus()
    }
  })

  const q = v.qualifiers_per_group
  const t = v.teams_per_group
  const checks: Record<string, Check> = {
    group_count: whole(2, 16),
    teams_per_group: (x) => whole(2, 16)(x) ?? (q != null && Number(x) <= q ? teamsAboveQualifiers(q) : null),
    qualifiers_per_group: (x) => (t == null ? whole(1, 15)(x) : whole(1, t - 1)(x) && qualifiersRange(t)),
    points_win: whole(0, 9), points_draw: whole(0, 9), points_loss: whole(0, 9),
  }
  const groups = v.structure === 'groups_knockout'
  const table = groups || v.structure === 'league'

  function order(tiebreaks: string[], key: string, acts: string[], said: string) {
    focus.current = { key, acts }
    setAnnounce(said)
    save({ tiebreaks })
  }
  function move(i: number, d: -1 | 1) {
    const tb = [...shown.current.tiebreaks]
    const k = tb[i]!
    ;[tb[i], tb[i + d]] = [tb[i + d]!, k]
    order(tb, k, d < 0 ? ['up', 'down', 'remove'] : ['down', 'up', 'remove'], `${words[k]} moved to number ${i + d + 1} of ${tb.length}.`)
  }

  function next() {
    if (!shown.current.structure) {
      setStructureError(true)
      ref.current?.querySelector<HTMLInputElement>('input[name="structure"]')?.focus()
      return
    }
    if (!values()) return
    save(typed(ref.current, checks))
    void send('set_setup_step', { season_id: ids.seasonId, step: 6 }, { scope: ids.tournamentId })
    navigate(`/t/${ids.tournamentId}/setup/7`, { replace: true })
  }
  function back() {
    save(typed(ref.current, checks))
    navigate(`/t/${ids.tournamentId}/setup/5`, { replace: true })
  }
  const num = (k: keyof Structure & string, label: string, range: string) => (
    <Field label={label} name={k} inputMode="numeric" autoComplete="off" value={v[k] == null ? '' : String(v[k])} required
      requiredMessage={range} validate={checks[k]} showErrors={showErrors} onSave={(x) => save({ [k]: Number(x) })} />
  )
  const removed = TIEBREAKS.filter(([k]) => !v.tiebreaks.includes(k))

  return (
    <Frame step={6} onBack={back} onNext={next}>
      <form ref={ref} noValidate className="wizard-fields wizard-single" onSubmit={(e) => (e.preventDefault(), next())}>
        <fieldset className="choices" aria-describedby={structureError ? errorId : undefined}>
          <legend className="body-strong">Structure</legend>
          {STRUCTURES.map(([k, label]) => (
            <label key={k} className="choice body">
              <input type="radio" name="structure" value={k} checked={v.structure === k}
                onChange={() => (setStructureError(false), save({ structure: k as Structure['structure'] }))} />
              {label}
            </label>
          ))}
          {structureError && <p id={errorId} className="meta ui-error">{messages.structure_required}</p>}
        </fieldset>
        {groups && (
          <>
            {num('group_count', 'Number of groups', numberRange(2, 16))}
            {num('teams_per_group', 'Teams per group', numberRange(2, 16))}
            {num('qualifiers_per_group', 'Qualifiers per group', t == null ? numberRange(1, 15) : qualifiersRange(t))}
          </>
        )}
        {table && (
          <>
            <fieldset className="choices wizard-fields">
              <legend className="body-strong">Points</legend>
              {num('points_win', 'Points for a win', numberRange(0, 9))}
              {num('points_draw', 'Points for a draw', numberRange(0, 9))}
              {num('points_loss', 'Points for a loss', numberRange(0, 9))}
            </fieldset>
            <div ref={list} className="wizard-fields">
              <h2 className="body-strong">Tie-breaks</h2>
              <p id={tiebreakHint} className="meta">For Teams level on points, in this order. A shootout decides a tie but adds no goals or points.</p>
              <ol className="tiebreaks" aria-describedby={tiebreakHint}>
                {v.tiebreaks.map((k, i) => (
                  <li key={k} data-key={k} className="tiebreak">
                    <span className="body">{i + 1}. {words[k] ?? k}</span>
                    <span className="tiebreak-actions">
                      <button type="button" className="ui-button ui-secondary" data-act="up" aria-label={`Move up ${words[k]}`}
                        disabled={i === 0} onClick={() => move(i, -1)}>Move up</button>
                      <button type="button" className="ui-button ui-secondary" data-act="down" aria-label={`Move down ${words[k]}`}
                        disabled={i === v.tiebreaks.length - 1} onClick={() => move(i, 1)}>Move down</button>
                      <button type="button" className="ui-button ui-secondary" data-act="remove" aria-label={`Remove ${words[k]}`}
                        onClick={() => order(shown.current.tiebreaks.filter((x) => x !== k), k, ['add'], `${words[k]} removed.`)}>Remove</button>
                    </span>
                  </li>
                ))}
              </ol>
              {!v.tiebreaks.length && <p className="meta">No tie-breaks: Teams level on points stay level.</p>}
              {removed.length > 0 && (
                <>
                  <h3 className="body-strong">Not used</h3>
                  <ul className="tiebreaks">
                    {removed.map(([k, label]) => (
                      <li key={k} data-key={k} className="tiebreak">
                        <span className="body">{label}</span>
                        <button type="button" className="ui-button ui-secondary" data-act="add" aria-label={`Add back ${label}`}
                          onClick={() => order([...shown.current.tiebreaks, k], k, ['remove'],
                            `${label} added back as number ${shown.current.tiebreaks.length + 1}.`)}>Add back</button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <p className="ui-visually-hidden" aria-live="polite">{announce}</p>
            </div>
          </>
        )}
      </form>
    </Frame>
  )
}
