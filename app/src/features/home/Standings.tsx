import { useEffect, useState } from 'react'
import { runCommand, useOutbox } from '../../domain/commands'
import type { Match } from '../../domain/matches'
import { messageFor } from '../../domain/messages'
import { seasonStandings, shootoutsNeeded, type Sides, type StandingRow } from '../../domain/standings'
import type { Team } from '../../domain/teams'
import { SecondaryButton } from '../../ui/Button'
import { Sheet } from '../../ui/Sheet'
import { Problem } from '../auth/Screen'
import { useOnline } from '../app/online'
import { sideText } from './Fixtures'

/** The Season's group tables and resolved Match sides from the database (read once Fixtures exist), kept for offline; reloads as changes send and when the signal returns. */
export function useStandings(seasonId: string, enabled: boolean) {
  const [data, setData] = useState<{ rows: StandingRow[]; sides: Sides[] } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const pending = useOutbox().entries.length
  useEffect(() => {
    const again = () => setAttempt((n) => n + 1)
    window.addEventListener('online', again)
    return () => window.removeEventListener('online', again)
  }, [])
  useEffect(() => {
    if (!enabled) return
    let live = true
    void seasonStandings(seasonId).then((r) => live && setData((prev) => ('code' in r ? prev : r)))
    return () => {
      live = false
    }
  }, [seasonId, enabled, attempt, pending])
  return { data, reload: () => setAttempt((n) => n + 1) }
}

const groupName = (grp: number) => (grp === 0 ? 'League table' : `Group ${String.fromCharCode(64 + grp)}`)

/**
 * Group tables and the knockout bracket (Story 3.4), as the database works them out: nothing is ranked here. A tie that needs a
 * tie-break shootout says so, and an Organiser records who won it.
 */
export function Standings({ seasonId, rows, matches, sides, byId, canRecord, reload }: {
  seasonId: string; rows: StandingRow[]; matches: Match[]; sides: Map<string, Sides>; byId: Map<string, Team>; canRecord: boolean; reload: () => void
}) {
  const online = useOnline()
  const [pair, setPair] = useState<{ a: string; b: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const code = (id: string) => byId.get(id)?.code ?? '?'
  const needed = shootoutsNeeded(rows)
  const groups = [...new Set(rows.map((r) => r.grp))].sort((a, b) => a - b)
  const knockout = matches.filter((m) => m.stage === 'knockout')
  const rounds = [...new Set(knockout.map((m) => m.round))]

  async function record(winner: string, loser: string) {
    if (busy) return
    setBusy(true)
    setNotice('')
    setProblem(null)
    const r = await runCommand('record_tiebreak_shootout', { season_id: seasonId, shootout_id: crypto.randomUUID(), winner_team_id: winner, loser_team_id: loser })
    if (r.ok) setNotice('Shootout recorded')
    else setProblem(messageFor(r.code))
    setBusy(false)
    reload()
  }

  return (
    <>
      {groups.map((g) => {
        const table = rows.filter((r) => r.grp === g).sort((a, b) => a.pos - b.pos)
        const ties = needed.filter((n) => n.grp === g)
        return (
          <section key={g} className="standings" aria-label={groupName(g)}>
            <table>
              <caption className="body-strong">{groupName(g)}</caption>
              <thead>
                <tr>
                  <th scope="col">Team</th>
                  {['P', 'W', 'D', 'L', 'GF', 'GA', 'GD', 'Pts'].map((h) => <th key={h} scope="col">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {table.map((r) => (
                  <tr key={r.teamId}>
                    <th scope="row">{code(r.teamId)}{r.provisional && <abbr title="Provisional until a shootout is recorded"> *</abbr>}</th>
                    {[r.p, r.w, r.d, r.l, r.gf, r.ga, r.gd, r.pts].map((v, i) => <td key={i}>{v}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
            {ties.map((n) => (
              <div key={n.a + n.b}>
                <p className="meta">Shootout needed: {code(n.a)} v {code(n.b)}</p>
                {canRecord && (online
                  ? <SecondaryButton label="Record the shootout" onClick={() => setPair(n)} />
                  : <p className="meta">Recording a shootout needs a signal.</p>)}
              </div>
            ))}
          </section>
        )
      })}
      <p role="status" aria-live="polite" className="body-strong">{notice}</p>
      <Problem text={problem} />
      {rounds.length > 0 && (
        <section className="bracket" aria-label="Knockout bracket">
          <h3 className="body-strong">Knockout bracket</h3>
          {rounds.map((r) => (
            <div key={r}>
              <p className="meta">{r}</p>
              <ul className="cards">
                {knockout.filter((m) => m.round === r).map((m) => {
                  const s = sides.get(m.id)
                  return (
                    <li key={m.id} className="card bracket-match">
                      {m.label && <span className="meta">{m.label}</span>}{' '}
                      <span className="match-side">{sideText(s ? s.homeTeamId : m.homeTeamId, m.homeSrc, byId)}</span>
                      <span className="meta" aria-label="versus"> v </span>
                      <span className="match-side">{sideText(s ? s.awayTeamId : m.awayTeamId, m.awaySrc, byId)}</span>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </section>
      )}
      <Sheet open={!!pair} title="Who won the shootout?" onClose={() => setPair(null)}>
        {({ close }) => pair && (
          <div className="ui-sheet-actions">
            {[[pair.a, pair.b], [pair.b, pair.a]].map(([w, l]) => (
              <button key={w} type="button" className="ui-button ui-primary" onClick={() => (void record(w!, l!), close())}>
                {`Record ${code(w!)} as the winner`}
              </button>
            ))}
            <button type="button" className="ui-button ui-secondary" onClick={close}>Cancel</button>
          </div>
        )}
      </Sheet>
    </>
  )
}
