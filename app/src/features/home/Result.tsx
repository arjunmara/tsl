import { useEffect, useState } from 'react'
import { forgetRefused, noteVersion, send } from '../../domain/commands'
import { goalMinute, goalsOf, playerNames, readConsole, type Console, type ConsoleTeam, type MatchEvent } from '../../domain/console'
import type { Match } from '../../domain/matches'
import { messageFor, messages, numberRange } from '../../domain/messages'
import { PrimaryButton, SecondaryButton } from '../../ui/Button'
import { ConfirmSheet } from '../../ui/ConfirmSheet'
import { StatusPill } from '../../ui/StatusPill'
import { Problem } from '../auth/Screen'
import { awardGroups, shootoutProblem } from '../console/Awards'
import { EventEditors, type Ask } from '../console/EventEditors'
import { EventLog } from '../console/EventLog'
import { Picker } from '../console/Picker'
import { startDraft } from '../console/PreMatch'
import { resultText } from './Fixtures'

const NO_ONE = 'nobody'

/**
 * A Match's result for an Organiser (Story 4.6), under the Match card: "Type the result" for a Match scored on paper, and for a finished Match the
 * result with its Awards and the Event log whose goals can be added, changed and deleted, each behind a Confirm sheet.
 */
export function Result({ seasonId, match, onChanged }: { seasonId: string; match: Match; onChanged: () => void }) {
  const [c, setC] = useState<Console | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [ask, setAsk] = useState<Ask | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [picker, setPicker] = useState<{ team: string } | { assist: string } | { award: 'mom' | 'fair' } | null>(null)
  const read = async () => {
    const r = await readConsole(match.id)
    if (typeof r !== 'object' || !('match' in r)) return null
    r.events.forEach((e) => void noteVersion(e.id, e.version ?? 1))
    r.teams.forEach((t) => t.squad.forEach((p) => playerNames.set(p.playerId, p.name)))
    return r
  }
  const load = async () => setC((await read()) ?? c)
  useEffect(() => {
    let live = true
    void read().then((r) => live && r && setC(r))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read again when the Match changes
  }, [match.id, match.version, match.status])

  // One command, then the Match is read again; a refusal is said once (the server's own words for the two that name a Team or the next round).
  async function run(name: string, args: Record<string, unknown>, opts: { scope: string; versionOf?: string; commandId?: string }) {
    setProblem(null)
    setNotice('')
    const r = await send(name, { season_id: seasonId, ...args }, opts)
    if (r.code === 'queued') return setNotice(messages.clock_queued)
    if (!r.ok && r.code !== 'version_conflict') {
      if (r.commandId) void forgetRefused(r.commandId)
      setProblem((r.code === 'downstream_started' || r.code === 'goals_named') && r.message ? r.message : messageFor(r.code))
    }
    await load()
    onChanged()
  }

  if (!c || c.match.seasonStatus !== 'started' || c.teams.length < 2) return null
  const finished = c.match.status === 'finished'
  const [home, away] = c.teams as [ConsoleTeam, ConsoleTeam]
  const picksOf = (t: ConsoleTeam) => startDraft(t).picks
  const name = (id: string | null) => (id ? playerNames.get(id) ?? NO_ONE : NO_ONE)
  const teamOf = (id: string | null | undefined) => c.teams.find((t) => t.teamId === id)
  const score = (events: MatchEvent[]): [number, number] => [goalsOf(events, home.teamId), goalsOf(events, away.teamId)]
  const scorers = (t: ConsoleTeam) => (t.lineup ? t.squad.filter((p) => t.lineup!.starters.includes(p.playerId) || t.lineup!.bench.includes(p.playerId)) : t.squad)
  const pickTeam = picker && 'team' in picker ? teamOf(picker.team) : undefined
  const assistEvent = picker && 'assist' in picker ? c.events.find((e) => e.id === picker.assist) : undefined
  const award = picker && 'award' in picker ? picker.award : null
  const label = award === 'fair' ? 'Fair Player' : 'Man of the Match'

  function addGoal(t: ConsoleTeam, who: string) {
    const id = crypto.randomUUID()
    const own = who === 'own'
    const player = own || who === 'unknown' ? null : who
    const [h, a] = score(c!.events)
    const [nh, na] = t === home ? [h + 1, a] : [h, a + 1]
    setAsk({ title: `Add a goal for ${t.code} by ${own ? 'own goal' : player ? name(player) : 'unknown scorer'}? The score becomes ${nh}–${na}.`, before: `${h}–${a}`, after: `${nh}–${na}`, action: 'Save goal',
      run: () => void run('record_goal', { match_id: match.id, team_id: t.teamId, player_id: player, own_goal: own, period: c!.clock.period || 1, minute: goalMinute(c!.clock, c!.rules, new Date()) },
        { scope: match.id, commandId: id }) })
  }
  function pickAward(who: string) {
    const now = { mom: c!.match.momId, fair: c!.match.fairId }
    const next = who === 'skip' ? null : who
    const was = now[award!]
    if (next === was) return
    setAsk({ title: `Change ${label} from ${name(was)} to ${name(next)}?`, before: name(was), after: name(next), action: 'Save Awards',
      run: () => void run('set_awards', { match_id: match.id, expected_version: c!.match.version, mom_player_id: award === 'mom' ? next : now.mom, fair_player_id: award === 'fair' ? next : now.fair },
        { scope: match.id }) })
  }

  return (
    <>
      {finished && (
        <section className="card" aria-labelledby="result-head">
          <h2 id="result-head" className="body-strong"><StatusPill state="done" label="FT" /> {score(c.events).join('–')}{c.match.homePens != null ? ` · pens ${c.match.homePens}–${c.match.awayPens}` : ''}</h2>
          <p className="body">Man of the Match: {name(c.match.momId)}</p>
          <p className="body">Fair Player: {name(c.match.fairId)}</p>
          {c.teams.every((t) => t.lineup) && (
            <div className="ui-sheet-actions">
              <SecondaryButton label="Change Man of the Match" onClick={() => setPicker({ award: 'mom' })} />
              <SecondaryButton label="Change Fair Player" onClick={() => setPicker({ award: 'fair' })} />
            </div>
          )}
          <EventLog c={c} waiting={new Set()} onEdit={(e) => setEditing(e.id)} />
          <div className="ui-sheet-actions">
            {c.teams.map((t) => <SecondaryButton key={t.teamId} label={`Record goal for ${t.code}`} onClick={() => setPicker({ team: t.teamId })} />)}
          </div>
        </section>
      )}
      {c.match.status !== 'live' && <TypeForm key={`${match.version}-${match.status}-${match.hg}-${match.ag}-${match.homePens}-${match.awayPens}`} match={match} c={c} onSave={(a) => setAsk(a)} run={run} setProblem={setProblem} />}
      <p role="status" aria-live="polite" className="body-strong">{notice}</p>
      <Problem text={problem} />
      <Picker title={pickTeam ? `Who scored for ${pickTeam.name}?` : assistEvent ? `Who assisted for ${teamOf(assistEvent.teamId)?.name}?` : award ? `Who is the ${label}?` : null}
        players={pickTeam ? scorers(pickTeam) : assistEvent ? (teamOf(assistEvent.teamId)?.squad ?? []).filter((p) => p.playerId !== assistEvent.playerId) : undefined}
        groups={award ? awardGroups(c.teams, picksOf) : undefined}
        extras={pickTeam ? [{ label: 'Own goal', value: 'own' }, { label: 'Unknown scorer', value: 'unknown' }] : award ? [{ label: 'Skip', value: 'skip' }] : undefined}
        onPick={(who) => (pickTeam ? addGoal(pickTeam, who) : award ? pickAward(who) : assistEvent && void run('add_assist', { event_id: assistEvent.id, assist_id: who }, { scope: assistEvent.id, versionOf: assistEvent.id }))}
        onClose={() => setPicker(null)} />
      {finished && (
        <EventEditors c={c} home={home} away={away} editing={editing} onClose={() => setEditing(null)} onAssist={(id) => setPicker({ assist: id })} picksOf={picksOf}
          setProblem={setProblem} ask={setAsk} change={(id, n, args) => void run(n, { event_id: id, ...args }, { scope: id, versionOf: id })}
          takeAway={(id) => void run('delete_event', { event_id: id }, { scope: id, versionOf: id })} />
      )}
      <ConfirmSheet open={!!ask} title={ask?.title ?? ''} before={ask?.before ?? ''} after={ask?.after ?? ''} actionLabel={ask?.action ?? ''} destructive={ask?.destructive}
        note={messages.logged_note} onClose={() => setAsk(null)} onConfirm={() => ask?.run()} />
    </>
  )
}

/** "Type the result": the score of a Match played on paper (and the shootout of a level knockout Match), saved behind a Confirm sheet. */
function TypeForm({ match, c, onSave, run, setProblem }: { match: Match; c: Console; onSave: (a: Ask) => void; run: (name: string, args: Record<string, unknown>, o: { scope: string }) => Promise<void>; setProblem: (t: string | null) => void }) {
  const [t, setT] = useState({ h: match.status === 'finished' ? String(match.hg ?? 0) : '', a: match.status === 'finished' ? String(match.ag ?? 0) : '',
    hp: match.homePens == null ? '' : String(match.homePens), ap: match.awayPens == null ? '' : String(match.awayPens) })
  // The Match's own sides: the home Team first, whatever the line-up says.
  const side = (id: string | null) => c.teams.find((x) => x.teamId === id)
  const home = side(c.match.homeId)
  const away = side(c.match.awayId)
  if (!home || !away) return null
  const num = (s: string) => (/^\d{1,2}$/.test(s.trim()) ? Number(s) : null)
  const h = num(t.h)
  const a = num(t.a)
  const level = match.stage === 'knockout' && h !== null && h === a
  const input = (k: 'h' | 'a' | 'hp' | 'ap', text: string) => (
    <div className="ui-field">
      <label htmlFor={`type-${k}`} className="body-strong">{text}</label>
      <input id={`type-${k}`} className="ui-input" inputMode="numeric" autoComplete="off" value={t[k]} onChange={(e) => (setProblem(null), setT({ ...t, [k]: e.target.value }))} />
    </div>
  )
  function save() {
    if (h === null || a === null) return setProblem(numberRange(0, 99))
    const bad = level ? shootoutProblem(t.hp, t.ap) : null
    if (bad) return setProblem(bad)
    const text = `${home!.code} ${h}–${a} ${away!.code}`
    const pens = level ? { home_pens: Number(t.hp), away_pens: Number(t.ap) } : { home_pens: null, away_pens: null }
    const shown = `${h}–${a}${level ? ` · pens ${t.hp}–${t.ap}` : ''}`
    onSave({ title: `Save ${level ? `${text} (pens ${t.hp}–${t.ap})` : text} as the final result?`, before: match.status === 'finished' ? `Finished ${resultText(match)}` : 'Not played', after: `Finished ${shown}`,
      action: 'Save result', run: () => void run('type_result', { match_id: match.id, expected_version: c.match.version, home: h, away: a, ...pens }, { scope: match.id }) })
  }
  return (
    <form noValidate className="card" onSubmit={(e) => (e.preventDefault(), save())}>
      <h2 className="body-strong">Type the result</h2>
      {input('h', `${home.code} goals`)}
      {input('a', `${away.code} goals`)}
      {level && input('hp', `${home.code} shootout goals`)}
      {level && input('ap', `${away.code} shootout goals`)}
      <PrimaryButton label="Save result" onClick={save} />
    </form>
  )
}
