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
5. Authentication > URL Configuration: Site URL = the live app URL (test project: the preview URL you use). Redirect URLs: the live URL, `https://*.tsl-eby.pages.dev/**`, `http://localhost:5173/**`.
6. Cloudflare Pages > Settings > Variables and Secrets: `VITE_TURNSTILE_SITE_KEY` in both Production and Preview (a Cloudflare build fails without it). Optional `VITE_APP_URL` fixes the base for email links.

Local builds without `VITE_TURNSTILE_SITE_KEY` skip the widget; sign-up then only works against a project with CAPTCHA off.

The theme override (account menu: Device / Light / Dark) is stored per device in `localStorage` key `theme` and applied before first paint by the inline script in `index.html`.

## Make the release gate block merges

GitHub > `arjunmara/tsl` > Settings > Rules > Rulesets (or Branches > Branch protection) > target `main` > Require status checks to pass > add `gate` (from `.github/workflows/release-gate.yml`). Also require a pull request before merging.
