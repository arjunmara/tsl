import { useEffect, useRef, useState } from 'react'
import { forgetRefused, queuedFor, send, useOutbox } from '../../domain/commands'
import { formatDay, formatDate, inZone, toBs } from '../../domain/format'
import { useNavigate, useParams } from 'react-router'
import { matchMeta, overlayMatches, seasonMatches, type Match } from '../../domain/matches'
import { messageFor, messages } from '../../domain/messages'
import { backIcon, IconButton, PrimaryButton } from '../../ui/Button'
import { Field } from '../../ui/Field'
import { Problem } from '../auth/Screen'
import { Unavailable, UUID } from '../setup/Setup'
import { kickOffText, sideText } from './Fixtures'
import { readHead } from './Home'
import { useTeams } from './Teams'

/** /t/:tournamentId/m/:matchId: one Fixture: the round, both sides and the kick-off, which an Organiser can set while registration is open. */
export function MatchDetail() {
  const { tournamentId = '', matchId = '' } = useParams()
  if (!UUID.test(tournamentId) || !UUID.test(matchId)) return <Unavailable />
  return <Load key={matchId} tournamentId={tournamentId} matchId={matchId} />
}

function Load({ tournamentId, matchId }: { tournamentId: string; matchId: string }) {
  const navigate = useNavigate()
  const [seasonId, setSeasonId] = useState<string | null>(null)
  const [season, setSeason] = useState<{ editable: boolean; starts: string; ends: string }>({ editable: false, starts: '', ends: '' })
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
      setSeason({ editable: h.season.status === 'registration', starts: h.season.answers.starts_on, ends: h.season.answers.ends_on })
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
        {typeof match === 'object' && match && season.editable && seasonId && (
          <KickOffForm key={match.version} notice={notice} setNotice={setNotice} tournamentId={tournamentId} seasonId={seasonId} match={match} starts={season.starts} ends={season.ends} />
        )}
      </div>
    </main>
  )
}

/** Date (shown in BS and AD) and time, in Kathmandu time. "Save kick-off" queues one command with the Match's version. */
function KickOffForm({ tournamentId, seasonId, match, starts, ends, notice, setNotice }: { notice: string; setNotice: (s: string) => void; tournamentId: string; seasonId: string; match: Match; starts: string; ends: string }) {
  const z = match.kickOff ? inZone(match.kickOff) : { date: '', time: '' }
  const [date, setDate] = useState(z.date)
  const [time, setTime] = useState(z.time)
  const saving = useRef(false)
  const [problem, setProblem] = useState<string | null>(null)
  const range = starts && ends ? `Pick a date between ${formatDay(starts)} and ${formatDay(ends)}.` : messages.date_out_of_range
  const dateProblem = (v: string) => (!toBs(v) || (starts && v < starts) || (ends && v > ends) ? range : null)
  const ok = !!date && !!time && !dateProblem(date)

  async function save() {
    if (saving.current) return
    setNotice('')
    setProblem(null)
    if (!ok) return setProblem(!date || !time ? 'Pick a date and a time first.' : range)
    // Kathmandu has no daylight saving: always +05:45.
    saving.current = true
    const r = await send('set_kick_off', { season_id: seasonId, match_id: match.id, expected_version: match.version, kick_off: `${date}T${time}:00+05:45` },
      { scope: tournamentId })
    if (r.ok) setNotice('Kick-off saved')
    else if (r.code === 'queued') setNotice(`${messages.offline} The kick-off will be saved when the signal is back.`)
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
    </form>
  )
}
