import type { CSSProperties } from 'react'
import type { ConsoleTeam } from '../../domain/console'

/** Two GOAL buttons side by side in the Scoreboard's order (Story 4.4): orange, with the Team's kit colour as a band on the outer edge. */
export function GoalButtons({ home, away, kits, onGoal }: { home: ConsoleTeam; away: ConsoleTeam; kits: Record<string, string>; onGoal: (t: ConsoleTeam) => void }) {
  return (
    <div className="goal-buttons">
      {[home, away].map((t, i) => (
        <button key={t.teamId} type="button" className={`goal-button ${i ? 'goal-away' : 'goal-home'}`} style={{ '--kit': kits[t.teamId] || 'var(--surface)' } as CSSProperties}
          aria-label={`GOAL ${t.code}`} onClick={() => onGoal(t)}>
          <span className="display-lg">GOAL</span>
          <span className="body-strong">{t.code}</span>
        </button>
      ))}
    </div>
  )
}
