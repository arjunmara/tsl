import { useEffect, useState } from 'react'
import { serverNow } from '../../domain/clock'
import { elapsedAt, formatClock, type ClockState } from '../../domain/console'

/** The Match clock as mm:ss, redrawn four times a second from the server-corrected time. Not a live region: nothing announces it. */
export function Clock({ clock }: { clock: ClockState }) {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!clock.running) return
    const t = setInterval(() => tick((n) => n + 1), 250)
    return () => clearInterval(t)
  }, [clock.running])
  return <span className="clock-time" data-testid="clock">{formatClock(elapsedAt(clock, serverNow()))}</span>
}

/** Keeps the screen on while the console is open. The browser drops the lock when the page is hidden, so it is asked for again when shown. */
export function useWakeLock() {
  useEffect(() => {
    let lock: WakeLockSentinel | null = null
    let pending = false
    let gone = false
    const ask = async () => {
      if (gone || pending || document.visibilityState !== 'visible' || (lock && !lock.released)) return
      pending = true
      try {
        const got = (await navigator.wakeLock?.request('screen')) ?? null
        if (gone) void got?.release()
        else lock = got
      } catch {
        // No wake lock here (or refused): the screen may dim, the clock stays right.
      } finally {
        pending = false
      }
    }
    void ask()
    document.addEventListener('visibilitychange', ask)
    return () => {
      gone = true
      document.removeEventListener('visibilitychange', ask)
      void lock?.release()
    }
  }, [])
}
