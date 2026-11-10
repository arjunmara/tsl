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
  `finish_command`, `season_allows`), RLS helpers (`is_member`) and trigger functions
  (`log_change`, `season_status_guard`, `activity_log_immutable`). They are listed in the `helpers` allowlist in
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
