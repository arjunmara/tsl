import { db } from './db'

export type Result = { ok: boolean; code: string | null; message: string | null }
export type Config = {
  run: (name: string, args: Record<string, unknown>, commandId: string) => Promise<Result>
  /** The signed-in user's id, or null. */
  actor: () => Promise<string | null>
  appVersion: string
  now: () => Date
}

export const QUEUED: Result = { ok: false, code: 'queued', message: null }
// The command may not have run (or its answer was lost): keep it and try again later.
// not_signed_in: kept until the session is back (sign-in or token refresh kicks a pass).
const RETRY = new Set(['offline', 'unknown', 'in_progress', 'not_signed_in'])

let config: Config | null = null
export const setConfig = (c: Config) => void (config = c)
export const getConfig = () => config

// send() promises, by seq: settled with the server's answer, or QUEUED when a pass ends without one.
const waiters = new Map<number, (r: Result) => void>()
export const waitFor = (seq: number) => new Promise<Result>((resolve) => waiters.set(seq, resolve))
function settle(seq: number, r: Result) {
  waiters.get(seq)?.(r)
  waiters.delete(seq)
}
const settleAll = () => [...waiters.keys()].forEach((seq) => settle(seq, QUEUED))

type Listeners = { sending: (sending: boolean) => void; actor: (id: string | null) => void }
let on: Listeners = { sending: () => {}, actor: () => {} }
export const setListeners = (l: Listeners) => void (on = l)

/** One pass over the queue, in seq order. 'retry' when a network-type failure stopped it. */
async function pass(): Promise<'done' | 'retry'> {
  const me = config && (await config.actor())
  on.actor(me ?? null)
  if (!config || !me) return (settleAll(), 'done')
  const all = await db.entries.orderBy('seq').toArray()
  const stopped = new Set(all.filter((e) => e.state === 'failed').map((e) => e.scope))
  for (const e of all) {
    // Other users' entries wait untouched; a failed entry holds back the rest of its scope.
    if (e.state !== 'pending' || e.actor !== me || stopped.has(e.scope)) {
      settle(e.seq, QUEUED)
      continue
    }
    await db.entries.update(e.seq, { attempts: e.attempts + 1 })
    on.sending(true)
    const r = await config.run(e.name, e.args, e.commandId).finally(() => on.sending(false))
    if (r.ok) {
      await db.entries.delete(e.seq)
      settle(e.seq, r)
    } else if (RETRY.has(r.code ?? '')) {
      settleAll() // this and every later entry stays queued
      return 'retry'
    } else {
      await db.entries.update(e.seq, { state: 'failed', code: r.code ?? 'unknown' })
      stopped.add(e.scope)
      settle(e.seq, r)
    }
  }
  return 'done'
}

// Tabs share one queue: the Web Lock keeps passes from overlapping across tabs.
const locked = (fn: () => Promise<'done' | 'retry'>) =>
  navigator.locks ? navigator.locks.request('tsl-outbox', fn) : fn()

let running = false
let again = false
let delay = 0
let timer: ReturnType<typeof setTimeout> | undefined

/** Starts a pass now (or right after the current one). Backs off 2 s, 4 s … 60 s after network failures. */
export function kick() {
  clearTimeout(timer)
  if (running) return void (again = true)
  running = true
  void (async () => {
    let r: 'done' | 'retry'
    try {
      do {
        again = false
        r = await locked(pass)
      } while (again)
    } catch {
      r = 'retry'
    } finally {
      running = false
    }
    settleAll()
    if (r === 'retry') {
      delay = Math.min(delay ? delay * 2 : 2000, 60000)
      timer = setTimeout(kick, delay)
    } else delay = 0
  })()
}
