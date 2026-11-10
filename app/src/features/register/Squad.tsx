import { useId, useState } from 'react'
import { forgetRefused, send } from '../../domain/commands'
import { formatDay, inZone } from '../../domain/format'
import { messageFor, messages } from '../../domain/messages'
import { isMinor, noteNew, type RegistrationForm, type SquadPlayer, type StaffMember } from '../../domain/registration'
import { serverNow } from '../../domain/clock'
import { STAFF_ROLES } from '../../domain/tournaments'
import { DestructiveButton, PrimaryButton } from '../../ui/Button'
import { Field } from '../../ui/Field'
import { StatusPill } from '../../ui/StatusPill'
import { blocked, useForm } from '../auth/form'
import { Problem } from '../auth/Screen'

/** Sends one Squad command for the Team; returns the refusal in words (dropped from the queue), else null. */
type Run = (name: string, args: Record<string, unknown>, versionOf?: string) => Promise<string | null>
const roleLabel = (k: string) => STAFF_ROLES.find(([r]) => r === k)?.[1] ?? k
const today = () => inZone(serverNow()).date
const SHIRT = /^\d{1,2}$/
const checkName = (v: string) => (v.length > 80 ? messages.name_long : null)
const checkDob = (v: string) => (v < '1940-01-01' || v > today() ? messages.dob_invalid : null)
const consentLine = (p: SquadPlayer) => (p.consent ? `photo consent: ${p.givenBy ?? ''}` : 'no photo consent')

/**
 * Players, Staff and "Send this Team for review" on the open Registration link form (Story 2.3). Each change is a
 * command through the outbox (scope: the Team); the server checks the Line-up rules and says why in words.
 */
export function Squad({ form, reload }: { form: RegistrationForm; reload: () => Promise<void> }) {
  const teamId = form.team.id
  const run: Run = async (name, args, versionOf) => {
    const r = await send(name, { team_id: teamId, ...args }, { scope: teamId, ...(versionOf ? { versionOf } : {}) })
    void reload()
    // A conflict waits in the hand-back sheet (Keep theirs / Send mine); any other refusal is said here and dropped.
    if (r.ok || r.code === 'queued' || r.code === 'version_conflict') return null
    if (r.commandId) void forgetRefused(r.commandId)
    return r.code === 'lineup_violation' && r.message ? r.message : messageFor(r.code)
  }
  const { starters, maxBench } = form.rules
  return (
    <>
      <section className="card squad">
        <h2 className="body-strong">Players · {form.players.length}</h2>
        {starters !== null && maxBench !== null && (
          <p className="meta">From {starters} to {starters + maxBench} Players: {starters} starters and up to {maxBench} on the bench.</p>
        )}
        {form.players.map((p) => <PlayerCard key={p.id} player={p} form={form} run={run} />)}
        <AddPlayer form={form} run={run} />
      </section>
      <section className="card squad">
        <h2 className="body-strong">Staff · {form.staff.length}</h2>
        {form.staff.map((s) => <StaffCard key={s.id} staff={s} form={form} run={run} />)}
        <AddStaff form={form} run={run} />
      </section>
      <Submit form={form} run={run} />
    </>
  )
}

/** The photo-consent statement and its tick box. */
function ConsentBox({ form, checked, onChange }: { form: RegistrationForm; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <fieldset className="choices">
      <legend className="body-strong">Photo consent</legend>
      {form.rules.consentStatement && <p className="body">{form.rules.consentStatement}</p>}
      <label className="choice body">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        Photo consent given
      </label>
    </fieldset>
  )
}

/** Who gives consent: a parent or guardian for a minor (under 18 today), else the person giving it. */
const givenByField = (minor: boolean) => minor
  ? { label: "Parent or guardian's name", requiredMessage: messages.guardian_required }
  : { label: 'Name of the person giving consent', requiredMessage: messages.consent_name_required }

const shirtCheck = (players: SquadPlayer[], self?: string) => (v: string) => {
  if (!SHIRT.test(v) || Number(v) < 1) return messages.shirt_invalid
  const other = players.find((p) => p.id !== self && p.shirtNumber === Number(v))
  return other ? `Shirt number ${v} is already used by ${other.name}. Choose another number.` : null
}

function AddPlayer({ form, run }: { form: RegistrationForm; run: Run }) {
  const { ref, showErrors, values } = useForm()
  const [key, setKey] = useState(0)
  const [dob, setDob] = useState('')
  const [consent, setConsent] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const who = givenByField(isMinor(dob))

  async function add() {
    const v = values()
    if (!v || busy) return
    setBusy(true)
    setProblem(null)
    const id = crypto.randomUUID()
    await noteNew(id)
    const name = v['player-name']!
    const p = await run('add_player', { player_id: id, name, shirt_number: Number(v['shirt-number']), date_of_birth: v['date-of-birth'],
      consent, ...(consent ? { given_by: v['given-by'] } : {}) })
    setBusy(false)
    if (p) return setProblem(p)
    setNotice(`${name} added.`)
    setDob('')
    setConsent(false)
    setKey((n) => n + 1)
  }

  return (
    <form key={key} ref={ref} noValidate className="squad-add" onSubmit={(e) => (e.preventDefault(), void add())}>
      <h3 className="body-strong">Add player</h3>
      <p role="status" className="body">{notice}</p>
      <Field label="Player's name" name="player-name" value="" onSave={() => {}} required requiredMessage={messages.player_name_required}
        validate={checkName} showErrors={showErrors} autoComplete="off" />
      <Field label="Shirt number" name="shirt-number" value="" onSave={() => {}} required requiredMessage={messages.shirt_required}
        validate={shirtCheck(form.players)} showErrors={showErrors} inputMode="numeric" autoComplete="off" />
      <Field label="Date of birth" name="date-of-birth" type="date" value={dob} onSave={setDob} required requiredMessage={messages.dob_required}
        validate={checkDob} showErrors={showErrors} min="1940-01-01" max={today()} hint={formatDay} />
      <ConsentBox form={form} checked={consent} onChange={setConsent} />
      {consent && <Field label={who.label} name="given-by" value="" onSave={() => {}} required requiredMessage={who.requiredMessage}
        validate={checkName} showErrors={showErrors} autoComplete="off" />}
      <Problem text={problem} />
      <PrimaryButton label="Add this Player" onClick={() => void add()} {...blocked(busy && 'Adding the Player…')} />
    </form>
  )
}

/** One Player: a summary line that opens the card; each field saves on leaving it. */
function PlayerCard({ player: p, form, run }: { player: SquadPlayer; form: RegistrationForm; run: Run }) {
  const [problem, setProblem] = useState<string | null>(null)
  const [consent, setConsent] = useState(p.consent)
  const [prop, setProp] = useState(p.consent)
  const [missing, setMissing] = useState(false)
  // A new date of birth that makes a consenting adult a minor waits for the guardian's name; both go in one change.
  const [heldDob, setHeldDob] = useState<string | null>(null)
  // A new read replaces the tick, unless the person ticked it and still owes the name.
  if (p.consent !== prop) {
    setProp(p.consent)
    if (!missing) setConsent(p.consent)
  }
  const who = givenByField(isMinor(heldDob ?? p.dateOfBirth))

  function saveDob(date_of_birth: string) {
    if (p.consent && isMinor(date_of_birth) && !isMinor(p.dateOfBirth)) return (setHeldDob(date_of_birth), setMissing(true))
    setHeldDob(null)
    void save({ date_of_birth })
  }
  const save = async (args: Record<string, unknown>) => setProblem(await run('edit_player', { player_id: p.id, ...args }, p.id))

  function tick(v: boolean) {
    setConsent(v)
    setProblem(null)
    if (!v) return (setMissing(false), setHeldDob(null), p.consent && void save({ consent: false, ...(heldDob ? { date_of_birth: heldDob } : {}) }))
    if (p.givenBy) return void save({ consent: true, given_by: p.givenBy })
    setMissing(true) // the name field asks for it; leaving it filled in saves both
  }

  return (
    <details className="squad-card">
      <summary>
        <span className="body-strong">{p.name} · #{p.shirtNumber}</span>
        <span className="meta"> {consentLine(p)}</span>
      </summary>
      <Field label="Player's name" value={p.name} onSave={(name) => void save({ name })} required requiredMessage={messages.player_name_required}
        validate={checkName} autoComplete="off" />
      <Field label="Shirt number" value={String(p.shirtNumber)} onSave={(v) => void save({ shirt_number: Number(v) })} required
        requiredMessage={messages.shirt_required} validate={shirtCheck(form.players, p.id)} inputMode="numeric" autoComplete="off" />
      <Field label="Date of birth" type="date" value={p.dateOfBirth} onSave={saveDob} required
        requiredMessage={messages.dob_required} validate={checkDob} min="1940-01-01" max={today()} hint={formatDay} />
      <ConsentBox form={form} checked={consent} onChange={tick} />
      {consent && <Field key={heldDob ? 'guardian' : 'giver'} label={who.label} value={p.consent && !heldDob ? p.givenBy ?? '' : ''} required
        requiredMessage={who.requiredMessage} validate={checkName} showErrors={missing} autoComplete="off"
        onSave={(given_by) => (setMissing(false), setHeldDob(null),
          void save({ consent: true, given_by, ...(heldDob ? { date_of_birth: heldDob } : {}) }))} />}
      <Problem text={problem} />
      <DestructiveButton label="Remove from the Squad" accessibleLabel={`Remove ${p.name} from the Squad`} sheetTitle={`Remove ${p.name}?`}
        before={`${p.name} in the Squad`} after="Removed, with their details" actionLabel={`Remove ${p.name}`}
        onConfirm={() => void run('remove_player', { player_id: p.id }, p.id).then(setProblem)} />
    </details>
  )
}

function RoleSelect({ roles, value, onChange }: { roles: string[]; value: string; onChange: (v: string) => void }) {
  const id = useId()
  return (
    <div className="ui-field">
      <label htmlFor={id} className="body-strong">Role</label>
      <select id={id} name="staff-role" className="ui-input" value={value} onChange={(e) => onChange(e.target.value)}>
        {roles.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
      </select>
    </div>
  )
}

function AddStaff({ form, run }: { form: RegistrationForm; run: Run }) {
  const { ref, showErrors, values } = useForm()
  const roles = form.rules.staffRoles
  const [key, setKey] = useState(0)
  const [role, setRole] = useState(roles[0] ?? '')
  const [problem, setProblem] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  if (!roles.length) return <p className="body">The Line-up rules allow no Staff for this Season.</p>
  const picked = roles.includes(role) ? role : roles[0]!

  async function add() {
    const v = values()
    if (!v || busy) return
    setBusy(true)
    setProblem(null)
    const id = crypto.randomUUID()
    await noteNew(id)
    const p = await run('add_staff', { staff_id: id, name: v['staff-name'], role: picked })
    setBusy(false)
    if (p) return setProblem(p)
    setNotice(`${v['staff-name']} added as ${roleLabel(picked)}.`)
    setKey((n) => n + 1)
  }

  return (
    <form key={key} ref={ref} noValidate className="squad-add" onSubmit={(e) => (e.preventDefault(), void add())}>
      <h3 className="body-strong">Add staff</h3>
      <p role="status" className="body">{notice}</p>
      <Field label="Staff member's name" name="staff-name" value="" onSave={() => {}} required requiredMessage={messages.staff_name_required}
        validate={checkName} showErrors={showErrors} autoComplete="off" />
      <RoleSelect roles={roles} value={picked} onChange={setRole} />
      <Problem text={problem} />
      <PrimaryButton label="Add this Staff member" onClick={() => void add()} {...blocked(busy && 'Adding the Staff member…')} />
    </form>
  )
}

function StaffCard({ staff: s, form, run }: { staff: StaffMember; form: RegistrationForm; run: Run }) {
  const [problem, setProblem] = useState<string | null>(null)
  const save = async (args: Record<string, unknown>) => setProblem(await run('edit_staff', { staff_id: s.id, ...args }, s.id))
  // A role the rules no longer allow still shows, so the person sees what to change.
  const roles = form.rules.staffRoles.includes(s.role) ? form.rules.staffRoles : [s.role, ...form.rules.staffRoles]
  return (
    <details className="squad-card">
      <summary>
        <span className="body-strong">{s.name}</span>
        <span className="meta"> {roleLabel(s.role)}</span>
      </summary>
      <Field label="Staff member's name" value={s.name} onSave={(name) => void save({ name })} required
        requiredMessage={messages.staff_name_required} validate={checkName} autoComplete="off" />
      <RoleSelect roles={roles} value={s.role} onChange={(role) => void save({ role })} />
      <Problem text={problem} />
      <DestructiveButton label="Remove from the Staff" accessibleLabel={`Remove ${s.name} from the Staff`} sheetTitle={`Remove ${s.name}?`}
        before={`${s.name}, ${roleLabel(s.role)}`} after="Removed from the Staff" actionLabel={`Remove ${s.name}`}
        onConfirm={() => void run('remove_staff', { staff_id: s.id }, s.id).then(setProblem)} />
    </details>
  )
}

function Submit({ form, run }: { form: RegistrationForm; run: Run }) {
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const status = form.team.status
  const { starters } = form.rules
  async function submit() {
    // The one rule this phone can check offline; the server checks them all.
    if (starters !== null && form.players.length < starters) {
      return setProblem(`Squad needs at least ${starters} Player${starters === 1 ? '' : 's'}. You have ${form.players.length}.`)
    }
    setBusy(true)
    setProblem(await run('submit_team', {}))
    setBusy(false)
  }
  return (
    <section className="card">
      <h2 className="body-strong">Review</h2>
      {status === 'submitted' || status === 'approved' ? (
        <>
          <StatusPill state={status === 'approved' ? 'done' : 'pending'} label={status === 'approved' ? 'Approved' : 'Submitted'} />
          <p className="body">{status === 'approved' ? 'The organiser approved this Team.'
            : 'Sent for review. You can still change the Squad until the deadline.'}</p>
        </>
      ) : (
        <>
          <p className="body">When the Squad and Staff are complete, send them to the organiser.</p>
          <PrimaryButton label="Send this Team for review" onClick={() => void submit()} {...blocked(busy && 'Sending the Team…')} />
        </>
      )}
      <Problem text={problem} />
    </section>
  )
}

/** The Squad as text, once the form is closed: no date of birth, the consent's name only. */
export function ClosedSquad({ form }: { form: RegistrationForm }) {
  return (
    <>
      <section className="card">
        <h2 className="body-strong">Players · {form.players.length}</h2>
        <ul className="squad-list">
          {form.players.map((p) => <li key={p.id} className="body">{p.name} · #{p.shirtNumber} · {consentLine(p)}</li>)}
        </ul>
      </section>
      <section className="card">
        <h2 className="body-strong">Staff · {form.staff.length}</h2>
        <ul className="squad-list">
          {form.staff.map((s) => <li key={s.id} className="body">{s.name} · {roleLabel(s.role)}</li>)}
        </ul>
      </section>
    </>
  )
}
