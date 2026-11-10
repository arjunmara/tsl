import { isAuthError, isAuthRetryableFetchError, type EmailOtpType } from '@supabase/supabase-js'
import { callbackUrl } from './appUrl'
import { messages, type MessageCode } from './messages'
import { supabase } from './supabase'

export type Session = { id: string; email: string; verified: boolean }
/** null on success; otherwise the code and its plain-English message. */
export type AuthFailure = { code: MessageCode; message: string } | null

// Supabase codes that share a message.
const alias: Record<string, MessageCode> = {
  email_exists: 'user_already_exists',
  session_not_found: 'session_missing',
  flow_state_expired: 'otp_expired',
  flow_state_not_found: 'otp_expired',
}

function fail(error: unknown): AuthFailure {
  if (!error) return null
  let code: MessageCode = 'unknown'
  if (isAuthRetryableFetchError(error) || !navigator.onLine) code = 'offline'
  else if (isAuthError(error)) {
    const raw = error.code ?? ''
    if (raw in messages) code = raw as MessageCode
    else if (raw in alias) code = alias[raw]!
    else if (error.name === 'AuthSessionMissingError') code = 'session_missing'
  }
  return { code, message: messages[code] }
}

// Supabase returns errors rather than throwing, except for network failures in some paths.
async function run(call: () => Promise<{ error: unknown }>): Promise<AuthFailure> {
  try {
    return fail((await call()).error)
  } catch (e) {
    return fail(e)
  }
}

const redirect = () => ({ emailRedirectTo: callbackUrl() })

export async function signUp(email: string, password: string, captchaToken: string): Promise<AuthFailure> {
  let exists = false
  const failure = await run(async () => {
    const r = await supabase.auth.signUp({ email, password, options: { ...redirect(), captchaToken: captchaToken || undefined } })
    // An already-confirmed email comes back as a user with no identities and no error.
    exists = !r.error && r.data.user?.identities?.length === 0
    return r
  })
  return failure ?? (exists ? { code: 'user_already_exists', message: messages.user_already_exists } : null)
}

export const verifyEmailOtp = (email: string, code: string) =>
  run(() => supabase.auth.verifyOtp({ email, token: code, type: 'signup' }))

// captchaToken: needed when CAPTCHA protection is on in Supabase, which also guards resend, sign-in and reset.
export const resendSignupCode = (email: string, captchaToken?: string) =>
  run(() => supabase.auth.resend({ type: 'signup', email, options: { ...redirect(), captchaToken: captchaToken || undefined } }))

export const signIn = (email: string, password: string, captchaToken?: string) =>
  run(() => supabase.auth.signInWithPassword({ email, password, options: { captchaToken: captchaToken || undefined } }))

/**
 * Emails a sign-in code (and link) to email. create: make the account if the email has none (an invite); Supabase then
 * sends its Confirm signup email, else its Magic Link email. Guarded by CAPTCHA like sign-in.
 */
export const emailSignInCode = (email: string, create: boolean, captchaToken?: string) =>
  run(() => supabase.auth.signInWithOtp({ email, options: { ...redirect(), shouldCreateUser: create, captchaToken: captchaToken || undefined } }))

/** Signs in with the emailed code; this also marks the email verified. */
export const verifySignInCode = (email: string, code: string) =>
  run(() => supabase.auth.verifyOtp({ email, token: code, type: 'email' }))

export const requestPasswordReset = (email: string, captchaToken?: string) =>
  run(() => supabase.auth.resetPasswordForEmail(email, { redirectTo: callbackUrl(), captchaToken: captchaToken || undefined }))

export const verifyRecoveryOtp = (email: string, code: string) =>
  run(() => supabase.auth.verifyOtp({ email, token: code, type: 'recovery' }))

export const setNewPassword = (password: string) => run(() => supabase.auth.updateUser({ password }))

export type LinkType = 'signup' | 'email' | 'recovery'
export const isLinkType = (t: string | null): t is LinkType => t === 'signup' || t === 'email' || t === 'recovery'

/** The emailed link: /auth/callback?token_hash=…&type=… */
export const verifyLink = (tokenHash: string, type: LinkType) =>
  run(() => supabase.auth.verifyOtp({ token_hash: tokenHash, type: type as EmailOtpType }))

/** Re-reads the session from the server: has the email been verified (e.g. via the link on another device)? */
export async function checkVerified(): Promise<'verified' | 'unverified' | 'none'> {
  try {
    if (!(await supabase.auth.getSession()).data.session) return 'none'
    const { data } = await supabase.auth.refreshSession()
    if (!data.user) return 'none'
    return data.user.email_confirmed_at ? 'verified' : 'unverified'
  } catch {
    return 'none'
  }
}

export const signOut = () => run(() => supabase.auth.signOut({ scope: 'local' }))

/** A Registration link's Team-manager session: anonymous, no account, guarded by CAPTCHA like sign-in (AD-19). */
export const signInAnonymously = (captchaToken?: string) =>
  run(() => supabase.auth.signInAnonymously({ options: { captchaToken: captchaToken || undefined } }))

/** True when this page has a stored session (it may be anonymous). */
export const hasSession = async () => !!(await supabase.auth.getSession()).data.session

/** Calls cb with the current session now and on every change; returns the unsubscribe. */
export function onSession(cb: (s: Session | null) => void): () => void {
  const { data } = supabase.auth.onAuthStateChange((_event, s) => {
    cb(s?.user ? { id: s.user.id, email: s.user.email ?? '', verified: !!s.user.email_confirmed_at } : null)
  })
  return () => data.subscription.unsubscribe()
}
