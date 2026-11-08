import { useSyncExternalStore } from 'react'

function subscribe(cb: () => void) {
  window.addEventListener('online', cb)
  window.addEventListener('offline', cb)
  return () => {
    window.removeEventListener('online', cb)
    window.removeEventListener('offline', cb)
  }
}
/** navigator.onLine, re-rendering on change. */
export const useOnline = () => useSyncExternalStore(subscribe, () => navigator.onLine)
