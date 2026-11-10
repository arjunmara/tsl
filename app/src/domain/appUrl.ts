import { appUrlEnv } from './env'

// The one place links are built from: VITE_APP_URL if set, else this page's origin.
export function appUrl(): string {
  return (appUrlEnv || location.origin).replace(/\/+$/, '')
}

export function callbackUrl(): string {
  return appUrl() + '/auth/callback'
}

/** The link that opens a co-organiser invite. */
export function inviteUrl(token: string): string {
  return `${appUrl()}/invite/${token}`
}
