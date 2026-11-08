// Every failure text the app shows, in plain English. One map, keyed by code.
export const messages = {
  invalid_credentials: 'Email or password is wrong.',
  otp_expired: "That code didn't work or has expired.",
  email_not_confirmed: 'Confirm your email first. Enter the code we sent you.',
  offline: "Can't reach the server. Check your signal and try again.",
  offline_banner: "Can't reach the server. Showing what's on this phone.",
  captcha_failed: "The robot check didn't pass. Try again.",
  captcha_needed: 'Complete the check above.',
  captcha_wait: "Checking you're not a robot…",
  weak_password: 'Use at least 8 characters.',
  same_password: 'Choose a password different from your old one.',
  user_already_exists: 'An account with this email already exists.',
  not_verified_yet: 'Your email is not verified yet. Enter the code or tap the link in the email.',
  email_address_invalid: "That email address doesn't look right.",
  over_email_send_rate_limit: 'Too many emails sent. Wait a few minutes, then try again.',
  over_request_rate_limit: 'Too many tries. Wait a few minutes, then try again.',
  session_missing: 'Your reset session has ended. Ask for a new code.',
  bad_link: "That link didn't work or has expired.",
  captcha_load: "Couldn't load the check. Reload the page.",
  unknown: 'Something went wrong. Try again.',
  // Commands
  not_signed_in: 'You are signed out. Sign in again, then try again.',
  email_not_verified: 'Verify your email first, then try again.',
  not_authorized: "Only this tournament's organisers can change it.",
  not_found: 'That season no longer exists. Reload the page.',
  in_progress: 'This change is still being saved. Wait a moment, then reload.',
  name_invalid: 'Names must be 1 to 80 characters.',
  already_exists: 'This was already created. Reload to see it.',
  season_setup: "This can't change while the season is in setup.",
  season_registration: "This can't change once registration has opened.",
  season_started: "This can't change once the season has started.",
  season_finished: "This can't change because the season has finished.",
  request_failed: "This change was refused. It's kept so you can try again.",
  tournaments_unknown: "Couldn't load your tournaments. Try loading them again.",
  // Form checks
  email_format: 'Enter an email address like name@example.com.',
  password_short: 'Use at least 8 characters.',
  code_format: 'Enter the code from the email.',
  name_long: 'Use 80 characters or fewer.',
} as const

export type MessageCode = keyof typeof messages

/** Text for any code, e.g. from a command; unknown codes get the generic message. */
export const messageFor = (code: string | null): string =>
  code && Object.hasOwn(messages, code) ? messages[code as MessageCode] : messages.unknown
