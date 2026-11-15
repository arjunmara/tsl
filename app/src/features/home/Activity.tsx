import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { activityLines, activityPage, type ActivityFilter, type ActivityRow } from '../../domain/activity'
import { formatDate, inZone } from '../../domain/format'
import { messages } from '../../domain/messages'
import { backIcon, IconButton, SecondaryButton } from '../../ui/Button'
import { Problem } from '../auth/Screen'
import { fieldLabels } from '../save-status/labels'
import { show } from '../save-status/HandBack'
import { SaveStatusBar } from '../save-status/SaveStatusBar'
import { Unavailable, UUID } from '../setup/Setup'
import { sideText, useMatches } from './Fixtures'
import { readHead } from './Home'
import { useTeams } from './Teams'

/** "Kick-off", "Date of birth"; a field with no label reads as its name in words. */
const label = (k: string) => fieldLabels[k] ?? k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
const when = (ts: string) => {
  const z = inZone(ts)
  return `${formatDate(z.date)} · ${z.time}`
}
const SUBJECTS: Record<string, string> = { eligibility_record: 'Document', photo_consent: 'Photo consent', season: 'Season', tournament: 'Tournament',
  organiser_membership: 'Organiser', organiser_invite: 'Invite', registration_grant: 'Registration link', registration_link: 'Registration link', scorer_device: 'Scorer phone', sponsor: 'Sponsor' }

/** /t/:tournamentId/settings/activity: who changed what and when in this Season, newest first, in pages of 50. */
export function Activity() {
  const { tournamentId = '' } = useParams()
  if (!UUID.test(tournamentId)) return <><SaveStatusBar /><Unavailable /></>
  return <Log key={tournamentId} tournamentId={tournamentId} />
}

function Log({ tournamentId }: { tournamentId: string }) {
  const navigate = useNavigate()
  const [seasonId, setSeasonId] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)
  const [filter, setFilter] = useState<ActivityFilter>({})
  const [rows, setRows] = useState<ActivityRow[] | null>(null)
  const [more, setMore] = useState(false)
  const [offline, setOffline] = useState(false)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState(0)
  // Everyone seen so far, so a person's chip stays while another filter narrows the list.
  const [people, setPeople] = useState<string[]>([])
  useEffect(() => {
    let live = true
    void readHead(tournamentId).then((h) => live && (typeof h === 'string' ? (h === 'missing' ? setMissing(true) : setFailed(true)) : setSeasonId(h.season.id)))
    return () => {
      live = false
    }
  }, [tournamentId])
  useEffect(() => {
    const again = () => setAttempt((n) => n + 1)
    window.addEventListener('online', again)
    return () => window.removeEventListener('online', again)
  }, [])
  useEffect(() => {
    if (!seasonId) return
    let live = true
    void activityPage(seasonId, filter).then((r) => {
      if (!live) return
      if ('code' in r) return setFailed(true)
      setRows(r.rows)
      setMore(r.more)
      setOffline(r.offline)
      setPeople((p) => [...new Set([...p, ...r.rows.map((x) => x.who)])].filter(Boolean))
    })
    return () => {
      live = false
    }
  }, [seasonId, filter, attempt])
  const current = useRef(filter)
  useEffect(() => {
    current.current = filter
  })
  const { teams } = useTeams(tournamentId, seasonId ?? '')
  const { matches } = useMatches(tournamentId, seasonId ?? '')
  const teamList = Array.isArray(teams) ? teams : []
  const byId = new Map(teamList.map((t) => [t.id, t]))
  const matchList = Array.isArray(matches) ? matches : []
  const matchName = (id: string) => {
    const m = matchList.find((x) => x.id === id)
    return m ? `${sideText(m.homeTeamId, m.homeSrc, byId)} v ${sideText(m.awayTeamId, m.awaySrc, byId)}` : 'Match'
  }

  async function loadMore() {
    if (!seasonId || !rows?.length || busy) return
    setBusy(true)
    const r = await activityPage(seasonId, filter, rows[rows.length - 1]!.id)
    setBusy(false)
    if (current.current !== filter) return
    if ('code' in r) return setFailed(true)
    setRows([...rows, ...r.rows])
    setMore(r.more)
  }

  /** What the row is about, in words. */
  function subject(r: ActivityRow) {
    const j = r.after ?? r.before ?? {}
    const code = r.teamId ? byId.get(r.teamId)?.code : undefined
    if (r.matchId) return matchName(r.matchId)
    if (r.table === 'team') return code ?? String(j.code ?? 'Team')
    if (r.table === 'player' || r.table === 'staff') return String(j.name ?? (r.table === 'staff' ? 'Staff member' : 'Player'))
    if (r.table === 'squad_entry') return `${code ?? 'Team'} Squad`
    if (r.table === 'draw_slot') return `${code ?? 'Team'} Draw`
    return SUBJECTS[r.table] ?? label(r.table)
  }

  const chip = (k: keyof ActivityFilter, value: string, text: string, what: string) => {
    const on = filter[k] === value
    return (
      <button key={`${k}${value}`} type="button" className="draw-chip" aria-pressed={on} aria-label={`Show only ${what}`}
        onClick={() => (setRows(null), setFailed(false), setFilter({ ...filter, [k]: on ? undefined : value }))}>
        {text}
      </button>
    )
  }

  if (missing) return <><SaveStatusBar /><Unavailable /></>
  return (
    <main className="home">
      <header className="home-bar">
        <IconButton label="Back to settings" onClick={() => navigate(`/t/${tournamentId}/settings`)}>{backIcon}</IconButton>
        <h1 className="title home-title">Activity log</h1>
        <SaveStatusBar />
      </header>
      <div className="home-panel activity">
        {offline && <p className="meta" role="status">{messages.offline} Showing the last Activity log read on this device.</p>}
        {teamList.length > 0 && (
          <section aria-label="Teams"><h2 className="meta">Team</h2>
            <div className="draw-chips">{teamList.map((t) => chip('teamId', t.id, t.code, `Team ${t.code}`))}</div>
          </section>
        )}
        {matchList.length > 0 && (
          <section aria-label="Matches"><h2 className="meta">Match</h2>
            <div className="draw-chips">{matchList.map((m) => chip('matchId', m.id, matchName(m.id), `Match ${matchName(m.id)}`))}</div>
          </section>
        )}
        {people.length > 0 && (
          <section aria-label="People"><h2 className="meta">Person</h2>
            <div className="draw-chips">{people.map((w) => chip('who', w, w, `changes by ${w}`))}</div>
          </section>
        )}
        {failed && (
          <>
            <Problem text={messages.activity_unknown} />
            <SecondaryButton label="Load the Activity log again" onClick={() => (setRows(null), setFailed(false), setAttempt((n) => n + 1))} />
          </>
        )}
        {!failed && rows === null && <div aria-busy="true"><div className="skeleton-row" /><div className="skeleton-row" /><div className="skeleton-row" /></div>}
        {rows?.length === 0 && <p className="body">{Object.values(filter).some(Boolean) ? 'No changes match these filters.' : 'Nothing changed yet.'}</p>}
        {rows && rows.length > 0 && (
          <ul className="cards">
            {rows.map((r) => {
              const lines = activityLines(r, label, show)
              const body = (
                <>
                  <h2 className="body-strong">{subject(r)}</h2>
                  {lines.map((l) => (
                    <p key={l.key || l.text} className="body">
                      {l.text ?? <>{l.label}: <s className="ink-muted">{l.old}</s> → {l.now}</>}
                    </p>
                  ))}
                  {lines.length === 0 && <p className="body">Changed</p>}
                  <p className="meta">{r.who} · {when(r.at)}</p>
                  {r.reason && <p className="meta">Reason: {r.reason}</p>}
                </>
              )
              const to = r.matchId ? `/t/${tournamentId}/m/${r.matchId}` : r.teamId ? `/t/${tournamentId}/teams/${r.teamId}` : null
              return <li key={r.id} className="card activity-row">{to ? <Link to={to} className="activity-link">{body}</Link> : body}</li>
            })}
          </ul>
        )}
        {more && <SecondaryButton label="Show 50 more changes" onClick={() => void loadMore()} />}
      </div>
    </main>
  )
}
