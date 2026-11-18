import type { SquadPlayer } from '../../domain/console'
import { Sheet } from '../../ui/Sheet'

/** The Player picker (Story 4.4): one 64px tile per starter, name first then shirt number; Cancel, Escape or tapping outside picks nobody. */
export function Picker({ title, players, extras, chosen, onPick, onClose }: {
  title: string | null; players: SquadPlayer[]; extras?: { label: string; value: 'own' | 'unknown' }[]; chosen?: string
  onPick: (who: string) => void; onClose: () => void
}) {
  return (
    <Sheet open={title !== null} title={title ?? ''} dismissOutside onClose={onClose}>
      {({ close }) => {
        const pick = (who: string) => () => {
          onPick(who)
          close()
        }
        return (
          <>
            <ul className="picker-tiles">
              {players.map((p) => (
                <li key={p.playerId}>
                  <button type="button" className="ui-button ui-secondary picker-tile" aria-pressed={chosen === undefined ? undefined : chosen === p.playerId} onClick={pick(p.playerId)}>
                    <span>{p.name}</span> <span className="meta">{p.shirt}</span>
                  </button>
                </li>
              ))}
            </ul>
            {extras && (
              <div className="ui-sheet-actions">
                {extras.map((x) => (
                  <button key={x.value} type="button" className="ui-button ui-secondary picker-tile" aria-pressed={chosen === undefined ? undefined : chosen === x.value} onClick={pick(x.value)}>
                    {x.label}
                  </button>
                ))}
              </div>
            )}
            <div className="ui-sheet-actions">
              <button type="button" className="ui-button ui-secondary" onClick={close}>Cancel</button>
            </div>
          </>
        )
      }}
    </Sheet>
  )
}
