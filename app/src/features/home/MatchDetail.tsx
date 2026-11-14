import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { matchMeta, seasonMatches, type Match } from '../../domain/matches'
import { messages } from '../../domain/messages'
import { backIcon, IconButton } from '../../ui/Button'
import { Problem } from '../auth/Screen'
import { Unavailable, UUID } from '../setup/Setup'
import { kickOffText, sideText } from './Fixtures'
import { readHead } from './Home'
import { useTeams } from './Teams'

/** /t/:tournamentId/m/:matchId: one Fixture, minimal: the round, both sides and the kick-off. Editing comes with Story 3.3. */
export function MatchDetail() {
  const { tournamentId = '', matchId = '' } = useParams()
  if (!UUID.test(tournamentId) || !UUID.test(matchId)) return <Unavailable />
  return <Load key={matchId} tournamentId={tournamentId} matchId={matchId} />
}

function Load({ tournamentId, matchId }: { tournamentId: string; matchId: string }) {
  const navigate = useNavigate()
  const [seasonId, setSeasonId] = useState<string | null>(null)
  const [match, setMatch] = useState<Match | 'missing' | 'offline' | 'unknown' | null>(null)
  useEffect(() => {
    let live = true
    void (async () => {
      const h = await readHead(tournamentId)
      if (!live) return
      if (typeof h === 'string') return setMatch(h === 'missing' ? 'missing' : h)
      setSeasonId(h.season.id)
      const r = await seasonMatches(h.season.id)
      if (live) setMatch('code' in r ? r.code : r.matches.find((m) => m.id === matchId) ?? 'missing')
    })()
    return () => {
      live = false
    }
  }, [tournamentId, matchId])
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
      </div>
    </main>
  )
}
