import { supabase } from './supabase'

/** What every command returns. code is null on success. */
export type CommandResult = { ok: boolean; code: string | null; message: string | null }

/**
 * Runs an `app` command. Pass the same commandId to retry the same command: the server returns
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
    const code = status === 0 || !navigator.onLine ? 'offline' : status === 401 || error.code === '42501' ? 'not_signed_in' : 'unknown'
    return { ok: false, code, message: error.message }
  } catch {
    return { ok: false, code: 'offline', message: null }
  }
}
