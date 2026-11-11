import { configure, hasPending, kick, myQueued, type Conflict, type Entry, type Upload } from '../outbox'
import { serverNow, syncClock } from './clock'
import { appVersion } from './env'
import { supabase } from './supabase'

// Features write only through send(): it queues on the device and replays in order (src/outbox).
export { discard, forgetRefused, resend, send, sendMine, useOutbox, whenEmpty, type Conflict, type Entry as OutboxEntry, type Upload } from '../outbox'

/**
 * What every command returns. code is null on success. A refused edit of a versioned row returns
 * code 'version_conflict' with conflict (the row now, who changed it and when); it is passed through as is.
 */
export type CommandResult = { ok: boolean; code: string | null; message: string | null; conflict?: Conflict; version?: number; uploadFailed?: true }

/**
 * Runs an `app` command. Only the outbox calls this; features use send(). Pass the same commandId to retry the same command: the server returns
 * the stored result instead of running it twice. enteredAt goes as the header x-entered-at: the server's deadline checks
 * count the change by it, within its grace window. Never throws.
 */
export async function runCommand(
  name: string,
  args: Record<string, unknown>,
  commandId: string = crypto.randomUUID(),
  enteredAt?: string,
): Promise<CommandResult> {
  try {
    const call = supabase.schema('app').rpc(name, { command_id: commandId, ...args })
    const { data, error, status } = await (enteredAt ? call.setHeader('x-entered-at', enteredAt) : call)
    if (!error) return data as CommandResult
    // postgrest-js reports a failed fetch as an error with status 0; no EXECUTE means the session is gone.
    // 5xx may have run (retry); any other 4xx is a definite refusal.
    const code = status === 0 || !navigator.onLine ? 'offline'
      : status === 401 || error.code === '42501' ? 'not_signed_in'
      : status >= 500 ? 'unknown' : 'request_failed'
    return { ok: false, code, message: error.message }
  } catch {
    return { ok: false, code: 'offline', message: null }
  }
}

/**
 * Uploads a queued file to Storage (upsert: a retry overwrites the same path; without upsert, a retry that finds the
 * file already there is done, since each path holds a fresh uuid). Never throws.
 */
async function uploadFile(u: Upload): Promise<CommandResult> {
  try {
    const { error } = await supabase.storage.from(u.bucket).upload(u.path, u.blob, { upsert: u.upsert ?? true, contentType: u.contentType })
    if (!error) return { ok: true, code: null, message: null }
    // Only a failed fetch is offline. Storage may answer an RLS refusal with HTTP 400 and statusCode "403" in the body.
    const e = error as { status?: number; statusCode?: string; originalError?: unknown }
    const status = e.status ?? 0
    const body = String(e.statusCode ?? '')
    if (u.upsert === false && (status === 409 || body === '409')) return { ok: true, code: null, message: null }
    const code = !navigator.onLine || e.originalError instanceof TypeError ? 'offline'
      : status === 401 || body === '401' ? 'not_signed_in'
        : status === 403 || body === '403' ? 'not_authorized'
          : status >= 500 ? 'unknown' : 'request_failed'
    return { ok: false, code, message: error.message }
  } catch (err) {
    return { ok: false, code: err instanceof TypeError || !navigator.onLine ? 'offline' : 'request_failed', message: null }
  }
}

/** This user's pending entries in one scope (a Tournament id), oldest first, including every send() already called. */
export const queuedFor = async (scope: string): Promise<Entry[]> =>
  (await myQueued()).filter((e) => e.scope === scope && e.state === 'pending')

const actor = async () => (await supabase.auth.getSession()).data.session?.user.id ?? null

/**
 * Starts the outbox once at app start: replays now (after the first clock sync, or 3 s at most), on sign-in
 * and when the signal comes back. The clock re-syncs on reconnect and whenever the page is shown again.
 */
export function startOutbox() {
  const ready = Promise.race([syncClock(), new Promise((r) => setTimeout(r, 3000))])
  configure({ run: runCommand, upload: uploadFile, actor, appVersion, now: serverNow, ready })
  // Every auth change (sign-in, token refresh, sign-out) re-reads the user and replays.
  // Deferred: supabase-js deadlocks if an auth call runs inside its own callback.
  supabase.auth.onAuthStateChange(() => void setTimeout(kick))
  window.addEventListener('online', () => {
    void syncClock()
    kick()
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void syncClock()
  })
}

/** True while the signed-in user has changes waiting to send. */
export const hasWaitingChanges = hasPending
