import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { forgetRefused, queuedFor, send, useOutbox } from '../../domain/commands'
import { formatDate } from '../../domain/format'
import { messageFor, messages } from '../../domain/messages'
import { CODE, newLink, suggestCode } from '../../domain/teamCode'
import { linkToken, overlayTeams, registrationUrl, rememberLink, seasonTeams, type Team, type TeamStatus } from '../../domain/teams'
import { PrimaryButton, SecondaryButton } from '../../ui/Button'
import { Field } from '../../ui/Field'
import { KitDot } from '../../ui/KitDot'
import { StatusPill } from '../../ui/StatusPill'
import { blocked, useForm } from '../auth/form'
import { Problem } from '../auth/Screen'
import type { Head } from './Home'

export const teamStatusLabel: Record<TeamStatus, string> = { invited: 'Invited', submitted: 'Submitted', approved: 'Approved', returned: 'Returned' }

/** The Season's Teams with this user's pending Team commands laid over; reloads as they send and when the signal returns. */
export function useTeams(tournamentId: string, seasonId: string) {
  const [teams, setTeams] = useState<Team[] | 'offline' | 'unknown' | null>(null)
  const [attempt, setAttempt] = useState(0)
  const pending = useOutbox().entries.length
  useEffect(() => {
    const again = () => setAttempt((n) => n + 1)
    window.addEventListener('online', again)
    return () => window.removeEventListener('online', again)
  }, [])
  useEffect(() => {
    let live = true
    void (async () => {
      const r = await seasonTeams(seasonId)
      const queued = await queuedFor(tournamentId)
      if (live) setTeams('code' in r ? r.code : overlayTeams(r.teams, queued, seasonId))
    })()
    return () => {
      live = false
    }
  }, [tournamentId, seasonId, attempt, pending])
  return { teams, reload: () => setAttempt((n) => n + 1), retry: () => (setTeams(null), setAttempt((n) => n + 1)) }
}

/** Setup a Team needs first: the photo-consent statement and all three dates (open_registration's setup_incomplete). */
export const setupMissing = (h: Head) => {
  const a = h.season.answers
  return !a.photo_consent.trim() ? 'rules' : !a.starts_on || !a.ends_on || !a.registration_deadline ? 'dates' : null
}

/**
 * Hands the Team's link and a ready message to the share sheet; without Web Share, copies both. Returns the words to
 * show (empty when shared).
 */
export async function shareLink(team: Team, token: string, h: Head): Promise<string> {
  const url = registrationUrl(token)
  const deadline = h.season.answers.registration_deadline
  const text = `Register ${team.name} for ${h.name} Season ${h.season.number}. Open this link to add your Players and Staff.` +
    (deadline ? ` Open until ${formatDate(deadline)}.` : '')
  try {
    if (navigator.share) return (await navigator.share({ title: `Register ${team.name}`, text, url }), '')
  } catch (e) {
    if ((e as Error).name === 'AbortError') return ''
  }
  try {
    await navigator.clipboard.writeText(`${text}\n${url}`)
    return `Link and message copied. Paste them in a message to ${team.name}'s manager.`
  } catch {
    return `Copy the link shown on ${team.name}'s page and send it to the Team manager.`
  }
}

/** The Teams tab: setup first if it's missing, else the add form and the Team rows. */
export function Teams({ tournamentId, head: h, openId, onSeasonChange }: { tournamentId: string; head: Head; openId?: string; onSeasonChange: () => void }) {
  const navigate = useNavigate()
  const { teams, reload, retry } = useTeams(tournamentId, h.season.id)
  const { ref, showErrors, values } = useForm()
  const [name, setName] = useState('')
  const [code, setCode] = useState<string | null>(null) // null: follows the name
  const [formKey, setFormKey] = useState(0)
  const [problem, setProblem] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const missing = setupMissing(h)
  const list = Array.isArray(teams) ? teams : []
  const suggestion = suggestCode(name, list.map((t) => t.code))
  const canAdd = h.season.status === 'setup' || h.season.status === 'registration'
  const openTeam = (t: Team) => navigate(`/t/${tournamentId}/teams/${t.id}`)

  const checkCode = (v: string) => {
    const c = v.toUpperCase()
    if (!CODE.test(c)) return messages.code_invalid
    const other = list.find((t) => t.code === c)
    return other ? `${c} is already used by ${other.name}. Choose another code.` : null
  }

  async function add() {
    const v = values()
    if (!v || busy) return
    const c = v['team-code']!.toUpperCase()
    setBusy(true)
    setProblem(null)
    setNotice('')
    const teamId = crypto.randomUUID()
    const linkId = crypto.randomUUID()
    const { token, hash } = await newLink()
    rememberLink(linkId, token)
    const r = await send('add_team', { season_id: h.season.id, team_id: teamId, name: v['team-name'], code: c, link_id: linkId, token_hash: hash },
      { scope: tournamentId })
    if (!r.ok && r.code !== 'queued') {
      if (r.commandId) void forgetRefused(r.commandId)
      rememberLink(linkId, null)
      setBusy(false)
      return setProblem(messageFor(r.code))
    }
    // The first Team opens registration (once: not while an open is already waiting to send).
    if (h.season.status === 'setup' && !(await queuedFor(tournamentId)).some((e) => e.name === 'open_registration')) {
      const o = await send('open_registration', { season_id: h.season.id }, { scope: tournamentId })
      if (o.ok) onSeasonChange()
      else if (o.code !== 'queued') {
        if (o.commandId) void forgetRefused(o.commandId)
        setProblem(messageFor(o.code))
      }
    }
    setBusy(false)
    setNotice(r.code === 'queued' ? `${messages.offline} ${v['team-name']} will be added when the signal is back.` : `${v['team-name']} added. Share its link below.`)
    setName('')
    setCode(null)
    setFormKey((n) => n + 1)
    reload()
  }

  async function share(t: Team) {
    const token = linkToken(t.linkId)
    if (!token) return openTeam(t)
    setNotice(await shareLink(t, token, h))
  }

  if (missing) {
    return (
      <>
        <p className="body">Finish setup before adding Teams: add the photo-consent statement and the Season dates.</p>
        <PrimaryButton label="Continue setup" onClick={() => navigate(h.season.setupStep < 7
          ? `/t/${tournamentId}/setup/${h.season.setupStep + 1}` : `/t/${tournamentId}/settings/${missing}`)} />
      </>
    )
  }
  return (
    <div className="teams">
      <p role="status" className="body">{notice}</p>
      {teams === null ? (
        <div aria-busy="true">
          <p className="ui-visually-hidden">Loading the Teams</p>
          <div className="skeleton-row" />
          <div className="skeleton-row" />
          <div className="skeleton-row" />
        </div>
      ) : !Array.isArray(teams) ? (
        <>
          <Problem text={teams === 'offline' ? messages.offline : messages.teams_unknown} />
          <SecondaryButton label="Try loading again" onClick={retry} />
        </>
      ) : teams.length ? (
        <ul className="cards">
          {teams.map((t) => (
            <li key={t.id} className="card team-row">
              <button type="button" className="team-open" aria-label={`Open ${t.name}`} aria-current={t.id === openId || undefined} onClick={() => openTeam(t)}>
                <KitDot colour={t.kitColour} />
                <span className="team-name">
                  <span className="body-strong">{t.name}</span>
                  <span className="meta">{t.code}</span>
                </span>
                <StatusPill state={t.status === 'approved' ? 'done' : 'pending'} label={teamStatusLabel[t.status]} />
              </button>
              <button type="button" className="ui-button ui-secondary" aria-label={`Share link for ${t.name}`} onClick={() => void share(t)}>Share link</button>
            </li>
          ))}
        </ul>
      ) : <p className="body">Add your Teams to send each one its Registration link.</p>}
      {canAdd ? (
        <section className="teams-add">
          <h2 className="body-strong">Add a Team</h2>
          <form key={formKey} ref={ref} noValidate onSubmit={(e) => (e.preventDefault(), void add())}>
            <Field label="Team name" name="team-name" value={name} onSave={setName} required requiredMessage={messages.team_name_required}
              validate={(v) => (v.length > 80 ? messages.name_long : null)} showErrors={showErrors} autoComplete="off" />
            <Field label="Team code" name="team-code" value={code ?? suggestion} onSave={setCode} required requiredMessage={messages.team_code_required}
              validate={checkCode} showErrors={showErrors} autoComplete="off" />
            <Problem text={problem} />
            <PrimaryButton label="Add this Team" onClick={() => void add()} {...blocked(busy && 'Adding the Team…')} />
          </form>
        </section>
      ) : <p className="meta">Teams can't be added once the Season has started.</p>}
    </div>
  )
}
