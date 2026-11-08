interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string
  readonly VITE_TURNSTILE_SITE_KEY?: string
  readonly VITE_APP_URL?: string
}

/** package.json version, set by vite.config.ts. */
declare const __APP_VERSION__: string
