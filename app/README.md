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

## Make the release gate block merges

GitHub > `arjunmara/tsl` > Settings > Rules > Rulesets (or Branches > Branch protection) > target `main` > Require status checks to pass > add `gate` (from `.github/workflows/release-gate.yml`). Also require a pull request before merging.
