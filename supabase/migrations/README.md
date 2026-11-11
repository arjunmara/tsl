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
