import { appVersion } from './env'
import { supabase } from './supabase'

// Client errors go straight to the Postgres log via app.report_client_error (not the outbox), with no personal data.
const MAX = 5
let sent = 0

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const EMAIL = /[^\s@<>()[\]"',;:/]+@[^\s@<>()[\]"',;:/]+/g
// Phone numbers: 8+ digits, optionally grouped by single spaces, dashes or dots, optionally after a +.
const PHONE = /\+?\d(?:[\s.-]?\d){7,}/g

/** Emails, ids, phone numbers and any run of 6+ digits replaced by [removed]. */
export const scrubText = (m: string) =>
  m.replace(EMAIL, '[removed]').replace(UUID, '[removed]').replace(PHONE, '[removed]').replace(/\d{6,}/g, '[removed]')
/** The path with every UUID segment as :id and every other segment scrubbed; no query or hash. */
export const scrubRoute = (path: string) =>
  path.split('/').map((s) => (/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(s) ? ':id' : scrubText(s))).join('/')

/** The first stack frame as file:line (path only, scrubbed); never the message. */
function firstFrame(stack: string | undefined): string {
  for (const line of (stack ?? '').split('\n').slice(1)) {
    const m = /(?:https?:\/\/[^/\s]+)?(\/[^\s():]*):(\d+):\d+/.exec(line)
    if (m) return `${scrubRoute(m[1] ?? '')}:${m[2]}`
  }
  return ''
}

/** Sends one error report; at most 5 per page load. Never throws. */
export function reportError(err: unknown) {
  try {
    if (sent >= MAX) return
    sent++
    const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : 'Non-Error thrown')
    void Promise.resolve(supabase.schema('app').rpc('report_client_error', {
      app_version: appVersion,
      route: scrubRoute(location.pathname),
      error_name: scrubText(String(e.name)),
      message: scrubText(String(e.message)),
      frame: err instanceof Error ? firstFrame(e.stack) : '',
    })).catch(() => {})
  } catch {
    // Reporting must never cause another error.
  }
}

/** Reports uncaught errors and unhandled rejections. Called once at app start. */
export function startReporting() {
  window.addEventListener('error', (e) => {
    // A cross-origin script's error carries nothing useful; it doesn't count.
    if (!e.error && e.message === 'Script error.') return
    reportError(e.error ?? e.message)
  })
  window.addEventListener('unhandledrejection', (e) => reportError(e.reason))
}
