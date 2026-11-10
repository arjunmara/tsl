# App database migrations

The new app keeps its data in the `app` schema. The legacy TSL pages keep using `public`, and the
older files in `supabase/` stay as they are. There are two Supabase projects: **test** (previews)
and **live** (the existing TSL project).

## Rules

- One file per change, numbered in order: `0001_app_schema.sql`, `0002_<name>.sql`, ... Never
  reuse a number.
- Never edit a migration once it has been applied to live. Fix forward with a new file.
- Migrations stay backward compatible and land on live *before* the app deploy that needs them.
- The founder applies every migration: paste it into the Supabase SQL Editor of **test** first,
  check the preview, then **live**.
- Agents never apply migrations, never hold live credentials or connection strings, and never
  ask for or handle the organiser password.
- `app` starts with no table, sequence or function access for `anon` and `authenticated`. Every
  migration grants exactly what it needs and ships each table's RLS policy in the same file.
- Always apply migrations as `postgres` in the SQL Editor. Default privileges bind only the role
  that ran them, so objects created by another role would not start locked.
- Every write is a **command**: a function in `app`, `security definer set search_path = ''`,
  that calls `app.authorize(actor, action, target)` and then `app.claim_command(actor, command_id)`
  before anything else, and returns `{ok, code, message}`. Clients get EXECUTE on commands only,
  SELECT through RLS, and never insert, update or delete grants.
- **Helpers** are the shared functions commands call (`authorize`, `claim_command`,
  `finish_command`, `season_allows`), RLS helpers (`is_member`), trigger functions
  (`log_change`, `season_status_guard`, `activity_log_immutable`) and the write-free client helpers
  `server_now` and `report_client_error`. They are listed in the `helpers` allowlist in
  `check.sh`. Anything in `app` not on that list is a command, and the `pg_proc` skeleton check
  fails naming it if it misses `authorize` then `claim_command`. Every function in `app`, helper
  or command, must be `security definer` with `search_path = ''`. Add a new helper to the
  allowlist in the same pull request, and only if clients cannot call it to write.
- A released command's signature and meaning never change. A change ships as a new function
  (`create_tournament_v2`); the old one stays while any supported app version still calls it.
- Commands never insert Activity log rows; the `log_change` trigger on every tenant table does,
  from `app.actor`, `app.command_id` and optional `app.reason` (set with `set_config(..., true)`).
  Season status changes only through lifecycle commands and `app.season_transition`;
  `app.season_allows` is the only reader of `app.season_action`.
- `bash supabase/migrations/check.sh` applies all files twice to a local Postgres in Docker and
  checks the result, then runs the command, Activity log, cross-tenant leak and skeleton tests; it
  prints `ok`. The release gate runs it on every pull request.

## One-time setup (founder)

1. Apply `0001_app_schema.sql` to test, then to live. Check with
   `select nspname from pg_namespace where nspname = 'app';` (one row).
2. On test, confirm new objects start locked (all four should be `false`), then clean up:
   ```sql
   create table app.probe (id int); create function app.probe_f() returns int language sql as 'select 1';
   select has_table_privilege('anon','app.probe','select'), has_table_privilege('authenticated','app.probe','insert'),
          has_function_privilege('anon','app.probe_f()','execute'), has_function_privilege('authenticated','app.probe_f()','execute');
   drop table app.probe; drop function app.probe_f();
   ```
3. In both projects: Project Settings → Data API → Exposed schemas, add `app`.
4. On live, check the legacy TSL pages still load, and that the maker and match console still
   save a goal on test season 99.
5. Cloudflare R2: create a private bucket (for example `tsl-app-backups`), add a lifecycle rule
   that deletes objects after 30 days, and create an API token with Object Read & Write on that
   bucket only.
6. GitHub → repo Settings → Secrets and variables → Actions, add:
   - `LIVE_DB_URL`: live project → Connect → **Session pooler** connection string, with the
     database password filled in (GitHub runners have no IPv6, so not the direct one).
   - `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`.
7. Actions → **App backup** → Run workflow. Check that `app-<date>.sql.gz` appears in the bucket.

## Apply 0002_command_skeleton.sql (Story 1.6)

Apply before the app deploy that has the "Create tournament" form (test first, then live).
Check with `select count(*) from app.season_transition;` (3 rows). Then on the test preview,
create a tournament, see it on My tournaments, and check that a second test account does not
see it.

## Apply 0003_handback.sql (Story 1.7 part B)

Apply before the app deploy with the hand-back sheet (test first, then live). It adds
`app.discarded_command`, the `discard_command` command, `server_now` and `report_client_error`, and
lets an actor read their own Activity log rows that have no Tournament. A discard whose scope is not
one of the caller's Tournaments or Seasons is logged with no Tournament (visible only to the caller). Check with
`select app.server_now();` (one row). Then on the test preview, create a tournament offline and
online again, and open `/__crash?crashtest`: Logs → Postgres shows a `client_error` line with
`[removed]` where the test email and number were.

## Apply 0004_wizard_step1.sql (Story 1.8)

Apply before the app deploy with the setup wizard (test first, then live). It adds the brand colours and
`logo_path` to `app.tournament`, `setup_step` to `app.season`, the `set_tournament_branding` and
`set_setup_step` commands, and the **`tournament-assets`** Storage bucket (public read) with policies that let
a signed-in Organiser write only under `<their tournament id>/`. The bucket is public: **never put personal data
in it** (no player photos, ID documents or anything about a person), only Tournament and Sponsor logos and ads
(WebP, PNG or JPEG, at most 1 MiB each). The Tournament's name, colours and logo stay editable after a Season
starts (no Season check); `set_setup_step` only works while setup can be edited and never changes the Season's
`version`. `create_tournament` is redefined with the same signature so its ok answer also carries `version: 1`;
`set_tournament_branding` answers with the new `version` too.
Check with `select public from storage.buckets where id = 'tournament-assets';` (one row, `true`). Then on the
test preview, create a tournament through the wizard, pick colours and a logo, and open My tournaments on
another device: the Resume card opens step 2 once step 1 is finished with Next.

## Apply 0005_wizard_rules_dates.sql (Story 1.9)

Apply before the app deploy with wizard steps 2 and 3 (test first, then live); the wizard reads the new columns, so
it shows "Couldn't load this tournament" until this is applied. It adds `description`, `rules`, `photo_consent`,
`starts_on`, `ends_on` and `registration_deadline` to `app.season` (dates are AD days in Asia/Kathmandu; the deadline is
the last day registration is open), a check that the deadline is on or before the start and the end on or after it,
and the `set_season_rules` and `set_season_dates` commands (versioned edits with the conflict envelope; allowed while
setup can be edited). Check with `select count(*) from information_schema.columns where table_schema = 'app' and
table_name = 'season' and column_name in ('rules', 'registration_deadline');` (2). Then on the test preview, fill
steps 2 and 3 and reopen them on another device.

## Apply 0006_match_settings.sql (Story 1.10)

Apply before the app deploy with wizard step 4 (test first, then live); the wizard reads the new columns, so it shows
"Couldn't load this tournament" until this is applied. It adds `app.format_preset`, the one table of Format preset
defaults (futsal from the FIFA Futsal Laws 2025-26; custom starts from futsal; 5-, 7- and 11-a-side have
`confirmed = false` until the founder confirms their values), readable by every signed-in client; the Match settings
columns on `app.season` with range checks; and the `set_match_settings` command (picking a preset copies its row; other
arguments change single settings; versioned with the conflict envelope; allowed while setup can be edited). Re-running
the file resets the preset rows to its values. Check with `select key, confirmed from app.format_preset order by sort;`
(5 rows). Then on the test preview, pick a preset on step 4, change a value, switch preset, and reopen it on another device.

Edit commands added later answer a stale `expected_version` with
`{ok: false, code: 'version_conflict', conflict: {current_version, current, changed_by, changed_at}}`
(see `app/README.md`, Conflict envelope).

## Nightly backup

**Paused (2026-11-08):** the schedule is commented out in `app-backup.yml` until the R2 bucket and secrets exist. Turn it on before the first real Organiser data lands (Story 2.x at the latest); steps 5–7 above are deferred until then.

`.github/workflows/app-backup.yml` runs at 19:00 UTC (00:45 in Nepal). It dumps schema `app`
from live with `pg_dump --schema=app --strict-names --no-owner`, checks the dump contains the schema, uploads it and confirms the object is in the bucket, gzips it and uploads
`app-YYYY-MM-DDTHHMMZ.sql.gz` to R2 (reruns never overwrite). A failed run fails the workflow, and GitHub emails the owner.
Dumps never go to git or to Actions artifacts, because the repo is public and the app holds
minors' details.

GitHub disables scheduled workflows in public repos after 60 days without repo activity, which
is likely between seasons. At each season start, open Actions → App backup and click
"Enable workflow" if it shows.

## Restoring a dump

Try it on test first.

1. Before restoring onto live, run Actions → App backup once so a fresh copy of the current
   state exists.
2. Download the file from the R2 bucket and unzip it: `gunzip app-<stamp>.sql.gz`.
3. Empty the target with `drop schema app restrict;` in the SQL Editor. If it refuses because
   objects exist, drop them inside `app` first. Use `drop schema app cascade;` only after checking
   what it lists: cascade also drops objects in `public` that depend on `app`.
4. Load it with the project's Session pooler string:
   `psql "<connection string>" -v ON_ERROR_STOP=1 -f app-<stamp>.sql`. The dump includes the
   grants, so nothing else needs replaying.
