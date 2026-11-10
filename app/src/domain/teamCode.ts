// Pure helpers for Teams (Story 2.1), with no Supabase import so `npm run check:teams` can test them in Node.

/** A Team code: 2–5 upper-case letters or digits (app.team's check). */
export const CODE = /^[A-Z0-9]{2,5}$/

/**
 * A Team code suggested from its name: each word's first letter, a number kept whole ("14 Star Youth Club" → 14SYC),
 * at most 5; fewer than 2 → the first 3 letters or digits. A taken code gets its last character replaced by 2–9.
 * '' when the name has fewer than 2 Latin letters or digits.
 */
export function suggestCode(name: string, taken: Iterable<string> = []): string {
  const words = name.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean)
  let code = words.map((w) => (/^\d+$/.test(w) ? w : w[0])).join('').slice(0, 5)
  if (code.length < 2) code = words.join('').slice(0, 3)
  if (code.length < 2) return ''
  const used = new Set(taken)
  for (let d = 2; used.has(code) && d <= 9; d++) code = code.slice(0, -1) + d
  return code
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')

/**
 * A new Registration link token: 256 random bits as base64url (43 characters), and its SHA-256 as 64 lower-case hex.
 * Only the hash goes to the server (AD-19); 2.2 looks a token up by sha256(convert_to(token, 'UTF8')).
 */
export async function newLink(): Promise<{ token: string; hash: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return { token, hash: hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))) }
}
