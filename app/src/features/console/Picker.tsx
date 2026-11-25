import type { SquadPlayer } from '../../domain/console'
import { Sheet } from '../../ui/Sheet'

/** A Player tile; note ("Bench") says where the Player is. */
export type PickPlayer = SquadPlayer & { note?: string }
/** Tiles under a heading, like a Team's name. */
/** A group with a reason is disabled and says why (a Team that has used all its substitutions). */
export type PickGroup = { heading: string; players: PickPlayer[]; reason?: string }

/**
 * The Player picker (Story 4.4, 4.5): one 64px tile per Player (name first then shirt number), optionally grouped under a Team's name, plus extra
 * tiles (Own goal, a card, a Team). A tile with a `reason` is disabled and says why. Cancel, Escape or tapping outside picks nobody. onPick may
 * answer true when another step follows: the sheet stays open and the parent changes its title and tiles.
 */
export function Picker({ title, players, groups, extras, chosen, onPick, onClose }: {
  title: string | null; players?: PickPlayer[]; groups?: PickGroup[]; extras?: { label: string; value: string; reason?: string }[]; chosen?: string
  onPick: (who: string) => boolean | void; onClose: () => void
}) {
  return (
    <Sheet open={title !== null} title={title ?? ''} dismissOutside onClose={onClose}>
      {({ close, focusHeading }) => {
        const pick = (who: string) => () => {
          if (onPick(who)) focusHeading()
          else close()
        }
        const tiles = (list: PickPlayer[], off?: boolean) => (
          <ul className="picker-tiles">
            {list.map((p) => (
              <li key={p.playerId}>
                <button type="button" className="ui-button ui-secondary picker-tile" disabled={off} aria-pressed={chosen === undefined ? undefined : chosen === p.playerId} onClick={pick(p.playerId)}>
                  <span>{p.name}</span> <span className="meta">{[p.shirt, p.note].filter((x) => x != null && x !== '').join(' · ')}</span>
                </button>
              </li>
            ))}
          </ul>
        )
        return (
          <>
            {players && tiles(players)}
            {groups?.map((g) => (
              <section key={g.heading} aria-label={g.heading}>
                <h3 className="body-strong">{g.heading}</h3>
                {g.reason ? <p className="meta ui-reason">{g.reason}</p> : null}
                {tiles(g.players, !!g.reason)}
              </section>
            ))}
            {extras && (
              <div className="ui-sheet-actions">
                {extras.map((x) => (
                  <div key={x.value} className="picker-extra">
                    <button type="button" className="ui-button ui-secondary picker-tile" disabled={!!x.reason} aria-describedby={x.reason ? `reason-${x.value}` : undefined}
                      aria-pressed={chosen === undefined ? undefined : chosen === x.value} onClick={pick(x.value)}>
                      {x.label}
                    </button>
                    {x.reason && <p id={`reason-${x.value}`} className="meta ui-reason">{x.reason}</p>}
                  </div>
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
