import { useSyncExternalStore } from 'react'

/** What the Save status is beside: null (a page), 'console' (a scoring console) or 'on-air' (the console of the On-air Match; Story 4.7). */
export type ConsoleMode = 'console' | 'on-air' | null
let mode: ConsoleMode = null
const listeners = new Set<() => void>()
export const setConsoleMode = (m: ConsoleMode) => {
  if (m === mode) return
  mode = m
  listeners.forEach((l) => l())
}
export const useConsoleMode = () => useSyncExternalStore((l) => (listeners.add(l), () => void listeners.delete(l)), () => mode)
