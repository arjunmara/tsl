// The only place that reads the build environment.
export const supabaseUrl: string = import.meta.env.VITE_SUPABASE_URL ?? ''
export const supabasePublishableKey: string = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? ''

/** Project ref (first label of the URL host), or null for an empty or malformed URL. */
export function refFromUrl(url: string): string | null {
  if (!url) return null
  try {
    return new URL(url).hostname.split('.')[0] || null
  } catch {
    return null
  }
}

export function databaseRef(): string | null {
  return refFromUrl(supabaseUrl)
}

export const turnstileSiteKey: string = import.meta.env.VITE_TURNSTILE_SITE_KEY ?? ''
/** Optional fixed base for links in emails; empty means the page's own origin (see appUrl.ts). */
export const appUrlEnv: string = import.meta.env.VITE_APP_URL ?? ''
/** package.json version, recorded on every outbox entry. */
export const appVersion: string = __APP_VERSION__
