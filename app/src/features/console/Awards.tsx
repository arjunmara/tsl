import { useState, type Dispatch, type SetStateAction } from 'react'
import { messages } from '../../domain/messages'
import type { ConsoleTeam } from '../../domain/console'
import { Sheet } from '../../ui/Sheet'

/** The whistle's state on this phone (Story 4.6): `at` is when the clock stopped; step: which sheet is open (null: none, Finish match reopens it). */
export type Finish = { at: string; step: 'sheet' | 'mom' | 'fair' | null; hp: string; ap: string; mom: string | null; fair: string | null }

/** The Man of the Match and Fair Player choices: both line-ups, starters and bench, grouped by Team. */
export const awardGroups = (teams: ConsoleTeam[], picksOf: (t: ConsoleTeam) => Record<string, string | undefined>) => teams.map((t) => ({ heading: t.name,
  players: t.squad.filter((p) => picksOf(t)[p.playerId] === 'start' || picksOf(t)[p.playerId] === 'bench') }))

/** The shootout's two numbers; null when one is missing, else the words the server uses for a tie. */
export const shootoutProblem = (hp: string, ap: string): string | null => {
  const h = /^\d{1,2}$/.test(hp.trim()) ? Number(hp) : null
  const a = /^\d{1,2}$/.test(ap.trim()) ? Number(ap) : null
  return h === null || a === null ? messages.shootout_needed : h === a ? messages.shootout_tied : null
}

/**
 * The Awards sheet after the whistle: the shootout first when the Match is a level knockout one, then Man of the Match and Fair Player (each opens
 * the Player picker; Skip is allowed), then "Finish match". Cancel keeps the clock stopped on this phone and closes the sheet.
 */
export function AwardsSheet({ fin, setFin, home, away, shootout, nameOf, onFinish }: {
  fin: Finish; setFin: Dispatch<SetStateAction<Finish | null>>; home: ConsoleTeam; away: ConsoleTeam; shootout: boolean; nameOf: (id: string | null) => string; onFinish: () => void
}) {
  const [problem, setProblem] = useState<string | null>(null)
  const set = (p: Partial<Finish>) => setFin((f) => (f ? { ...f, ...p } : f))
  const field = (id: 'hp' | 'ap', t: ConsoleTeam) => (
    <div className="ui-field">
      <label htmlFor={`pens-${id}`} className="body-strong">{t.code} shootout goals</label>
      <input id={`pens-${id}`} className="ui-input" inputMode="numeric" autoComplete="off" value={fin[id]} onChange={(e) => (setProblem(null), set({ [id]: e.target.value }))} />
    </div>
  )
  const award = (step: 'mom' | 'fair', label: string, who: string | null, close: () => void) => (
    <div>
      <p className="body">{label}: {nameOf(who)}</p>
      <button type="button" className="ui-button ui-secondary" onClick={() => (close(), set({ step }))}>{who ? `Change ${label}` : `Pick ${label}`}</button>
    </div>
  )
  return (
    <Sheet open={fin.step === 'sheet'} title="Finish the match" onClose={() => setFin((f) => (f && f.step === 'sheet' ? { ...f, step: null } : f))}>
      {({ close }) => (
        <>
          {shootout && (
            <fieldset>
              <legend className="body-strong">Shootout</legend>
              {field('hp', home)}
              {field('ap', away)}
              {problem && <p className="meta ui-reason" role="alert">{problem}</p>}
            </fieldset>
          )}
          {award('mom', 'Man of the Match', fin.mom, close)}
          {award('fair', 'Fair Player', fin.fair, close)}
          <div className="ui-sheet-actions">
            <button type="button" className="ui-button ui-primary" onClick={() => {
              const bad = shootout ? shootoutProblem(fin.hp, fin.ap) : null
              if (bad) return setProblem(bad)
              close()
              onFinish()
            }}>Finish match</button>
            <button type="button" className="ui-button ui-secondary" onClick={close}>Cancel</button>
          </div>
        </>
      )}
    </Sheet>
  )
}
