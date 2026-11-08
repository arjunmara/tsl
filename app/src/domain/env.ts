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
