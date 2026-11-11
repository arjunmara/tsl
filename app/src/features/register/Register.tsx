import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { hasSession, signInAnonymously, signOut } from '../../domain/auth'
import { forgetRefused, queuedFor, send } from '../../domain/commands'
import { formatDay } from '../../domain/format'
import { messageFor, messages } from '../../domain/messages'
import { forgetForm, overlayForm, redeem, registrationClosed, registrationForm, type RegistrationForm } from '../../domain/registration'
import { CODE, sha256Hex, TOKEN } from '../../domain/teamCode'
import { SecondaryButton } from '../../ui/Button'
import { Field } from '../../ui/Field'
import { KitDot } from '../../ui/KitDot'
import { StatusPill } from '../../ui/StatusPill'
import { Problem } from '../auth/Screen'
import { Turnstile } from '../auth/Turnstile'
import { teamStatusLabel } from '../home/Teams'
import { SaveStatusBar } from '../save-status/SaveStatusBar'
import { token } from '../setup/brand'
import { ColourField } from '../setup/Setup'
import { ClosedSquad, Squad } from './Squad'

type State = { step: 'loading' | 'captcha' | 'bad' | 'dead' } | { step: 'problem'; text: string } | { step: 'form'; form: RegistrationForm; hash: string }

/**
 * /register#<token>: a Team manager's own Team form (AD-19). Sealed: no App bar, tabs, Settings or link to anywhere
 * else. The page's anonymous session (its own storage key, see domain/supabase.ts) redeems the token for a grant to
 * this one Team; every read and change is fenced by that grant on the server.
 */
export function Register() {
  const token = location.hash.slice(1)
  const [state, setState] = useState<State>({ step: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [captchaKey, setCaptchaKey] = useState(0)
  // Another link opened in this tab changes only the fragment: start again from it.
  useEffect(() => {
    const h = () => location.reload()
    window.addEventListener('hashchange', h)
    return () => window.removeEventListener('hashchange', h)
  }, [])

  useEffect(() => {
    let live = true
    const show = (s: State) => live && setState(s)
    void (async () => {
      if (!TOKEN.test(token)) return show({ step: 'bad' })
      const hash = await sha256Hex(token)
      if (!(await hasSession())) return show({ step: 'captcha' })
      const r = await redeem(token)
      if (r.code === 'not_signed_in') {
        await signOut()
        return show({ step: 'captcha' })
      }
      if (r.code === 'link_dead') {
        forgetForm()
        return show({ step: 'dead' })
      }
      // Offline (or any other trouble redeeming): the form this phone last read through this link, if any.
      if (!r.ok && r.code !== 'offline' && r.code !== 'unknown') return show({ step: 'problem', text: messageFor(r.code) })
      const f = await registrationForm(hash)
      if ('form' in f) {
        const queued = await queuedFor(f.form.team.id)
        return show({ step: 'form', hash, form: overlayForm(f.form, queued) })
      }
      show(f.code === 'link_dead' ? { step: 'dead' }
        : { step: 'problem', text: f.code === 'offline' ? messages.offline : messages.registration_unknown })
    })()
    return () => {
      live = false
    }
  }, [token, attempt])

  async function signIn(captcha: string | null) {
    if (captcha === null) return
    setState({ step: 'loading' })
    const failure = await signInAnonymously(captcha)
    setCaptchaKey((k) => k + 1)
    if (failure) setState({ step: 'problem', text: failure.message })
    else setAttempt((n) => n + 1)
  }

  const again = <SecondaryButton label="Try the link again" onClick={() => (setState({ step: 'loading' }), setAttempt((n) => n + 1))} />
  if (state.step === 'form') return <TeamForm key={state.hash} initial={state.form} hash={state.hash} />
  return (
    <main className="screen register">
      <h1 className="title">Team registration</h1>
      {state.step === 'loading' && <p className="body" aria-busy="true">Opening your Team's form…</p>}
      {state.step === 'captcha' && (
        <>
          <p className="body">{messages.captcha_wait}</p>
          <Turnstile key={captchaKey} quiet onToken={(t) => void signIn(t)} />
        </>
      )}
      {state.step === 'bad' && <Problem text={messages.link_incomplete} />}
      {state.step === 'dead' && <Problem text={messages.link_dead} />}
      {state.step === 'problem' && (
        <>
          <Problem text={state.text} />
          {again}
        </>
      )}
    </main>
  )
}

/** The Team form: open until the deadline (fields save on leaving them), then read-only. */
function TeamForm({ initial, hash }: { initial: RegistrationForm; hash: string }) {
  const [form, setForm] = useState(initial)
  const closed = registrationClosed(form)
  const day = form.deadline ? formatDay(form.deadline) : null
  async function load() {
    const f = await registrationForm(hash)
    return 'form' in f ? overlayForm(f.form, await queuedFor(f.form.team.id)) : null
  }

  return (
    <main className="screen register">
      <header className="register-bar">
        <p className="meta">{form.tournamentName} · Season {form.seasonNumber}</p>
        <h1 className="title">Team registration</h1>
      </header>
      {!closed && <SaveStatusBar />}
      <section className="deadline-banner" aria-live="polite">
        {closed ? (
          <>
            <p className="body-strong">{day ? `Registration closed on ${day}.` : 'Registration is closed.'}</p>
            <p className="body">To change anything now, ask the organiser.</p>
          </>
        ) : (
          <>
            {day && <p className="body-strong">Open until {day}.</p>}
            <p className="body">After that this form can only be read.</p>
          </>
        )}
      </section>
      {closed ? <ClosedTeam form={form} /> : <TeamEditor form={form} setForm={setForm} load={load} />}
    </main>
  )
}

/** The Team, Squad and Staff as text: no inputs, no date of birth. */
export function ClosedTeam({ form }: { form: RegistrationForm }) {
  const t = form.team
  return (
    <>
      <section className="card">
        <h2 className="body-strong">{t.name}</h2>
        <StatusPill state={t.status === 'approved' ? 'done' : 'pending'} label={teamStatusLabel[t.status]} />
        <p className="body">Team code {t.code}</p>
        <p className="body register-kit">{t.kitColour ? <>Kit colour <KitDot colour={t.kitColour} /></> : 'No kit colour yet'}</p>
      </section>
      <ClosedSquad form={form} />
    </>
  )
}

/**
 * Team details, Players, Staff, Eligibility and photos, each saved on leaving it through the same commands for the Team
 * manager (their grant) and the Organiser (their membership). load: the form read again with pending changes laid over.
 */
export function TeamEditor({ form, setForm, load }: {
  form: RegistrationForm; setForm: Dispatch<SetStateAction<RegistrationForm>>; load: () => Promise<RegistrationForm | null>
}) {
  const [problem, setProblem] = useState<string | null>(null)
  const [kit, setKit] = useState(form.team.kitColour)
  // With no kit colour yet the picker shows a placeholder; leaving it untouched must not save that.
  const picked = useRef(false)
  const t = form.team

  async function reload() {
    const next = await load()
    if (!next) return
    setForm(next)
    setKit(next.team.kitColour)
  }

  async function save(change: { name?: string; code?: string; kit_colour?: string }) {
    setProblem(null)
    setForm((f) => ({ ...f, team: { ...f.team, ...('name' in change ? { name: change.name! } : {}),
      ...('code' in change ? { code: change.code! } : {}), ...('kit_colour' in change ? { kitColour: change.kit_colour! } : {}) } }))
    const r = await send('edit_team', { team_id: t.id, ...change }, { scope: t.id, versionOf: t.id })
    // A conflict waits in the hand-back sheet (Keep theirs / Send mine); any other refusal is said here and dropped.
    if (!r.ok && r.code !== 'queued' && r.code !== 'version_conflict') {
      if (r.commandId) void forgetRefused(r.commandId)
      setProblem(messageFor(r.code))
    }
    void reload()
  }

  return (
    <>
      <section className="card">
        <h2 className="body-strong">Team</h2>
        <Field label="Team name" value={t.name} required requiredMessage={messages.team_name_required} autoComplete="off"
          validate={(v) => (v.length > 80 ? messages.name_long : null)} onSave={(name) => void save({ name })} />
        <Field label="Team code" value={t.code} required requiredMessage={messages.team_code_required} autoComplete="off"
          validate={(v) => (CODE.test(v.toUpperCase()) ? null : messages.code_invalid)}
          hint={() => 'The Team code shows on the score bug. 2–5 letters or numbers.'}
          onSave={(code) => code.toUpperCase() !== t.code && void save({ code: code.toUpperCase() })} />
        <div className="register-kit">
          <KitDot colour={kit} />
          <ColourField label="Kit colour" value={kit ?? token('--ink-dark')} onInput={(c) => ((picked.current = true), setKit(c))}
            onSave={(c) => (t.kitColour !== null || picked.current) && c !== t.kitColour && void save({ kit_colour: c })} />
        </div>
        <Problem text={problem} />
      </section>
      <Squad form={form} reload={reload} />
    </>
  )
}
