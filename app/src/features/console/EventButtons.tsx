import type { Console, EventKind } from '../../domain/console'

const buttons: { kind: EventKind; label: string; icon: string }[] = [
  { kind: 'card', label: 'Record card', icon: '🟨' }, { kind: 'foul', label: 'Record foul', icon: '✋' }, { kind: 'sub', label: 'Record sub', icon: '🔄' },
  { kind: 'timeout', label: 'Record timeout', icon: '⏸' }, { kind: 'missed_penalty', label: 'Record missed penalty', icon: '🥅' },
]

/** The Event row (Story 4.5), under the GOAL buttons: 64px, icon and text. Foul only when the Format has a foul limit, timeout only when it has timeouts. */
export function EventButtons({ rules, onPick }: { rules: Console['rules']; onPick: (k: EventKind) => void }) {
  return (
    <div className="event-buttons">
      {buttons.filter((b) => (b.kind !== 'foul' || rules.foulWarning) && (b.kind !== 'timeout' || rules.timeoutsPerPeriod)).map((b) => (
        <button key={b.kind} type="button" className="ui-button ui-secondary event-button" onClick={() => onPick(b.kind)}>
          <span aria-hidden="true">{b.icon}</span> {b.label}
        </button>
      ))}
    </div>
  )
}
