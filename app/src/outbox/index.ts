import { liveQuery } from 'dexie'
import { useSyncExternalStore } from 'react'
import { db, type Entry } from './db'
import { getConfig, kick, setConfig, setListeners, waitFor, type Config, type Result } from './replay'

export type { Entry, Result }
export { kick }

// entries: everyone's; mine: the signed-in user's (me undefined until the first pass has asked).
type Snapshot = { entries: Entry[]; me: string | null | undefined; mine: Entry[]; sending: boolean; ready: boolean }
let snap: Snapshot = { entries: [], me: undefined, mine: [], sending: false, ready: false }
const listeners = new Set<() => void>()
function set(change: Partial<Snapshot>) {
  snap = { ...snap, ...change }
  snap.mine = snap.entries.filter((e) => e.actor === snap.me)
  listeners.forEach((l) => l())
}
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l))

setListeners({ sending: (sending) => set({ sending }), actor: (me) => me !== snap.me && set({ me }) })
// Follows the table, including changes made in other tabs.
liveQuery(() => db.entries.orderBy('seq').toArray()).subscribe({
  next: (entries) => set({ entries, ready: true }),
  error: () => set({ ready: true }),
})

let configured: () => void
const isConfigured = new Promise<void>((r) => (configured = r))

/** Wires the outbox to the server (called once by domain at start-up) and starts a pass. */
export function configure(config: Config) {
  setConfig(config)
  configured()
  kick()
}

/**
 * Queues a command for the signed-in user and starts sending. Resolves with the server's answer for it, or
 * { ok: false, code: 'queued' } when the first attempt couldn't reach the server (it stays queued).
 */
export async function send(
  name: string, args: Record<string, unknown>, opts: { scope: string; confirmed?: true },
): Promise<Result & { commandId?: string }> {
  await isConfigured
  const config = getConfig()!
  const actor = await config.actor()
  if (!actor) return { ok: false, code: 'not_signed_in', message: null }
  const commandId = crypto.randomUUID()
  let seq: number
  try {
    seq = await db.entries.add({
      commandId, name, args, scope: opts.scope, actor, appVersion: config.appVersion, enteredAt: config.now().toISOString(),
      ...(opts.confirmed ? { confirmed: true as const } : {}), state: 'pending', attempts: 0,
    })
  } catch {
    // ponytail: no IndexedDB (blocked storage): send directly, nothing survives a tab close.
    return config.run(name, args, commandId)
  }
  const answer = waitFor(seq)
  kick()
  return { ...(await answer), commandId }
}

/** Puts this user's failed entries back in the queue (same command ids) and sends them. */
export async function retry() {
  const me = snap.me
  await db.entries.filter((e) => e.state === 'failed' && e.actor === me).modify((e) => {
    e.state = 'pending'
    delete e.code
  })
  kick()
}

/** Removes a refused entry whose refusal the caller has already shown (e.g. on the form that sent it). */
export const forgetRefused = (commandId: string) =>
  db.entries.filter((e) => e.commandId === commandId && e.state === 'failed').delete()

const idle = () => snap.ready && snap.me !== undefined && !snap.mine.some((e) => e.state === 'pending')
/** True while the signed-in user has changes waiting to send. */
export const hasPending = () => snap.mine.some((e) => e.state === 'pending')

/**
 * Calls cb once, when this user has nothing pending and ok() holds. Re-checked on every outbox change;
 * call the returned function to re-check after something ok() depends on changes.
 */
export function whenEmpty(cb: () => void, ok: () => boolean = () => true): () => void {
  let done = false
  const check = () => {
    if (done || !idle() || !ok()) return
    done = true
    off()
    cb()
  }
  const off = subscribe(check)
  check()
  return check
}

/** The signed-in user's queued entries, whether a send is in flight, and retry. */
export function useOutbox() {
  const s = useSyncExternalStore(subscribe, () => snap)
  return { entries: s.mine, sending: s.sending, retry }
}
