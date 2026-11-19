import { useEffect, useState } from 'react'
import { useParams } from 'react-router'
import { answerTakeOver, matchesToday, readTakeovers, type TakeoverAsk } from '../../domain/console'
import { messageFor, messages } from '../../domain/messages'
import { PrimaryButton, SecondaryButton } from '../../ui/Button'
import { Problem } from '../auth/Screen'
import { UUID } from '../setup/Setup'

const POLL_MS = 3000
// Whether the Tournament has a live Match or one scheduled today is looked up again after this long, not on every poll. Polling pauses while the tab is hidden.
const CHECK_MS = 15_000

/**
 * The Organiser's prompt (Story 4.8): a Scorer phone asks to take over scoring. Shown in every Organiser page of a Tournament, console included.
 * Polls every 3 s, and only while the Tournament has a live Match or one scheduled today. Answering needs a signal and is never queued.
 */
export function TakeoverPrompt() {
  const { tournamentId = '' } = useParams()
  const [asks, setAsks] = useState<TakeoverAsk[]>([])
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!UUID.test(tournamentId)) return
    let live = true
    let timer: ReturnType<typeof setTimeout>
    let needed = false
    let checked = 0
    let busy = false
    const tick = async () => {
      if (busy) return
      busy = true
      if (navigator.onLine && !document.hidden) {
        if (Date.now() - checked > CHECK_MS) {
          needed = (await matchesToday(tournamentId)) ?? needed
          checked = Date.now()
        }
        const a = needed ? await readTakeovers(tournamentId) : []
        if (live && a) setAsks(a)
      }
      busy = false
      if (live) timer = setTimeout(() => void tick(), POLL_MS)
    }
    // Back on screen: an immediate read.
    const shown = () => {
      if (!document.hidden) {
        clearTimeout(timer)
        void tick()
      }
    }
    document.addEventListener('visibilitychange', shown)
    void tick()
    return () => {
      live = false
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', shown)
    }
  }, [tournamentId])

  const ask = asks[0]
  if (!ask && !problem) return null
  async function answer(approve: boolean) {
    if (!ask || busy) return
    setBusy(true)
    setProblem(null)
    const r = await answerTakeOver(ask.seasonId, ask.id, approve)
    setBusy(false)
    if (r.ok || r.code === 'request_expired' || r.code === 'request_missing' || r.code === 'request_answered') setAsks((x) => x.filter((y) => y.id !== ask.id))
    if (!r.ok) {
      setProblem(r.code === 'offline' ? messages.move_offline : r.code === 'request_expired' ? messages.takeover_expired : messageFor(r.code))
      // A refusal of an ask that is already gone stays on screen only for a moment.
      if (r.code === 'request_expired' || r.code === 'request_missing' || r.code === 'request_answered') setTimeout(() => setProblem(null), 6000)
    }
  }
  const holder = ask?.holderLabel ?? "an organiser's phone"
  const match = ask?.homeCode && ask.awayCode ? `${ask.homeCode} v ${ask.awayCode}` : 'a match'
  return (
    <aside className="card takeover-prompt" aria-label="Request to take over scoring" role="alert">
      {ask && <p className="body-strong">{ask.label} asks to take over scoring of {match} from {holder}.</p>}
      <Problem text={problem} />
      {ask && (
        <div className="takeover-actions">
          <PrimaryButton label={`Let ${ask.label} score`} onClick={() => void answer(true)} />
          <SecondaryButton label={`Keep ${holder}`} onClick={() => void answer(false)} />
        </div>
      )}
    </aside>
  )
}
