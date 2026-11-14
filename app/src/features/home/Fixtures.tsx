import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { runCommand } from '../../domain/commands'
import { suggestFixtures } from '../../domain/fixtures'
import { formatDate, inZone } from '../../domain/format'
import { matchMeta, seasonMatches, type Match } from '../../domain/matches'
import { messageFor, messages } from '../../domain/messages'
import type { Team } from '../../domain/teams'
import { PrimaryButton, SecondaryButton } from '../../ui/Button'
import { ConfirmSheet } from '../../ui/ConfirmSheet'
import { Problem } from '../auth/Screen'
import { useOnline } from '../app/online'
import { Draw, useDraw } from './Draw'
import type { Head } from './Home'
import { useTeams } from './Teams'

/** The Season's Fixtures in order; reloads when the signal returns. */
export function useMatches(seasonId: string) {
  const [matches, setMatches] = useState<Match[] | 'offline' | 'unknown' | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const again = () => setAttempt((n) => n + 1)
    window.addEventListener('online', again)
    return () => window.removeEventListener('online', again)
  }, [])
  useEffect(() => {
    let live = true
    void seasonMatches(seasonId).then((r) => live && setMatches('code' in r ? r.code : r.matches))
    return () => {
      live = false
    }
  }, [seasonId, attempt])
  return { matches, reload: () => setAttempt((n) => n + 1), retry: () => (setMatches(null), setAttempt((n) => n + 1)) }
}

/** A side as the card shows it: the Team's code ("RTM (Bye)" after a bye), or the source label while the Team is not known. */
export const sideText = (teamId: string | null, src: string | null, byId: Map<string, Team>) =>
  teamId ? `${byId.get(teamId)?.code ?? '?'}${src === 'Bye' ? ' (Bye)' : ''}` : src ?? '?'

/** "Kick-off not set", or the BS and AD day with the time. */
export function kickOffText(kickOff: string | null) {
  if (!kickOff) return 'Kick-off not set'
  const z = inZone(kickOff)
  return `${formatDate(z.date)} · ${z.time}`
}

/**
 * The Matches tab from the Draw on (Stories 3.1, 3.2): the "Suggest fixtures" action, the Match cards, and the Draw board
 * below. The phone works out the pairings and sends the whole list in one command that needs a signal.
 */
export function Fixtures({ tournamentId, head: h, fallback }: { tournamentId: string; head: Head; fallback: string }) {
  const navigate = useNavigate()
  const { teams } = useTeams(tournamentId, h.season.id)
  const { slots } = useDraw(tournamentId, h.season.id)
  const { matches, reload, retry } = useMatches(h.season.id)
  const online = useOnline()
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const league = h.season.structure.structure === 'league'
  const editable = h.season.status === 'registration'

  if (!Array.isArray(matches)) {
    return matches === null
      ? <div aria-busy="true"><p className="ui-visually-hidden">Loading</p><div className="skeleton-card" /></div>
      : <>
        <Problem text={matches === 'offline' ? messages.offline : messages.fixtures_unknown} />
        <SecondaryButton label="Try loading the Fixtures again" onClick={retry} />
      </>
  }
  const approved = Array.isArray(teams) ? teams.filter((t) => t.status === 'approved') : []
  const approvedIds = new Set(approved.map((t) => t.id))
  const byId = new Map(Array.isArray(teams) ? teams.map((t) => [t.id, t]) : [])
  const placed = new Set(Array.isArray(slots) ? slots.map((s) => s.teamId) : [])
  const ready = league ? approved.length >= 2 : approved.length >= 2 && approved.every((t) => placed.has(t.id))

  async function suggest(replace: boolean) {
    if (busy) return
    setBusy(true)
    setNotice('')
    setProblem(null)
    const fixtures = suggestFixtures(h.season.structure, approved, (Array.isArray(slots) ? slots : []).filter((x) => approvedIds.has(x.teamId)))
    const r = await runCommand('suggest_fixtures', { season_id: h.season.id, fixtures, replace })
    if (r.ok) setNotice('Fixtures suggested')
    else setProblem(messageFor(r.code))
    setBusy(false)
    reload()
  }

  const action = !editable || !h.season.structure.structure ? null : !online ? (
    <p className="meta">Suggesting fixtures needs a signal.</p>
  ) : matches.length ? (
    <SecondaryButton label="Suggest fixtures again" onClick={() => setConfirm(true)} />
  ) : ready ? (
    <PrimaryButton label="Suggest fixtures" onClick={() => void suggest(false)} />
  ) : (
    <PrimaryButton label="Suggest fixtures" disabled disabledReason={league ? 'Approve at least two Teams first.' : 'Record the whole draw first.'} />
  )

  return (
    <div className="fixtures">
      {action}
      <p role="status" aria-live="polite" className="body-strong">{notice}</p>
      <Problem text={problem} />
      {matches.length > 0 && (
        <ul className="cards">
          {matches.map((m) => {
            const home = sideText(m.homeTeamId, m.homeSrc, byId)
            const away = sideText(m.awayTeamId, m.awaySrc, byId)
            return (
              <li key={m.id}>
                <button type="button" className="card match-card" onClick={() => navigate(`/t/${tournamentId}/m/${m.id}`)}>
                  <span className="meta">{matchMeta(m)}</span>
                  <span className="match-sides">
                    <span className="match-side">{home}</span>
                    <span className="meta" aria-label="versus">v</span>
                    <span className="match-side">{away}</span>
                  </span>
                  <span className="meta">{kickOffText(m.kickOff)}</span>
                  <svg className="match-chevron" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2"
                    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7" /></svg>
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {league ? (!matches.length && !editable && <p className="body">{fallback}</p>)
        : (editable || !matches.length) && <Draw tournamentId={tournamentId} head={h} fallback={fallback} />}
      {league && !matches.length && editable && !ready && <p className="body">{fallback}</p>}
      <ConfirmSheet open={confirm} title={`Replace the ${matches.length} suggested Fixtures?`} before={`${matches.length} suggested Fixtures`}
        after="a new suggestion" actionLabel="Replace the Fixtures" destructive onConfirm={() => void suggest(true)} onClose={() => setConfirm(false)} />
    </div>
  )
}
