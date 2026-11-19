import type { ScoringState } from '../../domain/console'
import { messages } from '../../domain/messages'
import { PrimaryButton, SecondaryButton } from '../../ui/Button'
import { Sheet } from '../../ui/Sheet'

/** The read-only console's top (Story 4.8): who is scoring, and how to ask for it (a Scorer phone) or take it (an Organiser). */
export function Following({ st, scorer, canAsk, busy, onAsk, onTake }: { st: ScoringState | null; scorer: boolean; canAsk: boolean; busy: boolean; onAsk: () => void; onTake: () => void }) {
  const who = st ? st.holderLabel ?? "an organiser's phone" : null
  const ask = st?.request?.status
  return (
    <section className="handover-follow" aria-label="Who is scoring">
      <p className="body-strong" role="status">{who ? `Scoring on ${who}.` : 'Another phone is scoring this match.'}</p>
      {scorer && ask === 'pending' && <p className="body" role="status">Waiting for an organiser to approve.</p>}
      {scorer && ask === 'expired' && <p className="body" role="status">This request expired.</p>}
      {scorer && ask === 'declined' && <p className="body" role="status">The organiser said no. {who} keeps scoring.</p>}
      {canAsk && scorer && ask !== 'pending' && (busy
        ? <PrimaryButton label={ask === 'expired' ? 'Ask again to take over' : 'Ask to take over'} disabled disabledReason="Asking…" />
        : <PrimaryButton label={ask === 'expired' ? 'Ask again to take over' : 'Ask to take over'} onClick={onAsk} />)}
      {canAsk && !scorer && <PrimaryButton label="Take over scoring" onClick={busy ? undefined : onTake} />}
    </section>
  )
}

/** The holder's sheet: the Season's other approved Scorer phones. Disabled with its reason while this phone has changes waiting to send. */
export function HandOverSheet({ open, devices, blocked, onPick, onClose }: {
  open: boolean; devices: ScoringState['devices']; blocked: boolean; onPick: (deviceId: string) => void; onClose: () => void
}) {
  return (
    <Sheet open={open} title="Hand over scoring" dismissOutside onClose={onClose}>
      {({ close }) => (
        <>
          {blocked && <p className="meta ui-reason">{messages.handover_waiting}</p>}
          {!devices.length && <p className="body">No other approved Scorer phone in this Season.</p>}
          <ul className="picker-tiles">
            {devices.map((d) => (
              <li key={d.id}>
                <button type="button" className="ui-button ui-secondary picker-tile" disabled={blocked} onClick={() => (onPick(d.id), close())}>Hand over to {d.label}</button>
              </li>
            ))}
          </ul>
          <div className="ui-sheet-actions"><SecondaryButton label="Cancel" onClick={close} /></div>
        </>
      )}
    </Sheet>
  )
}
