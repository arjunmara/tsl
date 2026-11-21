import { useEffect, useRef, useState } from 'react'
import { playerGraphics, type PlayerData } from '../../domain/graphics'
import type { Match } from '../../domain/matches'
import { messages } from '../../domain/messages'
import { SecondaryButton } from '../../ui/Button'
import { Problem } from '../auth/Screen'
import { PlayerCard } from './GraphicCard'

/** The Player Graphic cards of a finished Match (Story 5.3): one per goal in minute order, then Man of the Match and Fair Player when set. Story 5.4 groups them into the Post-match pack. */
export function PlayerGraphics({ tournamentId, seasonId, match }: { tournamentId: string; seasonId: string; match: Match }) {
  const [list, setList] = useState<PlayerData[]>([])
  const [problem, setProblem] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const shown = useRef('')
  useEffect(() => {
    let live = true
    void playerGraphics(tournamentId, seasonId, match).then((r) => {
      if (!live) return
      if ('code' in r) return setProblem(r.code === 'offline' ? messages.offline : messages.graphic_failed)
      setProblem(null)
      // Signing makes a new URL every read: only changed content (the cut-out aside) needs new PNGs.
      const k = JSON.stringify(r.map((d) => ({ ...d, cutout: !!d.cutout })))
      if (k === shown.current) return
      shown.current = k
      setList(r)
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read again when the Match changes, not on every new object
  }, [tournamentId, seasonId, match.id, match.version, match.hg, match.ag, match.homePens, match.awayPens, match.kickOff, attempt])
  return (
    <>
      {list.map((d, i) => <PlayerCard key={i} data={d} onRetry={() => (shown.current = '', setAttempt((n) => n + 1))} />)}
      <Problem text={problem} />
      {problem && <SecondaryButton label="Try loading the player graphics again" onClick={() => setAttempt((n) => n + 1)} />}
    </>
  )
}
