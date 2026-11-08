import { registerSW } from 'virtual:pwa-register'
import { hasWaitingChanges, startOutbox, whenEmpty } from '../../domain/commands'

/** Once at app start: replay of queued changes, the leave warning, and the service-worker update gate. */
export function start() {
  startOutbox()
  // Closing the tab with changes still on this device: ask first.
  window.addEventListener('beforeunload', (e) => {
    if (!hasWaitingChanges()) return
    e.preventDefault()
    e.returnValue = ''
  })
  // A new version activates (and reloads the page) only once every waiting change has been sent, and
  // only while the page is hidden, or right at app start, so the reload never wipes a half-typed field.
  const waitingAtStart = navigator.serviceWorker?.getRegistration().then((r) => !!r?.waiting, () => false) ?? Promise.resolve(false)
  const updateSW = registerSW({
    onNeedRefresh: () => void waitingAtStart.then((atStart) => {
      const recheck = whenEmpty(() => void updateSW(true), () => atStart || document.visibilityState === 'hidden')
      document.addEventListener('visibilitychange', recheck)
    }),
  })
}
