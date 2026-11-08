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
  // Form checks
  email_format: 'Enter an email address like name@example.com.',
  password_short: 'Use at least 8 characters.',
  code_format: 'Enter the code from the email.',
} as const

export type MessageCode = keyof typeof messages
