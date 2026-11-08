<!-- bmad:context -->
<!-- Verified 2026-11-03 against 17d3f4a. Managed by bmad-project-context; edits inside this block are replaced on refresh. Keep anything you want preserved outside the markers. -->

## Tamghas Super League

Tools for the Tamghas Super League futsal tournament (Tamghas, Gulmi, Nepal): a phone graphics maker, a live-stream overlay and a match console. Static HTML pages with plain scripts and no build step, served by GitHub Pages from `arjunmara/tsl`; data in Supabase Postgres. BMAD planning output goes in `_bmad-output/`, long-term docs in `docs/`.

The exception is `app/`, the new multi-organiser PWA: a Vite + React build (Node 22) deployed by Cloudflare Pages, not GitHub Pages; see `app/README.md`.

## Policy

- Ask before every `git push`: pushing to `main` deploys to every phone via GitHub Pages.
- Never ask for or handle the organiser password; the user signs in themselves.
- Never delete untracked files in the repo root or media folders, which hold the user's own media (clips, trailer project, screenshots); put scratch files in the session scratchpad.

## Where things are

- Data layer used by every page: `db.js` (`loadSeason`, `write`, `rpc`, sign-in).
- Live stream: `live/live.js` (state), `live/overlay.html` (PRISM widget), `live/control.html` (match console), `live/screen.html`.
- Graphics: `maker.html` drives the templates in `matchday/matchday.html` and `teamlist/*.html`; table and tie-break rules are in `matchday/league.js`.
- Schema and migrations: `supabase/*.sql`. Season 1 archive: `seasons/season-1/`.

## Running and verifying

- Serve from the repo root with `python3 -m http.server 8765` and test pages in headless Chrome; `?nosync` (maker) and `?nolive` (live pages) keep a test page off live data.
- `node matchday/league.test.js` checks the table logic; it prints `ok`.
- Test database writes on a throwaway season 99, signed in as a test editor, never on real seasons; afterwards delete it and restore the `live` row.
- Test a migration first on a local `postgres:16-alpine` container, stubbing `auth.jwt()`, the `anon`/`authenticated` roles and the `supabase_realtime` publication.
- `python3 sync.py` is read-only: it pulls the latest season into `matchday/*.txt`, `matchday/*.json`, `teamlist/squads.txt` and `seasons/db.json`.

## Conventions that differ from defaults

- `.gitignore` is a whitelist (`/*`, then `!` lines): add a `!/path` line for every new top-level file or folder, or git silently ignores it.
- Schema changes go in a new numbered `supabase/NNN_name.sql` for the user to paste into the Supabase SQL Editor; agents can't run DDL with the publishable key.
- The score is derived from `goals` rows by a trigger. Never write `matches.hg`/`ag`; insert or delete goals, or call `set_result` for a typed score.
- Write through `write()`/`rpc()` from `db.js`, never bare `sb.from()` writes: updates and deletes that RLS blocks touch 0 rows with no error.
- Bump `?v=N` on every `live.js?v=N` script tag when `live/live.js` changes; GitHub Pages caches it for 10 minutes.
- Show dates fans see in both BS and AD, e.g. `Saturday · Kartik 14, 2083 BS (31 Oct 2026)`. BS month lengths vary by year, so look dates up rather than computing an offset.
- `loadSeason()` in `db.js` and `texts()` in `sync.py` build the same text/JSON shapes the templates read; change them together.

## Known pitfalls

- A page's scripts share one global scope (`db.js`, `league.js`, `live.js`, then the page's own script), so a duplicate top-level `const` breaks the whole page. Check the name is free before adding a helper.

<!-- /bmad:context -->
