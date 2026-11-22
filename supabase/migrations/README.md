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

## Apply 0007_lineup_structure.sql (Story 1.11)

Apply before the app deploy with wizard steps 5 and 6 (test first, then live); the wizard reads the new columns, so it
shows "Couldn't load this tournament" until this is applied. It adds `starters` and `max_bench` defaults to
`app.format_preset` (futsal and custom 5 and 9; 5-, 7- and 11-a-side for founder confirmation), the Line-up rules
(`starters`, `max_bench`, `staff_roles`) and Structure (`structure`, `group_count`, `teams_per_group`,
`qualifiers_per_group`, points 3/1/0, `tiebreaks` in the default order) columns on `app.season` with range checks, the
`set_lineup_rules` and `set_structure` commands (versioned with the conflict envelope; allowed while setup can be edited,
so a tie-break change after the start fails with `season_started`), and the helper `app.lineup_violations(season_id,
squad)` that registration and line-up commands will call (no client grant). Check with
`select key, starters, max_bench from app.format_preset order by sort;` (5 rows, futsal 5 and 9). Then on the test
preview, fill steps 5 and 6, reorder and remove tie-breaks, and reopen them on another device.

## Apply 0008_sponsors.sql (Story 1.13)

Apply before the app deploy with wizard step 7 (test first, then live); step 7 and Settings → Sponsors read `app.sponsor`, so
they show "Couldn't load the Sponsors" until this is applied. It adds `app.sponsor` (Tournament id, Season id, logo path, up to
5 ad image paths, a one-line caption of 1–120 characters, `sort`, `version`) with its read policy and Activity log trigger,
the Season action `edit_sponsors` (allowed in setup, registration and started; not once finished), the helper
`app.sponsor_invalid` (no client grant) and the commands `add_sponsor` (insert-only), `edit_sponsor` and `delete_sponsor`
(versioned with the conflict envelope; deleting a Sponsor already gone is ok) and `reorder_sponsors` (listed Sponsors first,
the rest after; bumps no version). Finishing the wizard is the existing `set_setup_step(7)`. Images go in the
`tournament-assets` bucket from 0004 under `<tournament id>/`; nothing in this file changes Storage. Check with
`select count(*) from app.season_action where action = 'edit_sponsors';` (3). Then on the test preview, add a Sponsor
with a logo and two ads on step 7, reorder and delete one, finish the wizard, and edit Sponsors from Settings on another device.

## Apply 0009_co_organisers.sql (Story 1.14)

Apply before the app deploy with Settings → Co-organisers (test first, then live); that page and `/invite/<token>` fail until this
is applied. It adds `app.organiser_invite` (email in lower case, a 244-bit token, 14-day expiry, inviter, accepted / cancelled
times, `version`) readable only by that Tournament's Organisers; the read helper `app.organisers(tournament_id)` (Organisers and
their sign-in emails, no rows for anyone else) and the internal helper `app.lock_membership` (no client grant); and the commands
`invite_organiser` (insert-only; `email_invalid`, `already_organiser`, `already_invited`), `cancel_invite` (`invite_used` once used),
`accept_invite` (only for the invited email, verified; `invite_wrong_email`, `invite_used`, `invite_cancelled`, `invite_expired`,
`invite_missing`) and `remove_organiser` (yourself included; `last_organiser`; also cancels invites the removed person sent or
that were sent to their email). Membership changes for one Tournament run one at a time (the Tournament row is locked and the
caller's membership checked again). It also redefines `app.authorize` (accept_invite needs only a verified account) and
`app.log_change` (an invite `token` is logged by name only). No email is sent: the Organiser shares the link. Check with
`select count(*) from pg_proc where proname in ('invite_organiser', 'accept_invite', 'remove_organiser', 'cancel_invite');` (4).
Then on the test preview, with two accounts: invite the second, open the link signed out, sign up with the invited email, accept,
and check both see the Tournament; open a second invite while signed in with another email (refused); remove the second account
while it has an offline change waiting, and check that change comes back for review.

## Apply 0010_invite_code.sql (Story 1.14b)

Apply before the app deploy where the invite page offers "Email me a code" (test first, then live); a signed-out visit to
`/invite/<token>` fails to load until this is applied. It adds the read helper `app.invite_preview(token)`, callable signed out:
one row for a known token with `status` (`pending`, `used`, `cancelled`, `expired`) and, only while pending, the invited email and
the Tournament's name; no row for an unknown token. It writes nothing. **Set the Magic Link email template (see `app/README.md`,
Auth) in the same project first**: without it, existing accounts get an email with no code to type. Check with `select count(*) from app.invite_preview('nope');` (0). Then on the test preview, open an invite link signed out
with an email that has no account, tap "Email me a code", enter the code and land on the Tournament home.

Edit commands added later answer a stale `expected_version` with
`{ok: false, code: 'version_conflict', conflict: {current_version, current, changed_by, changed_at}}`
(see `app/README.md`, Conflict envelope).

## Apply 0011_teams.sql (Story 2.1)

Already applied to test (2026-11-10); apply to live before the app deploy with the Teams tab. It adds `app.team` and
`app.registration_link` (RLS: that Tournament's Organisers read; no client writes), the Season actions `manage_teams`,
`revoke_links` and `open_registration`, and the commands `add_team`, `open_registration`, `revoke_registration_link` and
`reissue_registration_link`. Only a link token's SHA-256 is stored; the token itself stays on the Organiser's phone.
Check with `select count(*) from app.season_action where action in ('manage_teams', 'revoke_links', 'open_registration');`
(8 rows). Then on the test preview, add a Team on the Teams tab (the Season moves to Registration), share its link,
reissue and revoke it, and check that a second test account sees no Team.

## Apply 0012_registration_grant.sql (Story 2.2)

**First turn on anonymous sign-ins** in the same project (`app/README.md`, Registration link). Apply before the app deploy with
the `/register` page (test first, then live). It adds `app.registration_grant` (one per anonymous user: the link it redeemed and
that link's Team, Season and Tournament; that Tournament's Organisers read it), the Season action `edit_team` (setup and
registration), the read helpers `app.granted_team()` and `app.registration_form()`, a second read policy on `app.team` (a grant
holder reads its own Team while the link is active), the commands `redeem_registration_link` (the token is hashed on the server;
`link_dead` for unknown, revoked or replaced links; redeeming again replaces the grant) and `edit_team` (name, Team code, kit
colour; versioned with the conflict envelope, `changed_by` is "Organiser" or "Team manager"; Organisers may call it too), and
redefines `app.authorize`: a `team_id` target resolves to its Season, and an anonymous user passes only for redeeming, discarding
its own refused change, and grant actions on the Team of its live grant. Check with
`select count(*) from app.season_action where action = 'edit_team';` (2). Then on the test preview, add a Team, open its link in
a private window on a phone, change the name, code and kit colour, check the Organiser sees them; revoke the link and reload the
private window ("This link no longer works").

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

## Apply 0013_players_staff.sql (Story 2.3)

Apply after 0012 and before the app deploy with Players and Staff on the `/register` page (test first, then live); that page
fails to load until this is applied. It adds `app.player` (per Tournament: name, date of birth, version), `app.squad_entry`
(Team, Player, shirt number 1–99, unique per Team), `app.staff` (Team, name, role, version) and `app.photo_consent` (Player,
Season, consent given, given_by, recorded_at), readable by the Tournament's Organisers and, for its own Team, the Registration
link grant; the Season actions `edit_squad` and `submit_team` (setup and registration); the helpers `app.conflict` (the
conflict envelope, no client grant) and `app.registration_rules()` (the grant's photo-consent statement and Line-up rules); and
the commands `add_player` (insert-only; a consenting minor, under 18 on today's Kathmandu date, needs `given_by`:
`guardian_required`), `edit_player`, `remove_player` (a Player in no other Squad is deleted with their details), `add_staff`,
`edit_staff`, `remove_staff` (edits and removes versioned with the conflict envelope) and `submit_team` (status Submitted). Line-up
rule refusals are `lineup_violation` with the reasons in words as `message`; `app.lineup_violations` gains a minimum (at least
the starters) for a complete Squad. `app.authorize` lets a grant holder run these on its own Team.

**Personal fields.** `app.log_change` no longer has a built-in list: every log trigger names its table's personal fields as the
second argument (`log_change('tournament_id', '{date_of_birth}')`, `'{}'` for none), whose values are logged as the field's
name; a trigger without it raises. This file re-creates every existing log trigger with its declaration. A new tenant table
must declare its fields in the same file; `check.sh` fails naming any tenant table (any table with `tournament_id`, and
`tournament`) without a valid declaration. Check with `select count(*) from app.season_action where action in ('edit_squad',
'submit_team');` (4). Then on the test preview, open a Registration link, add a minor with a guardian's name and an adult, add
a Staff member, send the Team for review, and check the Organiser's Team row shows Submitted and that Activity log rows for
the Player show `date_of_birth` and `given_by` instead of the values.

## Apply 0014_eligibility.sql (Story 2.4)

Apply after 0013 and before the app deploy with the Eligibility section on the `/register` Player cards (test first, then live);
that page fails to load until this is applied. It adds `app.eligibility_record` (one per Player per Season: document type
`emis`, `birth_certificate`, `citizenship` or `passport`, document number, scan path and file name, when the scan was
uploaded, `verified_by`/`verified_at` for Story 2.7, `version`). Only the Tournament's Organisers read the table (stricter than
the default membership: no Scorer device or Registration link grant); a grant reads its own Team's records through
`app.registration_eligibility()`, which never returns the scan path. Commands `add_eligibility` (insert-only;
`eligibility_exists` for a second record) and `edit_eligibility` (versioned with the conflict envelope; `eligibility_verified`
once verified) take the Team, use the Season action `edit_squad`, and check the scan path is
`<tournament id>/<team id>/<player id>/<uuid>.webp`. `remove_player` is redefined so a removed Player's record goes too.
Document number, scan path and file name are logged by field name only.

It also creates the **private `eligibility-scans` Storage bucket** (WebP or PNG, at most 1 MiB) with two policies: Organisers of
the folder's Tournament read; Organisers, and a live grant for exactly that Team (for a Player in its Squad, while the Squad can change), add (never
upsert). There is no update or delete policy and no public URL: a Team manager can't open a scan, even their own. Scans are
deleted only through the Storage API by Story 2.7's scheduled job; until 2.7 ships, scans stay in the bucket, so don't
collect real documents on live before then. Check with `select public from storage.buckets where id = 'eligibility-scans';`
(one row, `false`) and `select count(*) from pg_policies where tablename = 'objects' and policyname like 'eligibility_scans%';`
(2). Then on the test preview, open a Registration link on a phone, pick a document type, enter a number and upload a scan
from the camera: the card shows the file name only. In Storage → eligibility-scans the file is under
`<tournament>/<team>/<player>/`. Uploading as a Team manager relies on Supabase allowing an upload without upsert with only an
insert policy; if it fails with a row-level security error, tell the developer before going further.

## Apply 0015_player_photos.sql (Story 2.5)

Apply after 0014 and before the app deploy with photos on the `/register` Player and Staff cards (test first, then live);
that page fails to load until this is applied. It adds `photo_path` and `is_cutout` (both or neither) to `app.player` and
`app.staff`, logged by field name only, and the command `set_photo` (the Team, a Player in its Squad or one of its Staff;
versioned on that person with the conflict envelope; Season action `edit_squad`; path `<tournament id>/<team id>/<person
id>/<uuid>.webp`). The view **`app.player_photo_public`** (security invoker, so the caller's own RLS applies) is the only
place Graphics, the Post-match pack and the Overlay may read a Player photo: its `photo_path` is null unless that Season's
Photo consent is recorded with who gave it and the photo is a cut-out. It returns the object path; the caller signs a URL.

It also creates the **private `player-photos` Storage bucket** (WebP or PNG, at most 2 MiB): Organisers of the folder's
Tournament and a live grant for exactly that Team read and add (the grant only for its own Squad or Staff while the Squad can
change); never upsert, no update or delete policy (Story 2.10 deletes through the Storage API). Check with
`select public, file_size_limit from storage.buckets where id = 'player-photos';` (`false`, 2097152) and
`select count(*) from pg_policies where tablename = 'objects' and policyname like 'player_photos%';` (2). Then on the test
preview, open a Registration link on a phone, open a Player and tap "Add photo": the card shows the photo with "Removing
background…", then the cut-out; in Storage → player-photos the file is under `<tournament>/<team>/<player>/`.

## Apply 0016_verify_eligibility.sql (Story 2.7)

Apply after 0015 and before the app deploy with "View document" / "Mark verified" on the Organiser's Player cards (test
first, then live). It adds the command `verify_eligibility` (Organisers only, Season action `verify_eligibility` in setup and
registration; needs a document type and number; versioned; keeps type, number, `verified_by`, `verified_at`), and narrows the
`eligibility-scans` read policy: an Organiser of the folder's Tournament reads a scan only while an **unverified** record of a
Season that has **not finished** points to it, so a verified, finished or orphan scan can't be opened even before it is
deleted. It also adds `app.scans_to_delete()` and `app.scans_deleted()` (service role only) and an hourly pg_cron job,
`delete-eligibility-scans` (at :17), that calls the `delete-scans` Edge Function through pg_net. The function deletes through
the Storage API every scan of a verified record or a finished Season, and every scan file no record points to (a replaced
scan, a removed Player's, a refused upload) once it is a day old; then it clears the scan path and file name on the records.
A file that fails to delete stays selected and is retried on the next run; failures show in the function's logs.

Steps, on **test** first, then the same on **live** (each project has its own secret):

1. Database → Extensions: enable **pg_cron** and **pg_net** (Vault is on by default). 0016 stops with "Enable the pg_cron and
   pg_net extensions first" if either is missing.
2. Paste `0016_verify_eligibility.sql` into the SQL Editor and run it.
3. Make a shared secret on your own computer, for example `openssl rand -hex 32`. Don't send it to anyone or put it in the
   repo.
4. Deploy the Edge Function, with JWT checking off (it checks the shared secret instead), using the Supabase CLI from the repo
   root:
   ```sh
   supabase login
   supabase functions deploy delete-scans --project-ref <project ref> --no-verify-jwt
   supabase secrets set SCAN_CLEANUP_SECRET=<the secret> --project-ref <project ref>
   ```
   Or in the dashboard: Edge Functions → Deploy a new function → Via Editor, name it `delete-scans`, paste
   `supabase/functions/delete-scans/index.ts`, deploy; in its Details turn **Enforce JWT verification** off; Edge Functions →
   Secrets → add `SCAN_CLEANUP_SECRET`. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are already there by default.
5. Store the function's URL and the same secret in Vault (SQL Editor), so the cron job can read them:
   ```sql
   select vault.create_secret('https://<project ref>.supabase.co/functions/v1/delete-scans', 'scan_cleanup_url');
   select vault.create_secret('<the secret>', 'scan_cleanup_secret');
   ```
   To change one later: `select vault.update_secret((select id from vault.secrets where name = 'scan_cleanup_secret'), '<new>');`
6. Check: `select jobname, schedule from cron.job;` (one row, `delete-eligibility-scans`, `17 * * * *`). Run the job once by
   hand with `select command from cron.job where jobname = 'delete-eligibility-scans';` (paste and run what it returns), then
   `select status_code, content from net._http_response order by id desc limit 1;`: 200 and `{"ok":true,...}`. A 401 means
   the two secrets differ. After the next hour, `select status, return_message from cron.job_run_details order by start_time
   desc limit 3;` shows `succeeded`.
7. On the test preview, as an Organiser, open a Submitted Team with a scan, open a Player card, tap "View document", tap the
   scan (full size inside the card, two fingers zoom), then "Mark verified": the card says "Verified. Scan deleted; EMIS number
   kept." Within the hour the file is gone from Storage → eligibility-scans and the function's log says how many it deleted.
   Uploading a scan as an Organiser now relies, as the Team manager's does since 0014, on Storage allowing an upload without
   a select policy on the new file; if it fails with a row-level security error, tell the developer.

Until step 5 is done the job runs but its call fails (no URL), so no scan is deleted: don't collect real documents on live
before the check in step 6 passes.

## Apply 0017_review_teams.sql (Story 2.8)

Apply after 0016 and before the app deploy with "Approve team", "Return with note" and "Withdraw team" on the Team page (test
first, then live). It adds the Team status `withdrawn` and the column `team.return_note`, the Organiser-only commands
`approve_team` (a submitted Team whose Squad and Staff meet the Line-up rules), `return_team` (a submitted or approved Team,
with a note of 1–500 characters the Team manager sees) and `withdraw_team` (any status), all under the Season action
`review_team` in setup and registration, and the view `app.draw_team`: the approved Teams the Draw (Epic 3) may place, read
through the reader's RLS. `app.authorize` now also reads the Team's status: an approved Team refuses its manager's changes
(`team_approved`), a withdrawn Team refuses every change but review (`team_withdrawn`). A submitted Team stays editable;
approval re-checks the Line-up rules. Steps: paste `0017_review_teams.sql` into the SQL Editor and run it. Check: as an
Organiser, `select count(*) from app.draw_team` runs (0 until a Team is approved).

## Apply 0018_registration_deadline.sql (Story 2.9)

Apply after 0017 and before the app deploy with "Reopen link" on the Team page (test first, then live). Registration links
now close on the server at the end of the deadline day in Asia/Kathmandu: `app.season_allows(season, action, team)` refuses a
Team manager's change with `registration_closed` unless it was entered on the phone before the close (the outbox sends its
`entered_at` as the request header `x-entered-at`) and arrives within `app.grace_window()` (1 hour; to change it, redefine
that one function). Organisers still edit until the Season starts. The Organiser-only command `reopen_registration_link`
(Season action `reopen_link`, setup and registration) reopens one Team's link through a new closing date (today up to the
start date) for a reason of 1–200 characters, stored on the Team (`reopened_until`, `reopen_reason`); the Team manager's
changes after the deadline carry that reason in the Activity log. Steps: paste `0018_registration_deadline.sql` into the SQL
Editor and run it. Check: `select app.grace_window();` returns `01:00:00`. Then, on the test preview, open a Registration
link and save a change while watching the browser's network tab: the request carries `x-entered-at` and is not blocked by
CORS (if it is, tell the developer).

## Apply 0019_erase_personal_data.sql (Story 2.10)

Apply after 0018 and before the app deploy with "Delete personal details" on the Organiser's Player cards (test first, then
live). It adds the Organiser-only command `erase_player_personal_data`: it clears a Player's date of birth and photo, the
guardian's (or giver's) name in every Season, so Photo consent becomes "not given", and the Eligibility document number and
scan (document type and verification kept), and keeps the name, Team, shirt number and match record. It works in any Season
status and for a withdrawn Team; Team managers can't call it. The Activity log names the cleared fields only, never their
values, and copies of the values in stored command answers are dropped. Every file in the Player's folders in
`player-photos` and `eligibility-scans` goes into the new queue `app.file_to_delete`; a queued photo can't be opened from
then on. The hourly `delete-eligibility-scans` job now also deletes, through the Storage API, queued files at once and every
Player or Staff photo nothing points to any more (a replaced photo, a removed Player's) once it is a day old.

Nightly backups keep a copy for 30 days (the R2 lifecycle rule), so erased data leaves the backups within 30 days. Backups
are paused at the moment; when you turn them on, keep that 30-day rule.

Steps, on **test** first, then **live**:

1. Paste `0019_erase_personal_data.sql` into the SQL Editor and run it.
2. Redeploy the Edge Function (it now also deletes photos), the same way as for 0016:
   `supabase functions deploy delete-scans --project-ref <project ref> --no-verify-jwt`, or in the dashboard paste the new
   `supabase/functions/delete-scans/index.ts` into the `delete-scans` function and deploy (keep **Enforce JWT
   verification** off). The secrets and the cron job stay as they are.
3. Check: run the job once by hand (step 6 of 0016), then
   `select status_code, content from net._http_response order by id desc limit 1;`: 200 with an `eligibility-scans` and a
   `player-photos` count.
4. On the test preview, as an Organiser, open a Team, open a Player card with a photo, tap "Delete personal details" and
   confirm. The card shows no photo, date of birth, guardian or document number; within the hour the photo is gone from
   Storage → player-photos.

## Apply 0020_chit_draw.sql (Story 3.1)

Apply after 0019 and before the app deploy with the Draw board on the Matches tab (test first, then live). It adds the table
`app.draw_slot` (a row per Team placed: Season, group number or 0 for a knockout bracket, slot number, Team, version) with
its Organiser-read policy and Activity-log trigger, the Season action `edit_draw` (registration only), the helper
`app.draw_slots` (the slots a Structure offers) and the Organiser-only commands `place_team_in_draw`,
`unplace_team_from_draw` and `place_rest_at_random`. Only approved Teams of the Season can be placed (`team_not_approved`);
a taken slot hands back the conflict envelope (Keep theirs / Use mine); a League has no Draw (`no_draw`). Steps: paste
`0020_chit_draw.sql` into the SQL Editor and run it. Check: as an Organiser, `select count(*) from app.draw_slot` runs
(0 until a Team is placed).

## Apply 0021_suggested_fixtures.sql (Story 3.2)

Apply after 0020 and before the app deploy with "Suggest fixtures" on the Matches tab (test first, then live). It adds the table
`app.match` (a Fixture is a Match not yet played: stage, round, label, order, home and away Team or source label such as "A1" or
"Winner SF1", kick-off, empty score columns) with its member-read policy and Activity-log trigger, the Season action
`edit_fixtures` (registration only) and the Organiser-only command `suggest_fixtures`. The phone works out the pairings and
order; the command checks that every Team is an approved Team of the Season and, with a Draw, that the Draw is complete
(`draw_incomplete`), then inserts the whole list in one go. A second suggestion needs `replace` (`fixtures_exist`). Steps: paste
`0021_suggested_fixtures.sql` into the SQL Editor and run it. Check: as an Organiser, `select count(*) from app.match` runs
(0 until Fixtures are suggested).

## Apply 0022_arrange_publish_fixtures.sql (Story 3.3)

Apply after 0021 and before the app deploy with "Arrange fixtures" and "Publish fixtures" (test first, then live). It adds
`app.season.fixtures_published_at`, turns the unique order of Matches into a deferrable constraint (so two Matches can swap), and
adds three Organiser-only commands under `edit_fixtures` (registration only): `swap_fixtures` (two Matches exchange their order, both
versions bump, a stale version returns `version_conflict`), `set_kick_off` (a kick-off inside the Season's dates, Asia/Kathmandu days:
`kickoff_outside_season`) and `publish_fixtures` (every Match needs a kick-off: `kickoff_missing`). `suggest_fixtures` is redefined to
refuse once published (`fixtures_published`). Steps: paste `0022_arrange_publish_fixtures.sql` into the SQL Editor and run it.
Check: `select fixtures_published_at from app.season` runs (null until published).

## Apply 0023_standings_progression.sql (Story 3.4)

Apply after 0022 and before the app deploy with the group tables and bracket on the Matches tab (test first, then live). It widens
`app.match.status` to scheduled, live and finished, adds `home_pens` / `away_pens` (a knockout Match level after play is decided by
them), the table `app.tiebreak_shootout` (member read, Activity-log trigger), the Season action `record_shootout` (started only),
the read functions `app.standings(season)` and `app.match_sides(season)` (members of the Tournament only; the rules of
`matchday/league.js` in the Season's `tiebreaks` order), the Organiser-only command `record_tiebreak_shootout` (`shootout_not_needed`
for Teams that are not level, `downstream_started` when it would change a Team already frozen into a live Match) and the freezing
of knockout slots: when a Match turns live its resolved Teams are written into it, and a change that would resolve a frozen side
differently fails with `downstream_started`. No command writes a score yet (Epic 4). Steps: paste `0023_standings_progression.sql`
into the SQL Editor and run it. Check: `select count(*) from app.standings('<season id>')` runs as an Organiser (one row per placed
Team). `check.sh` also runs `standings.parity.mjs`, which feeds Season 1 and the `league.test.js` cases through the database and
fails on any order different from `league.js`.

## Apply 0024_start_season.sql (Story 3.5)

Apply after 0023 and before the app deploy with "Start tournament" on the Matches tab (test first, then live). It adds the Season
action `start_season` (registration only), the read function `app.start_check(season)` (Organisers of the Tournament only: `ready`,
the reason in words and the Teams it names) and the Organiser-only command `start_season`, which re-checks readiness under a lock and
moves the Season from registration to started (`start_blocked` with the same reason when not ready). Ready means at least two
non-withdrawn Teams, every one approved, every approved Team in the Draw (a League has none) and the Fixtures published. Nothing
moves a started Season back. Steps: paste `0024_start_season.sql` into the SQL Editor and run it. Check:
`select app.start_check('<season id>')` runs as an Organiser (`ready` false with a reason until the Season is ready).

## Apply 0025_confirm_after_start.sql (Story 3.6)

Apply after 0024 and before the app deploy that lets Organisers change Squads and Fixtures after start (test first, then live).
`app.season_action` gains a `confirm` flag: in a started Season the 11 FR-16 commands (`add_player`, `edit_player`, `remove_player`,
`add_staff`, `edit_staff`, `remove_staff`, `add_eligibility`, `edit_eligibility`, `set_photo`, `swap_fixtures`, `set_kick_off`) are
allowed for Organisers only when called with `confirmed => true`; without it they answer `confirmation_required` and change nothing.
Each gained a `confirmed boolean default false` parameter (old signatures dropped, calls without it work as before; before start it
changes nothing). `app.season_allows` has a 4-argument form for it, and `app.authorize` passes the target's `confirmed` to it. A
Registration link still can't change a started Season (`season_started`). `suggest_fixtures` and `publish_fixtures` stay unusable
after start (they answer `confirmation_required` and have no way to confirm). `set_season_rules` now accepts a description-only change
after start (Season action `edit_description`); rules and the photo-consent statement stay locked. The Activity log triggers already
record before, after and actor. Steps: paste `0025_confirm_after_start.sql` into the SQL Editor and run it. Check:
`select action, status, confirm from app.season_action where confirm;` (2 rows: `edit_squad` and `edit_fixtures`, started).

## Apply 0026_activity_view.sql (Story 3.7)

Apply before the app deploy with Settings → Activity log (test first, then live). It adds the read-only view `app.activity_view`
(every `app.activity_log` row plus `who`, `team_id`, `match_id` and `season_id`) and the helper `app.actor_name(tournament, actor)`
(an Organiser's sign-in email, "Team manager (CODE)" for a Registration link, "System" for no actor; null unless the caller is a
member of the Tournament). The view is `security_invoker`, so the log's own RLS applies: members only. No log row can be written
through it. Steps: paste `0026_activity_view.sql` into the SQL Editor and run it. Check:
`select who, table_name from app.activity_view order by id desc limit 5;` runs as an Organiser.

## Apply 0027_finish_season.sql (Story 3.8)

Apply after 0026 and before the app deploy with "Finish season" on the Matches tab (test first, then live). It adds the Season
action `finish_season` (started only), the read function `app.finish_check(season)` (Organisers of the Tournament only: `ready` and
the reason in words) and the Organiser-only command `finish_season`, which re-checks under a lock and moves the Season from started to
finished (`finish_blocked` with the same reason when not ready). Ready means the Season is started, has at least one Match and every
Match is finished. A finished Season has no allowed actions, so every Squad, Fixture, shootout and setup command answers
`season_finished`; reads are unchanged. The deletion job already deletes a finished Season's eligibility scans. Nothing unfinishes a
Season. Steps: paste `0027_finish_season.sql` into the SQL Editor and run it. Check:
`select app.finish_check('<season id>')` runs as an Organiser.

## Apply 0028_scorer_devices.sql (Story 4.1)

Apply after 0027 and before the app deploy with Settings → Scorers and the `/score` page (test first, then live). It adds
`app.season.scorer_token_hash` (the one live Scorer link of a Season; only the token's SHA-256 is stored), the table
`app.scorer_device` (one row per request from a phone: label, status pending, approved, rejected or revoked, a hash of the
two-digit approval number, a 10-minute expiry; Organisers of the Tournament read it, nobody else), the Season action
`manage_scorers` (setup, registration and started), the Organiser-only commands `create_scorer_link`, `revoke_scorer_link`,
`approve_scorer_device` and `revoke_scorer_device`, the command `request_scorer_approval` (an anonymous phone through the live
link), the read function `app.scorer_status()` (a phone's own requests, newest first) and the helper `app.scorer_allows(actor, season,
entered_at)`, which later scoring commands ask: true for an approved device, or a revoked one for changes entered before the
revoke plus `app.grace_window()`. `app.authorize` lets an anonymous user ask for approval; `app.actor_name` names a phone by its
label in the Activity log. Needs anonymous sign-ins on, as for 0012. Steps: paste `0028_scorer_devices.sql` into the SQL Editor and
run it. Check: `select app.scorer_status();` runs as any signed-in user (no row until a phone has asked).

## Apply 0029_prematch.sql (Story 4.2)

Apply after 0028 and before the app deploy with the scoring console (test first, then live). It adds `app.match.scoring_device` (the
user, an Organiser or a Scorer phone, that holds scoring of a Match), the tables `app.match_lineup` (per Match and Team: starters,
bench, kit colour of the day, home or away, version) and `app.live_state` (one row per Tournament: the On-air Match, scene override and
Sponsor pop-up), both readable by the Tournament's Organisers only, the Season actions `take_scoring`, `confirm_lineups` and
`show_on_stream` (started only), the commands of the same names, and the reads `app.console_match(match)` and
`app.scorer_matches(season)` (and their helper `app.console_reads`), which answer only an Organiser of the Tournament or an approved
Scorer phone of the Season (a pending phone, another Season's phone or a Registration link reads nothing). `app.authorize` lets an
approved Scorer phone run the three commands for its own Season. `take_scoring` answers `scoring_elsewhere` for a Match another
phone holds (hand-over is Story 4.8); `confirm_lineups` is for the holder before kick-off and answers `lineup_invalid` in words.
Nothing here writes a score or a Match status. Steps: paste `0029_prematch.sql` into the SQL Editor and run it. Check:
`select app.console_match('<match id>')` runs as an Organiser (a JSON document with both Teams).

## Apply 0030_match_clock.sql (Story 4.3)

Apply after 0029 and before the app deploy with the Match clock (test first, then live). It adds `app.match.clock` (`running`,
`anchor_at`, `elapsed_ms`, `period`, `interval`: every phone shows `elapsed_ms` plus, while running, the time since `anchor_at`), the
append-only table `app.match_event` (client id, kind, period, minute, entered_at, the score then, version; this story writes only the kinds
`period_start`, `period_end`, `match_end` and `clock_set`; Organisers read it, a Scorer phone reads through `app.console_match`), the Season
actions `start_clock`, `pause_clock`, `next_period`, `set_clock` and `end_match` (started only), the commands of the same names, and the
helper `app.match_score(match)` (0-0 until Story 4.4 adds goals). Every command is for the holder of scoring only
(`not_scoring_device`), carries the Match's expected `version` and the time of the change (`at`, clamped to between the last change and
now()). The first `start_clock` needs both line-ups (`lineups_missing`), puts the Match live and starts period 1. `end_match` sets the
Match finished with `hg` and `ag` from `app.match_score`; no command takes a typed score. `app.console_match` gains the Match version,
the period rules, the clock, the score and the events. `app.authorize` lets an approved Scorer phone run the five commands for its own
Season. Steps: paste `0030_match_clock.sql` into the SQL Editor and run it. Check: `select app.console_match('<match id>')` runs as an
Organiser and shows `clock` and `events`.

## Apply 0031_goals.sql (Story 4.4)

Apply after 0030 and before the app deploy with goals in the console (test first, then live). It adds the kind `goal` to `app.match_event`
and its columns `team_id` (the Team the goal counts for; an own goal is recorded for the Team that gets it), `player_id` (none: own goal or
unknown scorer), `assist_id`, `own_goal` and `deleted_at` (a delete is soft: the row stays, every read skips it). `app.match.hg` and `ag`
are now derived by a trigger on `app.match_event` from the undeleted goals, in the Match's own sides, and the trigger does not change
`app.match.version` (so a goal never makes the holder's next clock command a `version_conflict`); `app.match_score` reads the same, and
`end_match` finishes the Match with that score. New Season actions and commands (started only, holder of scoring only, live Match only):
`record_goal` (a new row; the command id is the event id; `period`, `minute` and `at` come from the phone), `add_assist`, `edit_event`
(Player or minute) and `delete_event`, the last three with the goal's expected `version` (+1 per change; a stale one is a
`version_conflict` the hand-back shows). Answers: `match_not_live`, `not_scoring_device`, `team_invalid`, `player_invalid`, `goal_invalid`,
`event_missing`. `app.authorize` lets an approved Scorer phone run the four commands for its own Season. `app.console_match` gains the goal
fields on events, the score and divider scores in the line-up's home and away order, and `period_minutes` and `extra_time_minutes` in the
rules. Steps: paste `0031_goals.sql` into the SQL Editor and run it. Check: `select app.console_match('<match id>')` runs as an Organiser
and shows `events` with `team_id`.

## Apply 0032_match_events.sql (Story 4.5)

Apply after 0031 and before the app deploy with events in the console (test first, then live). It adds the kinds `card`, `foul`, `sub`,
`timeout` and `missed_penalty` to `app.match_event` and the columns `card` (`yellow` or `red`), `player_on_id` (a substitution: `player_id` goes
off, `player_on_id` comes on) and `clock_ms` (the Match clock's elapsed milliseconds in the period). These events never change the score: the
trigger and `app.match_score` count only goals. New command `record_event` (started Seasons only, holder of scoring only, live Match only; the
command id is the event id; `period`, `minute`, `clock_ms` and `at` come from the phone) with the answers `not_scoring_device`,
`match_not_live`, `team_invalid`, `player_invalid`, `event_invalid`, `event_not_allowed` (a foul without the Season's `foul_warning`, a timeout
without `timeouts_per_period`), `timeout_used` (one per Team per regular period, none in extra time; the message names the Team),
`subs_used` (a limited Season stops at `max_substitutions` per Team), `not_on_pitch` (the Player going off) and `not_on_bench` (the Player coming
on: on the bench or, when rolling, subbed off earlier). `app.on_pitch(match, team)` derives the Players on the pitch from the starters and the
undeleted subs. `edit_event` (Player and minute; a foul or timeout takes the minute only) and `delete_event` now also take these kinds;
`add_assist` still takes goals only (`event_not_allowed`). `app.authorize` lets an approved Scorer phone run `record_event` for its own Season.
`app.console_match` gains `foul_warning`, `timeouts_per_period`, `substitutions`, `max_substitutions` and `power_play_minutes` in `rules`, and
`card`, `player_on_id` and `clock_ms` on events. Steps: paste `0032_match_events.sql` into the SQL Editor and run it. Check:
`select app.console_match('<match id>')` runs as an Organiser and shows the new `rules` keys.

## Apply 0033_match_result.sql (Story 4.6)

Apply after 0032 and before the app deploy with the Awards sheet and "Type the result" (test first, then live). It adds `mom_player_id` and
`fair_player_id` (the Man of the Match and Fair Player Awards) to `app.match`; `home_pens` and `away_pens` exist from 0023. `app.end_match` is
dropped and recreated with `home_pens`, `away_pens`, `mom_player_id` and `fair_player_id` (all default null, so an old call still works): one
Finish takes the shootout and the Awards. Pens only for a level knockout Match (else `event_invalid`), none for a level one is `shootout_needed`,
equal is `shootout_tied`; Awards only from the two line-ups (`player_invalid`); the pens are in the line-up's home and away order and add no
goals. New Organiser-only commands (started Seasons only): `set_awards` (a finished Match; `match_not_finished`, a stale version is a
`version_conflict`) and `type_result` (a scheduled Match with both sides known, or a finished one; `match_live`, `team_invalid`): it adds
unknown-scorer goals (minute 0) or soft-deletes unknown-scorer goals newest first until each Team's goals equal the typed number, refuses
with `goals_named` when named goals exceed it, then finishes the Match (hg and ag still come from the goals; the pens are in the Match's own
sides). `record_goal`, `add_assist`, `edit_event` and `delete_event` now also work for an Organiser on a finished Match (a Scorer phone still gets
`match_not_live`); a change to a finished Match that would change a frozen knockout slot answers `downstream_started` ("This can't change: the
next round has already started.") and changes nothing, as do `end_match` and `type_result`. `app.console_match` gains `home_pens`, `away_pens`,
`mom_player_id` and `fair_player_id` on `match`. Steps: paste `0033_match_result.sql` into the SQL Editor and run it. Check:
`select app.console_match('<match id>')` runs as an Organiser and shows the new keys on `match`.

## Apply 0034_holder_grace.sql (Story 4.7)

Apply after 0033 and before the app deploy with offline-safe scoring (test first, then live). It adds `scoring_prev_device` and
`scoring_moved_at` to `app.match` (nothing sets them yet; Story 4.8, hand over and take over, will) and the helper `app.holds_scoring`. A scoring
command (the clock commands, `end_match`, the goal commands and `record_event`) from a phone that is not the holder is accepted when that phone
was the previous holder and the change was entered (`at`, never later than now) before `scoring_moved_at` plus `app.grace_window()`; later
ones still answer `not_scoring_device`, which holds that Match's queue on the phone and hands the command back (Try again / Discard). A revoked
Scorer phone keeps the `scorer_allows` grace from 0028. `goal_step`, `event_step`, `clock_step` and `end_match` are recreated with the same
signatures. Steps: paste `0034_holder_grace.sql` into the SQL Editor and run it. Check:
`select scoring_prev_device, scoring_moved_at from app.match limit 1` runs and shows two empty columns.

## Apply 0035_handover.sql (Story 4.8)

Apply after 0034 and before the app deploy with hand over and take over scoring (test first, then live). It adds `app.takeover_request` (a Scorer
phone's ask to take over a Match: pending, approved, declined or expired; 2 minutes; one pending per Match, a newer ask replaces older ones; Organisers
read their Tournament's rows, a phone reads its own ask only through `app.scoring_state`) and the commands `hand_over_scoring` (the holder passes
scoring to another approved Scorer phone of the Season: `device_not_approved`, a stale version is a `version_conflict`), `ask_take_over` (an approved
Scorer phone that is not the holder), `approve_take_over` and `decline_take_over` (Organisers; `request_expired` after 2 minutes) and
`take_over_scoring` (an Organiser takes it directly). Every move sets `scoring_prev_device` and `scoring_moved_at` (0034's grace keeps the old holder's
earlier changes), raises the Match's version by one and closes the Match's other pending asks. New reads: `app.scoring_state(match)` (the console's
2-second poll: holder name, whether the caller holds it, the caller's own ask, version, a stamp that grows with the Match's events, and for the holder
the phones it can hand over to) and `app.takeover_requests(tournament)` (pending asks, Organisers only). Steps: paste `0035_handover.sql` into the SQL
Editor and run it. Check: `select app.takeover_requests('<tournament id>')` runs as an Organiser and answers `[]`.

## Apply 0036_legacy_mirror.sql (Story 4.10)

Apply after 0035 and before TSL Season 2 goes on air (test first, then live). It adds the switch table `app.legacy_mirror` (Tournament, Season; no client
access, you fill it by hand) and triggers on `app.live_state`, `app.match` and `app.match_lineup`. While a switch row names a Season, its On-air Match is
copied one way into `public.live.state`: `home`, `away`, `hc`, `ac`, `hs`, `as`, `period`, `elapsed`, `since`, with `match` set to null so the old
`score_to_live` trigger leaves the score alone. Other keys (`scene`, `lay`, `ad`, `ticker`, `show`) are untouched. Nothing else in `public` is written: the
old maker and graphics get no Season 2 results. With no switch row nothing is written; an error inside the mirror is a warning in the Supabase logs and
the scoring command still succeeds. Steps: paste `0036_legacy_mirror.sql` into the SQL Editor and run it.

Switch on (ids from `select id, number, tournament_id from app.season`):

```sql
insert into app.legacy_mirror (tournament_id, season_id) values ('<tournament id>', '<season id>') on conflict do nothing;
```

Switch off (the next change writes nothing; `public.live` keeps its last state):

```sql
delete from app.legacy_mirror where season_id = '<season id>';
```

Check on tsl-test with season 99: tsl-test has no legacy `public.live`, so create it first if missing:

```sql
create table if not exists public.live (id smallint primary key default 1 check (id = 1), state jsonb not null default '{}');
insert into public.live (id) values (1) on conflict do nothing;
```

Switch season 99 on, put a Match on air, then run `select state from public.live` after a goal, an undo, a clock start and pause, the interval and the
end: each shows at once (`hs`/`as`, `since`/`elapsed`, `period` "1st Half", "Half Time", "2nd Half", "Full Time"). Switch it off and drop test-only rows
when done. The overlay itself reads the live project, so its 2-second check runs when Season 2 goes live. The triggers are dropped when the Stage 2
Overlay ships (`drop trigger legacy_mirror on app.live_state`, the same on `app.match` and `app.match_lineup`, then `drop function app.legacy_mirror_push()`).

## Apply 0037_season_venue.sql (Story 5.1)

Apply after 0036 and before the app deploy with the Result Graphic (test first, then live). It adds the optional `venue` (1 to 80 characters) to
`app.season` and the command `set_season_venue` (action `edit_venue`: allowed in setup, registration and started, so the venue stays editable after
the Season starts while the dates lock). A blank venue clears it; a stale version is a `version_conflict`; anything longer than 80 characters or with a
control character is `venue_invalid`. Steps: paste `0037_season_venue.sql` into the SQL Editor and run it. Check:
`select venue from app.season limit 1` runs and shows an empty column.

## Apply 0038_season_awards.sql (Story 5.6)

Apply after 0037 and before the app deploy with the Season awards Graphics (test first, then live). It adds `app.season_awards` (Best Goalkeeper and Player of
the Tournament, one row per Season and award; Organisers read it through RLS, nobody writes it directly, and every change is in the Activity log), the command
`set_season_award` (action `set_season_award`: started or finished Seasons; a Player outside the Season's Squads is `player_invalid`; a stale or missing
`expected_version` for an award already set is a `version_conflict`) and the read `app.season_top_scorers(season)` (goals per Player, own goals and unknown
scorers left out; the Top Scorer is derived from it, never stored). Steps: paste `0038_season_awards.sql` into the SQL Editor and run it. Check:
`select count(*) from app.season_awards` runs and shows 0.

## Apply 0039_template.sql (Story 5.7)

Apply after 0038 and before the app deploy with the template picker (test first, then live). It adds `app.tournament.template` (`classic` by default; `split` or
`minimal` otherwise) and the command `set_template` (any Organiser; a stale `expected_version` is a `version_conflict`, any other value is `template_invalid`; the
change shows in the Activity log). Steps: paste `0039_template.sql` into the SQL Editor and run it. Check: `select template from app.tournament limit 1` shows `classic`.
