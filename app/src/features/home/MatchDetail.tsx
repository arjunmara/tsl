import { useEffect, useRef, useState } from 'react'
import { forgetRefused, queuedFor, send, useOutbox } from '../../domain/commands'
import { formatDay, formatDate, inZone, toBs } from '../../domain/format'
import { useNavigate, useParams } from 'react-router'
import { matchMeta, overlayMatches, seasonMatches, type Match } from '../../domain/matches'
import { messageFor, messages } from '../../domain/messages'
import { backIcon, IconButton, PrimaryButton } from '../../ui/Button'
import { ConfirmSheet } from '../../ui/ConfirmSheet'
import { Field } from '../../ui/Field'
import { Problem } from '../auth/Screen'
import { Unavailable, UUID } from '../setup/Setup'
import { kickOffText, sideText } from './Fixtures'
import { readHead } from './Home'
import { useTeams } from './Teams'

/** /t/:tournamentId/m/:matchId: one Fixture: the round, both sides and the kick-off, which an Organiser can set while registration is open, and move after start once confirmed. */
export function MatchDetail() {
  const { tournamentId = '', matchId = '' } = useParams()
  if (!UUID.test(tournamentId) || !UUID.test(matchId)) return <Unavailable />
  return <Load key={matchId} tournamentId={tournamentId} matchId={matchId} />
}

function Load({ tournamentId, matchId }: { tournamentId: string; matchId: string }) {
  const navigate = useNavigate()
  const [seasonId, setSeasonId] = useState<string | null>(null)
  const [season, setSeason] = useState<{ editable: boolean; started: boolean; finished: boolean; starts: string; ends: string }>({ editable: false, started: false, finished: false, starts: '', ends: '' })
  const pending = useOutbox().entries.length
  const [notice, setNotice] = useState('')
  const [match, setMatch] = useState<Match | 'missing' | 'offline' | 'unknown' | null>(null)
  useEffect(() => {
    let live = true
    void (async () => {
      const h = await readHead(tournamentId)
      if (!live) return
      if (typeof h === 'string') return setMatch(h === 'missing' ? 'missing' : h)
      setSeasonId(h.season.id)
      setSeason({ editable: h.season.status === 'registration' || h.season.status === 'started', started: h.season.status === 'started', finished: h.season.status === 'finished', starts: h.season.answers.starts_on, ends: h.season.answers.ends_on })
      const r = await seasonMatches(h.season.id)
      const queued = await queuedFor(tournamentId)
      if (live) setMatch('code' in r ? r.code : overlayMatches(r.matches, queued, h.season.id).find((m) => m.id === matchId) ?? 'missing')
    })()
    return () => {
      live = false
    }
  }, [tournamentId, matchId, pending])
  const { teams } = useTeams(tournamentId, seasonId ?? '')
  const byId = new Map(Array.isArray(teams) ? teams.map((t) => [t.id, t]) : [])
  if (match === 'missing') return <Unavailable />
  const side = (id: string | null, src: string | null) => {
    const t = id ? byId.get(id) : undefined
    return (
      <p className="match-side"><span>{sideText(id, src, byId)}</span>{t && <span className="meta"> {t.name}</span>}</p>
    )
  }
  return (
    <main className="home">
      <header className="home-bar">
        <IconButton label="Back to the Matches" onClick={() => navigate(`/t/${tournamentId}`)}>{backIcon}</IconButton>
        <h1 className="title home-title">Match</h1>
      </header>
      <div className="home-panel">
        {match === null ? (
          <div aria-busy="true"><p className="ui-visually-hidden">Loading</p><div className="skeleton-card" /></div>
        ) : typeof match === 'string' ? (
          <Problem text={match === 'offline' ? messages.offline : messages.fixtures_unknown} />
        ) : (
          <div className="card">
            <p className="meta">{matchMeta(match)}</p>
            {side(match.homeTeamId, match.homeSrc)}
            <p className="meta" aria-label="versus">v</p>
            {side(match.awayTeamId, match.awaySrc)}
            <p className="body">{kickOffText(match.kickOff)}</p>
          </div>
        )}
        {typeof match === 'object' && match && season.finished && <p className="meta">{messages.season_finished}</p>}
        {typeof match === 'object' && match && season.editable && seasonId && (
          <KickOffForm key={match.version} notice={notice} setNotice={setNotice} tournamentId={tournamentId} seasonId={seasonId} match={match} starts={season.starts} ends={season.ends}
            started={season.started} name={`${sideText(match.homeTeamId, match.homeSrc, byId)} v ${sideText(match.awayTeamId, match.awaySrc, byId)}`} />
        )}
      </div>
    </main>
  )
}

/** Date (shown in BS and AD) and time, in Kathmandu time. "Save kick-off" queues one command with the Match's version. */
/** "9:30 AM" from "09:30"; the first time of a pair drops its AM or PM when the second has the same. */
const clock = (hhmm: string) => {
  const [h = 0, m = '00'] = hhmm.split(':')
  return `${Number(h) % 12 || 12}:${m} ${Number(h) >= 12 ? 'PM' : 'AM'}`
}

function KickOffForm({ tournamentId, seasonId, match, starts, ends, notice, setNotice, started, name }: { notice: string; setNotice: (s: string) => void; tournamentId: string; seasonId: string; match: Match; starts: string; ends: string; started: boolean; name: string }) {
  const z = match.kickOff ? inZone(match.kickOff) : { date: '', time: '' }
  const [date, setDate] = useState(z.date)
  const [time, setTime] = useState(z.time)
  const saving = useRef(false)
  const [problem, setProblem] = useState<string | null>(null)
  const range = starts && ends ? `Pick a date between ${formatDay(starts)} and ${formatDay(ends)}.` : messages.date_out_of_range
  const dateProblem = (v: string) => (!toBs(v) || (starts && v < starts) || (ends && v > ends) ? range : null)
  const ok = !!date && !!time && !dateProblem(date)
  const [asking, setAsking] = useState(false)

  async function save() {
    if (saving.current) return
    setNotice('')
    setProblem(null)
    if (!ok) return setProblem(!date || !time ? 'Pick a date and a time first.' : range)
    // After start the Organiser confirms first (the Confirm sheet below); Cancel puts the saved date and time back.
    if (started) return match.kickOff && `${date}T${time}:00+05:45` === `${z.date}T${z.time}:00+05:45` ? undefined : setAsking(true)
    void commit(false)
  }

  async function commit(confirmed: boolean) {
    if (saving.current) return
    // Kathmandu has no daylight saving: always +05:45.
    saving.current = true
    const r = await send('set_kick_off', { season_id: seasonId, match_id: match.id, expected_version: match.version, kick_off: `${date}T${time}:00+05:45` },
      { scope: tournamentId, ...(confirmed ? { confirmed: true as const } : {}) })
    if (r.ok) setNotice(confirmed ? messages.moved_logged : 'Kick-off saved')
    else if (r.code === 'queued') setNotice(`${messages.offline} The kick-off will be ${confirmed ? 'moved' : 'saved'} when the signal is back.`)
    else if (r.code !== 'version_conflict') {
      if (r.commandId) void forgetRefused(r.commandId)
      setProblem(messageFor(r.code))
    }
    if (!r.ok && r.code !== 'queued' && r.code !== 'version_conflict') saving.current = false
  }

  return (
    <form noValidate className="card kickoff-form" onSubmit={(e) => (e.preventDefault(), void save())}>
      <Field label="Kick-off date" type="date" value={date} onSave={setDate} required requiredMessage="Pick a date." min={starts || undefined} max={ends || undefined}
        validate={dateProblem} hint={(v) => formatDate(v) || null} />
      <div className="ui-field">
        <label htmlFor="kickoff-time" className="body-strong">Kick-off time</label>
        <input id="kickoff-time" type="time" className="ui-input" value={time} onChange={(e) => setTime(e.target.value)} />
        <p className="meta">Kathmandu time.</p>
      </div>
      <PrimaryButton label="Save kick-off" onClick={() => void save()} />
      <p role="status" aria-live="polite" className="body-strong">{notice}</p>
      <Problem text={problem} />
      <ConfirmSheet open={asking} title={moveTitle(name, z, date, time)} before={match.kickOff ? kickOffText(match.kickOff) : 'Kick-off not set'}
        after={`${formatDate(date)} · ${time}`} actionLabel="Move this kick-off" note={messages.logged_note}
        onConfirm={() => void commit(true)}
        onClose={() => (setAsking(false), !saving.current && (setDate(z.date), setTime(z.time)))} />
    </form>
  )
}

/** "Move RTM v RE8 from 8:10 to 9:30 AM, Saturday · Kartik 28, 2083 BS (14 Nov 2026)?" (a new day names both days). */
function moveTitle(name: string, old: { date: string; time: string }, date: string, time: string) {
  if (!old.date) return `Set the kick-off of ${name} to ${clock(time)}, ${formatDate(date)}?`
  const was = clock(old.time)
  const now = clock(time)
  if (old.date !== date) return `Move ${name} from ${formatDate(old.date)}, ${was} to ${formatDate(date)}, ${now}?`
  return `Move ${name} from ${was.slice(-2) === now.slice(-2) ? was.slice(0, -3) : was} to ${now}, ${formatDate(date)}?`
}
