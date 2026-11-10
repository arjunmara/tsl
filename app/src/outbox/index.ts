import { liveQuery } from 'dexie'
import { useSyncExternalStore } from 'react'
import { db, type Conflict, type Entry } from './db'
import { getConfig, kick, setConfig, setListeners, waitFor, type Config, type Result } from './replay'

export type { Conflict, Entry, Result }
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

// Hand-back: the user's choice for a refused (failed or conflict) entry. Nothing else drops an entry.

/**
 * "Try sending again": the same command and args, back in the queue in the same place, under a new command id
 * (the server stores the refusal under the old one and would only repeat it).
 */
export async function resend(seq: number) {
  await db.entries.where('seq').equals(seq).modify((e) => {
    if (e.state === 'pending') return
    e.commandId = crypto.randomUUID()
    e.state = 'pending'
    e.attempts = 0
    delete e.code
    delete e.conflict
  })
  kick()
}

/**
 * "Send my version" on a conflict: the same command and args with expected_version = the server's current version,
 * under a new command id (the old one has its refusal stored). Keeps the entry's place in the queue.
 */
export async function sendMine(seq: number) {
  await db.entries.where('seq').equals(seq).modify((e) => {
    if (e.state !== 'conflict' || !e.conflict) return
    e.args = { ...e.args, expected_version: e.conflict.current_version }
    e.commandId = crypto.randomUUID()
    e.state = 'pending'
    e.attempts = 0
    delete e.code
    delete e.conflict
  })
  kick()
}

/**
 * Drops a refused entry and queues the logged discard_command for it, in one step. Each discard has its own
 * scope, so one that gets stuck never holds back another.
 */
export async function discard(seq: number, reason: string) {
  const config = getConfig()
  await db.transaction('rw', db.entries, async () => {
    const e = await db.entries.get(seq)
    if (!e || e.state === 'pending') return
    await db.entries.add({
      commandId: crypto.randomUUID(), name: 'discard_command',
      args: { discarded_id: e.commandId, name: e.name, scope: e.scope, reason },
      scope: `discard:${e.commandId}`, actor: e.actor, appVersion: config?.appVersion ?? e.appVersion,
      enteredAt: (config?.now() ?? new Date()).toISOString(), state: 'pending', attempts: 0,
    })
    await db.entries.delete(seq)
  })
  kick()
}

/** Removes a refused (failed or conflict) entry whose refusal the caller has already shown (e.g. on the form that sent it). */
export const forgetRefused = (commandId: string) =>
  db.entries.filter((e) => e.commandId === commandId && e.state !== 'pending').delete()

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

/** The signed-in user's queued entries and whether a send is in flight. */
export function useOutbox() {
  const s = useSyncExternalStore(subscribe, () => snap)
  return { entries: s.mine, sending: s.sending }
}
