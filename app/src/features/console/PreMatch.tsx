import { lineupReason, type Console, type ConsoleTeam } from '../../domain/console'
import { KitDot } from '../../ui/KitDot'
import { PrimaryButton, SecondaryButton } from '../../ui/Button'
import { contrast, textColours } from '../setup/brand'

/** The two kits look alike at this contrast ratio or less (WCAG relative luminance). */
export const KIT_CLASH = 1.5

export type Picks = Record<string, 'start' | 'bench'>
export type TeamDraft = { picks: Picks; kit: string }
export type Drafts = Record<string, TeamDraft>

/** A Team's starting draft: the saved line-up, else nobody picked and the registered kit colour (the white of the tokens when it has none). */
export const startDraft = (t: ConsoleTeam): TeamDraft => {
  // A saved Player since removed from the Squad is dropped, or the counters would pass and the server refuse.
  const inSquad = new Set(t.squad.map((p) => p.playerId))
  const keep = (ids: string[]) => ids.filter((p) => inSquad.has(p))
  return {
  picks: t.lineup ? { ...Object.fromEntries(keep(t.lineup.starters).map((p) => [p, 'start' as const])), ...Object.fromEntries(keep(t.lineup.bench).map((p) => [p, 'bench' as const])) } : {},
  kit: t.lineup?.kitColour ?? t.registeredKit ?? textColours().white,
  }
}

const count = (d: TeamDraft, k: 'start' | 'bench') => Object.values(d.picks).filter((v) => v === k).length

/** The first Team (home first) whose line-up can't be confirmed, in words; null when both can. */
export function firstReason(teams: ConsoleTeam[], drafts: Drafts, rules: Console['rules']): string | null {
  for (const t of teams) {
    const r = lineupReason(count(drafts[t.teamId]!, 'start'), count(drafts[t.teamId]!, 'bench'), rules)
    if (r) return r
  }
  return null
}

/**
 * Pre-match (Story 4.2): each Team's Squad as a tick list (a Player starts or sits on the bench), the counters from the Season's Line-up
 * rules, the kit colour of the day and the kit-clash warning. Home is first; "Swap home and away" exchanges the sides.
 */
export function PreMatch({ c, teams, drafts, setDrafts, readOnly, confirmed, busy, onSwap, onConfirm }: {
  c: Console; teams: ConsoleTeam[]; drafts: Drafts; setDrafts: (d: Drafts) => void; readOnly: boolean; confirmed: boolean; busy: boolean
  onSwap: () => void; onConfirm: () => void
}) {
  const [home, away] = teams as [ConsoleTeam, ConsoleTeam]
  const reason = firstReason(teams, drafts, c.rules)
  const clash = contrast(drafts[home.teamId]!.kit, drafts[away.teamId]!.kit) <= KIT_CLASH
  const set = (t: ConsoleTeam, patch: (d: TeamDraft) => TeamDraft) => setDrafts({ ...drafts, [t.teamId]: patch(drafts[t.teamId]!) })
  const pick = (t: ConsoleTeam, id: string, as: 'start' | 'bench', on: boolean) =>
    set(t, (d) => {
      const picks = { ...d.picks }
      if (on) picks[id] = as
      else delete picks[id]
      return { ...d, picks }
    })

  return (
    <div className="prematch">
      {!readOnly && <SecondaryButton label="Swap home and away" onClick={onSwap} />}
      {teams.map((t, i) => {
        const d = drafts[t.teamId]!
        return (
          <section key={t.teamId} className="card prematch-team" aria-labelledby={`pm-${t.teamId}`}>
            <h2 id={`pm-${t.teamId}`} className="body-strong prematch-head">
              <span className="kit-chip"><KitDot colour={d.kit} /><span>{t.code}</span></span>
              <span>{t.name}</span>
              <span className="meta">{i === 0 ? 'Home' : 'Away'}</span>
            </h2>
            <p className="meta" role="status" aria-live="polite">Starting {count(d, 'start')} of {c.rules.starters} · Bench {count(d, 'bench')} of {c.rules.maxBench}</p>
            {t.squad.length === 0 && <p className="body">This Team has no Players in its Squad.</p>}
            <ul className="prematch-squad">
              {t.squad.map((p) => (
                <li key={p.playerId} className="prematch-player">
                  <span className="prematch-shirt body-strong">{p.shirt}</span>
                  <span className="body prematch-name">{p.name}</span>
                  <label className="prematch-tick">
                    <input type="checkbox" disabled={readOnly} checked={d.picks[p.playerId] === 'start'} aria-label={`Start ${p.name}`}
                      onChange={(e) => pick(t, p.playerId, 'start', e.target.checked)} />
                    <span className="meta" aria-hidden="true">Start</span>
                  </label>
                  <label className="prematch-tick">
                    <input type="checkbox" disabled={readOnly} checked={d.picks[p.playerId] === 'bench'} aria-label={`Put ${p.name} on the bench`}
                      onChange={(e) => pick(t, p.playerId, 'bench', e.target.checked)} />
                    <span className="meta" aria-hidden="true">Bench</span>
                  </label>
                </li>
              ))}
            </ul>
            <label className="prematch-kit body" htmlFor={`kit-${t.teamId}`}>
              <span>Kit colour for {t.code}</span>
              <input id={`kit-${t.teamId}`} type="color" value={d.kit} disabled={readOnly} onChange={(e) => set(t, (x) => ({ ...x, kit: e.target.value.toLowerCase() }))} />
            </label>
          </section>
        )
      })}
      {clash && (
        <div className="prematch-clash" role="status">
          <p className="body-strong">{home.code} and {away.code} kits look alike.</p>
          <p className="body">Pick another colour for the away Team.</p>
        </div>
      )}
      {!readOnly && (reason
        ? <PrimaryButton label="Confirm line-ups" disabled disabledReason={reason} />
        : <PrimaryButton label="Confirm line-ups" onClick={busy ? undefined : onConfirm} />)}
      {confirmed && <p className="meta" role="status">Line-ups confirmed.</p>}
    </div>
  )
}
