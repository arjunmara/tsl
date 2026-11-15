import { runCommand, type CommandResult } from './commands'
import { appUrl } from './appUrl'
import { supabase } from './supabase'
import { sha256Hex } from './teamCode'

// Scorer link and number-matching approval (Story 4.1, FR-3). A phone asks through the Season's Scorer link; the Organiser
// taps the number the phone shows.

/** The link a Scorer opens: the token in the fragment, so it never reaches server logs or Referer headers. */
export const scorerUrl = (token: string) => `${appUrl()}/score#${token}`

/** A phone's own latest request, as app.scorer_status() answers; 'expired' is a pending request past its 10 minutes. */
export type PhoneStatus = { id: string; seasonId: string; status: 'pending' | 'expired' | 'approved' | 'rejected' | 'revoked'; label: string; expiresAt: string }

/** Asks to be a Scorer through the token's link. ok with status 'approved': this phone already is. Never throws. */
export const requestApproval = (token: string, label: string): Promise<CommandResult & { device_id?: string; number?: number; expires_at?: string; status?: string }> =>
  runCommand('request_scorer_approval', { token, label })

/** This phone's own requests, newest first; { code } when the server can't be reached. */
export async function phoneStatus(): Promise<PhoneStatus[] | { code: 'offline' | 'unknown' }> {
  try {
    const { data, error, status } = await supabase.schema('app').rpc('scorer_status')
    if (error) return { code: status === 0 || !navigator.onLine ? 'offline' : 'unknown' }
    return (data as { id: string; season_id: string; status: PhoneStatus['status']; label: string; expires_at: string }[])
      .map((r) => ({ id: r.id, seasonId: r.season_id, status: r.status, label: r.label, expiresAt: r.expires_at }))
  } catch {
    return { code: 'offline' }
  }
}

// The request this phone made through a link, kept per token: another Season's link never shows this one's answer.
const deviceKey = (token: string) => `tsl-scorer-device:${token}`
export function keepDevice(token: string, id: string) {
  try {
    localStorage.setItem(deviceKey(token), id)
  } catch {
    // Blocked storage: the phone asks again after a reload.
  }
}
export function keptDevice(token: string): string | null {
  try {
    return localStorage.getItem(deviceKey(token))
  } catch {
    return null
  }
}

// The number a phone was given, kept on it: the server keeps only a hash, so a reload could not show it again.
const numberKey = 'tsl-scorer-number'
export function keepNumber(id: string, number: number) {
  try {
    localStorage.setItem(numberKey, JSON.stringify({ id, number }))
  } catch {
    // Blocked storage: after a reload the phone asks again.
  }
}
export function keptNumber(id: string): number | null {
  try {
    const k = JSON.parse(localStorage.getItem(numberKey) ?? 'null') as { id: string; number: number } | null
    return k?.id === id ? k.number : null
  } catch {
    return null
  }
}

/** A Scorer phone as the Organiser reads it. numberHash only while pending. */
export type Device = { id: string; label: string; status: 'pending' | 'approved' | 'rejected' | 'revoked'; expiresAt: string; numberHash: string }
/** hash: the live Scorer link's token hash (null: none). */
export type ScorerData = { hash: string | null; devices: Device[] }

/** The Season's Scorer link state and phones, newest first. */
export async function scorerData(seasonId: string): Promise<ScorerData | { code: 'offline' | 'unknown' }> {
  try {
    const app = supabase.schema('app')
    const [s, d] = await Promise.all([
      app.from('season').select('scorer_token_hash').eq('id', seasonId),
      app.from('scorer_device').select('id, label, status, expires_at, number_hash').eq('season_id', seasonId).order('created_at', { ascending: false }),
    ])
    if (s.error || d.error) return { code: [s.error, d.error].some((e) => e && !navigator.onLine) ? 'offline' : 'unknown' }
    const rows = d.data as { id: string; label: string; status: Device['status']; expires_at: string; number_hash: string }[]
    return {
      hash: (s.data as { scorer_token_hash: string | null }[])[0]?.scorer_token_hash ?? null,
      devices: rows.map((r) => ({ id: r.id, label: r.label, status: r.status, expiresAt: r.expires_at, numberHash: r.number_hash })),
    }
  } catch {
    return { code: 'offline' }
  }
}

/** The number a request was given: the server keeps sha256("<id>:<number>"), and the numbers are 10 to 99. */
export async function rightNumber(device: Device): Promise<number | null> {
  for (let n = 10; n <= 99; n++) if ((await sha256Hex(`${device.id}:${n}`)) === device.numberHash) return n
  return null
}

/** The right number and two others, in random order. */
export function numberChoices(right: number): number[] {
  const all = [right]
  while (all.length < 3) {
    const n = 10 + Math.floor(Math.random() * 90)
    if (!all.includes(n)) all.push(n)
  }
  return all.sort(() => Math.random() - 0.5)
}
