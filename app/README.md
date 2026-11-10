# TSL app

The multi-organiser PWA. Unlike the rest of the repo it has a build step (Vite) and deploys to Cloudflare Pages.

## Run and build

Node 22 (`.node-version`).

```sh
cd app
npm ci
npm run dev        # local dev server
npm run typecheck
npm run lint       # includes the layer rule
npm run build      # tsc -b && vite build -> dist/
npm run preview    # serve dist/
```

The database comes only from `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in the build environment; `src/domain/env.ts` is the only reader. Without them a local or CI build still works and the page shows "No database configured". On Cloudflare Pages (`CF_PAGES=1`) a missing variable fails the build. Never commit a `.env` file or a key.

## Design tokens

Tokens live in `src/ui/tokens.css`; sample at `/tokens.html`. `npm run check:a11y` (after build, needs Google Chrome) checks contrast, colour literals, themes, 200% text and reduced motion.

Components in `src/ui`: `PrimaryButton`, `SecondaryButton`, `DestructiveButton` (always via a Confirm sheet), `Field` with `focusFirstInvalid`, `StatusPill`, `ConfirmSheet`; sample at `/components.html`, checked by `npm run check:ui`.

## Writing labels

Every button and link is a verb plus its object and makes sense on its own: "Create new tournament", not "New tournament"; "Email me a reset code", not "Send code"; "Try the link again", not "Try again". No "Submit", "OK", "Continue" or "Done". Exceptions: wizard "Next"/"Back" and Confirm-sheet "Cancel". Messages come from `src/domain/messages.ts` and follow EXPERIENCE.md Voice and Tone. When you touch a screen, check its labels against this and fix any that fail.

## Layers

`src/ui` (tokens, components) imports nothing below it. `src/features/<area>` may import `ui` and `domain`. Only `src/domain` and `src/outbox` import Supabase. `eslint.config.js` enforces this with `no-restricted-imports`.

## Decisions

Installed by the first story that uses them, not before.

- Routing: react-router 8.5.1. The maintained default for React; data routers cover the few screens we need.
- Styling: plain CSS with custom-property tokens and Vite CSS Modules. No runtime or extra dependency; Vite supports both natively.
- Tests: Vitest 5.1.0. Shares the Vite config and transforms, so no second toolchain.
- Graphic capture: modern-screenshot 4.7.0. Actively maintained; html-to-image has had no release since Apr 2025.
- Hosting: Cloudflare Pages. Per-branch preview URLs with separate Preview and Production variables built in.
- Service worker: `registerType: 'prompt'`, so a new version waits until a later story activates it with an empty outbox (AD-25).

## Cloudflare Pages setup (founder)

1. Cloudflare dashboard > Workers & Pages > Create > Pages > Connect to Git > `arjunmara/tsl`.
2. Production branch `main`. Framework preset: None. Root directory `app`. Build command `npm run build`. Output directory `dist`.
3. Settings > Variables and Secrets:
   - Production: `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` of the live (existing TSL) project.
   - Preview: the same two names with the `tsl-test` project's values.
4. Node version comes from `app/.node-version` (22); set `NODE_VERSION=22` in both environments if the build picks another.
5. Check: a branch push gives a preview URL showing the test project ref; `main` shows the live ref.

## Auth (Story 1.5)

Supabase Auth, email + password. Screens in `src/features/auth`; only `src/domain/auth.ts` talks to Supabase, and every failure text comes from `src/domain/messages.ts`. Email links go to `/auth/callback` (base from `VITE_APP_URL`, else the page's origin); the code (OTP) and the link work equally for verifying and for password recovery. `npm run check:auth` (needs Google Chrome) builds the app with a fake Supabase URL into `node_modules/.auth-dist` and runs every case against mocked Supabase and Turnstile.

Email goes through Supabase's built-in sender for now: free, rate-limited, for testing only. **Before real Organisers sign up**, switch to Resend or Postmark in Supabase > Authentication > SMTP Settings (no code change).

Founder setup, in each Supabase project (test, then live):

1. Cloudflare dashboard > Turnstile > Add widget: hostnames `tsl-eby.pages.dev` (covers previews) and the live domain, mode Managed. Copy the site key and the secret key.
2. Supabase > Authentication > Attack Protection > Enable CAPTCHA protection > Cloudflare Turnstile, paste the secret key. This also guards sign-in, resend and password reset, so the app sends a Turnstile token on those too (the widget there shows only when Cloudflare wants an interaction, and turns visible if the hidden check fails).
3. Authentication > Sign In / Providers > Email: Confirm email on; Email OTP length 6. Password minimum length 8 with no extra character requirements (the app's only rule is "at least 8 characters").
4. Authentication > Email Templates:
   - Confirm signup: show the code `{{ .Token }}` and the link `{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=signup`.
   - Reset password: show `{{ .Token }}` and `{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=recovery`.
   - Magic Link (Story 1.14b; **tsl-test only for now**): the invite page and Sign in → "Email me a sign-in code" send it to existing, verified accounts, and the app asks for the code. Subject `Your Tamghas Super League sign-in code`, body:
     ```html
     <h2>Your sign-in code</h2>
     <p>Enter this code in the app: <strong>{{ .Token }}</strong></p>
     <p>Or tap this link on the phone you're signing in on: <a href="{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=email">Sign in</a></p>
     <p>If you didn't ask for this, ignore this email.</p>
     ```
     New or unconfirmed emails get the Confirm signup email instead (it already shows the code), so an invitee with no account needs nothing else.
5. Authentication > URL Configuration: Site URL = the live app URL (test project: the preview URL you use). Redirect URLs: the live URL, `https://*.tsl-eby.pages.dev/**`, `http://localhost:5173/**`.
6. Cloudflare Pages > Settings > Variables and Secrets: `VITE_TURNSTILE_SITE_KEY` in both Production and Preview (a Cloudflare build fails without it). Optional `VITE_APP_URL` fixes the base for email links.

Local builds without `VITE_TURNSTILE_SITE_KEY` skip the widget; sign-up then only works against a project with CAPTCHA off.

The theme override (account menu: Device / Light / Dark) is stored per device in `localStorage` key `theme` and applied before first paint by the inline script in `index.html`.

## Outbox (Story 1.7)

Every change goes through `send(name, args, { scope })` from `src/domain/commands.ts`; features never call `runCommand` or import `src/outbox`. `send` stores the command on the device (Dexie/IndexedDB) before any network call, replays in order with the same `command_id` on every attempt, and resolves with the server's answer or `{ ok: false, code: 'queued' }` when it couldn't reach the server (treat that as accepted: it sends later).

- Give a scope: the Tournament or Season id the change belongs to, or `'global'`. A refused change stops later changes in its scope only.
- Add a `commandLabels` entry in `src/features/save-status/labels.ts` for every new command, in plain words ("Create tournament ‘Gulmi Cup’"); the Save status lists waiting changes with it.
- Network failures, `unknown` (5xx), `in_progress` and `not_signed_in` retry (2 s doubling to 60 s, and at once on reconnect, any auth change and app start); any other code (4xx is `request_failed`) marks the change `failed`, and `version_conflict` marks it `conflict`. Either stops its scope until the user chooses in the hand-back sheet. Nothing is dropped without the user: a screen that shows a refusal itself (like the create form) calls `forgetRefused(commandId)`.
- Hand-back sheet (`src/features/save-status/HandBack.tsx`, opened by "Review this change" / "Review refused changes" beside the Save status; tapping the status itself lists the changes, refused first): one refused change at a time, oldest first. A conflict shows "Your change" / "Their version" for the fields that differ (add words for new fields to `fieldLabels` in `labels.ts`) with "Keep their version" (logged discard) or "Send my version" (same command, `expected_version` set). Any other refusal offers "Try sending again" or "Discard this change" (confirmed, logged). A resend always gets a new command id in the same queue place, since the server stores the refusal under the old one. Discards are the `discard_command` command, each queued in its own scope `discard:<discarded command id>`. A `version_conflict` without a valid `conflict` payload is treated as a plain refusal (`request_failed`).
- Only the signed-in user's entries replay and count for the Save status, the leave warning and the update gate. `send` with nobody signed in returns `not_signed_in` and stores nothing.
- A new service worker activates only once this user has nothing pending and the page is hidden (or right at app start); closing the tab with changes waiting asks first.
- `npm run check:outbox` (needs Google Chrome) runs every case against a mocked server.
- The server-corrected `enteredAt` takes its offset from `app.server_now()` at app start, on reconnect and when the page is shown again (round-trip midpoint; answers slower than 5 s or older than the last applied one are ignored). Replay's first pass waits up to 3 s for the first answer; until one arrives the offset is 0 and the device clock is used.

### Versioned edits

`send(name, args, { scope, versionOf: rowId })` queues an edit of a versioned row without `expected_version`. The outbox keeps a base version per row on the device (Dexie table `versions`): set from a read (`noteVersion`, only when nothing of this user's for that row is pending) and from every ok answer that carries `version` (commands return the row's new version). Replay fills `expected_version` from the base as it is at that moment, so a refused-and-discarded edit, a lost answer or another device's change never shifts later edits. "Send my version" sets the base to the conflict's `current_version`, so the edits queued behind it follow.

### Conflict envelope (for edit commands)

An edit of a versioned row takes `expected_version int` and, when the row's `version` differs, returns without writing:

```json
{ "ok": false, "code": "version_conflict", "message": "…",
  "conflict": { "current_version": 4, "current": { "name": "Gulmi Cup", "…": "…" }, "changed_by": "Sita", "changed_at": "2026-11-10T04:15:00Z" } }
```

`current` uses the command's argument names as keys, so the sheet can compare it with what was sent; `changed_by` is a display name. `runCommand` passes `conflict` through unchanged.

## Setup wizard (Story 1.8)

`src/features/setup/Setup.tsx`: "Create new tournament" opens `/new`, which makes the Tournament and Season ids once (kept in `history.state` and `sessionStorage`, so a reload or retry creates the same Tournament). Leaving the name field the first time sends `create_tournament` and moves to `/t/:id/setup/1`; later edits send `set_tournament_branding` with only the changed field, queued with `versionOf: <tournament id>` and no `expected_version` (see Versioned edits). Colours or a logo picked before the name wait and follow the create. Next sends `set_setup_step`.

- A logo is resized in the browser to fit 512×512, encoded WebP, and queued with the command: `send(..., { upload })` stores the blob in the outbox, and replay uploads it (upsert) to the `tournament-assets` bucket before running the command. That bucket is public: no personal data in it.
- The sample Graphic uses only the brand colours and navy/white text from the tokens; when neither reaches 4.5:1 on the main colour, the panel behind the text is darkened (`src/features/setup/brand.ts`).
- My tournaments shows a Resume card for each Tournament whose latest Season is in setup with `setup_step < 7`, read from the server.
- Steps 2–7 load the Tournament and go back to step 1 when it is missing or the step is past the furthest finished one + 1; an id that isn't a UUID shows "This tournament isn't available." Back and Next replace the history entry.
- `npm run check:setup` (needs Google Chrome) runs every case against a mocked server; `npm run check:sponsors` does the same for step 7.

Steps 2 and 3 (Story 1.9, `src/features/setup/RulesDates.tsx`) edit the Season with `set_season_rules` and `set_season_dates`, queued with `versionOf: <season id>`; each field sends only itself when left, Next sends every field, then `set_setup_step`. Each step re-reads the Tournament and lays pending changes over it; offline it uses the last read. A Season created offline gets base version 1 (`noteNewSeason`), so its edits replay without a conflict. Step 2 needs the photo-consent statement before Next; step 3 needs all three dates, with the deadline on or before the start and the end on or after it.

Step 4 (Story 1.10, `src/features/setup/Format.tsx`) reads the Format presets from `app.format_preset` (`formatPresets()` keeps the last answer in localStorage so the step opens offline) and edits the Season's Match settings with `set_match_settings`, `versionOf: <season id>`. Picking a preset sends only its key (the server copies the row; the client lays the same row over pending entries); numbers send themselves when left, choices when changed. Switching preset when the settings differ from the current preset's row opens a Confirm sheet first. "Limited" substitutions are sent only with a valid maximum. Fouls, timeouts and power play show only for presets with `futsal_rules`.

Steps 5 and 6 (Story 1.11, `src/features/setup/LineupStructure.tsx`) edit the Season with `set_lineup_rules` and `set_structure`, `versionOf: <season id>`, each field sending only itself when left (Next sends the numbers too). Step 5's Starters and Maximum bench show the Format preset's defaults (`app.format_preset.starters`, `max_bench`) until the Season has its own; Staff roles are a fixed list (keys and words in `STAFF_ROLES`, checked by `app.season`). Step 6 asks the groups only for groups then knockout (qualifiers per group 1 to Teams per group − 1), and points and tie-breaks only when there is a table; tie-breaks reorder with Move up / Move down, Remove and Add back buttons (focus stays on the item, a polite live region says where it went), each sending the whole order. Tie-break and every other setup edit is refused with `season_started` once the Season starts (Sponsors excepted: they stay editable until the Season finishes). The shared rule check `app.lineup_violations(season_id, squad)` returns the reasons in words for registration and line-up commands to call; it has no client grant. Step 7 (Story 1.13, `src/features/setup/Sponsors.tsx`) lists the Season's Sponsors (`seasonSponsors()`, an empty list when there are none) with Edit, Move up / Move down and Delete (a Confirm sheet naming the Sponsor, opening on Cancel). "Add a Sponsor" and Edit open the editor in place of the list: caption (one line, 1–120 characters), logo (required, fits 512×512) and up to 5 ad images (fit 1280×1280), all WebP under 1 MiB. A new Sponsor is sent with "Add this Sponsor": `add_sponsor` carrying the logo upload, then one `edit_sponsor` per ad image, since an outbox entry carries one upload; an existing Sponsor saves each change at once (`versionOf: <sponsor id>`). The order is `reorder_sponsors` with the whole list. Pending Sponsor commands and their queued pictures are laid over the read, so the list is right offline. "Skip for now" (no Sponsors) or "Finish setup" sends `set_setup_step(7)` and opens the Tournament home on Teams (`state.tab`); the Resume card then no longer shows, also while that step is still queued.

## Tournament home and Settings (Story 1.12)

`src/features/home`: `/t/:id` is the Tournament home. The App bar has "Back to My tournaments", the 32px round logo, the name, the Season line ("Season 1 · Setup ▾", a disclosure that lists only the current Season until new Seasons exist) and "Open settings"; the Save status renders inside it (App.tsx hides the page-wide one on `/t/:id` and `/t/:id/settings`). The Tab bar is Matches / Teams / Graphics (`role="tab"`, arrow keys, Home/End); the last tab is kept per Tournament in `localStorage` `tsl-tab:<id>`. Tabs are empty states until their epics; Matches offers "Continue setup" while setup is unfinished.

`/t/:id/settings` lists the setup sections; each (`/t/:id/settings/:section`, `SECTIONS` in `Setup.tsx`) renders the wizard step itself inside `SettingsMode` (`Frame.tsx`): heading "Settings · <step>", only "Back to settings", no step redirect, no `set_setup_step`, Enter never submits. So every setup answer is edited by the same fields, commands and validation as in the wizard; a new step only needs a `SECTIONS` entry. Back in a step goes through `useLeave`. Settings → Sponsors is step 7 in the same frame. `npm run check:home` (needs Google Chrome) runs the cases against a mocked server.

## Co-organisers (Story 1.14)

Settings → "Manage co-organisers" (`/t/:id/settings/co-organisers`, `src/features/home/CoOrganisers.tsx`) lists the Organisers (`organisers` read helper, with their emails), the invites waiting (`app.organiser_invite`, readable only by that Tournament's Organisers) and an invite form. "Send invite" sends `invite_organiser`; its answer carries the token, and the page shows `inviteUrl(token)` (`<appUrl()>/invite/<token>`) as selectable text with "Share invite link" (Web Share API, else copied to the clipboard). There is no invite email yet: the Organiser sends the link themselves. Each waiting invite has "Share invite link" and "Cancel invite" (Confirm sheet); each Organiser "Remove organiser", and you "Leave this tournament" (Confirm sheets; the last Organiser gets `last_organiser`). Refusals show beside the form or the lists and are dropped from the queue (`forgetRefused`).

`/invite/:token` (`src/features/auth/Invite.tsx`) is outside the signed-in routes. Signed out, it reads `invite_preview` (migration 0010; the invited email and Tournament name while pending, else only why the link is dead) and offers "Email me a code": a code sent to exactly the invited email (`emailSignInCode`, Supabase email OTP with `shouldCreateUser: true` and the Turnstile token), then the code field and "Accept this invite", which signs in (`verifySignInCode`, which also verifies the email) and accepts in one step; no password. "Sign in with a password" stays as the other way in. Unverified, it goes to "Check your email". Either way the token is kept in `localStorage` `tsl-invite`, and My tournaments (where sign-in, sign-up and verify all land) sends the person back to it; a verified visit drops it. "Accept this invite" sends `accept_invite` (scope `invite`) and opens the Tournament home. Any refusal (different email, used, cancelled, expired, unknown) is shown in words; a different email also offers "Sign out and use the invited email", which signs out and stays on the invite. A removed Organiser's queued changes come back `not_authorized` and wait in the hand-back sheet. `npm run check:organisers` (needs Google Chrome) runs every case against a mocked server.

## Dates and money

Every date the app shows goes through `src/domain/format.ts`: `formatDate('2026-10-31')` gives "Saturday · Kartik 14, 2083 BS (31 Oct 2026)". Dates are stored as AD (`date`, or `timestamptz` shown as its day in Asia/Kathmandu with `inZone`). BS comes only from the month-length table there (2080–2090 BS); add a year's row when the calendar committee publishes it, and dates past the table show in AD only. Date inputs use `BS_RANGE` as min/max. `npm run check:dates` checks the first and last day of every month of 2082–2084 BS.

Money is stored and passed as integer paisa plus an ISO 4217 currency code (`Money` in `format.ts`), never a float.

## Client errors

`src/domain/report.ts` sends uncaught errors, unhandled rejections and the error boundary's errors (App.tsx: "Something went wrong on this screen." + "Reload this page") straight to `app.report_client_error`, at most 5 per page load (a bare cross-origin `Script error.` is ignored). The route has UUID segments replaced by `:id` and no query or hash; the route, error name and message have emails, UUIDs, phone numbers (8+ digits, grouped or with +) and runs of 6+ digits replaced by `[removed]`; the first stack frame is sent as file:line only. The boundary wraps the routes only (the Save status stays) and resets on navigation. They appear in Supabase > Logs > Postgres as a `client_error` JSON line. `/__crash` (dev, or any build with `?crashtest`) throws on purpose to check this.

## Make the release gate block merges

GitHub > `arjunmara/tsl` > Settings > Rules > Rulesets (or Branches > Branch protection) > target `main` > Require status checks to pass > add `gate` (from `.github/workflows/release-gate.yml`). Also require a pull request before merging.
