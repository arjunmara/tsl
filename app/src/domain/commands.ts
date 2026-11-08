import { configure, hasPending, kick } from '../outbox'
import { serverNow } from './clock'
import { appVersion } from './env'
import { supabase } from './supabase'

// Features write only through send(): it queues on the device and replays in order (src/outbox).
export { forgetRefused, send, useOutbox, whenEmpty, type Entry as OutboxEntry } from '../outbox'

/** What every command returns. code is null on success. */
export type CommandResult = { ok: boolean; code: string | null; message: string | null }

/**
 * Runs an `app` command. Only the outbox calls this; features use send(). Pass the same commandId to retry the same command: the server returns
 * the stored result instead of running it twice. Never throws.
 */
export async function runCommand(
  name: string,
  args: Record<string, unknown>,
  commandId: string = crypto.randomUUID(),
): Promise<CommandResult> {
  try {
    const { data, error, status } = await supabase.schema('app').rpc(name, { command_id: commandId, ...args })
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

const actor = async () => (await supabase.auth.getSession()).data.session?.user.id ?? null

/** Starts the outbox once at app start: replays now, on sign-in and when the signal comes back. */
export function startOutbox() {
  configure({ run: runCommand, actor, appVersion, now: serverNow })
  // Every auth change (sign-in, token refresh, sign-out) re-reads the user and replays.
  // Deferred: supabase-js deadlocks if an auth call runs inside its own callback.
  supabase.auth.onAuthStateChange(() => void setTimeout(kick))
  window.addEventListener('online', kick)
}

/** True while the signed-in user has changes waiting to send. */
export const hasWaitingChanges = hasPending
