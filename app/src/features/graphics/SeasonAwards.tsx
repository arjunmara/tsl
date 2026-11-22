import { useEffect, useState } from 'react'
import { playerNames } from '../../domain/console'
import { forgetRefused, noteVersion, send, useOutbox } from '../../domain/commands'
import { messageFor, messages } from '../../domain/messages'
import { cutOutUrls } from '../../domain/playerPhotos'
import { AWARDS, readSeasonAwards, topScorers, type AwardKey, type SeasonAwardsData } from '../../domain/seasonAwards'
import type { Team } from '../../domain/teams'
import { SecondaryButton } from '../../ui/Button'
import { ConfirmSheet } from '../../ui/ConfirmSheet'
import { Problem } from '../auth/Screen'
import { Picker, type PickGroup } from '../console/Picker'

/** The Season's scorers, Players and set awards, with the consent gate's cut-outs for the Players an award Graphic shows. Read again as changes send and when the signal returns. */
export function useSeasonAwards(seasonId: string, teams: Team[] | null) {
  const [data, setData] = useState<SeasonAwardsData | null>(null)
  const [cutouts, setCutouts] = useState<Map<string, string>>(new Map())
  const [failed, setFailed] = useState<'offline' | 'unknown' | null>(null)
  const [attempt, setAttempt] = useState(0)
  const pending = useOutbox().entries.length
  const ids = teams ? teams.map((t) => t.id).join(',') : null
  useEffect(() => {
    const again = () => setAttempt((n) => n + 1)
    window.addEventListener('online', again)
    return () => window.removeEventListener('online', again)
  }, [])
  useEffect(() => {
    if (ids === null) return
    let live = true
    void (async () => {
      const r = await readSeasonAwards(seasonId, ids ? ids.split(',') : [])
      if (!live) return
      setFailed('code' in r ? r.code : null)
      if ('code' in r) return
      r.awards.forEach((a) => void noteVersion(a.id, a.version))
      r.players.forEach((p) => playerNames.set(p.playerId, p.name))
      // Only Players an award Graphic shows go through the gate.
      // A tie is text-only, so only a single leader goes through the gate.
      const lead = topScorers(r.scorers)
      const shown = [...(lead.length === 1 ? [lead[0]!.playerId] : []), ...r.awards.map((a) => a.playerId)]
      const urls = await cutOutUrls(seasonId, shown)
      if (!live) return
      setCutouts(urls)
      setData(r)
    })()
    return () => {
      live = false
    }
  }, [seasonId, ids, attempt, pending])
  return { data, cutouts, failed, reload: () => setAttempt((n) => n + 1) }
}

/**
 * The Season awards section (Story 5.6): the Top Scorer (derived, every tied leader named) and the two awards an Organiser picks, each from the Season's Players
 * grouped by Team. Changing an award already set asks first (old and new Player); every pick queues offline through the outbox.
 */
export function SeasonAwards({ seasonId, data, byId, onSaved }: { seasonId: string; data: SeasonAwardsData; byId: Map<string, Team>; onSaved: () => void }) {
  const [picking, setPicking] = useState<AwardKey | null>(null)
  const [ask, setAsk] = useState<{ award: AwardKey; player: string } | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const name = (id: string | null | undefined) => data.players.find((p) => p.playerId === id)?.name ?? 'nobody'
  const teamCode = (id: string) => byId.get(data.players.find((p) => p.playerId === id)?.teamId ?? data.scorers.find((s) => s.playerId === id)?.teamId ?? '')?.code ?? '?'
  const lead = topScorers(data.scorers)

  async function save(award: AwardKey, player: string) {
    setProblem(null)
    setNotice('')
    const row = data.awards.find((a) => a.award === award)
    const r = await send('set_season_award', { season_id: seasonId, award, player_id: player }, { scope: `${seasonId}:${award}`, ...(row ? { versionOf: row.id } : {}) })
    if (r.code === 'queued') setNotice(messages.clock_queued)
    else if (!r.ok && r.code !== 'version_conflict') {
      if (r.commandId) void forgetRefused(r.commandId)
      setProblem(messageFor(r.code))
    }
    onSaved()
  }
  function pick(who: string) {
    const award = picking!
    const was = data.awards.find((a) => a.award === award)?.playerId
    if (who === was) return
    if (was) setAsk({ award, player: who })
    else void save(award, who)
  }
  const groups: PickGroup[] = [...byId.values()].map((t) => ({ heading: t.name,
    players: data.players.filter((p) => p.teamId === t.id).sort((a, b) => a.shirt - b.shirt).map(({ playerId, name: n, shirt }) => ({ playerId, name: n, shirt })) })).filter((g) => g.players.length > 0)

  return (
    <div className="card graphic-card">
      <p className="body">Top Scorer: {lead.length ? `${lead.map((s) => `${name(s.playerId)} (${teamCode(s.playerId)})`).join(' and ')}, ${lead[0]!.goals} ${lead[0]!.goals === 1 ? 'goal' : 'goals'}` : 'Available once a goal is scored'}</p>
      {(Object.keys(AWARDS) as AwardKey[]).map((k) => {
        const row = data.awards.find((a) => a.award === k)
        return (
          <div key={k}>
            <p className="body">{AWARDS[k]}: {row ? `${name(row.playerId)} (${teamCode(row.playerId)})` : 'Not chosen yet'}</p>
            <SecondaryButton label={row ? `Change ${AWARDS[k]}` : `Pick ${AWARDS[k]}`} onClick={() => setPicking(k)} />
          </div>
        )
      })}
      <p role="status" aria-live="polite" className="body-strong">{notice}</p>
      <Problem text={problem} />
      <Picker title={picking ? `Who is the ${AWARDS[picking]}?` : null} groups={groups} chosen={picking ? data.awards.find((a) => a.award === picking)?.playerId : undefined}
        onPick={(who) => void pick(who)} onClose={() => setPicking(null)} />
      <ConfirmSheet open={!!ask} title={ask ? `Change ${AWARDS[ask.award]} from ${name(data.awards.find((a) => a.award === ask.award)?.playerId)} to ${name(ask.player)}?` : ''}
        before={ask ? name(data.awards.find((a) => a.award === ask.award)?.playerId) : ''} after={ask ? name(ask.player) : ''} actionLabel={ask ? `Change ${AWARDS[ask.award]}` : ''}
        note={messages.logged_note} onClose={() => setAsk(null)} onConfirm={() => ask && void save(ask.award, ask.player)} />
    </div>
  )
}
