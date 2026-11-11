import { useEffect, useId, useState } from 'react'
import { useNavigate } from 'react-router'
import { forgetRefused, queuedFor, send } from '../../domain/commands'
import { serverNow } from '../../domain/clock'
import { formatDay, inZone } from '../../domain/format'
import { lastOpenDay, overlayForm, registrationClosed, reopened, teamForm, type RegistrationForm } from '../../domain/registration'
import { messageFor, messages } from '../../domain/messages'
import { newLink } from '../../domain/teamCode'
import { linkToken, registrationUrl, rememberLink, type Team } from '../../domain/teams'
import { backIcon, DestructiveButton, IconButton, PrimaryButton, SecondaryButton } from '../../ui/Button'
import { KitDot } from '../../ui/KitDot'
import { StatusPill } from '../../ui/StatusPill'
import { Problem } from '../auth/Screen'
import { ClosedTeam, TeamEditor } from '../register/Register'
import { UUID } from '../setup/Setup'
import type { Head } from './Home'
import { shareLink, teamStatusLabel, useTeams } from './Teams'

/**
 * /t/:tournamentId/teams/:teamId, inside the Tournament home's Teams tab: one Team, its Registration link (share,
 * reissue, revoke) and the Team manager's form sections, which an Organiser fills from a paper sheet (Story 2.6).
 */
export function TeamPage({ tournamentId, teamId, h }: { tournamentId: string; teamId: string; h: Head }) {
  if (!UUID.test(teamId)) return <Problem text={messages.team_missing} />
  return <OneTeam key={teamId} tournamentId={tournamentId} teamId={teamId} h={h} />
}

function OneTeam({ tournamentId, teamId, h }: { tournamentId: string; teamId: string; h: Head }) {
  const navigate = useNavigate()
  const { teams, reload, retry } = useTeams(tournamentId, h.season.id)
  const [notice, setNotice] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const team = Array.isArray(teams) ? teams.find((t) => t.id === teamId) : undefined
  const canReissue = h.season.status === 'setup' || h.season.status === 'registration'
  const back = () => navigate(`/t/${tournamentId}`, { state: { tab: 'teams' } })


  async function run(name: string, args: Record<string, unknown>, onRefused?: () => void) {
    setProblem(null)
    setNotice('')
    setBusy(true)
    const r = await send(name, { season_id: h.season.id, ...args }, { scope: tournamentId })
    setBusy(false)
    if (!r.ok && r.code !== 'queued') {
      if (r.commandId) void forgetRefused(r.commandId)
      onRefused?.()
      setProblem(messageFor(r.code))
      return null
    }
    reload()
    return r
  }

  async function reissue(t: Team) {
    if (busy) return
    const linkId = crypto.randomUUID()
    const { token, hash } = await newLink()
    rememberLink(linkId, token)
    const r = await run('reissue_registration_link', { team_id: t.id, link_id: linkId, token_hash: hash }, () => rememberLink(linkId, null))
    if (!r) return
    setNotice(r.code === 'queued' ? `${messages.offline} The new link works once it's sent; share it now or later.`
      : t.linkId ? 'New link made. The old link no longer works.' : 'New link made. Share it with the Team manager.')
  }

  async function revoke(t: Team) {
    if (!t.linkId || busy) return
    const r = await run('revoke_registration_link', { link_id: t.linkId })
    if (!r) return
    // Forgotten only once the server has it: a queued revoke refused later leaves the link working and shareable here.
    if (r.ok) rememberLink(t.linkId, null)
    setNotice(r.code === 'queued' ? `${messages.offline} The link stops working once this is sent.` : `The link for ${t.name} no longer works.`)
  }

  const token = team ? linkToken(team.linkId) : null
  return (
    <div className="team-pane">
      <header className="team-bar">
        <IconButton label="Back to Teams" onClick={back}>{backIcon}</IconButton>
        <h2 className="title">{team?.name ?? 'Team'}</h2>
      </header>
      <div className="team-page">
        <p role="status" className="body">{notice}</p>
        <Problem text={problem} />
        {!Array.isArray(teams) ? (
          teams ? (
            <>
              <Problem text={teams === 'offline' ? messages.offline : messages.teams_unknown} />
              <SecondaryButton label="Try loading again" onClick={retry} />
            </>
          ) : <p className="body" aria-busy="true">Loading the Team…</p>
        ) : !team ? <Problem text={messages.team_missing} /> : (
          <>
            <p className="team-name">
              <KitDot colour={team.kitColour} />
              <span className="body">Team code {team.code}</span>
              <StatusPill state={team.status === 'approved' ? 'done' : 'pending'} label={teamStatusLabel[team.status]} />
            </p>
            <section className="card">
              <h2 className="body-strong">Registration link</h2>
              {token ? (
                <>
                  <label className="meta" htmlFor="team-link">Registration link for {team.name}</label>
                  <input id="team-link" className="ui-input" readOnly value={registrationUrl(token)} onFocus={(e) => e.currentTarget.select()} />
                  <SecondaryButton label="Share link" onClick={() => void shareLink(team, token, h).then(setNotice)} />
                </>
              ) : team.linkId ? (
                <p className="body">This phone doesn't have this Team's link. It stays on the phone that made it. Make a new link to share it from here; the old link then stops working.</p>
              ) : <p className="body">This Team has no working link.</p>}
              {canReissue && (team.linkId ? (
                <DestructiveButton label={token ? 'Reissue link' : 'Make a new link'} sheetTitle={`Make a new link for ${team.name}?`}
                  before="The current link lets the Team manager register" after="The current link stops working and the new link replaces it"
                  actionLabel="Make a new link" onConfirm={() => void reissue(team)} />
              ) : <PrimaryButton label="Make a new link" onClick={() => void reissue(team)} />)}
              {team.linkId && (
                <DestructiveButton label="Revoke link" sheetTitle={`Revoke the link for ${team.name}?`} before="The link lets the Team manager register"
                  after="The link stops working. You can make a new link later" actionLabel="Revoke link" onConfirm={() => void revoke(team)} />
              )}
              {!canReissue && <p className="meta">New links can't be made once the Season has started.</p>}
            </section>
            {canReissue && <Review team={team} tournamentId={tournamentId} done={reload} />}
            <TeamSheet key={team.status} tournamentId={tournamentId} seasonId={h.season.id} teamId={team.id} />
          </>
        )}
      </div>
    </div>
  )
}

/** The Team's form as its manager sees it, read through the Organiser's membership; as text once the Season has started. */
function TeamSheet({ tournamentId, seasonId, teamId }: { tournamentId: string; seasonId: string; teamId: string }) {
  const [form, setForm] = useState<RegistrationForm | 'missing' | 'offline' | 'unknown' | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    void load(seasonId, teamId).then((f) => live && setForm(f))
    return () => {
      live = false
    }
  }, [seasonId, teamId, attempt])
  if (form === null) return <p className="body" aria-busy="true">Loading the Players and Staff…</p>
  if (typeof form === 'string') {
    return (
      <>
        <Problem text={form === 'offline' ? messages.offline : form === 'missing' ? messages.team_missing : messages.team_form_unknown} />
        <SecondaryButton label="Try loading the Team again" onClick={() => (setForm(null), setAttempt((n) => n + 1))} />
      </>
    )
  }
  return (form.seasonStatus === 'setup' || form.seasonStatus === 'registration') && form.team.status !== 'withdrawn' ? (
    <>
      <Reopen form={form} tournamentId={tournamentId} done={() => setAttempt((n) => n + 1)} />
      <Editor key={attempt} initial={form} load={async () => { const f = await load(seasonId, teamId); return typeof f === 'string' ? null : f }} />
    </>
  ) : <ClosedTeam form={form} />
}

/**
 * Once the deadline has passed (Story 2.9): whether the Team manager's link is closed or reopened, and "Reopen link" with a
 * reason and a new closing date (reopen_registration_link). Organisers edit until the Season starts either way.
 */
function Reopen({ form, tournamentId, done }: { form: RegistrationForm; tournamentId: string; done: () => void }) {
  const today = inZone(serverNow()).date
  const [writing, setWriting] = useState(false)
  const [reason, setReason] = useState('')
  const [until, setUntil] = useState(today)
  const [errors, setErrors] = useState<{ reason?: string; until?: string }>({})
  const [problem, setProblem] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const id = useId()
  const t = form.team
  if (!form.deadline || today <= form.deadline || t.status === 'approved') return null
  const day = formatDay(lastOpenDay(form)!)

  async function reopen() {
    const n = reason.trim()
    const e = { ...(!n || n.length > 200 ? { reason: messages.reason_invalid } : {}), ...(!until || until < today ? { until: messages.reopen_date_invalid } : {}) }
    setErrors(e)
    if (Object.keys(e).length || busy) return
    setProblem(null)
    setBusy(true)
    const r = await send('reopen_registration_link', { team_id: t.id, reason: n, until }, { scope: tournamentId })
    setBusy(false)
    if (!r.ok && r.code !== 'queued') {
      if (r.commandId) void forgetRefused(r.commandId)
      return setProblem(messageFor(r.code))
    }
    setWriting(false)
    setReason('')
    setNotice(r.code === 'queued' ? `${messages.offline} The link reopens once this is sent.` : `${t.name}'s link is open until ${formatDay(until)}.`)
    done()
  }

  const field = (key: 'reason' | 'until') => ({
    id: `${id}-${key}`, className: key === 'reason' ? 'ui-input ui-textarea' : 'ui-input', 'aria-invalid': errors[key] ? true : undefined,
    'aria-describedby': errors[key] ? `${id}-${key}-error` : undefined,
  })
  const error = (key: 'reason' | 'until') => errors[key] && <p id={`${id}-${key}-error`} className="meta ui-error">{errors[key]}</p>
  return (
    <section className="card">
      <h2 className="body-strong">Registration deadline</h2>
      <p className="body">{registrationClosed(form) ? `The link closed on ${day}. The Team manager can only read it.`
        : reopened(form) ? `Reopened until ${day}: ${t.reopenReason}` : `Open until ${day}.`}</p>
      <p role="status" className="body">{notice}</p>
      <Problem text={problem} />
      {writing ? (
        <>
          <div className="ui-field">
            <label className="body-strong" htmlFor={`${id}-reason`}>Reason for reopening</label>
            <textarea {...field('reason')} rows={3} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
            {error('reason')}
          </div>
          <div className="ui-field">
            <label className="body-strong" htmlFor={`${id}-until`}>New closing date</label>
            <input {...field('until')} type="date" min={today} value={until} onChange={(e) => setUntil(e.target.value)} />
            {until && <p className="meta">Open through {formatDay(until)}</p>}
            {error('until')}
          </div>
          <PrimaryButton label="Reopen this Team's link" onClick={() => void reopen()} />
          <SecondaryButton label="Cancel reopening" onClick={() => (setWriting(false), setErrors({}))} />
        </>
      ) : <SecondaryButton label="Reopen link" onClick={() => setWriting(true)} />}
    </section>
  )
}

async function load(seasonId: string, teamId: string) {
  const r = await teamForm(seasonId, teamId)
  return 'form' in r ? overlayForm(r.form, await queuedFor(teamId)) : r.code
}

function Editor({ initial, load }: { initial: RegistrationForm; load: () => Promise<RegistrationForm | null> }) {
  const [form, setForm] = useState(initial)
  return <TeamEditor form={form} setForm={setForm} load={load} />
}

/**
 * Approve, return with a note, or withdraw the Team (Story 2.8). Status is the server's (approve_team, return_team,
 * withdraw_team); the Team list lays pending reviews over it. A refusal is said here in words and dropped.
 */
function Review({ team, tournamentId, done }: { team: Team; tournamentId: string; done: () => void }) {
  const [writing, setWriting] = useState(false)
  const [note, setNote] = useState('')
  const [noteError, setNoteError] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const noteId = useId()
  const s = team.status

  async function review(name: string, args: Record<string, unknown>, said: string) {
    if (busy) return
    setProblem(null)
    setNotice('')
    setBusy(true)
    const r = await send(name, { team_id: team.id, ...args }, { scope: tournamentId })
    setBusy(false)
    if (!r.ok && r.code !== 'queued') {
      if (r.commandId) void forgetRefused(r.commandId)
      setProblem(r.code === 'lineup_violation' && r.message ? `Can't approve: ${r.message}` : messageFor(r.code))
    } else {
      setWriting(false)
      setNote('')
      setNotice(r.code === 'queued' ? `${messages.offline} ${said} once it's sent.` : said)
    }
    done()
  }

  function sendNote() {
    const n = note.trim()
    if (!n || n.length > 500) return setNoteError(messages.note_invalid)
    setNoteError(null)
    void review('return_team', { note: n }, `${team.name} is returned. The Team manager sees your note on their link`)
  }

  return (
    <section className="card">
      <h2 className="body-strong">Review</h2>
      <p className="body">{s === 'withdrawn' ? 'This Team is withdrawn. It stays out of the Draw and its link can only be read.'
        : s === 'approved' ? 'Approved: this Team can be placed in the Draw. Its manager can no longer change it.'
          : s === 'submitted' ? 'The Team manager sent this Team for review.'
            : s === 'returned' ? 'Returned to the Team manager. They can change it and send it again.'
              : 'The Team manager hasn\'t sent this Team for review yet.'}</p>
      <p role="status" className="body">{notice}</p>
      <Problem text={problem} />
      {s === 'submitted' && (
        <PrimaryButton label="Approve team" onClick={() => void review('approve_team', {}, `${team.name} is approved`)} />
      )}
      {(s === 'submitted' || s === 'approved') && (writing ? (
        <>
          <div className="ui-field">
            <label className="body-strong" htmlFor={noteId}>Note for the Team manager</label>
            <textarea id={noteId} className="ui-input ui-textarea" rows={4} maxLength={500} value={note} aria-invalid={noteError ? true : undefined}
              aria-describedby={noteError ? `${noteId}-error` : undefined} onChange={(e) => setNote(e.target.value)} autoFocus />
            {noteError && <p id={`${noteId}-error`} className="meta ui-error">{noteError}</p>}
          </div>
          <PrimaryButton label="Send note and return team" onClick={sendNote} />
          <SecondaryButton label="Discard the note" onClick={() => (setWriting(false), setNote(''), setNoteError(null))} />
        </>
      ) : <SecondaryButton label="Return with note" onClick={() => setWriting(true)} />)}
      {s !== 'withdrawn' && (
        <DestructiveButton label="Withdraw team" sheetTitle={`Withdraw ${team.name}?`} before={`${team.name} can register and be placed in the Draw`}
          after={`${team.name} leaves the Draw and its link can only be read. This can't be undone`} actionLabel={`Withdraw ${team.name}`}
          onConfirm={() => void review('withdraw_team', {}, `${team.name} is withdrawn`)} />
      )}
    </section>
  )
}
