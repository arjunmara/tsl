#!/usr/bin/env bash
# Applies every supabase/migrations/*.sql twice to a throwaway local Postgres and checks the
# end state. Prints `ok`. Needs Docker. Run from anywhere: bash supabase/migrations/check.sh
set -euo pipefail
dir=$(cd "$(dirname "$0")" && pwd)
name=tsl-migration-check-$$
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT

docker run -d --name "$name" -e POSTGRES_PASSWORD=check postgres:17-alpine >/dev/null
# The image restarts Postgres once after init; wait until it answers over TCP.
ready=
for _ in $(seq 60); do
  docker exec "$name" pg_isready -h 127.0.0.1 -U postgres -q 2>/dev/null && { ready=1; break; }
  sleep 1
done
[ -n "$ready" ] || { echo "FAIL: postgres did not start" >&2; exit 1; }
psql() { docker exec -i -e PGOPTIONS=-cclient_min_messages=warning "$name" psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 -qAt "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

# Supabase stand-ins plus a legacy table in public.
psql <<'SQL'
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create role authenticator noinherit login; grant anon, authenticated, service_role to authenticator;
create schema auth;
create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz, is_anonymous boolean not null default false);
create function auth.uid() returns uuid language sql stable as
  $$ select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
grant usage on schema auth to anon, authenticated;
create table public.legacy_probe (id int primary key, name text);
grant select on public.legacy_probe to anon;
-- Supabase's own default for public: new functions there are executable by client roles.
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
insert into public.legacy_probe values (1, 'probe');
-- Supabase Storage stand-ins: buckets, objects (RLS on, client grants as Supabase has them), foldername().
create schema storage;
create table storage.buckets (id text primary key, name text not null, public boolean default false,
  allowed_mime_types text[], file_size_limit bigint);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets (id), name text, owner uuid,
  created_at timestamptz not null default now());
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated;
grant select, insert, update, delete on storage.objects to anon, authenticated;
create function storage.foldername(name text) returns text[] language plpgsql as $$
declare _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1:array_length(_parts, 1) - 1];
end $$;
-- pg_cron and pg_net stand-ins (Story 2.7): cron.schedule upserts by job name, as pg_cron does; net only needs to exist.
create schema cron;
create table cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text);
create function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as $$
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid $$;
create schema net;
SQL
before=$(docker exec "$name" pg_dump -h 127.0.0.1 -U postgres -n public --restrict-key=check)
# Default ACLs are invisible to pg_dump -n; snapshot them separately.
acl_sql="select defaclrole::regrole, defaclnamespace::regnamespace, defaclobjtype, defaclacl
         from pg_default_acl where defaclnamespace not in (0, coalesce(to_regnamespace('app')::oid, 0))
         order by 1,2,3"
acl_before=$(psql -c "$acl_sql")

for pass in 1 2; do
  for f in "$dir"/*.sql; do
    psql < "$f" || fail "pass $pass: $(basename "$f") did not apply"
  done
done

after=$(docker exec "$name" pg_dump -h 127.0.0.1 -U postgres -n public --restrict-key=check)
[ "$before" = "$after" ] || { diff <(echo "$before") <(echo "$after") >&2; fail "public changed"; }

q() { psql -c "$1"; }
acl_after=$(psql -c "$acl_sql")
[ "$acl_before" = "$acl_after" ] || { diff <(echo "$acl_before") <(echo "$acl_after") >&2; fail "default privileges outside app changed"; }
[ "$(q "select string_agg(defaclobjtype::text, '') from pg_default_acl where defaclnamespace = 0")" = f ] \
  || fail "unexpected global default privileges (only functions expected)"
q "create function public.chk() returns int language sql as 'select 1'" >/dev/null
for r in anon authenticated; do
  [ "$(q "select has_function_privilege('$r','public.chk()','execute')")" = t ] || fail "public function: $r cannot execute"
done
[ "$(q "select count(*) from pg_namespace where nspname='app'")" = 1 ] || fail "schema app missing"
for r in anon authenticated service_role; do
  [ "$(q "select has_schema_privilege('$r','app','usage')")" = t ] || fail "$r lacks usage on app"
done

# --- Command skeleton (Story 1.6): every app function is security definer with search_path='';
# every function not on the helper allowlist calls app.authorize, then app.claim_command.
helpers="{is_member,season_allows,authorize,claim_command,finish_command,log_change,season_status_guard,activity_log_immutable,server_now,report_client_error,is_asset_member,lineup_violations,sponsor_invalid,organisers,lock_membership,invite_preview,granted_team,registration_form,conflict,registration_rules,can_upload_scan,registration_eligibility,eligibility_invalid,can_use_photo,can_read_scan,scans_to_delete,scans_deleted,grace_window,link_closes_at,file_queued,photos_to_delete,files_deleted,draw_slots,standings_calc,standings,match_resolve,match_sides,match_going_live,match_freeze_check,start_check,finish_check,actor_name,scorer_allows,scorer_status,console_reads,console_match,scorer_matches,match_score,clock_step,match_goal_score,goal_step,on_pitch,event_step,sub_chain_ok}"
skeleton="select coalesce(string_agg(proname, ', ' order by proname), '') from pg_proc
  where pronamespace = 'app'::regnamespace and (not prosecdef
    or not coalesce(proconfig, '{}') @> array['search_path=\"\"']
    or (proname <> all ('$helpers'::name[]) and not (strpos(prosrc, 'app.authorize(') > 0
        and strpos(prosrc, 'app.authorize(') < strpos(prosrc, 'app.claim_command('))))"
bad=$(q "$skeleton"); [ -z "$bad" ] || fail "command skeleton: $bad"
q "create function app.probe_cmd() returns int language plpgsql security definer set search_path = ''
   as \$\$ begin perform app.authorize(null, 'x', '{}'); return 1; end \$\$" >/dev/null
[ "$(q "$skeleton")" = probe_cmd ] || fail "skeleton check did not name a command without claim_command"
q "drop function app.probe_cmd()" >/dev/null
body="as \$\$ begin perform app.authorize(null, 'x', '{}'); perform app.claim_command(null, null); return 1; end \$\$"
q "create function app.probe_invoker() returns int language plpgsql security invoker set search_path = '' $body" >/dev/null
q "create function app.probe_no_path() returns int language plpgsql security definer $body" >/dev/null
[ "$(q "$skeleton")" = "probe_invoker, probe_no_path" ] || fail "skeleton check did not name invoker / no search_path functions"
q "drop function app.probe_invoker(); drop function app.probe_no_path()" >/dev/null

# --- Commands, Activity log, RLS (Story 1.6). A and B verified, U unverified.
A=aaaaaaaa-0000-4000-8000-000000000001 B=bbbbbbbb-0000-4000-8000-000000000002 U=cccccccc-0000-4000-8000-000000000003
T1=11111111-0000-4000-8000-000000000001 S1=21111111-0000-4000-8000-000000000001
T2=11111111-0000-4000-8000-000000000002 S2=21111111-0000-4000-8000-000000000002
T3=11111111-0000-4000-8000-000000000003 S3=21111111-0000-4000-8000-000000000003
cmd() { printf '%08d-0000-4000-8000-000000000000' "$1"; }
q "insert into auth.users values ('$A','a@x.test',now()), ('$B','b@x.test',now()), ('$U','u@x.test',null)" >/dev/null
# as <user|anon> <sql>: runs sql as that client inside one transaction.
as() {
  local claims=; [ "$1" = anon ] || claims="set local request.jwt.claims to '{\"sub\":\"$1\"}';"
  psql <<<"begin; set local role $([ "$1" = anon ] && echo anon || echo authenticated); $claims $2; commit;"
}
create() { as "$1" "select app.create_tournament('$(cmd "$2")', '$3', '$4', '$5')"; }
code() { as "$1" "select case when (r->>'ok')::boolean then 'ok' else r->>'code' end
                  from app.create_tournament('$(cmd "$2")', '$3', '$4', '$5') r"; }
counts="select (select count(*) from app.tournament)||'/'||(select count(*) from app.season)||'/'||(select count(*) from app.activity_log)"

r1=$(create $A 1 $T1 $S1 'Gulmi Cup')
[ "$(q "select ('$r1'::jsonb->>'ok')||('$r1'::jsonb->>'version')")" = true1 ] || fail "create: $r1"
[ "$(q "select count(*) from app.organiser_membership where tournament_id='$T1' and user_id='$A'")" = 1 ] || fail "create: no membership"
[ "$(q "select status||version||number from app.season where id='$S1' and tournament_id='$T1'")" = setup11 ] || fail "create: Season 1 not setup v1"
[ "$(q "select count(*)||'/'||count(*) filter (where actor='$A' and command_id='$(cmd 1)') from app.activity_log where tournament_id='$T1'")" = 3/3 ] \
  || fail "create: activity log rows lack actor/command_id"
[ "$(q "select string_agg(table_name||':'||op, ',' order by id) from app.activity_log")" = tournament:insert,organiser_membership:insert,season:insert ] || fail "create: log rows"
[ "$(create $A 1 $T1 $S1 'Gulmi Cup')" = "$r1" ] || fail "repeat: different result"
[ "$(q "$counts")" = 1/1/3 ] || fail "repeat: wrote again"

before=$(q "$counts")
[ "$(code $U 2 $T2 $S2 'Unverified Cup')" = email_not_verified ] || fail "unverified: not refused"
[ "$(q "select count(*) from app.command_result where actor='$U'")" = 0 ] || fail "unverified: command_result row written"
out=$(as anon "select app.create_tournament('$(cmd 3)', '$T2', '$S2', 'Anon Cup')" 2>&1 || true)
[[ $out == *"permission denied for function create_tournament"* ]] || fail "anon: can execute create_tournament: $out"
[ "$(code $A 4 $T2 $S2 '')" = name_invalid ] || fail "bad name: empty accepted"
[ "$(code $A 5 $T2 $S2 "$(printf 'x%.0s' $(seq 81))")" = name_invalid ] || fail "bad name: 81 chars accepted"
[ "$(code $A 10 $T2 $S2 $'\t\n ')" = name_invalid ] || fail "bad name: whitespace-only accepted"
[ "$(code $B 6 $T1 $S2 'Stolen Cup')" = already_exists ] || fail "reused tournament_id: not refused"
[ "$(code $B 7 $T3 $S1 'Stolen Season')" = already_exists ] || fail "reused season_id: not refused"
[ "$(q "$counts")" = "$before" ] || fail "refused commands wrote rows"
[ "$(q "select name from app.tournament where id='$T1'")|$(q "select string_agg(user_id::text, ',') from app.organiser_membership")" = "Gulmi Cup|$A" ] \
  || fail "reused id: A's rows changed"
q "insert into app.command_result (actor, command_id) values ('$A', '$(cmd 8)')" >/dev/null
[ "$(q "select app.claim_command('$A', '$(cmd 8)')->>'code'")" = in_progress ] || fail "claim_command: pending row not in_progress"

# Cross-tenant: B (member of T2 only) sees no row mentioning A or T1 in any app table or view,
# and every client write on every table is denied.
[ "$(code $B 9 $T2 $S2 'B Cup')" = ok ] || fail "B could not create"
[ "$(as $A "select count(*) from app.tournament where id='$T1'")|$(as $A "select count(*) from app.activity_log where tournament_id='$T1'")" = 1\|3 ] || fail "A cannot read own rows"
for who in $B anon; do
  as "$who" "do \$\$ declare t text; c text; n int; begin
    for t in select relname from pg_class where relnamespace = 'app'::regnamespace and relkind in ('r','v','m','p') loop
      begin
        execute format('select count(*) from app.%I x where to_jsonb(x)::text ~ %L', t, '$A|$T1') into n;
        if n > 0 then raise exception 'leak: % sees % A rows in %', current_user, n, t; end if;
      exception when insufficient_privilege then null;
      end;
      select attname into c from pg_attribute where attrelid = ('app.'||t)::regclass and attnum > 0 and attidentity = '' order by attnum limit 1;
      foreach c in array array[format('insert into app.%I default values', t),
          format('update app.%I set %I = %I', t, c, c), format('delete from app.%I', t)] loop
        begin
          execute c;
          raise exception 'write allowed: % on %', current_user, c;
        -- object_not_in_prerequisite_state: a view that can't be written at all (player_photo_public).
        exception when insufficient_privilege or object_not_in_prerequisite_state then null;
        end;
      end loop;
    end loop; end \$\$" || fail "cross-tenant check as $who"
done

# Activity log is append-only for every role.
for stmt in "update app.activity_log set reason = 'x'" "delete from app.activity_log" "truncate app.activity_log"; do
  ! q "$stmt" >/dev/null 2>&1 || fail "postgres could: $stmt"
  ! as $A "$stmt" >/dev/null 2>&1 || fail "authenticated could: $stmt"
done
[ "$(q "select count(*)||'/'||count(reason) from app.activity_log")" = 6/0 ] || fail "activity log changed"

# Personal fields are logged by name only.
q "create table app.probe_person (id uuid primary key, tournament_id uuid, email text, phone text, nick text);
   create trigger log_change after insert on app.probe_person for each row execute function app.log_change('tournament_id', '{email,phone}');
   insert into app.probe_person values ('$S3', '$T3', 'kid@x.test', '98000', 'Ram');
   drop table app.probe_person" >/dev/null
[ "$(q "select (after->>'email')||(after->>'phone')||(after->>'nick') from app.activity_log where row_id='$S3'")" = emailphoneRam ] || fail "personal fields logged"
# Every tenant table (tournament, or any table with tournament_id except the log itself) declares its personal fields on
# its log_change trigger (second argument, real columns only); a trigger without the declaration refuses to log.
decl_sql=$(cat <<'SQL'
select coalesce(string_agg(c.relname, ', ' order by c.relname), '') from pg_class c
where c.relnamespace = 'app'::regnamespace and c.relkind in ('r', 'p') and c.relname <> 'activity_log'
  and (c.relname = 'tournament' or exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tournament_id' and not a.attisdropped))
  and not exists (select 1 from pg_trigger t where t.tgrelid = c.oid and t.tgfoid = 'app.log_change'::regproc and t.tgnargs = 2
    and not exists (select 1 from unnest((string_to_array(encode(t.tgargs, 'escape'), '\000'))[2]::text[]) f
      where not exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = f and not a.attisdropped)))
SQL
)
undeclared=$(psql <<<"$decl_sql")
[ -z "$undeclared" ] || fail "tenant tables without a personal-field declaration: $undeclared"
[ "$(q "select string_agg(c.relname || '=' || (string_to_array(encode(t.tgargs, 'escape'), '\\000'))[2], ' ' order by c.relname) from pg_trigger t join pg_class c on c.oid = t.tgrelid
         where t.tgfoid = 'app.log_change'::regproc and (string_to_array(encode(t.tgargs, 'escape'), '\\000'))[2] <> '{}'")" \
  = 'eligibility_record={document_number,scan_path,scan_name} organiser_invite={email,token} photo_consent={given_by} player={date_of_birth,photo_path} staff={photo_path}' ] || fail "personal-field declarations changed"
q "create table app.probe_a (id uuid primary key, tournament_id uuid, x text);
   create trigger log_change after insert on app.probe_a for each row execute function app.log_change('tournament_id');
   create table app.probe_b (id uuid primary key, tournament_id uuid, x text);
   create trigger log_change after insert on app.probe_b for each row execute function app.log_change('tournament_id', '{y}');
   create table app.probe_c (id uuid primary key, tournament_id uuid)" >/dev/null
undeclared=$(psql <<<"$decl_sql")
[ "$undeclared" = 'probe_a, probe_b, probe_c' ] || fail "declaration check did not name the probes: $undeclared"
! q "insert into app.probe_a values ('$S3', '$T3', 'x')" >/dev/null 2>&1 || fail "log_change logged without a declaration"
q "drop table app.probe_a, app.probe_b, app.probe_c" >/dev/null

# Season rule.
S9=29999999-0000-4000-8000-000000000009
q "insert into app.season (id, tournament_id, number, status) values ('$S9', '$T1', 2, 'started')" >/dev/null
! q "update app.season set status = 'started' where id = '$S1'" >/dev/null 2>&1 || fail "season: setup -> started allowed"
q "update app.season set status = 'registration' where id = '$S1'" >/dev/null || fail "season: setup -> registration refused"
q "update app.season set status = 'setup' where id = '$S1'" >/dev/null 2>&1 && fail "season: registration -> setup allowed"
q "update app.season set status = 'registration' where id = '$S1'" >/dev/null || fail "season: same status refused"
[ "$(q "select app.season_allows('$S9', 'edit_setup')")" = season_started ] || fail "season_allows on started"
[ "$(q "select coalesce(app.season_allows('$S1', 'edit_setup'), 'null')")" = null ] || fail "season_allows on registration"
[ "$(q "select app.authorize('$A', 'edit_setup', '{\"season_id\":\"$S9\"}')")" = season_started ] || fail "authorize: season rule"
[ "$(q "select app.authorize('$B', 'edit_setup', '{\"season_id\":\"$S1\"}')")" = not_authorized ] || fail "authorize: non-member"
[ "$(q "select app.authorize(null, 'create_tournament', '{}')")" = not_signed_in ] || fail "authorize: not signed in"

# --- Hand-back (Story 1.7 B): discard_command is logged; non-members are refused; a discard outside any
# Tournament is visible only to its actor; the clock and error-report helpers are callable by anon.
T4=11111111-0000-4000-8000-000000000004
discard() { as "$1" "select case when (r->>'ok')::boolean then 'ok' else r->>'code' end
                     from app.discard_command('$(cmd "$2")', '$3', 'create_tournament', '$4', '$5') r"; }
D1=d1111111-0000-4000-8000-000000000001 D2=d2222222-0000-4000-8000-000000000002 D3=d3333333-0000-4000-8000-000000000003
D4=d4444444-0000-4000-8000-000000000004 D5=d5555555-0000-4000-8000-000000000005
[ "$(discard $A 20 $D1 $S1 name_invalid)" = ok ] || fail "discard: not ok"
[ "$(q "select tournament_id||'/'||actor||'/'||reason from app.discarded_command where id='$D1'")" = "$T1/$A/name_invalid" ] || fail "discard: row"
[ "$(q "select count(*) from app.activity_log where table_name='discarded_command' and row_id='$D1'
        and tournament_id='$T1' and actor='$A' and command_id='$(cmd 20)' and reason='name_invalid'")" = 1 ] || fail "discard: not logged"
[ "$(discard $A 20 $D1 $S1 name_invalid)|$(q "select count(*) from app.discarded_command")" = ok\|1 ] || fail "discard: repeat wrote again"
[ "$(discard $U 23 $D2 global kept_theirs)" = email_not_verified ] || fail "discard: unverified not refused"
[ "$(q "select count(*) from app.discarded_command where actor='$U'")" = 0 ] || fail "discard: unverified wrote a row"
# B scoping A's Tournament or Season, or an unknown id: ok, logged without a Tournament, visible only to B.
[ "$(discard $B 21 $D2 $T1 kept_theirs)|$(discard $B 22 $D3 $S1 kept_theirs)" = ok\|ok ] || fail "discard: non-member scope not ok"
[ "$(q "select count(*) from app.discarded_command where actor='$B' and tournament_id is null and id in ('$D2','$D3')")" = 2 ] \
  || fail "discard: non-member scope got a tournament"
[ "$(as $A "select count(*) from app.discarded_command where actor='$B'")|$(as $A "select count(*) from app.activity_log where row_id in ('$D2','$D3')")" = 0\|0 ] \
  || fail "discard: A sees B's discards on A's tournament"
[ "$(as $B "select count(*) from app.discarded_command")|$(as $B "select count(*) from app.activity_log where row_id in ('$D2','$D3')")" = 2\|2 ] \
  || fail "discard: B cannot read own null-tournament rows"
[ "$(as $B "select count(*) from app.discarded_command where actor='$A'")|$(as $B "select count(*) from app.activity_log where row_id='$D1'")" = 0\|0 ] \
  || fail "discard: B sees A's discards"
[ "$(discard $A 24 $D4 $T4 name_invalid)" = ok ] || fail "discard: never-created tournament not ok"
[ "$(q "select coalesce(tournament_id::text, 'null') from app.discarded_command where id='$D4'")" = null ] || fail "discard: unknown scope got a tournament"
[ "$(as $A "select count(*) from app.discarded_command where id='$D4'")|$(as $A "select count(*) from app.activity_log where row_id='$D4'")" = 1\|1 ] \
  || fail "discard: actor cannot read own null-tournament rows"
# B pre-claiming A's discarded id does not block A's own discard of it.
[ "$(discard $B 26 $D5 global kept_theirs)|$(discard $A 27 $D5 $S1 kept_theirs)" = ok\|ok ] || fail "discard: same id by two actors"
[ "$(q "select string_agg(actor||':'||coalesce(tournament_id::text, 'null'), ',' order by actor) from app.discarded_command where id='$D5'")" = "$A:$T1,$B:null" ] \
  || fail "discard: A's row missing after B used the same id"
[ "$(as $A "select case when (r->>'ok')::boolean then 'ok' else r->>'code' end from app.discard_command('$(cmd 28)', null, 'x', 'global', 'x') r")" = request_failed ] \
  || fail "discard: null discarded_id not refused"
out=$(as anon "select app.discard_command('$(cmd 25)', '$D2', 'x', 'global', 'x')" 2>&1 || true)
[[ $out == *"permission denied for function discard_command"* ]] || fail "anon: can execute discard_command: $out"
for who in anon $A; do
  [ "$(as $who "select abs(extract(epoch from app.server_now() - now())) < 5")" = t ] || fail "server_now as $who"
  as $who "select app.report_client_error('1.0', '/t/:id', 'Error', repeat('x', 500), 'assets/index.js:1')" >/dev/null || fail "report_client_error as $who"
done

# --- Wizard step 1 (Story 1.8): branding with versions and the conflict envelope, setup_step, Storage policies.
# T1 is A's (version 1), T2 is B's; S1 is in registration (setup still editable), S9 started.
brand() { as "$1" "select case when (r->>'ok')::boolean then 'ok' else r->>'code' end
                   from app.set_tournament_branding('$(cmd "$2")', '$3', $4, $5) r"; }
[ "$(q "select version||brand_primary||brand_secondary||coalesce(logo_path, 'null') from app.tournament where id='$T1'")" = '1#0a1a3f#f58220null' ] \
  || fail "branding: defaults"
r=$(as $A "select app.set_tournament_branding('$(cmd 30)', '$T1', 1, name => ' Gulmi Cup 2 ', brand_primary => '#1B5E20')")
[ "$(q "select (r->>'ok')||(r->>'version') from (select '$r'::jsonb r) x")" = true2 ] || fail "branding: not ok with version 2: $r"
[ "$(q "select version||name||brand_primary||brand_secondary from app.tournament where id='$T1'")" = '2Gulmi Cup 2#1b5e20#f58220' ] \
  || fail "branding: not applied or version not bumped"
[ "$(q "select count(*) from app.activity_log where table_name='tournament' and op='update' and command_id='$(cmd 30)' and actor='$A'")" = 1 ] \
  || fail "branding: not logged"
[ "$(brand $A 30 $T1 1 "name => 'Again'")|$(q "select version from app.tournament where id='$T1'")" = ok\|2 ] || fail "branding: repeat wrote again"
r=$(as $A "select app.set_tournament_branding('$(cmd 31)', '$T1', 1, brand_secondary => '#000000')")
[ "$(q "select r->>'code', r->'conflict'->>'current_version', r->'conflict'->'current'->>'name', r->'conflict'->'current'->>'brand_primary',
         r->'conflict'->'current'->>'brand_secondary', coalesce(r->'conflict'->'current'->>'logo_path', 'null'), r->'conflict'->>'changed_by',
         (r->'conflict'->>'changed_at')::timestamptz is not null from (select '$r'::jsonb r) x")" = 'version_conflict|2|Gulmi Cup 2|#1b5e20|#f58220|null|a|t' ] \
  || fail "branding: conflict envelope: $r"
[ "$(q "select version||brand_secondary from app.tournament where id='$T1'")" = '2#f58220' ] || fail "branding: stale version wrote"
[ "$(brand $B 32 $T1 2 "name => 'Stolen'")" = not_authorized ] || fail "branding: non-member not refused"
[ "$(brand $A 33 $T1 2 "brand_primary => 'red'")" = colour_invalid ] || fail "branding: bad colour"
[ "$(brand $A 34 $T1 2 "brand_secondary => '#12345g'")" = colour_invalid ] || fail "branding: bad hex"
[ "$(brand $A 35 $T1 2 "logo_path => '$T2/logo.webp'")" = logo_invalid ] || fail "branding: other tournament's logo path"
[ "$(brand $A 36 $T1 2 "logo_path => 'logo.webp'")" = logo_invalid ] || fail "branding: logo path outside a folder"
[ "$(brand $A 37 $T1 2 "logo_path => '$T1/../x.webp'")" = logo_invalid ] || fail "branding: logo path with .."
[ "$(brand $A 38 $T1 2 "name => '  '")" = name_invalid ] || fail "branding: blank name"
[ "$(q "select version from app.tournament where id='$T1'")" = 2 ] || fail "branding: refusals wrote"
[ "$(brand $A 39 $T1 2 "logo_path => '$T1/logo-1.webp'")|$(q "select version||logo_path from app.tournament where id='$T1'")" = "ok|3$T1/logo-1.webp" ] \
  || fail "branding: logo"
[ "$(brand $A 40 $T1 3 "logo_path => ''")|$(q "select version||coalesce(logo_path, 'null') from app.tournament where id='$T1'")" = 'ok|4null' ] \
  || fail "branding: remove logo"
out=$(as anon "select app.set_tournament_branding('$(cmd 41)', '$T1', 4)" 2>&1 || true)
[[ $out == *"permission denied for function set_tournament_branding"* ]] || fail "anon: can execute set_tournament_branding: $out"

step() { as "$1" "select case when (r->>'ok')::boolean then 'ok' else r->>'code' end from app.set_setup_step('$(cmd "$2")', '$3', $4) r"; }
sv() { q "select setup_step||'/'||version from app.season where id='$S1'"; }
v0=$(q "select version from app.season where id='$S1'")
[ "$(step $A 50 $S1 1)|$(sv)" = "ok|1/$v0" ] || fail "setup_step: 1 (or bumped the Season version)"
[ "$(step $A 51 $S1 0)|$(sv)" = "ok|1/$v0" ] || fail "setup_step: went back"
[ "$(step $A 53 $S1 3)|$(sv)" = "ok|3/$v0" ] || fail "setup_step: 3"
[ "$(step $A 54 $S1 8)|$(step $A 55 $S1 -1)" = step_invalid\|step_invalid ] || fail "setup_step: out of range"
[ "$(step $A 56 $S9 1)" = season_started ] || fail "setup_step: started season"
[ "$(step $B 57 $S1 5)|$(sv)" = "not_authorized|3/$v0" ] || fail "setup_step: non-member"
# Branding stays editable once a Season has started (T1's Season 2, S9, is started).
[ "$(q "select status from app.season where tournament_id='$T1' and number=2")" = started ] || fail "branding: no started season to test with"
[ "$(brand $A 58 $T1 4 "brand_secondary => '#222222'")|$(q "select brand_secondary from app.tournament where id='$T1'")" = 'ok|#222222' ] \
  || fail "branding: refused after the season started"

# --- Wizard steps 2 and 3 (Story 1.9): rules and dates with versions, the conflict envelope and date order.
rules() { as "$1" "select case when (r->>'ok')::boolean then 'ok' else r->>'code' end
                   from app.set_season_rules('$(cmd "$2")', '$3', $4, $5) r"; }
dates() { as "$1" "select case when (r->>'ok')::boolean then 'ok' else r->>'code' end
                   from app.set_season_dates('$(cmd "$2")', '$3', $4, $5) r"; }
sver() { q "select version from app.season where id='$S1'"; }
v=$(sver)
[ "$(q "select description||rules||photo_consent||coalesce(starts_on::text, 'null') from app.season where id='$S1'")" = null ] || fail "season: defaults"
r=$(as $A "select app.set_season_rules('$(cmd 60)', '$S1', $v, rules => 'Fair play.', photo_consent => 'Photos may be posted.')")
[ "$(q "select (r->>'ok')||(r->>'version') from (select '$r'::jsonb r) x")" = "true$((v + 1))" ] || fail "rules: not ok with version: $r"
[ "$(q "select version||'|'||description||'|'||rules||'|'||photo_consent from app.season where id='$S1'")" = "$((v + 1))||Fair play.|Photos may be posted." ] \
  || fail "rules: not applied"
[ "$(q "select count(*) from app.activity_log where table_name='season' and op='update' and command_id='$(cmd 60)' and actor='$A'")" = 1 ] \
  || fail "rules: not logged"
[ "$(rules $A 60 $S1 $v "rules => 'Again'")|$(sver)" = "ok|$((v + 1))" ] || fail "rules: repeat wrote again"
r=$(as $A "select app.set_season_rules('$(cmd 61)', '$S1', $v, description => 'Stale')")
[ "$(q "select r->>'code', r->'conflict'->>'current_version', r->'conflict'->'current'->>'rules', r->'conflict'->'current'->>'photo_consent',
         r->'conflict'->>'changed_by' from (select '$r'::jsonb r) x")" = "version_conflict|$((v + 1))|Fair play.|Photos may be posted.|a" ] \
  || fail "rules: conflict envelope: $r"
v=$((v + 1))
[ "$(rules $B 62 $S1 $v "rules => 'Stolen'")" = not_authorized ] || fail "rules: non-member not refused"
[ "$(rules $A 63 $S1 $v "rules => repeat('x', 10001)")" = text_too_long ] || fail "rules: too long"
[ "$(rules $A 64 $S9 1 "rules => 'x'")" = season_started ] || fail "rules: started season"
[ "$(rules $A 65 $S1 $v "description => ''")|$(sver)" = "ok|$((v + 1))" ] || fail "rules: empty description"
v=$((v + 1))
[ "$(dates $A 70 $S1 $v "starts_on => '2026-10-31', ends_on => '2026-11-14', registration_deadline => '2026-10-20'")" = ok ] || fail "dates: not ok"
v=$((v + 1))
[ "$(q "select version||' '||starts_on||' '||ends_on||' '||registration_deadline from app.season where id='$S1'")" = "$v 2026-10-31 2026-11-14 2026-10-20" ] \
  || fail "dates: not applied"
[ "$(dates $A 71 $S1 $v "registration_deadline => '2026-11-01'")" = deadline_after_start ] || fail "dates: deadline after start"
[ "$(dates $A 72 $S1 $v "starts_on => '2026-10-19'")" = deadline_after_start ] || fail "dates: start moved before the deadline"
[ "$(dates $A 73 $S1 $v "ends_on => '2026-10-30'")" = end_before_start ] || fail "dates: end before start"
[ "$(dates $A 74 $S1 $v "registration_deadline => '2026-10-31'")|$(sver)" = "ok|$((v + 1))" ] || fail "dates: deadline on the start day"
r=$(as $A "select app.set_season_dates('$(cmd 75)', '$S1', $v, ends_on => '2026-12-01')")
[ "$(q "select r->>'code', r->'conflict'->'current'->>'starts_on', r->'conflict'->'current'->>'registration_deadline' from (select '$r'::jsonb r) x")" \
  = 'version_conflict|2026-10-31|2026-10-31' ] || fail "dates: conflict envelope: $r"
[ "$(dates $B 76 $S1 $((v + 1)) "ends_on => '2026-12-01'")" = not_authorized ] || fail "dates: non-member not refused"
! q "update app.season set ends_on = '2026-10-01' where id='$S1'" >/dev/null 2>&1 || fail "dates: check constraint missing"
! q "update app.season set registration_deadline = '2026-11-01' where id='$S1'" >/dev/null 2>&1 || fail "dates: deadline check constraint missing"
[ "$(dates $A 79 $S9 1 "ends_on => '2026-12-01'")" = season_started ] || fail "dates: started season"
for f in "set_season_rules('$(cmd 77)', '$S1', 1)" "set_season_dates('$(cmd 78)', '$S1', 1)"; do
  out=$(as anon "select app.$f" 2>&1 || true)
  [[ $out == *"permission denied for function"* ]] || fail "anon: can execute $f: $out"
done

# --- Wizard step 4 (Story 1.10): Format presets from one table, Match settings with versions and range checks.
ms() { as "$1" "select case when (r->>'ok')::boolean then 'ok' else r->>'code' end
                from app.set_match_settings('$(cmd "$2")', '$3', $4, $5) r"; }
setting_cols="format_preset, periods, period_minutes, clock, half_time_minutes, extra_time, extra_time_periods, extra_time_minutes,
  shootout, substitutions, max_substitutions, foul_warning, timeouts_per_period, power_play_minutes"
settings() { q "select concat_ws(' ', $setting_cols) from app.season where id='$1'"; }
[ "$(q "select string_agg(key||':'||confirmed||':'||futsal_rules, ',' order by sort) from app.format_preset")" \
  = 'futsal:true:true,5-a-side:false:false,7-a-side:false:false,11-a-side:false:false,custom:true:true' ] || fail "presets: rows"
[ "$(q "select count(*) from (select periods, period_minutes, clock, half_time_minutes, extra_time, extra_time_periods, extra_time_minutes,
        shootout, substitutions, max_substitutions, foul_warning, timeouts_per_period, power_play_minutes
        from app.format_preset where key in ('futsal', 'custom') group by 1,2,3,4,5,6,7,8,9,10,11,12,13) x")" = 1 ] || fail "presets: custom differs from futsal"
[ "$(as $B "select count(*) from app.format_preset")" = 5 ] || fail "presets: not readable by a signed-in client"
v=$(sver)
[ "$(settings $S1)" = '' ] || fail "settings: not empty before a preset"
[ "$(ms $A 80 $S1 $v "period_minutes => 25")" = preset_invalid ] || fail "settings: edit before a preset"
[ "$(ms $A 81 $S1 $v "format_preset => 'futsal-ish'")" = preset_invalid ] || fail "settings: unknown preset"
r=$(as $A "select app.set_match_settings('$(cmd 82)', '$S1', $v, format_preset => 'futsal')")
[ "$(q "select (r->>'ok')||(r->>'version') from (select '$r'::jsonb r) x")" = "true$((v + 1))" ] || fail "settings: futsal not ok with version: $r"
v=$((v + 1))
[ "$(settings $S1)" = 'futsal 2 20 stopped 15 t 2 5 t rolling 5 1 2' ] || fail "settings: futsal values: $(settings $S1)"
[ "$(q "select count(*) from app.activity_log where table_name='season' and op='update' and command_id='$(cmd 82)' and actor='$A'")" = 1 ] \
  || fail "settings: not logged"
[ "$(ms $A 82 $S1 $((v - 1)) "format_preset => 'futsal'")|$(sver)" = "ok|$v" ] || fail "settings: repeat wrote again"
[ "$(ms $A 83 $S1 $v "period_minutes => 25, extra_time => false")" = ok ] || fail "settings: edit"
v=$((v + 1))
[ "$(settings $S1)" = 'futsal 2 25 stopped 15 f 2 5 t rolling 5 1 2' ] || fail "settings: edit not applied: $(settings $S1)"
r=$(as $A "select app.set_match_settings('$(cmd 84)', '$S1', $((v - 1)), shootout => false)")
[ "$(q "select r->>'code', r->'conflict'->>'current_version', r->'conflict'->'current'->>'period_minutes', r->'conflict'->'current'->>'format_preset',
         r->'conflict'->'current'->>'extra_time', r->'conflict'->'current' ? 'rules' from (select '$r'::jsonb r) x")" = "version_conflict|$v|25|futsal|false|f" ] \
  || fail "settings: conflict envelope: $r"
[ "$(ms $A 85 $S1 $v "substitutions => 'limited'")" = substitutions_max_needed ] || fail "settings: limited without a maximum"
for bad in "periods => 0" "period_minutes => 61" "clock => 'paused'" "half_time_minutes => -1" "extra_time_periods => 3" \
           "extra_time_minutes => 0" "substitutions => 'some'" "max_substitutions => 0" "foul_warning => 21" "timeouts_per_period => 4" \
           "power_play_minutes => 6"; do
  [ "$(ms $A 86 $S1 $v "$bad")" = settings_invalid ] || fail "settings: accepted $bad"
  q "delete from app.command_result where command_id='$(cmd 86)'" >/dev/null
done
[ "$(sver)" = "$v" ] || fail "settings: refusals wrote"
[ "$(ms $A 87 $S1 $v "substitutions => 'limited', max_substitutions => 3")" = ok ] || fail "settings: limited with a maximum"
v=$((v + 1))
[ "$(ms $A 88 $S1 $v "format_preset => '7-a-side'")" = ok ] || fail "settings: 7-a-side"
v=$((v + 1))
[ "$(settings $S1)" = '7-a-side 2 30 running 10 f 2 10 t rolling' ] || fail "settings: 7-a-side values: $(settings $S1)"
n=88
for p in 5-a-side 11-a-side custom futsal; do
  n=$((n + 1)); [ "$(ms $A $n $S1 $v "format_preset => '$p'")" = ok ] || fail "settings: preset $p refused"; v=$((v + 1))
done
[ "$(ms $B 95 $S1 $v "period_minutes => 10")" = not_authorized ] || fail "settings: non-member not refused"
[ "$(ms $A 96 $S9 1 "format_preset => 'futsal'")" = season_started ] || fail "settings: started season"
out=$(as anon "select app.set_match_settings('$(cmd 97)', '$S1', 1)" 2>&1 || true)
[[ $out == *"permission denied for function"* ]] || fail "anon: can execute set_match_settings: $out"
! as $A "update app.format_preset set periods = 3" >/dev/null 2>&1 || fail "presets: client could update"
! as anon "select count(*) from app.format_preset" >/dev/null 2>&1 || fail "presets: anon could read"

# --- Wizard steps 5 and 6 (Story 1.11): Line-up rules, Structure and tie-breaks with versions; the shared line-up check.
lr() { as "$1" "select case when (r->>'ok')::boolean then 'ok' else r->>'code' end
                from app.set_lineup_rules('$(cmd "$2")', '$3', $4, $5) r"; }
st() { as "$1" "select case when (r->>'ok')::boolean then 'ok' else r->>'code' end
                from app.set_structure('$(cmd "$2")', '$3', $4, $5) r"; }
struct() { q "select concat_ws(' ', structure, group_count, teams_per_group, qualifiers_per_group, points_win, points_draw, points_loss, tiebreaks::text) from app.season where id='$1'"; }
[ "$(q "select string_agg(key||':'||starters||'/'||max_bench, ',' order by sort) from app.format_preset")" \
  = 'futsal:5/9,5-a-side:5/5,7-a-side:7/5,11-a-side:11/7,custom:5/9' ] || fail "presets: line-up defaults"
[ "$(q "select concat_ws(' ', starters, max_bench, staff_roles::text) from app.season where id='$S1'")" = '{manager,coach}' ] || fail "lineup: defaults"
[ "$(struct $S1)" = '3 1 0 {h2h_points,h2h_goal_difference,h2h_shootout,goal_difference,goals_scored}' ] || fail "structure: defaults: $(struct $S1)"
v=$(sver)
r=$(as $A "select app.set_lineup_rules('$(cmd 100)', '$S1', $v, starters => 5, max_bench => 9)")
[ "$(q "select (r->>'ok')||(r->>'version') from (select '$r'::jsonb r) x")" = "true$((v + 1))" ] || fail "lineup: not ok with version: $r"
v=$((v + 1))
[ "$(q "select count(*) from app.activity_log where table_name='season' and op='update' and command_id='$(cmd 100)' and actor='$A'")" = 1 ] \
  || fail "lineup: not logged"
[ "$(lr $A 100 $S1 $((v - 1)) "starters => 7")|$(sver)" = "ok|$v" ] || fail "lineup: repeat wrote again"
[ "$(lr $A 101 $S1 $v "staff_roles => '{manager,coach,physio}'")" = ok ] || fail "lineup: roles"
v=$((v + 1))
[ "$(q "select concat_ws(' ', starters, max_bench, staff_roles::text) from app.season where id='$S1'")" = '5 9 {manager,coach,physio}' ] || fail "lineup: not applied"
for bad in "starters => 0" "starters => 12" "max_bench => -1" "max_bench => 21" "staff_roles => '{manager,captain}'" \
           "staff_roles => '{coach,coach}'" "staff_roles => array[null]::text[]"; do
  [ "$(lr $A 102 $S1 $v "$bad")" = lineup_rules_invalid ] || fail "lineup: accepted $bad"
  q "delete from app.command_result where command_id='$(cmd 102)'" >/dev/null
done
[ "$(lr $A 103 $S1 $v "max_bench => 0, staff_roles => '{}'")" = ok ] || fail "lineup: bench 0 and no roles"
v=$((v + 1))
r=$(as $A "select app.set_lineup_rules('$(cmd 104)', '$S1', $((v - 1)), starters => 6)")
[ "$(q "select r->>'code', r->'conflict'->>'current_version', r->'conflict'->'current'->>'starters', r->'conflict'->'current'->>'max_bench',
         r->'conflict'->'current'->>'staff_roles', r->'conflict'->'current' ? 'rules' from (select '$r'::jsonb r) x")" = "version_conflict|$v|5|0|[]|f" ] \
  || fail "lineup: conflict envelope: $r"
[ "$(lr $B 105 $S1 $v "starters => 6")" = not_authorized ] || fail "lineup: non-member not refused"
[ "$(lr $A 106 $S9 1 "starters => 6")" = season_started ] || fail "lineup: started season"
[ "$(lr $A 107 $S1 $v "max_bench => 9, staff_roles => '{manager}'")" = ok ] || fail "lineup: reset"
v=$((v + 1))

# lineup_violations: reasons in words, empty when the rules are met, rules not set skipped, unknown Season raises.
lv() { q "select coalesce(array_to_string(app.lineup_violations('$1', '$2'), ' | '), 'null')"; }
[ "$(lv $S1 '{"starters": [1,2,3,4], "bench": [1,2,3,4,5,6,7,8,9,10], "players": [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15], "staff": ["physio", "manager", "physio"]}')" \
  = "Line-up needs 5 starters. You've picked 4. | Bench can have at most 9 Players. You've picked 10. | Squad can have at most 14 Players. You have 15. | Physio isn't an allowed Staff role." ] \
  || fail "lineup_violations: reasons: $(lv $S1 '{"starters": [1,2,3,4], "bench": [1,2,3,4,5,6,7,8,9,10], "players": [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15], "staff": ["physio", "manager", "physio"]}')"
[ "$(lv $S1 '{"starters": [1,2,3,4,5], "bench": [6,7,8,9,10,11,12,13,14], "players": [1,2,3,4,5,6,7,8,9,10,11,12,13,14], "staff": ["manager"]}')" = '' ] \
  || fail "lineup_violations: a valid squad has reasons"
[ "$(lv $S1 '{}')|$(lv $S1 '{"staff": ["assistant_coach"]}')" = "|Assistant coach isn't an allowed Staff role." ] || fail "lineup_violations: empty squad or role words"
[ "$(lv $S2 '{"starters": [1], "bench": [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22]}')" = '' ] || fail "lineup_violations: unset rules not skipped"
q "update app.season set starters = 1, max_bench = 1 where id='$S2'" >/dev/null
[ "$(lv $S2 '{"starters": [], "bench": [1,2]}')" = "Line-up needs 1 starter. You've picked 0. | Bench can have at most 1 Player. You've picked 2." ] \
  || fail "lineup_violations: singular: $(lv $S2 '{"starters": [], "bench": [1,2]}')"
! q "select app.lineup_violations('$T4', '{}')" >/dev/null 2>&1 || fail "lineup_violations: unknown season did not raise"
for who in anon $A; do
  out=$(as $who "select app.lineup_violations('$S1', '{}')" 2>&1 || true)
  [[ $out == *"permission denied for function lineup_violations"* ]] || fail "lineup_violations: $who can execute: $out"
done

r=$(as $A "select app.set_structure('$(cmd 110)', '$S1', $v, structure => 'groups_knockout', group_count => 2, teams_per_group => 4, qualifiers_per_group => 2)")
[ "$(q "select (r->>'ok')||(r->>'version') from (select '$r'::jsonb r) x")" = "true$((v + 1))" ] || fail "structure: not ok with version: $r"
v=$((v + 1))
[ "$(struct $S1)" = 'groups_knockout 2 4 2 3 1 0 {h2h_points,h2h_goal_difference,h2h_shootout,goal_difference,goals_scored}' ] || fail "structure: not applied: $(struct $S1)"
[ "$(q "select count(*) from app.activity_log where table_name='season' and op='update' and command_id='$(cmd 110)' and actor='$A'")" = 1 ] \
  || fail "structure: not logged"
[ "$(st $A 110 $S1 $((v - 1)) "structure => 'league'")|$(sver)" = "ok|$v" ] || fail "structure: repeat wrote again"
[ "$(st $A 111 $S1 $v "qualifiers_per_group => 0")" = qualifiers_invalid ] || fail "structure: 0 qualifiers"
[ "$(st $A 112 $S1 $v "qualifiers_per_group => 4")" = qualifiers_invalid ] || fail "structure: qualifiers = teams per group"
[ "$(st $A 113 $S1 $v "teams_per_group => 2")" = qualifiers_invalid ] || fail "structure: teams per group at the qualifiers"
q "update app.season set teams_per_group = null where id='$S2'" >/dev/null
[ "$(as $B "select app.set_structure('$(cmd 123)', '$S2', (select version from app.season where id='$S2'), qualifiers_per_group => 16)->>'code'")" = qualifiers_invalid ] \
  || fail "structure: 16 qualifiers with no group size"
for bad in "structure => 'swiss'" "group_count => 1" "group_count => 17" "teams_per_group => 17" "points_win => 10" "points_draw => -1" \
           "points_loss => 10"; do
  [ "$(st $A 114 $S1 $v "$bad")" = structure_invalid ] || fail "structure: accepted $bad"
  q "delete from app.command_result where command_id='$(cmd 114)'" >/dev/null
done
for bad in "tiebreaks => '{goals_scored,goals_scored}'" "tiebreaks => '{coin_toss}'" "tiebreaks => array[null]::text[]"; do
  [ "$(st $A 115 $S1 $v "$bad")" = tiebreaks_invalid ] || fail "structure: accepted $bad"
  q "delete from app.command_result where command_id='$(cmd 115)'" >/dev/null
done
[ "$(sver)" = "$v" ] || fail "structure: refusals wrote"
[ "$(st $A 116 $S1 $v "tiebreaks => '{h2h_goal_difference,h2h_points,goals_scored}', points_win => 2")" = ok ] || fail "structure: reorder and remove"
v=$((v + 1))
[ "$(struct $S1)" = 'groups_knockout 2 4 2 2 1 0 {h2h_goal_difference,h2h_points,goals_scored}' ] || fail "structure: reorder not applied: $(struct $S1)"
[ "$(st $A 117 $S1 $v "structure => 'league', tiebreaks => '{}'")" = ok ] || fail "structure: league with no tie-breaks"
v=$((v + 1))
r=$(as $A "select app.set_structure('$(cmd 118)', '$S1', $((v - 1)), points_draw => 2)")
[ "$(q "select r->>'code', r->'conflict'->'current'->>'structure', r->'conflict'->'current'->>'tiebreaks', r->'conflict'->'current'->>'qualifiers_per_group'
         from (select '$r'::jsonb r) x")" = 'version_conflict|league|[]|2' ] || fail "structure: conflict envelope: $r"
[ "$(st $B 119 $S1 $v "points_win => 2")" = not_authorized ] || fail "structure: non-member not refused"
[ "$(st $A 120 $S9 1 "tiebreaks => '{goals_scored}'")|$(q "select tiebreaks::text from app.season where id='$S9'")" \
  = 'season_started|{h2h_points,h2h_goal_difference,h2h_shootout,goal_difference,goals_scored}' ] || fail "structure: tie-break change after start"
for f in "set_lineup_rules('$(cmd 121)', '$S1', 1)" "set_structure('$(cmd 122)', '$S1', 1)"; do
  out=$(as anon "select app.$f" 2>&1 || true)
  [[ $out == *"permission denied for function"* ]] || fail "anon: can execute $f: $out"
done

# --- Wizard step 7 (Story 1.13): Sponsors with versions, order and the conflict envelope; empty list is no error.
sp() { as "$1" "select case when (r->>'ok')::boolean then 'ok' else r->>'code' end from app.$2 r"; }
P1=31111111-0000-4000-8000-000000000001 P2=31111111-0000-4000-8000-000000000002 P3=31111111-0000-4000-8000-000000000003
S8=29999999-0000-4000-8000-000000000008
q "insert into app.season (id, tournament_id, number, status) values ('$S8', '$T1', 3, 'finished')" >/dev/null
[ "$(as $A "select count(*) from app.sponsor where season_id='$S1'")" = 0 ] || fail "sponsors: empty Season not an empty list"
add() { sp "$1" "add_sponsor('$(cmd "$2")', '$3', '$4', $5)"; }
r=$(as $A "select app.add_sponsor('$(cmd 130)', '$P1', '$S1', '  Gulmi Hardware ', '$T1/sponsor-logo-1.webp', '{$T1/ad-1.webp,$T1/ad-2.webp}')")
[ "$(q "select (r->>'ok')||coalesce(r->>'version', '-') from (select '$r'::jsonb r) x")" = 'true-' ] || fail "sponsor add: $r"
[ "$(q "select concat_ws('|', tournament_id, caption, logo_path, ad_paths::text, sort, version) from app.sponsor where id='$P1'")" \
  = "$T1|Gulmi Hardware|$T1/sponsor-logo-1.webp|{$T1/ad-1.webp,$T1/ad-2.webp}|0|1" ] || fail "sponsor add: row"
[ "$(q "select count(*) from app.activity_log where table_name='sponsor' and op='insert' and command_id='$(cmd 130)' and actor='$A' and tournament_id='$T1'")" = 1 ] \
  || fail "sponsor add: not logged"
[ "$(as $A "select app.add_sponsor('$(cmd 130)', '$P1', '$S1', 'Other', '$T1/x.webp')")" = "$r" ] || fail "sponsor add: repeat differs"
[ "$(q "select count(*) from app.sponsor")" = 1 ] || fail "sponsor add: repeat wrote again"
[ "$(add $A 131 $P1 $S1 "'Again', '$T1/x.webp'")" = already_exists ] || fail "sponsor add: reused id"
for bad in "E'Two\\nlines', '$T1/x.webp'" "E'Sep\\u2028x', '$T1/x.webp'" "E'Tab\\there', '$T1/x.webp'" "'', '$T1/x.webp'" "'   ', '$T1/x.webp'" \
           "'$(printf 'x%.0s' $(seq 121))', '$T1/x.webp'"; do
  [ "$(add $A 132 $P2 $S1 "$bad")" = caption_invalid ] || fail "sponsor add: caption accepted: $bad"
  q "delete from app.command_result where command_id='$(cmd 132)'" >/dev/null
done
for bad in "'Cap', null" "'Cap', '$T2/x.webp'" "'Cap', 'x.webp'" "'Cap', '$T1/../x.webp'"; do
  [ "$(add $A 133 $P2 $S1 "$bad")" = logo_invalid ] || fail "sponsor add: logo accepted: $bad"
  q "delete from app.command_result where command_id='$(cmd 133)'" >/dev/null
done
for bad in "'{$T2/a.webp}'" "'{$T1/a.webp,$T1/a.webp}'" "array[null]::text[]" "null" \
           "'{$T1/1.webp,$T1/2.webp,$T1/3.webp,$T1/4.webp,$T1/5.webp,$T1/6.webp}'"; do
  [ "$(add $A 134 $P2 $S1 "'Cap', '$T1/x.webp', $bad")" = ads_invalid ] || fail "sponsor add: ads accepted: $bad"
  q "delete from app.command_result where command_id='$(cmd 134)'" >/dev/null
done
[ "$(q "select count(*) from app.sponsor")" = 1 ] || fail "sponsor add: refusals wrote"
[ "$(add $B 135 $P2 $S1 "'Cap', '$T1/x.webp'")" = not_authorized ] || fail "sponsor add: non-member"
[ "$(add $A 136 $P2 $S8 "'Cap', '$T1/x.webp'")" = season_finished ] || fail "sponsor add: finished season"
[ "$(add $A 137 $P2 $S9 "'Started Co', '$T1/x.webp'")" = ok ] || fail "sponsor add: started season refused"
[ "$(add $A 138 $P3 $S1 "'Second Co', '$T1/y.webp', '{}'")|$(q "select sort from app.sponsor where id='$P3'")" = 'ok|1' ] || fail "sponsor add: second not last"
out=$(as anon "select app.add_sponsor('$(cmd 139)', '$P2', '$S1', 'x', '$T1/x.webp')" 2>&1 || true)
[[ $out == *"permission denied for function add_sponsor"* ]] || fail "anon: can execute add_sponsor: $out"
[ "$(as $B "select count(*) from app.sponsor")" = 0 ] || fail "sponsors: B sees A's Sponsors"
for who in anon $A; do
  out=$(as $who "select app.sponsor_invalid('$T1', 'x', 'y', '{}')" 2>&1 || true)
  [[ $out == *"permission denied for function sponsor_invalid"* ]] || fail "sponsor_invalid: $who can execute: $out"
done

ed() { sp "$1" "edit_sponsor('$(cmd "$2")', '$3', '$4', $5)"; }
r=$(as $A "select app.edit_sponsor('$(cmd 140)', '$P1', '$S1', 1, caption => 'Gulmi Hardware & Paints')")
[ "$(q "select (r->>'ok')||(r->>'version') from (select '$r'::jsonb r) x")" = true2 ] || fail "sponsor edit: $r"
[ "$(q "select concat_ws('|', caption, logo_path, cardinality(ad_paths), version) from app.sponsor where id='$P1'")" = "Gulmi Hardware & Paints|$T1/sponsor-logo-1.webp|2|2" ] \
  || fail "sponsor edit: only the caption should change"
[ "$(ed $A 141 $P1 $S1 "2, logo_path => '$T1/logo-2.webp', ad_paths => '{}'")" = ok ] || fail "sponsor edit: logo and ads"
[ "$(q "select logo_path||cardinality(ad_paths)||version from app.sponsor where id='$P1'")" = "$T1/logo-2.webp03" ] || fail "sponsor edit: not applied"
r=$(as $A "select app.edit_sponsor('$(cmd 142)', '$P1', '$S1', 2, caption => 'Stale')")
[ "$(q "select r->>'code', r->'conflict'->>'current_version', r->'conflict'->'current'->>'caption', r->'conflict'->'current'->>'ad_paths', r->'conflict'->>'changed_by'
         from (select '$r'::jsonb r) x")" = 'version_conflict|3|Gulmi Hardware & Paints|[]|a' ] || fail "sponsor edit: conflict envelope: $r"
for bad in "caption => E'a\\nb'|caption_invalid" "logo_path => '$T2/x.webp'|logo_invalid" "ad_paths => '{$T2/x.webp}'|ads_invalid"; do
  [ "$(ed $A 143 $P1 $S1 "3, ${bad%|*}")" = "${bad#*|}" ] || fail "sponsor edit: accepted ${bad%|*}"
  q "delete from app.command_result where command_id='$(cmd 143)'" >/dev/null
done
[ "$(q "select version from app.sponsor where id='$P1'")" = 3 ] || fail "sponsor edit: refusals wrote"
[ "$(ed $A 144 $P1 $S9 "3, caption => 'x'")" = sponsor_missing ] || fail "sponsor edit: other Season's Sponsor"
[ "$(ed $B 145 $P1 $S1 "3, caption => 'x'")" = not_authorized ] || fail "sponsor edit: non-member"

ro() { sp "$1" "reorder_sponsors('$(cmd "$2")', '$3', $4)"; }
order() { q "select string_agg(caption, ',' order by sort, created_at) from app.sponsor where season_id='$S1'"; }
P4=31111111-0000-4000-8000-000000000004
[ "$(add $A 150 $P4 $S1 "'Third Co', '$T1/z.webp'")" = ok ] || fail "sponsor add: third"
[ "$(ro $A 151 $S1 "'{$P4,$P1}'")|$(order)" = 'ok|Third Co,Gulmi Hardware & Paints,Second Co' ] || fail "reorder: listed first, rest after: $(order)"
[ "$(q "select string_agg(version::text, ',' order by sort) from app.sponsor where season_id='$S1'")" = '1,3,1' ] || fail "reorder: bumped a version"
[ "$(ro $A 152 $S1 "'{$P3,$P4,$P1,$P2}'")|$(order)" = 'ok|Second Co,Third Co,Gulmi Hardware & Paints' ] || fail "reorder: full, unknown id ignored"
[ "$(q "select count(*) from app.activity_log where table_name='sponsor' and op='update' and command_id='$(cmd 152)'")" = 3 ] || fail "reorder: not logged"
for bad in null "'{$P1,$P1}'" "array[null]::uuid[]"; do
  [ "$(ro $A 153 $S1 "$bad")" = sponsors_invalid ] || fail "reorder: accepted $bad"
  q "delete from app.command_result where command_id='$(cmd 153)'" >/dev/null
done
[ "$(ro $B 154 $S1 "'{$P1}'")" = not_authorized ] || fail "reorder: non-member"

[ "$(add $A 129 31111111-0000-4000-8000-000000000029 $S1 "E'C1\\u0085x', '$T1/x.webp'")" = caption_invalid ] || fail "sponsor add: C1 control accepted"
[ "$(ed $A 128 $P2 $S9 "1, caption => 'Still editable'")" = ok ] || fail "sponsor edit: started season refused"
q "insert into app.sponsor (id, tournament_id, season_id, logo_path, caption, sort)
   select gen_random_uuid(), '$T1', '$S8', '$T1/f.webp', 'F'||n, n from generate_series(1, 2) n" >/dev/null
[ "$(ed $A 127 $(q "select id from app.sponsor where season_id='$S8' limit 1") $S8 "1, caption => 'x'")" = season_finished ] || fail "sponsor edit: finished season"
[ "$(ro $A 126 $S8 "'{}'")" = season_finished ] || fail "reorder: finished season"
q "insert into app.sponsor (id, tournament_id, season_id, logo_path, caption, sort)
   select gen_random_uuid(), '$T1', '$S9', '$T1/f.webp', 'F'||n, n from generate_series(1, 29) n" >/dev/null
[ "$(add $A 125 31111111-0000-4000-8000-000000000025 $S9 "'Full Co', '$T1/x.webp'")|$(q "select count(*) from app.sponsor where season_id='$S9'")" = 'sponsors_full|30' ] \
  || fail "sponsor add: 31st Sponsor accepted"
de() { sp "$1" "delete_sponsor('$(cmd "$2")', '$3', '$4', $5)"; }
r=$(as $A "select app.delete_sponsor('$(cmd 160)', '$P1', '$S1', 2)")
[ "$(q "select r->>'code', r->'conflict'->'current'->>'caption' from (select '$r'::jsonb r) x")|$(q "select count(*) from app.sponsor where id='$P1'")" \
  = 'version_conflict|Gulmi Hardware & Paints|1' ] || fail "sponsor delete: stale version: $r"
[ "$(de $B 161 $P1 $S1 3)" = not_authorized ] || fail "sponsor delete: non-member"
[ "$(de $A 162 $P1 $S1 3)|$(q "select count(*) from app.sponsor where id='$P1'")" = 'ok|0' ] || fail "sponsor delete"
[ "$(q "select count(*) from app.activity_log where table_name='sponsor' and op='delete' and command_id='$(cmd 162)' and row_id='$P1'")" = 1 ] || fail "sponsor delete: not logged"
[ "$(de $A 163 $P1 $S1 3)" = ok ] || fail "sponsor delete: already gone not ok"
[ "$(ed $A 164 $P1 $S1 "3, caption => 'x'")" = sponsor_missing ] || fail "sponsor edit: deleted Sponsor"
[ "$(de $A 165 $P2 $S8 1)" = season_finished ] || fail "sponsor delete: finished season"
for f in "edit_sponsor('$(cmd 166)', '$P3', '$S1', 1)" "delete_sponsor('$(cmd 167)', '$P3', '$S1', 1)" "reorder_sponsors('$(cmd 168)', '$S1', '{}')"; do
  out=$(as anon "select app.$f" 2>&1 || true)
  [[ $out == *"permission denied for function"* ]] || fail "anon: can execute $f: $out"
done

# Storage: the bucket is public; members write only into their Tournament's folder.
[ "$(q "select case when public then 't' else 'f' end||' '||allowed_mime_types::text||' '||file_size_limit from storage.buckets where id='tournament-assets'")" = 't {image/webp,image/png,image/jpeg} 1048576' ] \
  || fail "storage: bucket missing, not public, or without type and size limits"
obj() { as "$1" "insert into storage.objects (bucket_id, name) values ('$2', '$3')"; }
obj $A tournament-assets "$T1/logo-a.webp" >/dev/null || fail "storage: member cannot upload"
! obj $A tournament-assets "$T2/logo-a.webp" >/dev/null 2>&1 || fail "storage: member wrote into another tournament's folder"
! obj $B tournament-assets "$T1/logo-b.webp" >/dev/null 2>&1 || fail "storage: non-member wrote into the folder"
! obj $A tournament-assets "logo-a.webp" >/dev/null 2>&1 || fail "storage: wrote outside a folder"
! obj $A tournament-assets "not-a-uuid/logo.webp" >/dev/null 2>&1 || fail "storage: wrote into a non-tournament folder"
! obj anon tournament-assets "$T1/logo-x.webp" >/dev/null 2>&1 || fail "storage: anon wrote"
q "insert into storage.buckets (id, name) values ('other', 'other')" >/dev/null
! obj $A other "$T1/logo-a.webp" >/dev/null 2>&1 || fail "storage: wrote into another bucket"
[ "$(as $B "with d as (delete from storage.objects returning 1) select count(*) from d")|$(as $B "with u as (update storage.objects set name = name returning 1) select count(*) from u")" = 0\|0 ] \
  || fail "storage: non-member changed A's file"
[ "$(as $B "select count(*) from storage.objects")|$(as $A "select count(*) from storage.objects")" = 0\|1 ] || fail "storage: select scope"
[ "$(as $A "with u as (update storage.objects set name = name returning 1) select count(*) from u")" = 1 ] || fail "storage: member cannot update (upsert)"
[ "$(as $A "with d as (delete from storage.objects returning 1) select count(*) from d")" = 1 ] || fail "storage: member cannot delete"

# --- Teams and Registration links (Story 2.1). A organises T1 (S1 registration, S9 started, S8 finished); B organises T2
# (S2 setup). Only a token's SHA-256 reaches the server; Story 2.2 redeems by sha256(convert_to(token, 'UTF8')), which must
# equal the client's crypto.subtle hex.
tc() { as "$1" "select case when (r->>'ok')::boolean then 'ok' else r->>'code' end from app.$2 r"; }
hash() { printf %s "$1" | sha256sum | cut -d' ' -f1; }
TK1=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde
H1=$(hash $TK1) H2=$(hash ${TK1/A/B}) H3=$(hash ${TK1/A/C}) H4=$(hash ${TK1/A/D}) H5=$(hash ${TK1/A/E}) H6=$(hash ${TK1/A/F})
[ "$(q "select encode(sha256(convert_to('$TK1', 'UTF8')), 'hex')")" = "$H1" ] || fail "team: server sha256 differs from the client's"
TM1=51111111-0000-4000-8000-000000000001 TM2=51111111-0000-4000-8000-000000000002 TM3=51111111-0000-4000-8000-000000000003
L1=61111111-0000-4000-8000-000000000001 L2=61111111-0000-4000-8000-000000000002 L3=61111111-0000-4000-8000-000000000003
L4=61111111-0000-4000-8000-000000000004 L5=61111111-0000-4000-8000-000000000005 L6=61111111-0000-4000-8000-000000000006
add_t() { tc "$1" "add_team('$(cmd "$2")', '$3', '$4', $5, '$6', '$7', '$8')"; }
active() { q "select coalesce(string_agg(id::text, ',' order by id), 'none') from app.registration_link where team_id='$1' and revoked_at is null"; }
tcounts="select (select count(*) from app.team)||'/'||(select count(*) from app.registration_link)"
r=$(as $A "select app.add_team('$(cmd 300)', '$TM1', '$S1', '  Friends Sporting Wing ', ' fsw ', '$L1', '$H1')")
[ "$(q "select (r->>'ok')||coalesce(r->>'version', 'none') from (select '$r'::jsonb r) x")" = truenone ] || fail "add_team: not ok, or answered a version: $r"
[ "$(q "select concat_ws('|', tournament_id, season_id, name, code, coalesce(kit_colour, 'null'), status, version) from app.team where id='$TM1'")" \
  = "$T1|$S1|Friends Sporting Wing|FSW|null|invited|1" ] || fail "add_team: team row"
[ "$(q "select concat_ws('|', tournament_id, team_id, token_hash, created_by, coalesce(revoked_at::text, 'active'), version) from app.registration_link where id='$L1'")" \
  = "$T1|$TM1|$H1|$A|active|1" ] || fail "add_team: link row"
[ "$(q "select string_agg(table_name||':'||op, ',' order by id) from app.activity_log where command_id='$(cmd 300)' and actor='$A' and tournament_id='$T1'")" \
  = team:insert,registration_link:insert ] || fail "add_team: not logged"
[ "$(q "select count(*) from app.activity_log where strpos(coalesce(after::text, ''), '$TK1') > 0")" = 0 ] || fail "add_team: token in the log"
before=$(q "$tcounts")
[ "$(as $A "select app.add_team('$(cmd 300)', '$TM1', '$S1', 'Again', 'AGN', '$L1', '$H1')")" = "$r" ] || fail "add_team: repeat gave another answer"
[ "$(add_t $A 301 $TM2 $S1 "'Friends United'" ' Fsw' $L2 $H2)" = team_code_taken ] || fail "add_team: duplicate code"
for bad in "'x'|F|$L2|$H2|code_invalid" "'x'|TOOLNG|$L2|$H2|code_invalid" "'x'|F-W|$L2|$H2|code_invalid" "''|FU|$L2|$H2|name_invalid" \
    "'   '|FU|$L2|$H2|name_invalid" "repeat('x', 81)|FU|$L2|$H2|name_invalid" "E'F\\u0085U'|FU|$L2|$H2|name_invalid" \
    "'x'|FU|$L2|${H2:0:63}|token_invalid" "'x'|FU|$L2|${H2^^}|token_invalid" "'x'|FU|$L1|$H2|already_exists" "'x'|FU|$L2|$H1|already_exists"; do
  IFS='|' read -r n c l h want <<<"$bad"
  [ "$(add_t $A 302 $TM2 $S1 "$n" "$c" $l $h)" = "$want" ] || fail "add_team: $bad"
  q "delete from app.command_result where command_id='$(cmd 302)'" >/dev/null
done
[ "$(tc $A "add_team('$(cmd 303)', '$TM1', '$S1', 'x', 'FU', '$L2', '$H2')")" = already_exists ] || fail "add_team: reused team id"
[ "$(tc $A "add_team('$(cmd 304)', '$TM2', '$S1', 'x', 'FU', null, '$H2')")" = token_invalid ] || fail "add_team: null link id"
[ "$(q "$tcounts")" = "$before" ] || fail "add_team: refusals wrote"
[ "$(add_t $U 305 $TM2 $S1 "'x'" FU $L2 $H2)" = email_not_verified ] || fail "add_team: unverified"
[ "$(add_t $A 309 $TM2 21111111-0000-4000-8000-0000000000ff "'x'" FU $L2 $H2)" = not_authorized ] || fail "add_team: unknown season"
[ "$(add_t $A 306 $TM2 $S9 "'x'" FU $L2 $H2)|$(add_t $A 307 $TM2 $S8 "'x'" FU $L2 $H2)" = season_started\|season_finished ] || fail "add_team: closed season"
# The same code in another Season (B's own) is fine.
[ "$(add_t $B 308 $TM2 $S2 "'Friends Sporting Wing'" FSW $L2 $H2)" = ok ] || fail "add_team: same code in another season"

# Revoke: revoked_at set and version bumped once; repeating is ok; the hash is never active again.
rv() { tc "$1" "revoke_registration_link('$(cmd "$2")', '$3', '$4')"; }
[ "$(rv $A 310 $S1 $L1)|$(active $TM1)" = 'ok|none' ] || fail "revoke"
[ "$(q "select (revoked_at is not null)||'/'||version from app.registration_link where id='$L1'")|$(q "select count(*) from app.activity_log where command_id='$(cmd 310)' and table_name='registration_link' and op='update'")" = true/2\|1 ] \
  || fail "revoke: row or log"
[ "$(rv $A 311 $S1 $L1)|$(q "select version from app.registration_link where id='$L1'")" = ok\|2 ] || fail "revoke: again bumped or refused"
[ "$(rv $A 312 $S1 $L6)" = link_missing ] || fail "revoke: unknown link"
# Reissue: a new link after a revoke; then a reissue replaces the active one; a used hash or id is refused.
ri() { tc "$1" "reissue_registration_link('$(cmd "$2")', '$3', '$4', '$5', '$6')"; }
[ "$(ri $A 313 $S1 $TM1 $L3 $H3)|$(active $TM1)" = "ok|$L3" ] || fail "reissue after revoke"
[ "$(ri $A 314 $S1 $TM1 $L4 $H1)|$(ri $A 315 $S1 $TM1 $L1 $H4)|$(active $TM1)" = "already_exists|already_exists|$L3" ] || fail "reissue: old hash or id reused"
[ "$(ri $A 316 $S1 $TM1 $L4 $H4)|$(active $TM1)|$(q "select version from app.registration_link where id='$L3'")" = "ok|$L4|2" ] || fail "reissue: replace"
[ "$(q "select count(*) from app.registration_link where token_hash in ('$H1', '$H3') and revoked_at is null")" = 0 ] || fail "reissue: an old hash is active"
[ "$(q "select string_agg(table_name||':'||op, ',' order by id) from app.activity_log where command_id='$(cmd 316)'")" = registration_link:update,registration_link:insert ] \
  || fail "reissue: not logged"
[ "$(ri $A 317 $S1 $TM1 $L5 ${H5:1})|$(ri $A 318 $S1 $TM3 $L5 $H5)|$(ri $A 319 $S9 $TM1 $L5 $H5)" = token_invalid\|team_missing\|season_started ] \
  || fail "reissue: refusals"
# Revoking works in every Season status; reissuing and adding only in setup and registration.
q "insert into app.team (id, tournament_id, season_id, name, code) values ('$TM3', '$T1', '$S8', 'Old Boys', 'OB');
   insert into app.registration_link (id, tournament_id, team_id, token_hash, created_by) values ('$L5', '$T1', '$TM3', '$H5', '$A')" >/dev/null
[ "$(ri $A 320 $S8 $TM3 $L6 $H6)|$(rv $A 321 $S8 $L5)|$(active $TM3)" = 'season_finished|ok|none' ] || fail "finished season: reissue or revoke"
# Two reissues at once leave exactly one active link (the Team row is locked).
as $A "select app.reissue_registration_link('$(cmd 322)', '$S1', '$TM1', '$L6', '$H6'); select pg_sleep(1)" >/dev/null & held=$!
for _ in $(seq 100); do [ "$(q "select count(*) from pg_stat_activity where state = 'active' and query like '%pg_sleep(1)%' and pid <> pg_backend_pid()")" = 1 ] && break; sleep 0.1; done
L7=61111111-0000-4000-8000-000000000007
[ "$(ri $A 323 $S1 $TM1 $L7 $(hash ${TK1/A/G}))" = ok ] || fail "race: second reissue"
wait $held
[ "$(active $TM1)" = "$L7" ] || fail "race: active links $(active $TM1)"

# Open registration: needs the photo-consent statement and all three dates; moves setup -> registration without a version bump.
op() { tc "$1" "open_registration('$(cmd "$2")', '$3')"; }
v2=$(q "select version from app.season where id='$S2'")
[ "$(op $B 330 $S2)|$(q "select status from app.season where id='$S2'")" = 'setup_incomplete|setup' ] || fail "open_registration: incomplete setup"
q "update app.season set photo_consent = 'Photos may be posted.', starts_on = '2099-12-01', ends_on = '2099-12-10' where id='$S2'" >/dev/null
[ "$(op $B 331 $S2)" = setup_incomplete ] || fail "open_registration: no deadline"
q "update app.season set registration_deadline = '2099-11-20' where id='$S2'" >/dev/null
[ "$(op $B 332 $S2)|$(q "select status||'/'||version from app.season where id='$S2'")" = "ok|registration/$v2" ] || fail "open_registration"
[ "$(q "select count(*) from app.activity_log where command_id='$(cmd 332)' and table_name='season' and after->>'status'='registration'")" = 1 ] \
  || fail "open_registration: not logged"
[ "$(op $B 333 $S2)|$(op $A 334 $S9)|$(op $U 335 $S2)" = 'ok|season_started|email_not_verified' ] || fail "open_registration: already open, started or unverified"

# Leaks: B (T2) and anon read none of T1's Teams, links or their log rows, and none of T1's commands work for B.
[ "$(as $A "select count(*) from app.team where tournament_id='$T1'")|$(as $A "select count(*) from app.registration_link where tournament_id='$T1'")" = 2\|6 ] \
  || fail "team: A cannot read own rows"
[ "$(as $B "select count(*) from app.team where tournament_id<>'$T2'")|$(as $B "select count(*) from app.registration_link where tournament_id<>'$T2'")|$(as $B "select count(*) from app.activity_log where table_name in ('team','registration_link') and tournament_id<>'$T2'")" \
  = 0\|0\|0 ] || fail "leak: B reads T1's Teams, links or their log"
[ "$(as $B "select count(*) from app.team")|$(as $B "select count(*) from app.registration_link")" = 1\|1 ] || fail "team: B cannot read own rows"
for t in team registration_link; do
  ! as anon "select count(*) from app.$t" >/dev/null 2>&1 || fail "leak: anon reads $t"
done
for s in "insert into app.team (id, tournament_id, season_id, name, code) values (gen_random_uuid(), '$T1', '$S1', 'x', 'XX')" \
    "update app.registration_link set revoked_at = null" "delete from app.registration_link" "update app.team set code = 'ZZ'"; do
  ! as $A "$s" >/dev/null 2>&1 || fail "member wrote directly: $s"
done
links=$(q "select string_agg(id||':'||coalesce(revoked_at::text, 'active')||':'||version, ',' order by id) from app.registration_link")
[ "$(add_t $B 340 51111111-0000-4000-8000-000000000009 $S1 "'Stolen'" STL 61111111-0000-4000-8000-000000000009 $(hash x))|$(rv $B 341 $S1 $L7)|$(ri $B 342 $S1 $TM1 61111111-0000-4000-8000-000000000009 $(hash x))|$(op $B 343 $S1)" \
  = 'not_authorized|not_authorized|not_authorized|not_authorized' ] || fail "leak: B's Team commands on T1's Season"
# B naming its own Season with T1's ids touches nothing either.
[ "$(rv $B 344 $S2 $L7)|$(ri $B 345 $S2 $TM1 61111111-0000-4000-8000-000000000009 $(hash x))" = 'link_missing|team_missing' ] || fail "leak: B's Season with T1's ids"
[ "$(q "select string_agg(id||':'||coalesce(revoked_at::text, 'active')||':'||version, ',' order by id) from app.registration_link")" = "$links" ] || fail "leak: links changed"
for f in "add_team('$(cmd 346)', '$TM2', '$S1', 'x', 'XX', '$L6', '$H6')" "open_registration('$(cmd 347)', '$S1')" \
    "revoke_registration_link('$(cmd 348)', '$S1', '$L7')" "reissue_registration_link('$(cmd 349)', '$S1', '$TM1', '$L6', '$H6')"; do
  out=$(as anon "select app.$f" 2>&1 || true)
  [[ $out == *"permission denied for function"* ]] || fail "anon: can execute $f: $out"
done

# --- Co-organisers (Story 1.14). A organises T1, B organises T2; C and D are verified, U is not.
C=dddddddd-0000-4000-8000-000000000004 D=eeeeeeee-0000-4000-8000-000000000005
q "insert into auth.users values ('$C','c@x.test',now()), ('$D','d@x.test',now())" >/dev/null
oc() { as "$1" "select case when (r->>'ok')::boolean then 'ok' else r->>'code' end from app.$2 r"; }
inv() { oc "$1" "invite_organiser('$(cmd "$2")', '$3', '$4', '$5')"; }
acc() { oc "$1" "accept_invite('$(cmd "$2")', '$3')"; }
rm_() { oc "$1" "remove_organiser('$(cmd "$2")', '$3', '$4')"; }
cnl() { oc "$1" "cancel_invite('$(cmd "$2")', '$3', '$4')"; }
members() { q "select string_agg(user_id::text, ',' order by created_at, user_id) from app.organiser_membership where tournament_id='$T1'"; }
tokof() { q "select token from app.organiser_invite where id='$1'"; }
I1=41111111-0000-4000-8000-000000000001 I2=41111111-0000-4000-8000-000000000002 I3=41111111-0000-4000-8000-000000000003
I4=41111111-0000-4000-8000-000000000004 I5=41111111-0000-4000-8000-000000000005 I6=41111111-0000-4000-8000-000000000006
r=$(as $A "select app.invite_organiser('$(cmd 200)', '$I1', '$T1', '  C@X.Test ')")
tok=$(q "select '$r'::jsonb->>'token'")
[ "$(q "select ('$r'::jsonb->>'ok')||' '||(('$r'::jsonb->>'expires_at')::timestamptz between now() + interval '13 days' and now() + interval '15 days')")" = 'true true' ] \
  || fail "invite: not ok with a 14-day expiry: $r"
[[ $tok =~ ^[A-Za-z0-9_-]{43}$ ]] || fail "invite: token not 43 base64url characters: $tok"
[ "$(q "select email||'|'||token||'|'||invited_by from app.organiser_invite where id='$I1'")" = "c@x.test|$tok|$A" ] || fail "invite: row"
[ "$(as $A "select app.invite_organiser('$(cmd 200)', '$I1', '$T1', 'C@x.test')")" = "$r" ] || fail "invite: repeat gave another answer"
[ "$(q "select count(*) from app.activity_log where table_name='organiser_invite' and row_id='$I1' and after->>'token'='token' and after->>'email'='email'")|$(q "select count(*) from app.activity_log where strpos(after::text, '$tok') > 0 or strpos(before::text, '$tok') > 0")" = 1\|0 ] \
  || fail "invite: token or email in the Activity log"
[ "$(inv $A 201 $I2 $T1 c@x.test)" = already_invited ] || fail "invite: second pending invite to the same email"
[ "$(inv $A 202 $I2 $T1 ' A@X.TEST')" = already_organiser ] || fail "invite: an Organiser's email"
for bad in nope 'a b@x.test' '@x.test' "$(printf 'x%.0s' $(seq 250))@x.test" $'d\u200b@x.test' $'d\u00a0x@x.test'; do
  [ "$(inv $A 203 $I2 $T1 "$bad")" = email_invalid ] || fail "invite: accepted email $bad"
  q "delete from app.command_result where command_id='$(cmd 203)'" >/dev/null
done
[ "$(inv $A 204 $I1 $T1 d@x.test)" = already_exists ] || fail "invite: reused id"
[ "$(q "select count(*) from app.organiser_invite")" = 1 ] || fail "invite: refusals wrote"
# Only T1's Organisers read its invites, tokens and Organisers.
[ "$(as $A "select count(*) from app.organiser_invite")|$(as $A "select string_agg(email, ',') from app.organisers('$T1')")" = '1|a@x.test' ] || fail "invite: A cannot read"
[ "$(as $B "select count(*) from app.organiser_invite")|$(as $B "select count(*) from app.organisers('$T1')")" = 0\|0 ] || fail "invite: B reads T1's invites or Organisers"
# Leak: another tenant (B) can't invite, cancel, remove or accept someone else's invite; nothing changes.
[ "$(inv $B 205 $I2 $T1 b2@x.test)|$(cnl $B 206 $I1 $T1)|$(rm_ $B 207 $T1 $A)|$(acc $B 208 "$tok")" = 'not_authorized|not_authorized|not_authorized|invite_wrong_email' ] \
  || fail "leak: B's co-organiser commands on T1"
[ "$(inv $B 209 $I2 $T2 c@x.test)" = ok ] && q "delete from app.organiser_invite where id='$I2'" >/dev/null || fail "invite: B on own T2"
[ "$(acc $U 210 "$tok")" = email_not_verified ] || fail "accept: unverified"
out=$(as anon "select app.accept_invite('$(cmd 211)', '$tok')" 2>&1 || true)
[[ $out == *"permission denied for function accept_invite"* ]] || fail "anon: can execute accept_invite: $out"
[ "$(members)|$(q "select coalesce(accepted_at::text, 'pending') from app.organiser_invite where id='$I1'")" = "$A|pending" ] || fail "accept: wrong email changed something"
# Accept: C organises T1 only.
r=$(as $C "select app.accept_invite('$(cmd 212)', '$tok')")
[ "$(q "select ('$r'::jsonb->>'ok')||('$r'::jsonb->>'tournament_id')")" = "true$T1" ] || fail "accept: $r"
[ "$(members)" = "$A,$C" ] || fail "accept: no membership"
[ "$(as $C "select count(*) from app.tournament")|$(as $C "select count(*) from app.organisers('$T1')")|$(as $C "select count(*) from app.season where tournament_id='$T2'")" = 1\|2\|0 ] \
  || fail "accept: C's reads"
[ "$(acc $C 213 "$tok")|$(acc $B 214 "$tok")|$(acc $D 215 "$tok")|$(acc $D 216 nope)" = 'ok|invite_wrong_email|invite_wrong_email|invite_missing' ] \
  || fail "accept: used token"
[ "$(cnl $A 217 $I1 $T1)" = invite_used ] || fail "cancel: used invite"
# Cancelled and expired invites say so; a new invite is allowed after either.
[ "$(inv $A 218 $I2 $T1 d@x.test)|$(cnl $A 219 $I2 $T1)|$(cnl $A 220 $I2 $T1)|$(acc $D 221 "$(tokof $I2)")" = 'ok|ok|ok|invite_cancelled' ] || fail "cancel"
[ "$(inv $A 222 $I3 $T1 $' \u00a0d@x.test\u200b')|$(q "select email from app.organiser_invite where id='$I3'")" = 'ok|d@x.test' ] \
  || fail "invite after cancel, with invisible characters around the email"
q "update app.organiser_invite set expires_at = now() - interval '1 second' where id='$I3'" >/dev/null
[ "$(acc $D 223 "$(tokof $I3)")|$(inv $C 224 $I4 $T1 d@x.test)|$(cnl $A 225 $I4 $T2)" = 'invite_expired|ok|not_authorized' ] || fail "expired"
[ "$(members)" = "$A,$C" ] || fail "cancelled or expired invite granted something"
# Remove C: C's reads of T1 are empty and C's next commands are not_authorized; C's pending invites are cancelled.
[ "$(rm_ $A 227 $T1 $C)|$(members)" = "ok|$A" ] || fail "remove C"
[ "$(q "select count(*) from app.organiser_invite where id='$I4' and cancelled_at is not null")" = 1 ] || fail "remove: C's invite still pending"
for t in tournament season organiser_membership organiser_invite activity_log sponsor team registration_link; do
  [ "$(as $C "select count(*) from app.$t where to_jsonb($t)::text like '%$T1%'")" = 0 ] || fail "removed C still reads $t"
done
[ "$(as $C "select count(*) from app.organisers('$T1')")" = 0 ] || fail "removed C reads the Organisers"
[ "$(brand $C 228 $T1 2 "name => 'Taken'")|$(inv $C 229 $I5 $T1 x@x.test)|$(cnl $C 230 $I1 $T1)|$(rm_ $C 231 $T1 $A)|$(acc $C 232 "$tok")" \
  = 'not_authorized|not_authorized|not_authorized|not_authorized|invite_used' ] || fail "leak: removed C's commands"
[ "$(rm_ $A 233 $T1 $A)|$(members)" = "last_organiser|$A" ] || fail "remove: last Organiser"
[ "$(rm_ $A 234 $T1 $D)" = ok ] || fail "remove: non-member not ok"
# Self-removal with two Organisers; a pending invite to the removed email is cancelled too.
[ "$(inv $A 235 $I5 $T1 c@x.test)|$(acc $C 236 "$(tokof $I5)")|$(inv $A 237 $I6 $T1 d@x.test)" = ok\|ok\|ok ] || fail "re-invite C"
q "insert into app.organiser_invite (id, tournament_id, email, token, invited_by, expires_at)
   values ('41111111-0000-4000-8000-000000000009', '$T1', 'c@x.test', repeat('c', 43), '$A', now() + interval '1 day')" >/dev/null
[ "$(rm_ $C 238 $T1 $C)|$(members)" = "ok|$A" ] || fail "remove self"
[ "$(q "select string_agg(id::text || ':' || (cancelled_at is not null), ',' order by id) from app.organiser_invite
        where id in ('$I6', '41111111-0000-4000-8000-000000000009')")" = "$I6:false,41111111-0000-4000-8000-000000000009:true" ] \
  || fail "remove: invite to the removed email not cancelled, or another invite cancelled"
# Invite preview (Story 1.14b): anyone with the link sees the email and Tournament name while pending; a dead or
# unknown token gives only its status, or no row. It writes nothing.
pv() { as "$1" "select concat_ws('|', status, email, tournament_name) from app.invite_preview('$2')"; }
name1=$(q "select name from app.tournament where id='$T1'")
logs=$(q "select count(*) from app.activity_log")
[ "$(pv anon "$(tokof $I6)")|$(pv $B "$(tokof $I6)")" = "pending|d@x.test|$name1|pending|d@x.test|$name1" ] || fail "preview: pending"
[ "$(pv anon "$tok")/$(pv anon "$(tokof $I2)")/$(pv anon "$(tokof $I3)")/$(pv anon nope)/$(pv anon '')" = 'used/cancelled/expired//' ] \
  || fail "preview: dead or unknown tokens"
[ "$(q "select count(*) from app.activity_log")" = "$logs" ] || fail "preview: wrote"
! as anon "select count(*) from app.organiser_invite" >/dev/null 2>&1 || fail "preview: anon reads organiser_invite"
# Concurrent removals: A removes C while C removes A; then both remove themselves. One Organiser is always left.
I7=41111111-0000-4000-8000-000000000007 I8=41111111-0000-4000-8000-000000000008
[ "$(inv $A 239 $I7 $T1 c@x.test)|$(acc $C 240 "$(tokof $I7)")" = ok\|ok ] || fail "re-invite C (2)"
as $A "select app.remove_organiser('$(cmd 241)', '$T1', '$C'); select pg_sleep(1)" >/dev/null & held=$!
for _ in $(seq 100); do [ "$(q "select count(*) from pg_stat_activity where state = 'active' and query like '%pg_sleep(1)%' and pid <> pg_backend_pid()")" = 1 ] && break; sleep 0.1; done
[ "$(rm_ $C 242 $T1 $A)" = not_authorized ] || fail "race: removed C removed A"
wait $held
[ "$(members)" = "$A" ] || fail "race: members after A removed C"
[ "$(inv $A 243 $I8 $T1 c@x.test)|$(acc $C 244 "$(tokof $I8)")" = ok\|ok ] || fail "re-invite C (3)"
as $A "select app.remove_organiser('$(cmd 245)', '$T1', '$A'); select pg_sleep(1)" >/dev/null & held=$!
for _ in $(seq 100); do [ "$(q "select count(*) from pg_stat_activity where state = 'active' and query like '%pg_sleep(1)%' and pid <> pg_backend_pid()")" = 1 ] && break; sleep 0.1; done
[ "$(rm_ $C 246 $T1 $C)" = last_organiser ] || fail "race: both left"
wait $held
[ "$(members)" = "$C" ] || fail "race: members after both left"
for f in "invite_organiser('$(cmd 247)', '$I2', '$T1', 'x@x.test')" "cancel_invite('$(cmd 248)', '$I2', '$T1')" \
    "remove_organiser('$(cmd 249)', '$T1', '$C')" "organisers('$T1')"; do
  out=$(as anon "select app.$f" 2>&1 || true)
  [[ $out == *"permission denied for function"* ]] || fail "anon: can execute $f: $out"
done
[ "$(q "select has_function_privilege('authenticated', 'app.lock_membership(uuid, uuid)', 'execute')")" = f ] || fail "lock_membership granted"

# --- Registration grant (Story 2.2). A organises T5 (S5 and S6 in registration); B organises T2 (S2 in registration).
# G1, G2, G3 and G4 are anonymous Team managers (no email). X and Y are Teams of S5, Z of S6, W of B's S2.
T5=11111111-0000-4000-8000-000000000005 S5=21111111-0000-4000-8000-000000000005 S6=21111111-0000-4000-8000-000000000006
G1=f1111111-0000-4000-8000-000000000001 G2=f1111111-0000-4000-8000-000000000002 G3=f1111111-0000-4000-8000-000000000003
G4=f1111111-0000-4000-8000-000000000004
X=71111111-0000-4000-8000-000000000001 Y=71111111-0000-4000-8000-000000000002 Z=71111111-0000-4000-8000-000000000003
W=71111111-0000-4000-8000-000000000004
LX=81111111-0000-4000-8000-000000000001 LY=81111111-0000-4000-8000-000000000002 LZ=81111111-0000-4000-8000-000000000003
LW=81111111-0000-4000-8000-000000000004 LX2=81111111-0000-4000-8000-000000000005 LX3=81111111-0000-4000-8000-000000000006
TX=${TK1/A/x} TY=${TK1/A/y} TZ=${TK1/A/z} TW=${TK1/A/w} TX2=${TK1/A/2} TX3=${TK1/A/3}
q "insert into auth.users (id, is_anonymous) values ('$G1', true), ('$G2', true), ('$G3', true), ('$G4', true)" >/dev/null
[ "$(create $A 500 $T5 $S5 'Grant Cup' | grep -c '"ok": true')" = 1 ] || fail "grant: fixture tournament"
q "update app.season set status = 'registration', registration_deadline = '2099-11-20' where id = '$S5';
   insert into app.season (id, tournament_id, number, status) values ('$S6', '$T5', 2, 'setup');
   update app.season set status = 'registration' where id = '$S6';
   insert into app.team (id, tournament_id, season_id, name, code) values ('$X', '$T5', '$S5', 'Xenon', 'XEN'),
     ('$Y', '$T5', '$S5', 'Yeti', 'YET'), ('$Z', '$T5', '$S6', 'Zeal', 'ZEA'), ('$W', '$T2', '$S2', 'Wolves', 'WOL');
   insert into app.registration_link (id, tournament_id, team_id, token_hash, created_by) values
     ('$LX', '$T5', '$X', '$(hash $TX)', '$A'), ('$LY', '$T5', '$Y', '$(hash $TY)', '$A'),
     ('$LZ', '$T5', '$Z', '$(hash $TZ)', '$A'), ('$LW', '$T2', '$W', '$(hash $TW)', '$B')" >/dev/null
rd() { tc "$1" "redeem_registration_link('$(cmd "$2")', '$3')"; }
et() { tc "$1" "edit_team('$(cmd "$2")', '$3', $4, $5)"; }
ver() { q "select version from app.team where id='$1'"; }
seen() { as "$1" "select coalesce(string_agg(id::text, ',' order by id), 'none') from app.team"; }
form() { as "$1" "select coalesce((select concat_ws('|', tournament_name, season_number, season_status, registration_deadline) from app.registration_form()), 'none')"; }
# Every command except the grant's own, called as $1 with ids of T5, S5, X and LX: all must be not_authorized.
others=$(q "select string_agg(format('%s(%s)', p.proname, (select string_agg(format('%s => %s', a.n, case
    when a.n = 'command_id' then 'gen_random_uuid()' when a.n = 'tournament_id' then quote_literal('$T5')
    when a.n = 'season_id' then quote_literal('$S5') when a.n = 'team_id' then quote_literal('$X')
    when a.n = 'link_id' then quote_literal('$LX') when a.t = 'uuid'::regtype then 'gen_random_uuid()'
    when a.t in ('integer'::regtype, 'smallint'::regtype, 'numeric'::regtype) then '1' when a.t = 'boolean'::regtype then 'true' when a.t = 'date'::regtype then '''2026-12-01''' when a.t = 'timestamptz'::regtype then 'now()'
    when a.t in ('text[]'::regtype, 'uuid[]'::regtype, 'jsonb'::regtype) then '''{}''' else '''x''' end), ', ' order by a.o)
    from unnest(p.proargnames, p.proargtypes::oid[]::regtype[]) with ordinality a(n, t, o))), E'\n' order by p.proname)
  from pg_proc p where p.pronamespace = 'app'::regnamespace and p.prorettype = 'jsonb'::regtype
    and p.proname <> all ('$helpers'::name[] || '{redeem_registration_link,edit_team,discard_command,add_player,edit_player,remove_player,add_staff,edit_staff,remove_staff,submit_team,add_eligibility,edit_eligibility,set_photo,request_scorer_approval}'::name[])")
[ "$(wc -l <<<"$others")" -ge 20 ] || fail "grant: too few commands listed: $others"
refused_all() {
  while IFS= read -r f; do
    [ "$(tc "$1" "$f")" = not_authorized ] || fail "grant: $1 ran $f"
  done <<<"$others"
}

# No grant yet: an anonymous user reads nothing and changes nothing.
[ "$(seen $G1)|$(form $G1)|$(et $G1 500 $X 1 "name => 'Taken'")" = 'none|none|not_authorized' ] || fail "grant: before redeeming"
# Redeem: the server hashes the token; a bad or unknown token is link_dead; a repeat gives the same answer.
r=$(as $G1 "select app.redeem_registration_link('$(cmd 501)', '$TX')")
[ "$(q "select (r->>'ok')||(r->>'team_id') from (select '$r'::jsonb r) x")" = "true$X" ] || fail "redeem: $r"
[ "$(as $G1 "select app.redeem_registration_link('$(cmd 501)', '$TX')")" = "$r" ] || fail "redeem: repeat gave another answer"
[ "$(q "select concat_ws('|', link_id, team_id, season_id, tournament_id) from app.registration_grant where id='$G1'")" = "$LX|$X|$S5|$T5" ] \
  || fail "redeem: grant row"
[ "$(q "select count(*) from app.activity_log where table_name='registration_grant' and actor='$G1' and tournament_id='$T5' and command_id='$(cmd 501)'")|$(q "select count(*) from app.activity_log where strpos(coalesce(after::text, ''), '$TX') > 0")" = 1\|0 ] \
  || fail "redeem: not logged, or token in the log"
[ "$(rd $G2 502 nope)|$(rd $G2 503 '')|$(rd $G2 504 "$(hash $TY)")|$(q "select count(*) from app.registration_grant where id='$G2'")" = 'link_dead|link_dead|link_dead|0' ] \
  || fail "redeem: bad tokens (or the stored hash itself) accepted"
[ "$(rd $A 505 $TY)|$(rd $U 506 $TY)" = 'not_authorized|email_not_verified' ] || fail "redeem: an account redeemed a link"
# The grant reads its own Team and the form's Season facts, nothing else.
[ "$(seen $G1)|$(form $G1)" = "$X|Grant Cup|1|registration|2099-11-20" ] || fail "grant: G1's reads"
tables=$(q "select string_agg(table_name, ' ' order by table_name) from information_schema.role_table_grants
             where grantee = 'authenticated' and table_schema = 'app' and privilege_type = 'SELECT'
               and table_name not in ('team', 'format_preset', 'season_transition', 'season_action')")
[[ " $tables " == *" registration_grant "*" season "* ]] || fail "grant: leak table list: $tables"
for t in $tables; do
  [ "$(as $G1 "select count(*) from app.$t")" = 0 ] || fail "leak: grant holder reads $t"
done
[ "$(as $G1 "select count(*) from app.organisers('$T5')")" = 0 ] || fail "leak: grant holder reads the Organisers"
refused_all $G1
# edit_team as the grant: only its Team; name, code and kit colour each alone; versioned.
[ "$(et $G1 510 $X 1 "name => '  Xenon FC '")|$(et $G1 511 $X 2 "code => ' xfc'")|$(et $G1 512 $X 3 "kit_colour => '#FFAA00'")" = ok\|ok\|ok ] \
  || fail "edit_team: grant edits"
[ "$(q "select concat_ws('|', name, code, kit_colour, version) from app.team where id='$X'")" = 'Xenon FC|XFC|#ffaa00|4' ] || fail "edit_team: row"
r=$(as $G1 "select app.edit_team('$(cmd 513)', '$X', 4, name => 'Xenon')")
[ "$(q "select (r->>'ok')||(r->>'version') from (select '$r'::jsonb r) x")" = true5 ] || fail "edit_team: answer lacks the new version: $r"
[ "$(q "select count(*) from app.activity_log where table_name='team' and row_id='$X' and actor='$G1' and op='update'")" = 4 ] || fail "edit_team: not logged"
[ "$(et $G1 514 $Y 1 "name => 'Taken'")|$(et $G1 515 $Z 1 "name => 'Taken'")|$(et $G1 516 $W 1 "name => 'Taken'")" \
  = 'not_authorized|not_authorized|not_authorized' ] || fail "leak: grant edits another Team"
[ "$(tc $G1 "edit_team('$(cmd 517)', '$X', 5, code => 'YET')")|$(tc $G1 "edit_team('$(cmd 518)', '$X', 5, code => 'ZEA')")" = 'team_code_taken|ok' ] \
  || fail "edit_team: code unique per Season only"
for bad in "code => 'X'|code_invalid" "code => 'X-Y'|code_invalid" "name => ''|name_invalid" "name => repeat('x', 81)|name_invalid" \
    "kit_colour => 'red'|colour_invalid" "kit_colour => '#fff'|colour_invalid"; do
  IFS='|' read -r a want <<<"$bad"
  [ "$(et $G1 519 $X 6 "$a")" = "$want" ] || fail "edit_team: $bad"
  q "delete from app.command_result where command_id='$(cmd 519)'" >/dev/null
done
# Conflicts name a role, never an email; an Organiser edits the same Team through the same command.
[ "$(et $A 520 $X 6 "name => 'Xenon United'")" = ok ] || fail "edit_team: Organiser"
r=$(as $G1 "select app.edit_team('$(cmd 521)', '$X', 6, name => 'Mine')")
[ "$(q "select concat_ws('|', r->>'code', r->'conflict'->>'current_version', r->'conflict'->'current'->>'name', r->'conflict'->'current'->>'code', r->'conflict'->>'changed_by') from (select '$r'::jsonb r) x")" \
  = 'version_conflict|7|Xenon United|ZEA|Organiser' ] || fail "edit_team: conflict for the grant: $r"
r=$(as $A "select app.edit_team('$(cmd 522)', '$X', 6, name => 'Theirs')")
[ "$(q "select r->'conflict'->>'changed_by' from (select '$r'::jsonb r) x")|$(et $G1 523 $X 7 "name => 'Xenon'")" = 'Organiser|ok' ] || fail "edit_team: conflict for A"
r=$(as $A "select app.edit_team('$(cmd 524)', '$X', 7, name => 'Theirs')")
[ "$(q "select r->'conflict'->>'changed_by' from (select '$r'::jsonb r) x")" = 'Team manager' ] || fail "edit_team: changed_by for the grant's change: $r"
[ "$(et $G1 528 $X 8 "name => null")|$(ver $X)" = ok\|8 ] || fail "edit_team: nothing to change bumped the version"
[ "$(et $B 525 $X 8 "name => 'Stolen'")|$(et $B 526 $W 1 "name => 'Wolves FC'")" = 'not_authorized|ok' ] || fail "edit_team: other tenant"
# A discard by the grant holder is logged with no Tournament.
[ "$(tc $G1 "discard_command('$(cmd 527)', '$(cmd 521)', 'edit_team', '$X', 'Keep theirs')")" = ok ] || fail "grant: discard"
[ "$(q "select count(*) from app.discarded_command where id='$(cmd 521)' and tournament_id is null and actor='$G1'")" = 1 ] || fail "grant: discard row"
# Organisers see their Tournament's grants; another tenant doesn't.
[ "$(as $A "select count(*) from app.registration_grant")|$(as $B "select count(*) from app.registration_grant")" = 1\|0 ] || fail "grant: Organiser reads"

# Another Season's Team: G3's grant for Z; once S6 starts, it reads but can't edit.
[ "$(rd $G3 530 $TZ)|$(seen $G3)|$(et $G3 531 $Z 1 "kit_colour => '#ffffff'")" = "ok|$Z|ok" ] || fail "grant: G3 on S6"
q "update app.season set status = 'started' where id='$S6'" >/dev/null
[ "$(et $G3 532 $Z 2 "name => 'Late'")|$(form $G3)" = 'season_started|Grant Cup|2|started' ] || fail "grant: started Season"
# Replacing the grant: G2 redeems Y, then B's W; Y is gone at once.
[ "$(rd $G2 533 $TY)|$(seen $G2)|$(rd $G2 534 $TW)|$(seen $G2)|$(et $G2 535 $Y 1 "name => 'Gone'")" = "ok|$Y|ok|$W|not_authorized" ] \
  || fail "grant: replaced"
[ "$(q "select count(*) from app.registration_grant")" = 3 ] || fail "grant: one grant per user"
# Revoke, then reissue: the old grant is dead at once and its token never redeems again; the new token does.
[ "$(rv $A 540 $S5 $LX)|$(seen $G1)|$(form $G1)|$(et $G1 541 $X 8 "name => 'After'")|$(rd $G1 542 $TX)" = 'ok|none|none|not_authorized|link_dead' ] \
  || fail "revoke: grant still works"
refused_all $G1
[ "$(ri $A 543 $S5 $X $LX2 $(hash $TX2))|$(seen $G1)|$(rd $G1 544 $TX)|$(rd $G1 545 $TX2)|$(seen $G1)" = "ok|none|link_dead|ok|$X" ] \
  || fail "reissue after revoke: $(seen $G1)"
[ "$(ri $A 546 $S5 $X $LX3 $(hash $TX3))|$(seen $G1)|$(form $G1)|$(et $G1 547 $X 8 "name => 'After'")|$(rd $G1 548 $TX2)" = 'ok|none|none|not_authorized|link_dead' ] \
  || fail "reissue: old grant still works"
# An anonymous user that never redeemed gets nothing.
[ "$(seen $G4)|$(form $G4)" = 'none|none' ] || fail "grant: G4 reads"
refused_all $G4
for f in "redeem_registration_link('$(cmd 549)', '$TX3')" "edit_team('$(cmd 550)', '$X', 1, 'x')" "registration_form()" "granted_team()"; do
  out=$(as anon "select app.$f" 2>&1 || true)
  [[ $out == *"permission denied for function"* ]] || fail "anon: can execute $f: $out"
done
! as anon "select count(*) from app.registration_grant" >/dev/null 2>&1 || fail "leak: anon reads registration_grant"
for s in "insert into app.registration_grant (id, link_id, team_id, season_id, tournament_id) values ('$G4', '$LX3', '$X', '$S5', '$T5')" \
    "update app.team set name = 'Direct'" "delete from app.registration_grant"; do
  ! as $G1 "$s" >/dev/null 2>&1 || fail "grant holder wrote directly: $s"
done

# --- Players and Staff (Story 2.3). A organises T5 (S5 in registration, S6 started); B organises T2. G1 holds X's grant
# (link LX3), G5 Y's (LY), G2 W's (B's T2), G3 Z's (S6). S5: 2 starters, 1 on the bench (Squad 2 to 3), Staff manager
# and coach. Minor: under 18 on today's Kathmandu date; exactly 18 today is an adult.
G5=f1111111-0000-4000-8000-000000000005
P1=91111111-0000-4000-8000-000000000001 P2=91111111-0000-4000-8000-000000000002 P3=91111111-0000-4000-8000-000000000003
P4=91111111-0000-4000-8000-000000000004 P5=91111111-0000-4000-8000-000000000005 P6=91111111-0000-4000-8000-000000000006
SF1=a1111111-0000-4000-8000-000000000001 SF2=a1111111-0000-4000-8000-000000000002 SF3=a1111111-0000-4000-8000-000000000003
q "insert into auth.users (id, is_anonymous) values ('$G5', true);
   update app.season set starters = 2, max_bench = 1, staff_roles = '{manager,coach}', photo_consent = 'Photos may be used.' where id = '$S5'" >/dev/null
[ "$(rd $G1 600 $TX3)|$(rd $G5 601 $TY)" = 'ok|ok' ] || fail "squad: fixture grants"
kt="(now() at time zone 'Asia/Kathmandu')::date"
today=$(q "select $kt") adult=$(q "select ($kt - interval '18 years')::date") minor=$(q "select ($kt - interval '18 years' + interval '1 day')::date")
kid=$(q "select ($kt - interval '12 years')::date") grown=$(q "select ($kt - interval '25 years')::date") later=$(q "select ($kt + 1)")
ap() { tc "$1" "add_player('$(cmd "$2")', '$3', '$4', $5)"; }
ep() { tc "$1" "edit_player('$(cmd "$2")', '$3', '$4', $5)"; }
pv() { q "select version from app.player where id='$1'"; }
redo() { q "delete from app.command_result where command_id='$(cmd "$1")'" >/dev/null; }
msg() { as "$1" "select r->>'message' from app.$2 r"; }

# lineup_violations: a complete Squad needs at least the starters; other callers see no minimum.
[ "$(lv $S5 '{"players": [1], "complete": true}')|$(lv $S5 '{"players": [1]}')|$(lv $S5 '{"players": [1, 2], "complete": true}')" \
  = "Squad needs at least 2 Players. You have 1.||" ] || fail "lineup_violations: minimum"
[ "$(lv $S2 '{"players": [], "complete": true}')" = "Squad needs at least 1 Player. You have 0." ] || fail "lineup_violations: minimum singular"

# Add: a minor with a guardian's name; one call writes the Player, the Squad entry and the consent; repeat answers alike.
[ "$(ap $G1 610 $X $P1 "name => '  Bisho Basnet ', shirt_number => 7, date_of_birth => '$kid', consent => true, given_by => ' Mina Basnet '")" = ok ] \
  || fail "add_player: minor with guardian"
[ "$(q "select concat_ws('|', p.tournament_id, p.name, p.date_of_birth, p.version, e.team_id, e.shirt_number, c.season_id, c.consent_given, c.given_by)
       from app.player p join app.squad_entry e on e.player_id = p.id join app.photo_consent c on c.player_id = p.id where p.id = '$P1'")" \
  = "$T5|Bisho Basnet|$kid|1|$X|7|$S5|t|Mina Basnet" ] || fail "add_player: rows"
[ "$(ap $G1 610 $X $P1 "name => 'Again', shirt_number => 8, date_of_birth => '$kid', consent => false")|$(q "select count(*) from app.player")" = 'ok|1' ] \
  || fail "add_player: repeat wrote again"
[ "$(q "select string_agg(table_name || ':' || (actor = '$G1') || ':' || coalesce(after->>'date_of_birth', after->>'given_by', '-'), ',' order by id)
       from app.activity_log where command_id = '$(cmd 610)'")" = 'player:true:date_of_birth,squad_entry:true:-,photo_consent:true:given_by' ] \
  || fail "add_player: log rows, or personal fields logged by value"
# Consent needs a name: a parent or guardian's for a minor (the day before the 18th birthday too), else the giver's.
[ "$(ap $G1 611 $X $P2 "name => 'Anup', shirt_number => 9, date_of_birth => '$minor', consent => true")" = guardian_required ] || fail "minor without guardian"
[ "$(msg $G1 "add_player('$(cmd 612)', '$X', '$P2', 'Anup', 9, '$kid', true, '   ')")" = "Add the parent or guardian's name." ] || fail "minor: blank guardian"
[ "$(ap $G1 613 $X $P2 "name => 'Anup', shirt_number => 9, date_of_birth => '$adult', consent => true")" = consent_name_required ] || fail "adult without a name"
[ "$(ap $G1 614 $X $P2 "name => 'Anup', shirt_number => 9, date_of_birth => '$minor', consent => false, given_by => 'Ignored'")" = ok ] || fail "minor without consent"
[ "$(q "select concat(c.consent_given, coalesce(c.given_by, 'null')) from app.photo_consent c where c.player_id = '$P2'")" = fnull ] || fail "no consent kept a name"
for bad in "name => '', shirt_number => 10, date_of_birth => '$grown', consent => false|name_invalid" \
    "name => 'Z', shirt_number => 0, date_of_birth => '$grown', consent => false|shirt_invalid" \
    "name => 'Z', shirt_number => 100, date_of_birth => '$grown', consent => false|shirt_invalid" \
    "name => 'Z', shirt_number => 10, date_of_birth => '$later', consent => false|dob_invalid" \
    "name => 'Z', shirt_number => 10, date_of_birth => '1939-12-31', consent => false|dob_invalid" \
    "name => 'Z', shirt_number => 10, date_of_birth => null, consent => false|dob_invalid" \
    "name => 'Z', shirt_number => 10, date_of_birth => '$grown', consent => true, given_by => repeat('x', 81)|given_by_invalid" \
    "name => 'Z', shirt_number => 7, date_of_birth => '$grown', consent => false|shirt_taken" \
    "name => 'Z', shirt_number => 10, date_of_birth => '$grown', consent => false, player_id => '$P1'|already_exists"; do
  IFS='|' read -r a want <<<"$bad"
  pid=$P6; [[ $a == *"player_id =>"* ]] && { pid=; a=${a/, player_id => /|}; IFS='|' read -r a pid <<<"$a"; pid=${pid//\'/}; }
  [ "$(ap $G1 615 $X $pid "$a")" = "$want" ] || fail "add_player: $bad"
  redo 615
done
[ "$(q "select count(*) from app.player")|$(q "select count(*) from app.squad_entry where player_id = '$P1'")" = '2|1' ] || fail "add_player: refusals wrote"
# Squad size: the 3rd Player fits, the 4th is refused in words.
[ "$(ap $G1 616 $X $P3 "name => 'Sita KC', shirt_number => 10, date_of_birth => '$grown', consent => true, given_by => 'Sita KC'")" = ok ] || fail "3rd player"
[ "$(msg $G1 "add_player('$(cmd 617)', '$X', '$P4', 'Extra', 11, '$grown', false)")|$(as $G1 "select r->>'code' from app.add_player('$(cmd 617)', '$X', '$P4', 'Extra', 11, '$grown', false) r")" \
  = 'Squad can have at most 3 Players. You have 4.|lineup_violation' ] || fail "squad full"
[ "$(q "select count(*) from app.player where id = '$P4'")" = 0 ] || fail "squad full: wrote"

# Reads: the grant reads its own Team's Squad and consent; Y's grant, another Tournament's Organiser and grant read none.
squad() { as "$1" "select (select count(*) from app.player)||'/'||(select count(*) from app.squad_entry)||'/'||(select count(*) from app.photo_consent)||'/'||(select count(*) from app.staff)"; }
[ "$(squad $G1)|$(squad $A)|$(squad $G5)|$(squad $B)|$(squad $G2)|$(squad $G3)|$(squad $G4)" = '3/3/3/0|3/3/3/0|0/0/0/0|0/0/0/0|0/0/0/0|0/0/0/0|0/0/0/0' ] \
  || fail "leak: squad reads $(squad $G5) $(squad $B)"
for t in player squad_entry photo_consent staff; do
  ! as anon "select count(*) from app.$t" >/dev/null 2>&1 || fail "leak: anon reads $t"
done
rr() { as "$1" "select coalesce((select concat_ws('|', consent_statement, starters, max_bench, staff_roles) from app.registration_rules()), 'none')"; }
[ "$(rr $G1)|$(rr $A)|$(rr $G4)" = 'Photos may be used.|2|1|{manager,coach}|none|none' ] || fail "registration_rules: $(rr $G1) $(rr $A)"
# Y's grant can't touch X's Players, through Y or X.
[ "$(ep $G5 620 $Y $P1 "1, name => 'Stolen'")|$(ep $G5 621 $X $P1 "1, name => 'Stolen'")|$(ap $G5 622 $X $P5 "name => 'Z', shirt_number => 20, date_of_birth => '$grown', consent => false")" \
  = 'player_missing|not_authorized|not_authorized' ] || fail "leak: Y's grant changes X's Player"
[ "$(tc $G5 "remove_player('$(cmd 623)', '$Y', '$P1', 1)")|$(tc $G5 "remove_player('$(cmd 624)', '$X', '$P1', 1)")|$(tc $G5 "submit_team('$(cmd 625)', '$X')")" \
  = 'ok|not_authorized|not_authorized' ] || fail "leak: Y's grant removes or submits for X"
[ "$(q "select count(*) from app.squad_entry where player_id = '$P1' and team_id = '$X'")|$(q "select status from app.team where id = '$X'")" = '1|invited' ] \
  || fail "leak: X's Squad changed by Y's grant"
[ "$(ep $B 626 $X $P1 "1, name => 'Stolen'")|$(tc $B "add_staff('$(cmd 627)', '$X', '$SF3', 'Z', 'coach')")" = 'not_authorized|not_authorized' ] \
  || fail "leak: another Tournament's Organiser changes X"

# Edit: each field alone, versioned; the Organiser too; conflicts name a role; consent and the minor rule.
[ "$(ep $G1 630 $X $P1 "1, name => 'Bisho B'")|$(ep $G1 631 $X $P1 "2, shirt_number => 9")|$(ep $G1 632 $X $P1 "2, shirt_number => 8")|$(pv $P1)" = 'ok|shirt_taken|ok|3' ] \
  || fail "edit_player: name and shirt"
r=$(as $G1 "select app.edit_player('$(cmd 633)', '$X', '$P1', 3, date_of_birth => '$minor')")
[ "$(q "select (r->>'ok')||(r->>'version') from (select '$r'::jsonb r) x")|$(q "select date_of_birth from app.player where id='$P1'")" = "true4|$minor" ] \
  || fail "edit_player: date of birth: $r"
[ "$(ep $G1 634 $X $P1 "4")|$(pv $P1)" = 'ok|4' ] || fail "edit_player: nothing to change bumped the version"
[ "$(ep $G1 635 $X $P1 "4, consent => false")|$(q "select concat(consent_given, coalesce(given_by, 'null')) from app.photo_consent where player_id='$P1'")" = 'ok|fnull' ] \
  || fail "edit_player: consent withdrawn"
[ "$(ep $G1 636 $X $P1 "5, consent => true")|$(ep $G1 637 $X $P1 "5, consent => true, given_by => 'Hari Basnet'")" = 'guardian_required|ok' ] \
  || fail "edit_player: consent again for a minor"
[ "$(q "select concat(consent_given, given_by) from app.photo_consent where player_id='$P1'")" = 'tHari Basnet' ] || fail "edit_player: consent row"
# An adult consenting for themselves who turns out a minor: the guardian's name is needed with the change.
[ "$(ep $G1 638 $X $P3 "1, date_of_birth => '$kid'")|$(ep $G1 639 $X $P3 "1, date_of_birth => '$kid', given_by => 'Gita KC'")" = 'guardian_required|ok' ] \
  || fail "edit_player: becoming a minor"
[ "$(ep $A 640 $X $P1 "6, name => 'Bisho Basnet'")" = ok ] || fail "edit_player: Organiser"
r=$(as $G1 "select app.edit_player('$(cmd 641)', '$X', '$P1', 6, name => 'Mine')")
[ "$(q "select concat_ws('|', r->>'code', r->'conflict'->>'current_version', r->'conflict'->'current'->>'name', r->'conflict'->'current'->>'shirt_number',
         r->'conflict'->'current'->>'date_of_birth', r->'conflict'->'current'->>'consent', r->'conflict'->'current'->>'given_by', r->'conflict'->>'changed_by') from (select '$r'::jsonb r) x")" \
  = "version_conflict|7|Bisho Basnet|8|$minor|true|Hari Basnet|Organiser" ] || fail "edit_player: conflict: $r"
[ "$(ep $G1 642 $X $P1 "7, name => 'Bisho'")" = ok ] || fail "edit_player: after conflict"
r=$(as $A "select app.edit_player('$(cmd 643)', '$X', '$P1', 7, name => 'Theirs')")
[ "$(q "select r->'conflict'->>'changed_by' from (select '$r'::jsonb r) x")" = 'Team manager' ] || fail "edit_player: changed_by for the grant: $r"
for bad in "name => ''|name_invalid" "shirt_number => 100|shirt_invalid" "date_of_birth => '$later'|dob_invalid" "given_by => repeat('x', 81)|given_by_invalid"; do
  IFS='|' read -r a want <<<"$bad"
  [ "$(ep $G1 644 $X $P1 "8, $a")" = "$want" ] || fail "edit_player: $bad"
  redo 644
done
[ "$(pv $P1)" = 8 ] || fail "edit_player: refusals wrote"

# No date of birth or consent name ever reaches the Activity log, only the field names.
for v in "$kid" "$minor" "$grown" Mina Hari Gita; do
  [ "$(q "select count(*) from app.activity_log where strpos(coalesce(before::text, '') || coalesce(after::text, ''), '$v') > 0 and table_name <> 'season'")" \
    = 0 ] || fail "personal value in the Activity log: $v"
done
[ "$(q "select count(*) from app.activity_log where table_name = 'player' and after->>'date_of_birth' = 'date_of_birth'")" -ge 5 ] || fail "player log rows"

# Remove: versioned; a Player in no other Squad goes with their consent; already gone is ok.
[ "$(tc $G1 "remove_player('$(cmd 650)', '$X', '$P2', 2)")|$(tc $G1 "remove_player('$(cmd 651)', '$X', '$P2', 1)")" = 'version_conflict|ok' ] || fail "remove_player"
[ "$(q "select concat((select count(*) from app.player where id='$P2'), (select count(*) from app.photo_consent where player_id='$P2'), (select count(*) from app.squad_entry where player_id='$P2'))")" = 000 ] \
  || fail "remove_player: rows left"
[ "$(q "select before->>'date_of_birth' from app.activity_log where table_name='player' and op='delete' and row_id='$P2'")|$(tc $G1 "remove_player('$(cmd 652)', '$X', '$P2', 1)")" = 'date_of_birth|ok' ] \
  || fail "remove_player: log or repeat"
# A Player also in another Squad stays (Organiser puts P1 in Y too), only X's entry goes.
q "insert into app.squad_entry (tournament_id, team_id, player_id, shirt_number) values ('$T5', '$Y', '$P1', 4)" >/dev/null
[ "$(tc $A "remove_player('$(cmd 653)', '$Y', '$P1', $(pv $P1))")|$(q "select count(*) from app.player where id='$P1'")|$(q "select count(*) from app.photo_consent where player_id='$P1'")" = 'ok|1|1' ] \
  || fail "remove_player: Player in another Squad"

# Staff: only allowed roles; versioned edits and removes; Y's grant can't reach X's Staff.
ast() { tc "$1" "add_staff('$(cmd "$2")', '$3', '$4', $5)"; }
[ "$(ast $G1 660 $X $SF1 "' Ram Thapa ', 'manager'")|$(q "select concat_ws('|', tournament_id, team_id, name, role, version) from app.staff where id='$SF1'")" = "ok|$T5|$X|Ram Thapa|manager|1" ] \
  || fail "add_staff"
[ "$(msg $G1 "add_staff('$(cmd 661)', '$X', '$SF2', 'Hari', 'physio')")|$(ast $G1 662 $X $SF2 "'Hari', null")|$(ast $G1 663 $X $SF2 "'', 'coach'")|$(ast $G1 664 $X $SF1 "'Dup', 'coach'")" \
  = "Physio isn't an allowed Staff role.|role_required|name_invalid|already_exists" ] || fail "add_staff: refusals"
[ "$(ast $G1 665 $X $SF2 "'Hari', 'coach'")" = ok ] || fail "add_staff: coach"
es() { tc "$1" "edit_staff('$(cmd "$2")', '$3', '$4', $5)"; }
[ "$(es $G1 666 $X $SF1 "1, role => 'coach'")|$(es $G1 667 $X $SF1 "2, role => 'doctor'")|$(es $G1 668 $X $SF1 "1, name => 'Old'")|$(es $G5 669 $Y $SF1 "2, name => 'Stolen'")|$(es $G1 670 $X $SF1 "2")" \
  = 'ok|lineup_violation|version_conflict|staff_missing|ok' ] || fail "edit_staff"
r=$(as $G1 "select app.edit_staff('$(cmd 671)', '$X', '$SF1', 1, name => 'Old')")
[ "$(q "select concat_ws('|', r->'conflict'->>'current_version', r->'conflict'->'current'->>'name', r->'conflict'->'current'->>'role', r->'conflict'->>'changed_by') from (select '$r'::jsonb r) x")" \
  = '2|Ram Thapa|coach|Team manager' ] || fail "edit_staff: conflict: $r"

# Send for review: the whole Squad and Staff against the rules, in words; then Submitted (version kept); Organiser sees it.
q "update app.season set staff_roles = '{manager}' where id = '$S5'" >/dev/null
[ "$(msg $G1 "submit_team('$(cmd 680)', '$X')")" = "Coach isn't an allowed Staff role." ] || fail "submit_team: staff role"
q "update app.season set staff_roles = '{manager,coach}' where id = '$S5'" >/dev/null
[ "$(tc $G1 "remove_staff('$(cmd 681)', '$X', '$SF2', 2)")|$(tc $G1 "remove_staff('$(cmd 682)', '$X', '$SF2', 1)")|$(tc $G1 "remove_staff('$(cmd 683)', '$X', '$SF2', 1)")|$(q "select count(*) from app.staff where id='$SF2'")" \
  = 'version_conflict|ok|ok|0' ] || fail "remove_staff"
[ "$(tc $G1 "remove_player('$(cmd 689)', '$X', '$P3', $(pv $P3))")" = ok ] || fail "remove P3"
[ "$(msg $G1 "submit_team('$(cmd 684)', '$X')")" = "Squad needs at least 2 Players. You have 1." ] || fail "submit_team: too few"
[ "$(ap $G1 685 $X $P5 "name => 'Yugal', shirt_number => 11, date_of_birth => '$grown', consent => false")" = ok ] || fail "squad: 2nd player"
tv=$(ver $X)
[ "$(tc $G1 "submit_team('$(cmd 686)', '$X')")|$(q "select status from app.team where id='$X'")|$(ver $X)|$(tc $G1 "submit_team('$(cmd 687)', '$X')")" = "ok|submitted|$tv|ok" ] \
  || fail "submit_team"
[ "$(as $A "select status from app.team where id='$X'")|$(as $B "select count(*) from app.team where id='$X'")" = 'submitted|0' ] || fail "submit_team: Organiser reads"
q "update app.team set status = 'approved' where id = '$Y'" >/dev/null
[ "$(tc $A "submit_team('$(cmd 688)', '$Y')")" = team_approved ] || fail "submit_team: approved"
q "update app.team set status = 'invited' where id = '$Y'" >/dev/null
# Started Season: no Squad changes; revoked link: no reads or changes.
[ "$(ap $G3 690 $Z $P6 "name => 'Late', shirt_number => 1, date_of_birth => '$grown', consent => false")|$(tc $G3 "submit_team('$(cmd 691)', '$Z')")" = 'season_started|season_started' ] \
  || fail "squad: started Season"
[ "$(rv $A 692 $S5 $LX3)|$(squad $G1)|$(ap $G1 693 $X $P6 "name => 'Gone', shirt_number => 12, date_of_birth => '$grown', consent => false")|$(es $G1 694 $X $SF1 "2, name => 'Gone'")" \
  = 'ok|0/0/0/0|not_authorized|not_authorized' ] || fail "squad: revoked link"
for f in "add_player('$(cmd 695)', '$X', '$P6', 'x', 1, '2000-01-01', false)" "edit_player('$(cmd 696)', '$X', '$P1', 1)" "remove_player('$(cmd 697)', '$X', '$P1', 1)" \
    "add_staff('$(cmd 698)', '$X', '$SF3', 'x', 'coach')" "edit_staff('$(cmd 699)', '$X', '$SF1', 1)" "remove_staff('$(cmd 700)', '$X', '$SF1', 1)" \
    "submit_team('$(cmd 701)', '$X')" "registration_rules()"; do
  out=$(as anon "select app.$f" 2>&1 || true)
  [[ $out == *"permission denied for function"* ]] || fail "anon: can execute $f: $out"
done
for f in "conflict('$T5', 'player', '$P1', 1, '{}')"; do
  out=$(as $A "select app.$f" 2>&1 || true)
  [[ $out == *"permission denied for function"* ]] || fail "client can execute $f: $out"
done

# --- Eligibility proof (Story 2.4). A organises T5 (S5 in registration, S6 started); B organises T2. X's link was revoked
# above: A reissues it (LX4) and G1 redeems it again. X's Squad: P1 (minor) and P5; G5 holds Y's grant (Y has no Players),
# G3 Z's (S6 started), G4 none. Scans: <tournament>/<team>/<player>/<uuid>.webp in the private eligibility-scans bucket.
LX4=81111111-0000-4000-8000-000000000007 TX4=${TK1/A/4}
R1=b1111111-0000-4000-8000-000000000001 R2=b1111111-0000-4000-8000-000000000002 R3=b1111111-0000-4000-8000-000000000003
U1=c2111111-0000-4000-8000-000000000001 U2=c2111111-0000-4000-8000-000000000002 U3=c2111111-0000-4000-8000-000000000003
[ "$(ri $A 800 $S5 $X $LX4 $(hash $TX4))|$(rd $G1 801 $TX4)" = 'ok|ok' ] || fail "eligibility: fixture grant"
[ "$(q "select case when public then 't' else 'f' end||' '||allowed_mime_types::text||' '||file_size_limit from storage.buckets where id='eligibility-scans'")" \
  = 'f {image/webp,image/png} 1048576' ] || fail "eligibility: bucket missing, public, or without type and size limits"
# Stricter than membership: the table has exactly one policy, Organisers' select (no Scorer or grant policy).
[ "$(q "select string_agg(policyname||':'||cmd||':'||array_to_string(roles, ',')||':'||qual, ';') from pg_policies where schemaname='app' and tablename='eligibility_record'")" \
  = 'organiser_read:SELECT:authenticated:app.is_member(tournament_id)' ] || fail "eligibility: table policies"

# Storage: the grant adds its own Team's scans only, and reads none back, not even its own; Organisers read; nobody else.
scan() { as "$1" "select count(*) from storage.objects where bucket_id = 'eligibility-scans'"; }
obj $G1 eligibility-scans "$T5/$X/$P1/$U1.webp" >/dev/null || fail "scan: grant cannot upload into its Team's folder"
for p in "$T5/$Y/$P1/$U2.webp" "$T5/$X/$P6/$U2.webp" "$T2/$X/$P1/$U2.webp" "$T5/$X/$U2.webp" "$T5/$X/$P1/x/$U2.webp" "$T5/$X/nope/$U2.webp"; do
  ! obj $G1 eligibility-scans "$p" >/dev/null 2>&1 || fail "scan: grant uploaded to $p"
done
! obj $G1 tournament-assets "$T5/$X/$P1/$U2.webp" >/dev/null 2>&1 || fail "scan: grant wrote into tournament-assets"
! obj $G5 eligibility-scans "$T5/$X/$P1/$U2.webp" >/dev/null 2>&1 || fail "scan: Y's grant uploaded into X's folder"
! obj $B eligibility-scans "$T5/$X/$P1/$U2.webp" >/dev/null 2>&1 || fail "scan: another Tournament's Organiser uploaded"
! obj $G3 eligibility-scans "$T5/$Z/$P1/$U2.webp" >/dev/null 2>&1 || fail "scan: grant uploaded once the Season started"
! obj $G4 eligibility-scans "$T5/$X/$P1/$U2.webp" >/dev/null 2>&1 || fail "scan: anonymous user without a grant uploaded"
! obj anon eligibility-scans "$T5/$X/$P1/$U2.webp" >/dev/null 2>&1 || fail "scan: anon uploaded"
obj $A eligibility-scans "$T5/$X/$P5/$U2.webp" >/dev/null || fail "scan: Organiser cannot upload"
# Organisers read only a scan an unverified record points to (Story 2.7): none yet.
[ "$(scan $G1)|$(scan $G5)|$(scan $B)|$(scan $G3)|$(scan $G4)|$(scan anon)|$(scan $A)" = '0|0|0|0|0|0|0' ] \
  || fail "leak: scan objects read $(scan $G1) $(scan $B) $(scan anon) $(scan $A)"
for who in $G1 $A; do
  [ "$(as $who "with u as (update storage.objects set name = name where bucket_id = 'eligibility-scans' returning 1) select count(*) from u")|$(as $who "with d as (delete from storage.objects where bucket_id = 'eligibility-scans' returning 1) select count(*) from d")" = '0|0' ] \
    || fail "scan: $who changed or deleted a scan object"
done

# add_eligibility: insert-only, any fields; the number is trimmed; a repeat answers alike; personal fields logged by name.
ae() { tc "$1" "add_eligibility('$(cmd "$2")', '$3', '$4', '$5', $6)"; }
ee() { tc "$1" "edit_eligibility('$(cmd "$2")', '$3', '$4', $5)"; }
r=$(as $G1 "select app.add_eligibility('$(cmd 810)', '$X', '$P1', '$R1', 'emis', ' 430010248 ')")
[ "$(q "select (r->>'ok')||coalesce(r->>'version', '-') from (select '$r'::jsonb r) x")" = true- ] || fail "add_eligibility: $r"
[ "$(q "select concat_ws('|', tournament_id, player_id, season_id, document_type, document_number, coalesce(scan_path, '-'), version) from app.eligibility_record where id='$R1'")" \
  = "$T5|$P1|$S5|emis|430010248|-|1" ] || fail "add_eligibility: row"
[ "$(as $G1 "select app.add_eligibility('$(cmd 810)', '$X', '$P1', '$R1', 'passport', '1')")|$(q "select count(*) from app.eligibility_record")" = "$r|1" ] \
  || fail "add_eligibility: repeat wrote again"
[ "$(ae $G1 811 $X $P5 $R2 "scan_path => '$T5/$X/$P5/$U2.webp', scan_name => ' emis-yugal.jpg '")" = ok ] || fail "add_eligibility: scan only"
[ "$(q "select concat_ws('|', document_type is null, scan_path, scan_name, scan_uploaded_at is not null) from app.eligibility_record where id='$R2'")" \
  = "t|$T5/$X/$P5/$U2.webp|emis-yugal.jpg|t" ] || fail "add_eligibility: scan row"
[ "$(q "select string_agg(table_name||':'||coalesce(after->>'document_number', '-')||':'||coalesce(after->>'scan_path', '-')||':'||coalesce(after->>'scan_name', '-')||':'||(actor = '$G1'), ',' order by id)
       from app.activity_log where command_id in ('$(cmd 810)', '$(cmd 811)')")" \
  = 'eligibility_record:document_number:-:-:true,eligibility_record:-:scan_path:scan_name:true' ] || fail "add_eligibility: log rows, or personal fields by value"
for bad in "$P1|$R3|'emis'|eligibility_exists" "$P5|$R3|'emis'|eligibility_exists" "$P2|$R3|'emis'|player_missing" \
    "$P1|$R3|'licence'|type_invalid" "$P1|$R3|null, repeat('9', 41)|number_invalid" "$P1|$R3|null, '   '|number_invalid" \
    "$P1|$R3|null, E'12\\n3'|number_invalid" \
    "$P1|$R3|scan_path => '$T5/$Y/$P1/$U3.webp', scan_name => 'a.jpg'|scan_invalid" \
    "$P1|$R3|scan_path => '$T5/$X/$P5/$U3.webp', scan_name => 'a.jpg'|scan_invalid" \
    "$P1|$R3|scan_path => '$T5/$X/$P1/$U3.png', scan_name => 'a.jpg'|scan_invalid" \
    "$P1|$R3|scan_path => '$T5/$X/$P1/$U3.webp'|scan_invalid" "$P1|$R3|scan_name => 'a.jpg'|scan_invalid" \
    "$P1|$R3|scan_path => '$T5/$X/$P1/$U3.webp', scan_name => repeat('n', 121)|scan_invalid"; do
  IFS='|' read -r pl rid a want <<<"$bad"
  [ "$(ae $G1 812 $X $pl $rid "$a")" = "$want" ] || fail "add_eligibility: $bad"
  redo 812
done
q "delete from app.eligibility_record where id='$R2'" >/dev/null
[ "$(ae $G1 813 $X $P5 $R1 "'emis'")" = already_exists ] || fail "add_eligibility: reused id"
[ "$(ae $G1 814 $X $P5 $R2 "'citizenship', '12-34', '$T5/$X/$P5/$U2.webp', 'emis-yugal.jpg'")" = ok ] || fail "add_eligibility: all fields"

# Fences: Y's grant, another Tournament's Organiser, a started Season and anon can't add or change X's records.
[ "$(ae $G5 815 $X $P1 $R3 "'emis'")|$(ae $G5 816 $Y $P1 $R3 "'emis'")|$(ee $G5 817 $Y $P1 "1, document_number => '1'")|$(ae $B 818 $X $P1 $R3 "'emis'")|$(ee $B 819 $X $P1 "1, document_number => '1'")|$(ae $G3 820 $Z $P1 $R3 "'emis'")" \
  = 'not_authorized|player_missing|player_missing|not_authorized|not_authorized|season_started' ] || fail "leak: eligibility commands across Teams"
for f in "add_eligibility('$(cmd 821)', '$X', '$P1', '$R3', 'emis')" "edit_eligibility('$(cmd 822)', '$X', '$P1', 1, 'emis')" \
    "registration_eligibility()" "can_upload_scan('$T5/$X/$P1/$U3.webp')"; do
  out=$(as anon "select app.$f" 2>&1 || true)
  [[ $out == *"permission denied for function"* ]] || fail "anon: can execute $f: $out"
done
out=$(as $A "select app.eligibility_invalid(null::app.team, null, null, null, null, null)" 2>&1 || true)
[[ $out == *"permission denied for function"* ]] || fail "client can execute eligibility_invalid: $out"

# Reads: the grant reads its own Team's records through the helper, without the scan path, and never the table.
re() { as "$1" "select coalesce(string_agg(concat_ws(':', player_id, coalesce(document_type, '-'), coalesce(document_number, '-'), coalesce(scan_name, '-'), verified, version), ',' order by player_id), 'none') from app.registration_eligibility()"; }
[ "$(re $G1)" = "$P1:emis:430010248:-:f:1,$P5:citizenship:12-34:emis-yugal.jpg:f:1" ] || fail "registration_eligibility: $(re $G1)"
[ "$(as $G1 "select count(*) from app.registration_eligibility() r where to_jsonb(r)::text ~ '$U2'")" = 0 ] || fail "registration_eligibility: scan path read"
rt() { as "$1" "select count(*) from app.eligibility_record"; }
[ "$(rt $G1)|$(rt $G5)|$(rt $B)|$(rt $G3)|$(rt $G4)|$(rt $A)|$(re $G5)|$(re $B)|$(re $G4)|$(re $A)" = '0|0|0|0|0|2|none|none|none|none' ] \
  || fail "leak: eligibility reads $(rt $G1) $(rt $B) $(rt $A)"
! as anon "select count(*) from app.eligibility_record" >/dev/null 2>&1 || fail "leak: anon reads eligibility_record"
for s in "insert into app.eligibility_record (id, tournament_id, player_id, season_id) values ('$R3', '$T5', '$P1', '$S5')" \
    "update app.eligibility_record set document_number = '1'" "delete from app.eligibility_record"; do
  ! as $G1 "$s" >/dev/null 2>&1 || fail "grant holder wrote eligibility_record directly: $s"
  ! as $A "$s" >/dev/null 2>&1 || fail "Organiser wrote eligibility_record directly: $s"
done

# edit_eligibility: versioned, each field alone, scan path and name together; conflicts never carry the scan path.
[ "$(ee $G1 830 $X $P1 "1, document_number => '430010249'")|$(ee $G1 831 $X $P1 "2, scan_path => '$T5/$X/$P1/$U1.webp', scan_name => 'emis-bisho.jpg'")|$(ee $G1 832 $X $P1 "3, document_type => 'birth_certificate'")" \
  = 'ok|ok|ok' ] || fail "edit_eligibility: fields"
[ "$(q "select concat_ws('|', document_type, document_number, scan_path, scan_name, scan_uploaded_at is not null, version) from app.eligibility_record where id='$R1'")" \
  = "birth_certificate|430010249|$T5/$X/$P1/$U1.webp|emis-bisho.jpg|t|4" ] || fail "edit_eligibility: row"
r=$(as $G1 "select app.edit_eligibility('$(cmd 833)', '$X', '$P1', 4)")
[ "$(q "select (r->>'ok')||(r->>'version') from (select '$r'::jsonb r) x")" = true4 ] || fail "edit_eligibility: nothing to change: $r"
[ "$(ee $A 834 $X $P1 "4, document_number => '430010250'")" = ok ] || fail "edit_eligibility: Organiser"
r=$(as $G1 "select app.edit_eligibility('$(cmd 835)', '$X', '$P1', 4, document_number => 'mine')")
[ "$(q "select concat_ws('|', r->>'code', r->'conflict'->>'current_version', r->'conflict'->'current'->>'document_type', r->'conflict'->'current'->>'document_number', r->'conflict'->'current'->>'scan_name', r->'conflict'->>'changed_by', r::text ~ '$U1') from (select '$r'::jsonb r) x")" \
  = 'version_conflict|5|birth_certificate|430010250|emis-bisho.jpg|Organiser|f' ] || fail "edit_eligibility: conflict: $r"
r=$(as $A "select app.edit_eligibility('$(cmd 836)', '$X', '$P5', 9, document_number => 'x')")
[ "$(q "select r->'conflict'->>'changed_by' from (select '$r'::jsonb r) x")" = 'Team manager' ] || fail "edit_eligibility: changed_by for the grant: $r"
for bad in "document_type => 'licence'|type_invalid" "document_number => ''|number_invalid" "scan_path => '$T5/$X/$P5/$U3.webp', scan_name => 'a.jpg'|scan_invalid" \
    "scan_name => 'a.jpg'|scan_invalid"; do
  IFS='|' read -r a want <<<"$bad"
  [ "$(ee $G1 837 $X $P1 "5, $a")" = "$want" ] || fail "edit_eligibility: $bad"
  redo 837
done
q "update app.eligibility_record set verified_by = '$A', verified_at = now() where id = '$R2'" >/dev/null
[ "$(ee $G1 838 $X $P5 "1, document_number => 'changed'")|$(re $G1 | cut -d, -f2 | cut -d: -f5)" = 'eligibility_verified|t' ] || fail "edit_eligibility: verified"
[ "$(ee $G5 839 $Y $P5 "1, document_number => 'x'")|$(ee $G5 840 $X $P1 "5, document_number => 'x'")" = 'player_missing|not_authorized' ] || fail "leak: Y edits X's record"

# A Player with no record: eligibility_missing; removing a Player takes their record with them.
[ "$(ap $G1 841 $X $P4 "name => 'Extra', shirt_number => 12, date_of_birth => '$grown', consent => false")|$(ee $G1 842 $X $P4 "1, document_type => 'emis'")" \
  = 'ok|eligibility_missing' ] || fail "edit_eligibility: no record"
[ "$(ae $G1 843 $X $P4 $R3 "'passport', 'PA123'")|$(tc $G1 "remove_player('$(cmd 844)', '$X', '$P4', 1)")|$(q "select count(*) from app.eligibility_record where id='$R3'")|$(q "select count(*) from app.player where id='$P4'")" \
  = 'ok|ok|0|0' ] || fail "remove_player: Eligibility record left"
[ "$(q "select before->>'document_number' from app.activity_log where table_name='eligibility_record' and op='delete' and row_id='$R3'")" = document_number ] \
  || fail "remove_player: record delete not logged by name"

# No document number, file name or scan path ever reaches the Activity log.
for v in 430010248 430010249 430010250 12-34 PA123 emis-yugal emis-bisho "$U1" "$U2"; do
  [ "$(q "select count(*) from app.activity_log where strpos(coalesce(before::text, '') || coalesce(after::text, ''), '$v') > 0")" = 0 ] \
    || fail "personal value in the Activity log: $v"
done

# Revoked link: no reads, no commands, no uploads.
[ "$(rv $A 850 $S5 $LX4)|$(re $G1)|$(ee $G1 851 $X $P1 "5, document_number => 'x'")|$(ae $G1 852 $X $P1 $R3 "'emis'")" = 'ok|none|not_authorized|not_authorized' ] \
  || fail "eligibility: revoked link"
! obj $G1 eligibility-scans "$T5/$X/$P1/$U3.webp" >/dev/null 2>&1 || fail "scan: revoked grant uploaded"

# --- Player and Staff photos (Story 2.5). A organises T5 (S5 in registration, S6 started); B organises T2. X's link was
# revoked above: A reissues it (LX5) and G1 redeems it again. X's Squad: P1 (minor, consent from a guardian) and P5 (no
# consent); X's Staff: SF1. G5 holds Y's grant (Y has no Players), G3 Z's (S6 started), G4 none.
# Photos: <tournament>/<team>/<person>/<uuid>.webp in the private player-photos bucket.
LX5=81111111-0000-4000-8000-000000000008 TX5=${TK1/A/5}
V1=d2111111-0000-4000-8000-000000000001 V2=d2111111-0000-4000-8000-000000000002 V3=d2111111-0000-4000-8000-000000000003
V4=d2111111-0000-4000-8000-000000000004
[ "$(ri $A 900 $S5 $X $LX5 $(hash $TX5))|$(rd $G1 901 $TX5)" = 'ok|ok' ] || fail "photos: fixture grant"
q "update app.photo_consent set consent_given = true, given_by = 'Mina Basnet' where player_id = '$P1' and season_id = '$S5';
   update app.photo_consent set consent_given = false, given_by = null where player_id = '$P5' and season_id = '$S5'" >/dev/null
[ "$(q "select case when public then 't' else 'f' end||' '||allowed_mime_types::text||' '||file_size_limit from storage.buckets where id='player-photos'")" \
  = 'f {image/webp,image/png} 2097152' ] || fail "photos: bucket missing, public, or without type and size limits"

# Storage: the grant adds and reads its own Team's photos (Squad and Staff) only; Organisers too; nobody else.
pho() { as "$1" "select count(*) from storage.objects where bucket_id = 'player-photos'"; }
obj $G1 player-photos "$T5/$X/$P1/$V1.webp" >/dev/null || fail "photo: grant cannot upload a Player's photo"
obj $G1 player-photos "$T5/$X/$SF1/$V2.webp" >/dev/null || fail "photo: grant cannot upload a Staff photo"
for p in "$T5/$Y/$P1/$V3.webp" "$T5/$X/$P6/$V3.webp" "$T2/$X/$P1/$V3.webp" "$T5/$X/$V3.webp" "$T5/$X/$P1/x/$V3.webp" "$T5/$X/nope/$V3.webp"; do
  ! obj $G1 player-photos "$p" >/dev/null 2>&1 || fail "photo: grant uploaded to $p"
done
! obj $G5 player-photos "$T5/$X/$P1/$V3.webp" >/dev/null 2>&1 || fail "photo: Y's grant uploaded into X's folder"
! obj $B player-photos "$T5/$X/$P1/$V3.webp" >/dev/null 2>&1 || fail "photo: another Tournament's Organiser uploaded"
! obj $G3 player-photos "$T5/$Z/$P1/$V3.webp" >/dev/null 2>&1 || fail "photo: grant uploaded once the Season started"
! obj $G4 player-photos "$T5/$X/$P1/$V3.webp" >/dev/null 2>&1 || fail "photo: anonymous user without a grant uploaded"
! obj anon player-photos "$T5/$X/$P1/$V3.webp" >/dev/null 2>&1 || fail "photo: anon uploaded"
obj $A player-photos "$T5/$X/$P5/$V3.webp" >/dev/null || fail "photo: Organiser cannot upload"
[ "$(pho $G1)|$(pho $G5)|$(pho $B)|$(pho $G3)|$(pho $G4)|$(pho anon)|$(pho $A)" = '3|0|0|0|0|0|3' ] \
  || fail "leak: photo objects read $(pho $G1) $(pho $G5) $(pho $B) $(pho anon) $(pho $A)"
for who in $G1 $A; do
  [ "$(as $who "with u as (update storage.objects set name = name where bucket_id = 'player-photos' returning 1) select count(*) from u")|$(as $who "with d as (delete from storage.objects where bucket_id = 'player-photos' returning 1) select count(*) from d")" = '0|0' ] \
    || fail "photo: $who changed or deleted a photo object"
done

# set_photo: a Player's or Staff member's photo, versioned on that person; the path logged by name only.
sp_() { tc "$1" "set_photo('$(cmd "$2")', '$3', '$4', $5)"; }
r=$(as $G1 "select app.set_photo('$(cmd 910)', '$X', '$P1', $(pv $P1), '$T5/$X/$P1/$V1.webp', true)")
[ "$(q "select (r->>'ok')||(r->>'version') from (select '$r'::jsonb r) x")" = "true$(pv $P1)" ] || fail "set_photo: $r"
[ "$(q "select concat_ws('|', photo_path, is_cutout) from app.player where id='$P1'")" = "$T5/$X/$P1/$V1.webp|t" ] || fail "set_photo: row"
[ "$(as $G1 "select app.set_photo('$(cmd 910)', '$X', '$P1', 1, '$T5/$X/$P1/$V4.webp', false)")" = "$r" ] || fail "set_photo: repeat ran again"
sv1=$(q "select version from app.staff where id='$SF1'")
[ "$(sp_ $G1 911 $X $SF1 "$sv1, '$T5/$X/$SF1/$V2.webp', false")|$(q "select concat_ws('|', photo_path, is_cutout, version) from app.staff where id='$SF1'")" \
  = "ok|$T5/$X/$SF1/$V2.webp|f|$((sv1 + 1))" ] || fail "set_photo: Staff kept with its background"
[ "$(q "select string_agg(table_name||':'||coalesce(after->>'photo_path', '-')||':'||(actor = '$G1'), ',' order by id) from app.activity_log where command_id in ('$(cmd 910)', '$(cmd 911)')")" \
  = 'player:photo_path:changed:true,staff:photo_path:changed:true' ] || fail "set_photo: log rows, or the path logged by value"
v1=$(pv $P1)
for bad in "$P1|'$T5/$X/$P5/$V3.webp', true|photo_invalid" "$P1|'$T5/$X/$P1/$V3.png', true|photo_invalid" \
    "$P1|'$T5/$Y/$P1/$V3.webp', true|photo_invalid" "$P1|'$T5/$X/$P1/$V3.webp', null|photo_invalid" "$P1|null, true|photo_invalid" \
    "$P6|'$T5/$X/$P6/$V3.webp', true|person_missing"; do
  IFS='|' read -r who a want <<<"$bad"
  [ "$(sp_ $G1 912 $X $who "$v1, $a")" = "$want" ] || fail "set_photo: $bad"
  redo 912
done
r=$(as $G1 "select app.set_photo('$(cmd 913)', '$X', '$P1', $((v1 - 1)), '$T5/$X/$P1/$V3.webp', false)")
[ "$(q "select concat_ws('|', r->>'code', r->'conflict'->>'current_version', r->'conflict'->'current'->>'is_cutout', r::text ~ '$V1') from (select '$r'::jsonb r) x")" \
  = "version_conflict|$v1|true|f" ] || fail "set_photo: conflict: $r"

# Fences: Y's grant, another Tournament's Organiser, a started Season and anon can't set X's photos.
[ "$(sp_ $G5 914 $X $P1 "$v1, '$T5/$X/$P1/$V3.webp', true")|$(sp_ $G5 915 $Y $P1 "$v1, '$T5/$Y/$P1/$V3.webp', true")|$(sp_ $B 916 $X $P1 "$v1, '$T5/$X/$P1/$V3.webp', true")|$(sp_ $G3 917 $Z $P1 "$v1, '$T5/$Z/$P1/$V3.webp', true")" \
  = 'not_authorized|person_missing|not_authorized|season_started' ] || fail "leak: set_photo across Teams"
for f in "set_photo('$(cmd 918)', '$X', '$P1', 1, '$T5/$X/$P1/$V3.webp', true)" "can_use_photo('$T5/$X/$P1/$V3.webp', true)"; do
  out=$(as anon "select app.$f" 2>&1 || true)
  [[ $out == *"permission denied for function"* ]] || fail "anon: can execute $f: $out"
done
! as anon "select count(*) from app.player_photo_public" >/dev/null 2>&1 || fail "leak: anon reads player_photo_public"

# The consent gate: a path only with consent (from a guardian for this minor) and a cut-out; else null.
[ "$(sp_ $A 920 $X $P5 "$(pv $P5), '$T5/$X/$P5/$V3.webp', true")" = ok ] || fail "set_photo: Organiser"
gate() { as "$1" "select coalesce(string_agg(player_id||':'||coalesce(photo_path, 'null'), ',' order by player_id), 'none') from app.player_photo_public where team_id = '$X'"; }
[ "$(gate $A)" = "$P1:$T5/$X/$P1/$V1.webp,$P5:null" ] || fail "player_photo_public: consent and cut-out: $(gate $A)"
[ "$(sp_ $G1 921 $X $P1 "$v1, '$T5/$X/$P1/$V4.webp', false")|$(gate $A)" = "ok|$P1:null,$P5:null" ] || fail "player_photo_public: kept photo given as a cut-out"
[ "$(sp_ $G1 922 $X $P1 "$((v1 + 1)), '$T5/$X/$P1/$V1.webp', true")|$(gate $G1)" = "ok|$P1:$T5/$X/$P1/$V1.webp,$P5:null" ] || fail "player_photo_public: grant read"
q "update app.photo_consent set consent_given = false, given_by = null where player_id = '$P1' and season_id = '$S5'" >/dev/null
[ "$(gate $A)" = "$P1:null,$P5:null" ] || fail "player_photo_public: photo without consent"
q "delete from app.photo_consent where player_id = '$P1' and season_id = '$S5'" >/dev/null
[ "$(gate $A)" = "$P1:null,$P5:null" ] || fail "player_photo_public: photo with no consent row"
q "insert into app.photo_consent (tournament_id, player_id, season_id, consent_given, given_by) values ('$T5', '$P1', '$S5', true, 'Mina Basnet')" >/dev/null
[ "$(gate $A)|$(gate $G5)|$(gate $B)|$(gate $G3)|$(gate $G4)" = "$P1:$T5/$X/$P1/$V1.webp,$P5:null|none|none|none|none" ] || fail "leak: player_photo_public read across Teams"

# No photo path reaches the Activity log.
for v in "$V1" "$V2" "$V3" "$V4"; do
  [ "$(q "select count(*) from app.activity_log where strpos(coalesce(before::text, '') || coalesce(after::text, ''), '$v') > 0")" = 0 ] \
    || fail "photo path in the Activity log: $v"
done

# Revoked link: no reads, no commands, no uploads.
[ "$(rv $A 930 $S5 $LX5)|$(pho $G1)|$(gate $G1)|$(sp_ $G1 931 $X $P1 "$(pv $P1), '$T5/$X/$P1/$V3.webp', true")" = 'ok|0|none|not_authorized' ] \
  || fail "photos: revoked link"
! obj $G1 player-photos "$T5/$X/$P1/$V4.webp" >/dev/null 2>&1 || fail "photo: revoked grant uploaded"

# --- Organiser enters a Team from a paper sheet (Story 2.6). A organises T5 (S5 in registration: Squad 2 to 3, Staff
# manager and coach); B organises T2. Q is added by A and its link never shared; the same commands run as the Organiser,
# with the same Line-up and Photo consent checks. G5 holds Y's grant. Later G6 redeems Q's link: a manager's edit and an
# Organiser's edit of the same Player conflict either way round.
Q=71111111-0000-4000-8000-000000000006 LQ=81111111-0000-4000-8000-000000000009 TQ=${TK1/A/q} G6=f1111111-0000-4000-8000-000000000006
Q1=91111111-0000-4000-8000-000000000011 Q2=91111111-0000-4000-8000-000000000012 Q3=91111111-0000-4000-8000-000000000013
Q4=91111111-0000-4000-8000-000000000014 QS=a1111111-0000-4000-8000-000000000011 QR=b1111111-0000-4000-8000-000000000011
QV=d2111111-0000-4000-8000-000000000011
q "insert into auth.users (id, is_anonymous) values ('$G6', true)" >/dev/null
[ "$(add_t $A 1400 $Q $S5 "'Paper Sheet FC'" PSF $LQ $(hash $TQ))" = ok ] || fail "paper: add Team"
[ "$(tc $A "edit_team('$(cmd 1401)', '$Q', 1, kit_colour => '#1d4ed8')")" = ok ] || fail "paper: Organiser edits Team details"
[ "$(ap $A 1402 $Q $Q1 "name => 'Sita Rana', shirt_number => 4, date_of_birth => '$kid', consent => true")" = guardian_required ] \
  || fail "paper: minor's consent without a guardian accepted from the Organiser"
[ "$(ap $A 1403 $Q $Q1 "name => 'Sita Rana', shirt_number => 4, date_of_birth => '$kid', consent => true, given_by => 'Gita Rana'")|$(ap $A 1404 $Q $Q2 "name => 'Rita Rana', shirt_number => 5, date_of_birth => '$grown', consent => false")|$(ap $A 1405 $Q $Q3 "name => 'Mina Rana', shirt_number => 6, date_of_birth => '$grown', consent => false")" \
  = 'ok|ok|ok' ] || fail "paper: Organiser adds Players"
[ "$(msg $A "add_player('$(cmd 1406)', '$Q', '$Q4', 'Too Many', 7, '$grown', false)")" = "Squad can have at most 3 Players. You have 4." ] \
  || fail "paper: Line-up rules not applied to the Organiser"
[ "$(ep $A 1407 $Q $Q2 "1, shirt_number => 4")|$(ep $A 1408 $Q $Q2 "1, name => 'Rita K. Rana'")|$(tc $A "remove_player('$(cmd 1409)', '$Q', '$Q3', 1)")" \
  = 'shirt_taken|ok|ok' ] || fail "paper: Organiser edits and removes Players"
[ "$(ast $A 1410 $Q $QS "'Hari Rana', 'manager'")|$(ast $A 1411 $Q $Q4 "'Physio', 'physio'")" = 'ok|lineup_violation' ] || fail "paper: Organiser adds Staff"
obj $A player-photos "$T5/$Q/$Q1/$QV.webp" >/dev/null || fail "paper: Organiser cannot upload a photo"
[ "$(ae $A 1412 $Q $Q1 $QR "'birth_certificate', '12-34'")|$(sp_ $A 1413 $Q $Q1 "$(pv $Q1), '$T5/$Q/$Q1/$QV.webp', true")" = 'ok|ok' ] \
  || fail "paper: Organiser adds Eligibility and a photo"
[ "$(tc $A "submit_team('$(cmd 1414)', '$Q')")|$(q "select status from app.team where id='$Q'")" = 'ok|submitted' ] || fail "paper: Organiser sends the Team"
[ "$(q "select count(*) filter (where actor is distinct from '$A')||'/'||(count(*) > 0) from app.activity_log where command_id between '$(cmd 1400)' and '$(cmd 1414)'")" = 0/true ] \
  || fail "paper: log rows not the Organiser's"
[ "$(q "select count(*) from app.activity_log where strpos(coalesce(before::text, '') || coalesce(after::text, ''), 'Gita Rana') + strpos(coalesce(before::text, '') || coalesce(after::text, ''), '12-34') > 0")" = 0 ] \
  || fail "paper: personal fields logged by value"
# The Organiser reads every section the form shows (Team, Squad, consent, Staff, Eligibility, photos).
[ "$(as $A "select concat_ws('|', (select status||kit_colour from app.team where id='$Q'), (select count(*) from app.squad_entry where team_id='$Q'),
       (select string_agg(c.given_by, ',') from app.photo_consent c join app.squad_entry e on e.player_id = c.player_id where e.team_id='$Q'),
       (select count(*) from app.staff where team_id='$Q'), (select document_number from app.eligibility_record where id='$QR'),
       (select count(*) from storage.objects where name like '$T5/$Q/%'))")" = 'submitted#1d4ed8|2|Gita Rana|1|12-34|1' ] || fail "paper: Organiser reads"

# Leaks: another Tournament's Organiser and another Team's grant neither change nor read Q.
for who in $B $G5; do
  [ "$(ep $who 1420 $Q $Q1 "$(pv $Q1), name => 'Stolen'")|$(ast $who 1421 $Q $Q4 "'X', 'coach'")|$(tc $who "submit_team('$(cmd 1422)', '$Q')")|$(tc $who "edit_team('$(cmd 1423)', '$Q', $(ver $Q), name => 'Stolen')")|$(ae $who 1424 $Q $Q2 $Q4 "'emis', '1'")" \
    = 'not_authorized|not_authorized|not_authorized|not_authorized|not_authorized' ] || fail "leak: $who changed the paper Team"
  for r in 1420 1421 1422 1423 1424; do redo $r; done
  [ "$(as $who "select (select count(*) from app.team where id='$Q')+(select count(*) from app.squad_entry where team_id='$Q')+(select count(*) from app.player where id in ('$Q1','$Q2'))
       +(select count(*) from app.photo_consent where player_id in ('$Q1','$Q2'))+(select count(*) from app.staff where team_id='$Q')+(select count(*) from app.eligibility_record where player_id in ('$Q1','$Q2'))
       +(select count(*) from storage.objects where name like '$T5/$Q/%')")" = 0 ] || fail "leak: $who reads the paper Team"
  ! obj $who player-photos "$T5/$Q/$Q2/$QV.webp" >/dev/null 2>&1 || fail "leak: $who uploaded into the paper Team"
done
[ "$(q "select name from app.player where id='$Q1'")" = 'Sita Rana' ] || fail "leak: Q1 renamed"

# Manager and Organiser edit the same Player from the same version: the second gets the conflict, naming the other as a role.
[ "$(rd $G6 1430 $TQ)" = ok ] || fail "paper: redeem Q's link"
v=$(pv $Q2)
[ "$(ep $G6 1431 $Q $Q2 "$v, name => 'Manager Rita'")" = ok ] || fail "paper: manager edit"
r=$(as $A "select app.edit_player('$(cmd 1432)', '$Q', '$Q2', $v, name => 'Organiser Rita')")
[ "$(q "select concat_ws('|', r->>'code', r->'conflict'->>'changed_by', r->'conflict'->'current'->>'name') from (select '$r'::jsonb r) x")|$(q "select name from app.player where id='$Q2'")" \
  = "version_conflict|Team manager|Manager Rita|Manager Rita" ] || fail "paper: Organiser's stale edit not a conflict: $r"
v=$(pv $Q2)
[ "$(ep $A 1433 $Q $Q2 "$v, name => 'Organiser Rita'")" = ok ] || fail "paper: Organiser edit at the current version"
r=$(as $G6 "select app.edit_player('$(cmd 1434)', '$Q', '$Q2', $v, name => 'Manager again')")
[ "$(q "select concat_ws('|', r->>'code', r->'conflict'->>'changed_by') from (select '$r'::jsonb r) x")|$(q "select name from app.player where id='$Q2'")" \
  = "version_conflict|Organiser|Organiser Rita" ] || fail "paper: manager's stale edit not a conflict: $r"

# --- Organiser verifies Eligibility; scans are deleted by the scheduled job (Story 2.7). A organises T5 (S5 in registration,
# S6 started); B organises T2. Q (submitted, A's paper Team): Q1 has QR (birth certificate 12-34), Q2 no record. G6 holds Q's
# grant, G5 Y's. X's P1 has R1 (unverified, scan U1), P5 R2 (verified above, scan U2). S7: a finished Season of T5.
QU=d2111111-0000-4000-8000-000000000021 O1=d2111111-0000-4000-8000-000000000022 O2=d2111111-0000-4000-8000-000000000023
FU=d2111111-0000-4000-8000-000000000024 S7=21111111-0000-4000-8000-000000000007 RF=b1111111-0000-4000-8000-000000000021
QR2=b1111111-0000-4000-8000-000000000022
vf() { tc "$1" "verify_eligibility('$(cmd "$2")', '$3', '$4', $5)"; }
rv_() { q "select version from app.eligibility_record where id='$1'"; }
svc() { psql <<<"begin; set local role service_role; $1; commit;"; }
obj $A eligibility-scans "$T5/$Q/$Q1/$QU.webp" >/dev/null || fail "verify: Organiser cannot upload a scan"
[ "$(ee $A 1500 $Q $Q1 "1, scan_path => '$T5/$Q/$Q1/$QU.webp', scan_name => 'birth-sita.jpg'")" = ok ] || fail "verify: fixture scan"

# Reads: Organisers read a scan only while an unverified record points to it (QU, U1; not U2, whose record is verified).
[ "$(scan $A)|$(scan $B)|$(scan $G6)|$(scan $G5)|$(scan anon)" = '2|0|0|0|0' ] || fail "verify: scan reads $(scan $A) $(scan $B) $(scan $G6)"
[ "$(as $A "select string_agg(name, ',' order by name) from storage.objects where bucket_id = 'eligibility-scans'")" \
  = "$T5/$X/$P1/$U1.webp,$T5/$Q/$Q1/$QU.webp" ] || fail "verify: Organiser reads the wrong scans"

# Fences: a grant (even Q's own), another Tournament's Organiser and anon can't verify; nothing changes.
[ "$(vf $G6 1501 $Q $Q1 2)|$(vf $G5 1502 $Q $Q1 2)|$(vf $B 1503 $Q $Q1 2)" = 'not_authorized|not_authorized|not_authorized' ] \
  || fail "leak: verify_eligibility by a grant or another Tournament"
for f in "verify_eligibility('$(cmd 1504)', '$Q', '$Q1', 2)" "scans_to_delete()" "scans_deleted('{}')" "can_read_scan('$T5/$Q/$Q1/$QU.webp')"; do
  out=$(as anon "select app.$f" 2>&1 || true)
  [[ $out == *"permission denied for function"* ]] || fail "anon: can execute $f: $out"
done
for f in "scans_to_delete()" "scans_deleted('{}')"; do
  out=$(as $A "select app.$f" 2>&1 || true)
  [[ $out == *"permission denied for function"* ]] || fail "Organiser can execute $f: $out"
done
[ "$(q "select count(*) from app.eligibility_record where verified_at is not null and id <> '$R2'")" = 0 ] || fail "leak: a refused verify wrote"

# Refusals in words: no record, not in the Squad, no number yet, a started Season, a stale version (conflict without the path).
[ "$(ae $A 1505 $Q $Q2 $QR2 "'emis'")" = ok ] || fail "verify: fixture record without a number"
[ "$(vf $A 1506 $Q $P1 1)|$(vf $A 1507 $Q $Q2 1)|$(vf $A 1508 $Z $P1 1)" = 'player_missing|document_incomplete|season_started' ] \
  || fail "verify: refusals"
[ "$(as $A "select r->>'message' from app.verify_eligibility('$(cmd 1509)', '$Q', '$Q2', 1) r")" = 'Add the document type and number first.' ] \
  || fail "verify: incomplete in words"
q "delete from app.eligibility_record where id='$QR2'" >/dev/null
[ "$(vf $A 1510 $Q $Q2 1)" = eligibility_missing ] || fail "verify: no record"
r=$(as $A "select app.verify_eligibility('$(cmd 1511)', '$Q', '$Q1', 1)")
[ "$(q "select concat_ws('|', r->>'code', r->'conflict'->>'current_version', r->'conflict'->'current'->>'document_number', r->'conflict'->>'changed_by', r::text ~ '$QU') from (select '$r'::jsonb r) x")" \
  = 'version_conflict|2|12-34|Organiser|f' ] || fail "verify: conflict: $r"

# Verify: type and number kept, verifier and time set, version bumped once, the scan path kept for the job; a repeat is ok.
r=$(as $A "select app.verify_eligibility('$(cmd 1512)', '$Q', '$Q1', 2)")
[ "$(q "select (r->>'ok')||(r->>'version') from (select '$r'::jsonb r) x")" = true3 ] || fail "verify: $r"
[ "$(q "select concat_ws('|', document_type, document_number, verified_by, verified_at is not null, scan_path, version) from app.eligibility_record where id='$QR'")" \
  = "birth_certificate|12-34|$A|t|$T5/$Q/$Q1/$QU.webp|3" ] || fail "verify: row"
[ "$(as $A "select app.verify_eligibility('$(cmd 1512)', '$Q', '$Q1', 2)")" = "$r" ] || fail "verify: repeat answered differently"
[ "$(vf $A 1513 $Q $Q1 1)|$(rv_ $QR)" = 'ok|3' ] || fail "verify: verifying again changed the record"
[ "$(q "select count(*)||':'||bool_and(actor = '$A')||':'||bool_and(after->>'scan_path' = 'scan_path') from app.activity_log where command_id = '$(cmd 1512)'")" = '1:true:true' ] \
  || fail "verify: log row"
# Once verified: no Organiser reads the scan, and the Team manager can't change the record.
[ "$(scan $A)|$(ee $G6 1514 $Q $Q1 "3, document_number => '1'")" = '1|eligibility_verified' ] || fail "verify: verified scan still readable or editable"

# Finished Season: its records' scans go too (S7 inserted finished, as S8 was).
q "insert into app.season (id, tournament_id, number, status) values ('$S7', '$T5', 7, 'finished');
   insert into storage.objects (bucket_id, name) values ('eligibility-scans', '$T5/$Q/$Q2/$FU.webp');
   insert into app.eligibility_record (id, tournament_id, player_id, season_id, document_type, document_number, scan_path, scan_name)
     values ('$RF', '$T5', '$Q2', '$S7', 'emis', '77', '$T5/$Q/$Q2/$FU.webp', 'old.jpg')" >/dev/null
# Orphans: O1 just uploaded (its command may still be on its way), O2 two days old; U1 is old but its record is live.
q "insert into storage.objects (bucket_id, name) values ('eligibility-scans', '$T5/$X/$P1/$O1.webp');
   insert into storage.objects (bucket_id, name, created_at) values ('eligibility-scans', '$T5/$X/$P1/$O2.webp', now() - interval '2 days');
   update storage.objects set created_at = now() - interval '3 days' where name = '$T5/$X/$P1/$U1.webp';
   insert into storage.objects (bucket_id, name, created_at) values ('player-photos', '$T5/$X/$P1/$O2.webp', now() - interval '2 days')" >/dev/null
pick="select coalesce(string_agg(n, ',' order by n), 'none') from app.scans_to_delete() n"
[ "$(svc "$pick")" = "$T5/$X/$P1/$O2.webp,$T5/$X/$P5/$U2.webp,$T5/$Q/$Q1/$QU.webp,$T5/$Q/$Q2/$FU.webp" ] || fail "job: selection $(svc "$pick")"
[ "$(svc "select count(*) from app.scans_to_delete(1)")" = 1 ] || fail "job: limit"

# The Edge Function deletes through the Storage API (here: the rows), then reports what went; U2 "fails" and stays selected.
q "delete from storage.objects where bucket_id = 'eligibility-scans' and name in ('$T5/$Q/$Q1/$QU.webp', '$T5/$Q/$Q2/$FU.webp', '$T5/$X/$P1/$O2.webp')" >/dev/null
[ "$(svc "select app.scans_deleted(array['$T5/$Q/$Q1/$QU.webp', '$T5/$Q/$Q2/$FU.webp', '$T5/$X/$P1/$O2.webp'])")" = 2 ] || fail "job: records cleared"
[ "$(q "select concat_ws('|', coalesce(scan_path, '-'), coalesce(scan_name, '-'), document_type, document_number, verified_by, version) from app.eligibility_record where id='$QR'")" \
  = "-|-|birth_certificate|12-34|$A|4" ] || fail "job: verified record after deletion"
[ "$(q "select coalesce(scan_path, '-')||document_number from app.eligibility_record where id='$RF'")|$(q "select scan_path from app.eligibility_record where id='$R1'")" \
  = "-77|$T5/$X/$P1/$U1.webp" ] || fail "job: finished record not cleared, or a live record cleared"
[ "$(svc "$pick")" = "$T5/$X/$P5/$U2.webp" ] || fail "job: a failed deletion is not retried: $(svc "$pick")"
# Next run: U2 deleted, but reporting failed; the run after clears a verified record whose file is already gone.
q "delete from storage.objects where bucket_id = 'eligibility-scans' and name = '$T5/$X/$P5/$U2.webp'" >/dev/null
[ "$(svc "$pick")|$(svc "select app.scans_deleted('{}')")|$(q "select coalesce(scan_path, '-') from app.eligibility_record where id='$R2'")" = 'none|1|-' ] \
  || fail "job: verified record with its file gone not cleared"
[ "$(q "select count(*) from storage.objects where bucket_id = 'player-photos' and name = '$T5/$X/$P1/$O2.webp'")" = 1 ] || fail "job: touched another bucket"
[ "$(q "select count(*) filter (where reason = 'Scan deleted')||':'||count(*) filter (where strpos(coalesce(before::text, '') || coalesce(after::text, ''), '$QU') > 0)
       from app.activity_log where table_name = 'eligibility_record'")" = '3:0' ] || fail "job: log rows without the reason, or with the path"

# The schedule: one hourly job by name (applied twice), calling the Edge Function with its URL and secret from Vault.
[ "$(q "select string_agg(jobname||' '||schedule, ',') from cron.job")" = 'delete-eligibility-scans 17 * * * *' ] || fail "cron: job"
[ "$(q "select (command ~ 'net\.http_post') and (command ~ 'vault\.decrypted_secrets') and command ~ 'scan_cleanup_secret' from cron.job")" = t ] \
  || fail "cron: command"
! (echo "begin; drop schema cron cascade;"; cat "$dir/0016_verify_eligibility.sql") | psql >/dev/null 2>&1 || fail "0016 applied without pg_cron"

# --- Approve, return or withdraw a Team (Story 2.8). A organises T5 (S5 in registration: Squad 2 to 3, Staff manager and
# coach; S6 started); B organises T2. Q (A's paper Team) is submitted with 2 Players and a manager; G6 holds Q's grant, G5
# Y's (Y invited). app.draw_team lists only approved Teams, through the reader's RLS.
apt() { tc "$1" "approve_team('$(cmd "$2")', '$3')"; }
ret() { tc "$1" "return_team('$(cmd "$2")', '$3', $4)"; }
wd() { tc "$1" "withdraw_team('$(cmd "$2")', '$3')"; }
qst() { q "select status||'/'||coalesce(return_note, '-')||'/'||version from app.team where id='$Q'"; }
draw() { as "$1" "select coalesce(string_agg(code, ',' order by code), 'none') from app.draw_team"; }
qv=$(ver $Q)
[ "$(qst)" = "submitted/-/$qv" ] || fail "review: fixture $(qst)"

# Fences: Q's own grant, another Team's grant and another Tournament's Organiser can't review; anon can't call.
for who in $G6 $G5 $B; do
  [ "$(apt $who 1600 $Q)|$(ret $who 1601 $Q "'x'")|$(wd $who 1602 $Q)" = 'not_authorized|not_authorized|not_authorized' ] \
    || fail "leak: $who reviewed Q"
  for r in 1600 1601 1602; do redo $r; done
done
for f in "approve_team('$(cmd 1603)', '$Q')" "return_team('$(cmd 1603)', '$Q', 'x')" "withdraw_team('$(cmd 1603)', '$Q')"; do
  out=$(as anon "select app.$f" 2>&1 || true)
  [[ $out == *"permission denied for function"* ]] || fail "anon: can execute $f: $out"
done
[ "$(qst)" = "submitted/-/$qv" ] || fail "leak: a refused review wrote"

# Refusals: not sent for review, no note, a started Season, the Line-up rules in words.
[ "$(apt $A 1604 $Y)|$(ret $A 1605 $Y "'Fix it'")|$(ret $A 1606 $Q "'   '")|$(ret $A 1607 $Q "null")|$(ret $A 1608 $Q "repeat('x', 501)")|$(apt $A 1609 $Z)" \
  = 'team_not_submitted|team_not_submitted|note_invalid|note_invalid|note_invalid|season_started' ] || fail "review: refusals"
q "update app.season set staff_roles = '{coach}' where id = '$S5'" >/dev/null
[ "$(msg $A "approve_team('$(cmd 1610)', '$Q')")|$(qst)" = "Manager isn't an allowed Staff role.|submitted/-/$qv" ] || fail "approve: Line-up rules"
q "update app.season set staff_roles = '{manager,coach}' where id = '$S5'" >/dev/null

# Approve: status approved (version kept), in the Draw for A only; a repeat is ok; the manager's form is read-only, the
# Organiser still edits.
[ "$(apt $A 1611 $Q)|$(qst)|$(apt $A 1612 $Q)" = "ok|approved/-/$qv|ok" ] || fail "approve"
[ "$(draw $A)|$(draw $B)|$(draw $G5)" = 'PSF|none|none' ] || fail "draw_team: $(draw $A) $(draw $B) $(draw $G5)"
[ "$(et $G6 1613 $Q $qv "name => 'Late'")|$(ep $G6 1614 $Q $Q1 "$(pv $Q1), name => 'Late'")|$(tc $G6 "submit_team('$(cmd 1615)', '$Q')")" \
  = 'team_approved|team_approved|team_approved' ] || fail "approved: manager not locked"
[ "$(et $A 1616 $Q $qv "kit_colour => '#1d4ed8'")" = ok ] || fail "approved: Organiser locked"
qv=$(ver $Q)
[ "$(q "select count(*)||':'||bool_and(actor = '$A') from app.activity_log where command_id = '$(cmd 1611)' and after->>'status' = 'approved'")" = '1:true' ] \
  || fail "approve: log row"

# Return with a note (trimmed): returned, out of the Draw; the manager reads the note, edits and sends again.
[ "$(ret $A 1620 $Q "'  Add the coach''s name.  '")|$(qst)" = "ok|returned/Add the coach's name./$qv" ] || fail "return: $(qst)"
[ "$(as $G6 "select status||'/'||return_note from app.team")|$(as $B "select count(*) from app.team where id='$Q'")|$(draw $A)" \
  = "returned/Add the coach's name.|0|none" ] || fail "return: reads"
[ "$(apt $A 1621 $Q)|$(ep $G6 1622 $Q $Q1 "$(pv $Q1), name => 'Sita K. Rana'")|$(tc $G6 "submit_team('$(cmd 1623)', '$Q')")|$(q "select status from app.team where id='$Q'")" \
  = 'team_not_submitted|ok|ok|submitted' ] || fail "return: manager edits and sends again"

# Withdraw (from any status): read-only for everyone, out of the Draw; the grant still reads; repeat ok; review refused.
[ "$(apt $A 1630 $Q)|$(wd $A 1631 $Q)|$(q "select status from app.team where id='$Q'")|$(wd $A 1632 $Q)|$(draw $A)" = 'ok|ok|withdrawn|ok|none' ] \
  || fail "withdraw"
[ "$(et $G6 1633 $Q $(ver $Q) "name => 'Back'")|$(et $A 1634 $Q $(ver $Q) "name => 'Back'")|$(ap $A 1635 $Q $Q4 "name => 'Z', shirt_number => 30, date_of_birth => '$grown', consent => false")|$(tc $A "submit_team('$(cmd 1636)', '$Q')")" \
  = 'team_withdrawn|team_withdrawn|team_withdrawn|team_withdrawn' ] || fail "withdrawn: still editable"
[ "$(apt $A 1637 $Q)|$(ret $A 1638 $Q "'x'")|$(as $G6 "select count(*) from app.team")" = 'team_withdrawn|team_withdrawn|1' ] || fail "withdrawn: review or read"

# --- Links close at the deadline; reopen one for a reason (Story 2.9). A organises T5 (S5 in registration); B organises T2.
# G1 holds X's grant, G5 Y's. A link is open through the deadline day in Asia/Kathmandu; a grant's command counts by its
# x-entered-at header (capped at now) if received within app.grace_window(). The check widens the window to 2 days to
# place "now" inside it, then puts it back.
at_() { psql <<<"begin; set local role authenticated; set local request.jwt.claims to '{\"sub\":\"$1\"}';
  set local request.headers to '{\"x-entered-at\":\"$2\"}'; select case when (r->>'ok')::boolean then 'ok' else r->>'code' end from app.$3 r; commit;"; }
kit() { echo "kit_colour => '#$(printf '%06x' "$1")'"; }
today=$(q "select (now() at time zone 'Asia/Kathmandu')::date")
deadline() { q "update app.season set registration_deadline = '$1' where id='$S5'" >/dev/null; }
closes=$(q "select (('$today'::date)::timestamp) at time zone 'Asia/Kathmandu'")
[ "$(q "select app.grace_window()")" = '01:00:00' ] || fail "deadline: grace window"
ast_="add_staff('$(cmd 1709)', '$X', gen_random_uuid(), 'Late', 'coach')"
LX6=81111111-0000-4000-8000-000000000029 TX6=${TK1/A/6}
[ "$(ri $A 1699 $S5 $X $LX6 $(hash $TX6))|$(rd $G1 1698 $TX6)" = 'ok|ok' ] || fail "deadline: fixture grant"

# Open through the deadline day: a grant edits with no header (counts as now).
deadline "$today"
[ "$(et $G5 1700 $Y $(ver $Y) "$(kit 1)")" = ok ] || fail "deadline: open on the deadline day"
# Closed since midnight: entered before the close and received within the window is accepted; entered after, or no header,
# a future (capped) or unreadable one, refused; the Squad too. The Organiser still edits.
deadline "$(q "select '$today'::date - 1")"
q "create or replace function app.grace_window() returns interval language sql immutable security definer set search_path = '' as \$\$ select interval '2 days' \$\$" >/dev/null
[ "$(at_ $G5 "$(q "select '$closes'::timestamptz - interval '1 minute'")" "edit_team('$(cmd 1701)', '$Y', $(ver $Y), $(kit 2))")" = ok ] \
  || fail "deadline: entered before the close, within the window"
r=$(echo "$(at_ $G5 "$(q "select '$closes'::timestamptz + interval '1 minute'")" "edit_team('$(cmd 1702)', '$Y', $(ver $Y), $(kit 3))")|$(et $G5 1703 $Y $(ver $Y) "$(kit 3)")|$(at_ $G5 2999-01-01T00:00:00Z "edit_team('$(cmd 1704)', '$Y', $(ver $Y), $(kit 3))")|$(at_ $G5 nonsense "edit_team('$(cmd 1705)', '$Y', $(ver $Y), $(kit 3))")|$(at_ $G1 "$(q "select '$closes'::timestamptz + interval '1 minute'")" "$ast_")"); [ "$r" \
  = 'registration_closed|registration_closed|registration_closed|registration_closed|registration_closed' ] || fail "deadline: late commands accepted: $r"
[ "$(msg $G5 "edit_team('$(cmd 1703)', '$Y', $(ver $Y), $(kit 3))")" = 'Not allowed.' ] || fail "deadline: stored refusal"
[ "$(et $A 1706 $Y $(ver $Y) "$(kit 4)")" = ok ] || fail "deadline: Organiser locked out"
# Outside the window (the real 1 hour, deadline two days back): entered before the close is refused too.
q "create or replace function app.grace_window() returns interval language sql immutable security definer set search_path = '' as \$\$ select interval '1 hour' \$\$" >/dev/null
deadline "$(q "select '$today'::date - 2")"
[ "$(at_ $G5 "$(q "select '$closes'::timestamptz - interval '1 day 1 minute'")" "edit_team('$(cmd 1707)', '$Y', $(ver $Y), $(kit 5))")" = registration_closed ] \
  || fail "deadline: accepted outside the grace window"
deadline "$(q "select '$today'::date - 1")"

# Reopen: fences first (grants, another Tournament, anon); nothing changes.
ro_() { tc "$1" "reopen_registration_link('$(cmd "$2")', '$3', $4, $5)"; }
reopen() { q "select coalesce(reopened_until::text, '-')||'/'||coalesce(reopen_reason, '-')||'/'||version from app.team where id='$1'"; }
yv=$(ver $Y)
[ "$(ro_ $G5 1710 $Y "'x'" "'$today'")|$(ro_ $G1 1711 $Y "'x'" "'$today'")|$(ro_ $B 1712 $Y "'x'" "'$today'")" = 'not_authorized|not_authorized|not_authorized' ] \
  || fail "leak: reopen by a grant or another Tournament"
out=$(as anon "select app.reopen_registration_link('$(cmd 1713)', '$Y', 'x', '$today')" 2>&1 || true)
[[ $out == *"permission denied for function"* ]] || fail "anon: can reopen: $out"
for f in "grace_window()" "link_closes_at('$Y')" "season_allows('$S5', 'edit_team', '$Y')"; do
  out=$(as $A "select app.$f" 2>&1 || true)
  [[ $out == *"permission denied for function"* ]] || fail "Organiser can execute $f: $out"
done
# Refusals in words: no reason, a past date, no date, a date after the start.
q "update app.season set starts_on = '$today'::date + 10, ends_on = '$today'::date + 20 where id='$S5'" >/dev/null
[ "$(ro_ $A 1714 $Y "'   '" "'$today'")|$(ro_ $A 1715 $Y "'Injury'" "'$today'::date - 1")|$(ro_ $A 1716 $Y "'Injury'" null)|$(ro_ $A 1717 $Y "'Injury'" "'$today'::date + 11")|$(reopen $Y)" \
  = "reason_invalid|reopen_date_invalid|reopen_date_invalid|reopen_date_invalid|-/-/$yv" ] || fail "reopen: refusals"
[ "$(msg $A "reopen_registration_link('$(cmd 1718)', '$Y', repeat('x', 201), '$today')")" = 'Write a reason of 1 to 200 characters.' ] \
  || fail "reopen: reason in words"
# Reopened through today: only Y's grant edits again (X's stays closed); the reopen and the manager's change carry the reason,
# the change its device (G5's grant); the Team's version is kept by the reopen.
[ "$(ro_ $A 1720 $Y "'  Injury replacement '" "'$today'")|$(reopen $Y)" = "ok|$today/Injury replacement/$yv" ] || fail "reopen"
[ "$(et $G5 1721 $Y $yv "$(kit 6)")|$(et $G1 1722 $X $(ver $X) "$(kit 6)")|$(at_ $G1 "$today" "${ast_//$(cmd 1709)/$(cmd 1719)}")" = 'ok|registration_closed|registration_closed' ] \
  || fail "reopen: not only that Team"
[ "$(q "select reason||':'||actor from app.activity_log where command_id='$(cmd 1720)'")|$(q "select reason||':'||actor from app.activity_log where command_id='$(cmd 1721)'")" \
  = "Injury replacement:$A|Injury replacement:$G5" ] || fail "reopen: log rows"
[ "$(as $G5 "select concat_ws('|', reopened_until, reopen_reason) from app.team")" = "$today|Injury replacement" ] || fail "reopen: the manager reads it"
# Before the deadline a manager's change carries no reason; the reopen date past, the link closes again.
deadline "$today"
[ "$(et $G5 1723 $Y $(ver $Y) "$(kit 7)")|$(q "select coalesce(reason, '-') from app.activity_log where command_id='$(cmd 1723)'")" = 'ok|-' ] \
  || fail "reopen: reason on a change before the deadline"
q "update app.team set reopened_until = '$today'::date - 1 where id='$Y'" >/dev/null
deadline "$(q "select '$today'::date - 1")"
[ "$(et $G5 1724 $Y $(ver $Y) "$(kit 8)")" = registration_closed ] || fail "reopen: past reopen date still open"
q "update app.season set registration_deadline = '2099-11-20', starts_on = null, ends_on = null where id='$S5'" >/dev/null

# --- Delete a Player's photo and personal details on request (Story 2.10). A organises T5 (S5 in registration); B organises
# T2. G1 holds X's grant, G5 Y's. X's P1 (minor, consent from Mina Basnet) has photo V1 and record R1 (scan U1); in P1's
# folders also an old orphan photo O2 and a fresh orphan scan O1. P5's photo V3 and SF1's V2 stay. Q (withdrawn) has Q1.
er() { tc "$1" "erase_player_personal_data('$(cmd "$2")', '$3', '$4', $5)"; }
dob=$(q "select date_of_birth from app.player where id='$P1'")
num=$(q "select document_number from app.eligibility_record where id='$R1'")
[ -n "$dob" ] && [ -n "$num" ] && [ "$(q "select given_by from app.photo_consent where player_id='$P1' and season_id='$S5'")" = 'Mina Basnet' ] \
  && [ "$(q "select photo_path from app.player where id='$P1'")" = "$T5/$X/$P1/$V1.webp" ] || fail "erase: fixture"
v=$(pv $P1)
# A stored conflict answer that carries P1's date of birth (dropped by the erase).
[ "$(ep $A 1800 $X $P1 "$((v - 1)), name => 'Old'")" = version_conflict ] || fail "erase: fixture conflict"

# Fences: X's own grant, another Team's grant, another Tournament's Organiser can't erase; anon and Organisers can't call
# the job's functions. Nothing changes.
[ "$(er $G1 1801 $X $P1 $v)|$(er $G5 1802 $X $P1 $v)|$(er $B 1803 $X $P1 $v)|$(pv $P1)" = "not_authorized|not_authorized|not_authorized|$v" ] \
  || fail "leak: erase by a grant or another Tournament"
for f in "erase_player_personal_data('$(cmd 1804)', '$X', '$P1', $v)" "file_queued('player-photos', 'x')" "photos_to_delete()" "files_deleted('player-photos', '{}')"; do
  out=$(as anon "select app.$f" 2>&1 || true)
  [[ $out == *"permission denied for function"* ]] || fail "anon: can execute $f: $out"
done
for f in "photos_to_delete()" "files_deleted('player-photos', '{}')"; do
  out=$(as $A "select app.$f" 2>&1 || true)
  [[ $out == *"permission denied for function"* ]] || fail "Organiser can execute $f: $out"
done
[ "$(er $A 1805 $Y $P1 $v)|$(er $A 1806 $X $P1 $((v - 1)))" = 'player_missing|version_conflict' ] || fail "erase: refusals"
r=$(as $A "select app.erase_player_personal_data('$(cmd 1806)', '$X', '$P1', $((v - 1)))")
[ "$(q "select (r->'conflict'->'current') ? 'date_of_birth' from (select '$r'::jsonb r) x")" = f ] || fail "erase: conflict carries personal values: $r"
[ "$(q "select count(*) from app.file_to_delete")" = 0 ] || fail "erase: a refused erase queued files"

r=$(as $A "select app.erase_player_personal_data('$(cmd 1807)', '$X', '$P1', $v)")
[ "$(q "select (r->>'ok')||(r->>'version') from (select '$r'::jsonb r) x")" = "true$((v + 1))" ] || fail "erase: $r"
# Cleared: date of birth, photo, guardian (consent not given), document number and scan; kept: name, Squad entry, type.
[ "$(q "select concat_ws('|', name, coalesce(date_of_birth::text, '-'), coalesce(photo_path, '-'), coalesce(is_cutout::text, '-'), version) from app.player where id='$P1'")" \
  = "$(q "select name from app.player where id='$P1'")|-|-|-|$((v + 1))" ] || fail "erase: player row"
[ "$(q "select count(*) from app.squad_entry where player_id='$P1' and team_id='$X'")|$(q "select string_agg(consent_given||':'||coalesce(given_by, '-'), ',') from app.photo_consent where player_id='$P1'")" \
  = '1|false:-' ] || fail "erase: Squad entry or consent"
[ "$(q "select concat_ws('|', document_type is not null, coalesce(document_number, '-'), coalesce(scan_path, '-'), coalesce(scan_name, '-'), coalesce(scan_uploaded_at::text, '-')) from app.eligibility_record where id='$R1'")" \
  = 't|-|-|-|-' ] || fail "erase: Eligibility record"
# Queued for the Storage API: every file in P1's folders (current and orphan photos and scans); nobody else's.
[ "$(q "select string_agg(bucket_id||':'||name, ',' order by bucket_id, name) from app.file_to_delete")" \
  = "$(q "select string_agg(bucket_id||':'||name, ',' order by bucket_id, name) from storage.objects where name like '%/$P1/%'")" ] || fail "erase: queue"
[ "$(q "select count(*) from app.file_to_delete where name like '%/$P1/%'")" = 4 ] || fail "erase: queue size $(q "select count(*) from app.file_to_delete")"
# Activity log: one row per changed table, with the reason; field names only, never the values.
[ "$(q "select string_agg(table_name||':'||reason, ',' order by table_name) from app.activity_log where command_id='$(cmd 1807)'")" \
  = 'eligibility_record:Personal details deleted on request,photo_consent:Personal details deleted on request,player:Personal details deleted on request' ] \
  || fail "erase: log rows"
[ "$(q "select concat_ws('|', before->>'date_of_birth', before->>'photo_path', after->>'date_of_birth') from app.activity_log where command_id='$(cmd 1807)' and table_name='player'")" \
  = 'date_of_birth|photo_path' ] || fail "erase: log names"
for val in "$dob" "Mina Basnet" "$num" "$V1" "$U1"; do
  [ "$(q "select count(*) from app.activity_log where strpos(coalesce(before::text, '') || coalesce(after::text, ''), \$v\$$val\$v\$) > 0")" = 0 ] \
    || fail "erase: value in the Activity log: $val"
done
# Stored command answers keep no copy of the erased values.
[ "$(q "select count(*) from app.command_result where strpos(result::text, '$dob') > 0 or strpos(result::text, \$v\$Mina Basnet\$v\$) > 0 or strpos(result::text, \$v\$$num\$v\$) > 0")" = 0 ] \
  || fail "erase: values left in command_result"
[ "$(q "select result->>'code' from app.command_result where command_id='$(cmd 1800)'")" = version_conflict ] || fail "erase: stored conflict lost"

# Reads: nobody signs P1's queued photo, the consent gate gives none; other Teams, Tournaments and anon read nothing of P1.
[ "$(as $A "select count(*) from storage.objects where name like '%/$P1/%'")|$(as $G1 "select count(*) from storage.objects where name like '%/$P1/%'")|$(as $A "select count(*) from storage.objects where name like '%/$P5/%'")" \
  = '0|0|1' ] || fail "erase: queued files still readable, or others' photos hidden"
[ "$(gate $A)" = "$P1:null,$P5:null" ] || fail "erase: player_photo_public gives a photo"
[ "$(as $G1 "select concat_ws('|', coalesce(date_of_birth::text, '-'), coalesce(photo_path, '-')) from app.player where id='$P1'")|$(as $G1 "select coalesce(document_number, '-') from app.registration_eligibility() where player_id='$P1'")" \
  = '-|-|-' ] || fail "erase: the Team's own form"
for who in $G5 $B; do
  [ "$(as $who "select count(*) from app.player where id='$P1'")|$(as $who "select count(*) from app.eligibility_record")|$(as $who "select count(*) from app.photo_consent where player_id='$P1'")|$(gate $who)" \
    = '0|0|0|none' ] || fail "leak: $who reads P1 after erase"
done
! as anon "select count(*) from app.player" >/dev/null 2>&1 || [ "$(as anon "select count(*) from app.player")" = 0 ] || fail "leak: anon reads players"

# Repeat: same answer; a new erase with nothing left is ok and changes nothing.
[ "$(as $A "select app.erase_player_personal_data('$(cmd 1807)', '$X', '$P1', $v)")" = "$r" ] || fail "erase: repeat answered differently"
[ "$(er $A 1808 $X $P1 $v)|$(pv $P1)" = "ok|$((v + 1))" ] || fail "erase: nothing left changed the Player"
# A withdrawn Team's Player (Q1, verified) is erased too: number gone, type and verification kept.
[ "$(er $A 1809 $Q $Q1 $(pv $Q1))|$(q "select concat_ws('|', document_type, coalesce(document_number, '-'), verified_at is not null) from app.eligibility_record where id='$QR'")" \
  = 'ok|birth_certificate|-|t' ] || fail "erase: withdrawn Team"

# The job: photos nobody points to (queued now, or a day old), queued scans at once; then the queue empties.
ppick="select coalesce(string_agg(n, ',' order by n), 'none') from app.photos_to_delete() n"
[ "$(svc "$ppick")" = "$(q "select string_agg(name, ',' order by name) from storage.objects where bucket_id='player-photos' and (name like '%/$P1/%' or name like '%/$Q1/%')")" ] \
  || fail "job: photo selection $(svc "$ppick")"
[ "$(svc "$pick")" = "$(q "select string_agg(name, ',' order by name) from storage.objects where bucket_id='eligibility-scans' and name like '%/$P1/%'")" ] \
  || fail "job: queued scans not selected at once $(svc "$pick")"
q "delete from storage.objects where bucket_id = 'player-photos' and (name like '%/$P1/%' or name like '%/$Q1/%')" >/dev/null
nq=$(q "select count(*) from app.file_to_delete where bucket_id = 'player-photos'")
[ "$(svc "select app.files_deleted('player-photos', array['$T5/$X/$P1/$V1.webp'])")|$(svc "$ppick")" = "$nq|none" ] \
  || fail "job: photos reported"
q "delete from storage.objects where bucket_id = 'eligibility-scans' and name = '$T5/$X/$P1/$U1.webp'" >/dev/null
[ "$(svc "select app.files_deleted('eligibility-scans', array['$T5/$X/$P1/$U1.webp'])")|$(svc "$pick")" = "1|$T5/$X/$P1/$O1.webp" ] \
  || fail "job: a failed scan deletion is not retried"
[ "$(q "select count(*) from storage.objects where bucket_id='player-photos' and name in ('$T5/$X/$SF1/$V2.webp', '$T5/$X/$P5/$V3.webp')")|$(q "select count(*) from app.file_to_delete where bucket_id = 'player-photos'")" = '2|0' ] \
  || fail "job: deleted a photo still in use, or the queue kept deleted photos"

# --- Record the live chit Draw (Story 3.1). A organises T6 (S10: 2 groups of 4; 8 approved Teams D1..D8, plus DI invited and
# DW withdrawn; OS is an approved Team of A's other Season S5); B organises T2 (S2 setup). Slot ids are made on the client.
T6=11111111-0000-4000-8000-0000000000d6 S10=21111111-0000-4000-8000-0000000000d6
sid() { printf '71111111-0000-4000-8000-%012d' "$1"; }
dt() { printf '72111111-0000-4000-8000-%012d' "$1"; }
pl() { tc "$1" "place_team_in_draw('$(cmd "$2")', '$S10', '$(sid "$2")', '$(dt "$3")', $4, $5${6:+, $6})"; }
un() { tc "$1" "unplace_team_from_draw('$(cmd "$2")', '$S10', '$(dt "$3")')"; }
rnd() { tc "$1" "place_rest_at_random('$(cmd "$2")', '$S10')"; }
slots() { q "select coalesce(string_agg(grp||'.'||pos||'='||t.code, ' ' order by grp, pos), '-') from app.draw_slot d join app.team t on t.id = d.team_id where d.season_id='$S10'"; }
[ "$(create $A 1900 $T6 $S10 'Draw Cup')" != "" ] || fail "draw: fixture"
q "update app.season set structure = 'groups_knockout', group_count = 2, teams_per_group = 4, qualifiers_per_group = 2 where id='$S10'" >/dev/null
for i in 1 2 3 4 5 6 7 8; do
  q "insert into app.team (id, tournament_id, season_id, name, code, status) values ('$(dt $i)', '$T6', '$S10', 'Draw team $i', 'D$i', 'approved')" >/dev/null
done
q "insert into app.team (id, tournament_id, season_id, name, code, status) values ('$(dt 9)', '$T6', '$S10', 'Invited', 'DI', 'invited'),
   ('$(dt 10)', '$T6', '$S10', 'Withdrawn', 'DW', 'withdrawn'), ('$(dt 11)', '$T5', '$S5', 'Other season', 'OS', 'approved')" >/dev/null

# Not before registration: the Season is still in setup.
[ "$(pl $A 1901 1 1 1)|$(un $A 1902 1)|$(rnd $A 1903)" = 'season_setup|season_setup|season_setup' ] || fail "draw: allowed in setup"
q "update app.season set status = 'registration' where id='$S10'" >/dev/null

# Fences: another Tournament's Organiser can't place or send back; anon can't call; no client writes or helper calls.
for who in $B $G1; do
  [ "$(pl $who 1904 1 1 1)|$(un $who 1905 1)|$(rnd $who 1906)" = 'not_authorized|not_authorized|not_authorized' ] || fail "leak: $who recorded the Draw"
  for r in 1904 1905 1906; do redo $r; done
done
for f in "place_team_in_draw('$(cmd 1907)', '$S10', '$(sid 1907)', '$(dt 1)', 1, 1)" "unplace_team_from_draw('$(cmd 1907)', '$S10', '$(dt 1)')" \
         "place_rest_at_random('$(cmd 1907)', '$S10')" "draw_slots('$S10')"; do
  out=$(as anon "select app.$f" 2>&1 || true)
  [[ $out == *"permission denied for function"* ]] || fail "anon: can execute $f: $out"
done
out=$(as $A "select app.draw_slots('$S10')" 2>&1 || true)
[[ $out == *"permission denied for function"* ]] || fail "Organiser can execute draw_slots: $out"
out=$(as $A "insert into app.draw_slot (id, tournament_id, season_id, grp, pos, team_id) values (gen_random_uuid(), '$T6', '$S10', 1, 1, '$(dt 1)')" 2>&1 || true)
[[ $out == *"permission denied"* ]] || fail "Organiser can write draw_slot: $out"
[ "$(slots)" = - ] || fail "draw: a refused command wrote"

# Only approved Teams of the same Season, and slots the Structure offers.
[ "$(pl $A 1910 9 1 1)|$(pl $A 1911 10 1 1)|$(pl $A 1912 11 1 1)|$(pl $A 1913 99 1 1)" = 'team_not_approved|team_not_approved|team_not_approved|team_not_approved' ] \
  || fail "draw: unapproved Teams placed"
[ "$(pl $A 1914 1 3 1)|$(pl $A 1915 1 1 5)|$(pl $A 1916 1 0 1)|$(pl $A 1917 1 1 0)" = 'slot_invalid|slot_invalid|slot_invalid|slot_invalid' ] || fail "draw: slot out of range"
q "update app.season set structure = 'league' where id='$S10'" >/dev/null
[ "$(pl $A 1918 1 1 1)|$(rnd $A 1919)" = 'no_draw|no_draw' ] || fail "draw: a League has a Draw"
q "update app.season set structure = 'groups_knockout' where id='$S10'" >/dev/null
[ "$(slots)" = - ] || fail "draw: refusals wrote"

# Place: a row with the Team, version 1, logged; a repeat answers alike; the same Team in the same slot again is ok.
r1=$(as $A "select app.place_team_in_draw('$(cmd 1920)', '$S10', '$(sid 1920)', '$(dt 1)', 1, 1)")
[ "$(q "select (r->>'ok')||(r->>'version')||(r->>'complete') from (select '$r1'::jsonb r) x")" = true1false ] || fail "place: $r1"
[ "$(as $A "select app.place_team_in_draw('$(cmd 1920)', '$S10', '$(sid 1920)', '$(dt 1)', 1, 1)")" = "$r1" ] || fail "place: repeat answered differently"
[ "$(slots)" = '1.1=D1' ] || fail "place: $(slots)"
[ "$(q "select count(*)||':'||bool_and(actor = '$A') from app.activity_log where command_id='$(cmd 1920)' and table_name = 'draw_slot' and op = 'insert'")" = '1:true' ] \
  || fail "place: log row"
[ "$(pl $A 1921 1 1 1)|$(pl $A 1922 1 1 2)|$(pl $A 1923 2 1 1)" = 'ok|team_placed|version_conflict' ] || fail "place: repeat, moved Team, taken slot"
[ "$(slots)" = '1.1=D1' ] || fail "place: refusals changed the Draw"
[ "$(pl $A 1924 3 1 2 0)" = ok ] || fail "place: a wrong expected_version on an empty slot"

# Taken slot: the conflict names the occupant and a role-free name; Use mine (expected_version = theirs) replaces them.
r=$(as $A "select app.place_team_in_draw('$(cmd 1925)', '$S10', '$(sid 1925)', '$(dt 2)', 1, 1)")
[ "$(q "select (r->>'code')||(r->'conflict'->>'current_version')||(r->'conflict'->'current'->>'team_id')||(r->'conflict'->>'changed_by') from (select '$r'::jsonb r) x")" = "version_conflict1$(dt 1)a" ] \
  || fail "place: conflict envelope $r"
[ "$(pl $A 1926 2 1 1 1)|$(slots)" = 'ok|1.1=D2 1.2=D3' ] || fail "place: Use mine"

# Send back: the slot empties, a repeat and a Team never placed are ok.
[ "$(un $A 1930 3)|$(slots)|$(un $A 1931 3)|$(un $A 1932 1)" = 'ok|1.1=D2|ok|ok' ] || fail "unplace"
[ "$(q "select count(*) from app.activity_log where command_id='$(cmd 1930)' and table_name = 'draw_slot' and op = 'delete'")" = 1 ] || fail "unplace: log row"

# Seeds stay: D1 and D8 pinned, then the rest at random, in one command; every Team in a distinct slot of a Structure slot.
[ "$(pl $A 1933 1 1 2)|$(pl $A 1934 8 2 4)|$(slots)" = 'ok|ok|1.1=D2 1.2=D1 2.4=D8' ] || fail "seeds: $(slots)"
r=$(as $A "select app.place_rest_at_random('$(cmd 1935)', '$S10')")
[ "$(q "select (r->>'ok')||(r->>'placed')||(r->>'complete') from (select '$r'::jsonb r) x")" = true5true ] || fail "random: $r"
[ "$(q "select count(*)||':'||count(distinct team_id)||':'||count(distinct (grp, pos)) from app.draw_slot where season_id='$S10'")" = '8:8:8' ] || fail "random: not 8 distinct"
[ "$(q "select string_agg(code, ',' order by code) from app.team t join app.draw_slot d on d.team_id = t.id where d.season_id='$S10' and grp between 1 and 2 and pos between 1 and 4")" = D1,D2,D3,D4,D5,D6,D7,D8 ] \
  || fail "random: Teams outside the groups"
[ "$(q "select string_agg(t.code, ',' order by t.code) from app.draw_slot d join app.team t on t.id = d.team_id where (grp, pos) in ((1,1), (1,2), (2,4))")" = D1,D2,D8 ] \
  || fail "random: a seed moved"
[ "$(as $A "select (r->>'placed')||(r->>'complete') from app.place_rest_at_random('$(cmd 1936)', '$S10') r")" = 0true ] || fail "random: nothing left"
[ "$(as $A "select app.place_rest_at_random('$(cmd 1935)', '$S10')")" = "$r" ] || fail "random: repeat answered differently"
# Every placement can still be sent back one by one; the last one back in completes the Draw.
last=$(q "select grp||','||pos from app.draw_slot where team_id='$(dt 5)'")
[ "$(un $A 1939 5)|$(as $A "select (r->>'ok')||(r->>'complete') from app.place_team_in_draw('$(cmd 1940)', '$S10', '$(sid 1940)', '$(dt 5)', $last) r")" = 'ok|truetrue' ] \
  || fail "complete flag on the last placement"

# Knockout-only: bracket slots 1..8 in group 0; group numbers are invalid; random fills the rest.
q "delete from app.draw_slot where season_id='$S10'; update app.season set structure = 'knockout' where id='$S10'" >/dev/null
[ "$(pl $A 1950 1 0 1)|$(pl $A 1951 2 1 1)|$(pl $A 1952 3 0 9)|$(slots)" = 'ok|slot_invalid|slot_invalid|0.1=D1' ] || fail "knockout: $(slots)"
[ "$(as $A "select (r->>'placed')||(r->>'complete') from app.place_rest_at_random('$(cmd 1953)', '$S10') r")" = 7true ] || fail "knockout: random"
[ "$(q "select count(distinct pos)||':'||min(pos)||':'||max(pos) from app.draw_slot where season_id='$S10' and grp = 0")" = '8:1:8' ] || fail "knockout: slots"

# Leaks: another Tournament sees no slot and no log row; anon reads nothing.
[ "$(as $B "select count(*) from app.draw_slot")|$(as $B "select count(*) from app.activity_log where table_name = 'draw_slot'")|$(as $A "select count(*) from app.draw_slot")" = '0|0|8' ] \
  || fail "leak: another Tournament reads the Draw"
out=$(as anon "select count(*) from app.draw_slot" 2>&1 || true)
[[ $out == *"permission denied"* ]] || fail "leak: anon reads the Draw: $out"
# B naming its own Season with T6's Team places nothing.
S2n=$(q "select id from app.season where tournament_id='$T2'")
[ "$(as $B "select r->>'code' from app.place_team_in_draw('$(cmd 1960)', '$S2n', '$(sid 1960)', '$(dt 1)', 1, 1) r")" != ok ] \
  && [ "$(as $B "select count(*) from app.draw_slot")" = 0 ] || fail "leak: B placed in its own Season"

# --- Suggested fixtures (Story 3.2). Same Season S10 (knockout, 8 Teams all placed); A organises it, B and G1 do not.
mid() { printf '73111111-0000-4000-8000-%012d' "$1"; }
# A SQL jsonb expression: $2 Fixtures, ids mid($1 + i), Team i v Team i+1.
fx() { echo "(select jsonb_agg(jsonb_build_object('id', format('73111111-0000-4000-8000-%s', lpad(($1 + i)::text, 12, '0')), 'stage', 'knockout',
  'round', 'Round 1', 'label', 'QF' || i, 'ord', i, 'home_team', format('72111111-0000-4000-8000-%s', lpad(i::text, 12, '0')),
  'away_team', format('72111111-0000-4000-8000-%s', lpad((i + 1)::text, 12, '0')), 'home_src', null, 'away_src', null)) from generate_series(1, $2) i)"; }
sf() { tc "$1" "suggest_fixtures('$(cmd "$2")', '$S10', $3${4:+, $4})"; }
ms() { q "select count(*) from app.match where season_id='$S10'"; }
for who in $B $G1; do
  [ "$(sf $who 1981 "$(fx 100 3)")" = not_authorized ] || fail "leak: $who suggested Fixtures"
  redo 1981
done
out=$(as anon "select app.suggest_fixtures('$(cmd 1982)', '$S10', '[]'::jsonb)" 2>&1 || true)
[[ $out == *"permission denied for function"* ]] || fail "anon: can execute suggest_fixtures: $out"
out=$(as $A "insert into app.match (id, tournament_id, season_id, stage, round, ord) values (gen_random_uuid(), '$T6', '$S10', 'group', 'x', 1)" 2>&1 || true)
[[ $out == *"permission denied"* ]] || fail "Organiser can write match: $out"
# Refusals write nothing: a bad list, duplicate order, an unapproved or foreign Team, an incomplete Draw.
[ "$(sf $A 1983 "'[]'::jsonb")|$(sf $A 1984 "'{}'::jsonb")|$(sf $A 1985 "(select jsonb_set($(fx 100 2), '{1,ord}', '1'))")" = 'fixtures_invalid|fixtures_invalid|fixtures_invalid' ] \
  || fail "fixtures: bad lists"
[ "$(sf $A 1986 "(select jsonb_set($(fx 100 2), '{0,stage}', '\"cup\"'))")" = fixtures_invalid ] || fail "fixtures: bad stage"
[ "$(sf $A 1987 "(select jsonb_set($(fx 100 2), '{0,home_team}', '\"$(dt 9)\"'))")|$(sf $A 1988 "(select jsonb_set($(fx 100 2), '{0,away_team}', '\"$(dt 11)\"'))")" \
  = 'team_not_approved|team_not_approved' ] || fail "fixtures: unapproved or foreign Team"
pos8=$(q "select pos from app.draw_slot where team_id='$(dt 8)'")
q "delete from app.draw_slot where team_id='$(dt 8)'" >/dev/null
[ "$(sf $A 1989 "$(fx 100 3)")" = draw_incomplete ] || fail "fixtures: incomplete Draw"
q "insert into app.draw_slot (id, tournament_id, season_id, grp, pos, team_id) values (gen_random_uuid(), '$T6', '$S10', 0, $pos8, '$(dt 8)')" >/dev/null
[ "$(ms)" = 0 ] || fail "fixtures: refusals wrote"
# Suggest: rows with version 1, status scheduled, no score, logged; a repeat answers alike; a second list is refused until replace.
r1=$(as $A "select app.suggest_fixtures('$(cmd 1990)', '$S10', $(fx 100 3))")
[ "$(q "select (r->>'ok')||(r->>'count') from (select '$r1'::jsonb r) x")" = true3 ] || fail "fixtures: $r1"
[ "$(as $A "select app.suggest_fixtures('$(cmd 1990)', '$S10', $(fx 100 3))")" = "$r1" ] || fail "fixtures: repeat answered differently"
[ "$(q "select count(*)||':'||min(version)||':'||min(status)||':'||count(hg)||':'||count(kick_off) from app.match")" = '3:1:scheduled:0:0' ] || fail "fixtures: row shape"
[ "$(q "select count(*)||':'||bool_and(actor = '$A') from app.activity_log where command_id='$(cmd 1990)' and table_name = 'match' and op = 'insert'")" = '3:true' ] \
  || fail "fixtures: log rows"
[ "$(sf $A 1991 "$(fx 200 2)")|$(sf $A 1992 "$(fx 100 2)" true)" = 'fixtures_exist|already_exists' ] || fail "fixtures: second list or reused id"
[ "$(sf $A 1993 "$(fx 200 2)" true)|$(ms)|$(q "select string_agg(id::text, ',' order by ord) from app.match")" = "ok|2|$(mid 201),$(mid 202)" ] || fail "fixtures: replace"
[ "$(q "select count(*) from app.activity_log where command_id='$(cmd 1993)' and table_name = 'match' and op = 'delete'")" = 3 ] || fail "fixtures: replace log"
# Leaks: another Tournament sees no Fixture and no log row; anon reads nothing.
[ "$(as $B "select count(*) from app.match")|$(as $B "select count(*) from app.activity_log where table_name = 'match'")|$(as $A "select count(*) from app.match")" = '0|0|2' ] \
  || fail "leak: another Tournament reads Fixtures"
out=$(as anon "select count(*) from app.match" 2>&1 || true)
[[ $out == *"permission denied"* ]] || fail "leak: anon reads Fixtures: $out"
# A League needs no Draw.
q "delete from app.draw_slot where season_id='$S10'; update app.season set structure = 'league' where id='$S10'" >/dev/null
[ "$(sf $A 1994 "$(fx 300 2)" true)|$(ms)" = 'ok|2' ] || fail "fixtures: League without a Draw"
# Put the Draw back for the started-Season check below.
q "update app.season set structure = 'knockout' where id='$S10'" >/dev/null
for i in 1 2 3 4 5 6 7 8; do
  q "insert into app.draw_slot (id, tournament_id, season_id, grp, pos, team_id) values (gen_random_uuid(), '$T6', '$S10', 0, $i, '$(dt $i)')" >/dev/null
done

# --- Arrange, schedule and publish Fixtures (Story 3.3). S10 has 2 Fixtures M1 (ord 1) and M2 (ord 2), version 1, no kick-off.
M1=$(mid 301) M2=$(mid 302)
sw() { tc "$1" "swap_fixtures('$(cmd "$2")', '$S10', '$3', $4, '$5', $6)"; }
ko() { tc "$1" "set_kick_off('$(cmd "$2")', '$S10', '$3', $4, '$5'::timestamptz)"; }
pub() { tc "$1" "publish_fixtures('$(cmd "$2")', '$S10')"; }
ords() { q "select string_agg(ord||':'||version, ' ' order by id) from app.match where season_id='$S10'"; }
for who in $B $G1; do
  [ "$(sw $who 2001 $M1 1 $M2 1)|$(ko $who 2002 $M1 1 '2026-11-12 10:00+05:45')|$(pub $who 2003)" = 'not_authorized|not_authorized|not_authorized' ] \
    || fail "leak: $who arranged Fixtures"
  redo 2001; redo 2002; redo 2003
done
for f in "swap_fixtures('$(cmd 2004)', '$S10', '$M1', 1, '$M2', 1)" "set_kick_off('$(cmd 2004)', '$S10', '$M1', 1, now())" "publish_fixtures('$(cmd 2004)', '$S10')"; do
  out=$(as anon "select app.$f" 2>&1 || true)
  [[ $out == *"permission denied for function"* ]] || fail "anon: can execute $f: $out"
done
# Swap: the two Matches exchange order and both versions bump; a repeat answers alike; refusals write nothing.
r1=$(as $A "select app.swap_fixtures('$(cmd 2010)', '$S10', '$M1', 1, '$M2', 1)")
[ "$(ords)" = "2:2 1:2" ] || fail "swap: $r1 / $(ords)"
[ "$(as $A "select app.swap_fixtures('$(cmd 2010)', '$S10', '$M1', 1, '$M2', 1)")" = "$r1" ] && [ "$(ords)" = "2:2 1:2" ] || fail "swap: repeat"
[ "$(q "select count(*) from app.activity_log where command_id='$(cmd 2010)' and table_name='match' and op='update'")" = 2 ] || fail "swap: log rows"
[ "$(sw $A 2011 $M1 1 $M2 2)|$(sw $A 2012 $M1 2 $M1 2)|$(sw $A 2013 $M1 2 "$(mid 999)" 1)" = 'version_conflict|match_missing|match_missing' ] || fail "swap: refusals"
[ "$(as $A "select r->'conflict'->'resend' from app.swap_fixtures('$(cmd 2014)', '$S10', '$M1', 1, '$M2', 2) r")" = '{"version_a": 2, "version_b": 2}' ] || fail "swap: resend"
[ "$(ords)" = "2:2 1:2" ] || fail "swap: refusals wrote"
[ "$(sw $A 2015 $M1 2 $M2 2)" = ok ] && [ "$(ords)" = "1:3 2:3" ] || fail "swap: back"
# Kick-off: a Kathmandu day inside the Season's dates only (23:30 Kathmandu on the 20th is 17:45 UTC; 00:30 on the 21st is outside).
q "update app.season set starts_on = '2026-11-10', ends_on = '2026-11-20' where id='$S10'" >/dev/null
[ "$(ko $A 2020 $M1 3 '2026-11-09 23:59+05:45')|$(ko $A 2021 $M1 3 '2026-11-20 23:59+05:45')|$(ko $A 2022 $M1 3 '2026-11-21 00:30+05:45')" \
  = 'kickoff_outside_season|ok|kickoff_outside_season' ] || fail "kick-off: season dates"
[ "$(ko $A 2023 $M1 3 '2026-11-12 10:00+05:45')|$(ko $A 2024 $(mid 999) 1 '2026-11-12 10:00+05:45')" = 'version_conflict|match_missing' ] || fail "kick-off: stale or unknown"
[ "$(q "select version||' '||(kick_off at time zone 'Asia/Kathmandu') from app.match where id='$M1'")" = '4 2026-11-20 23:59:00' ] || fail "kick-off: stored"
# Publish needs every Match to have a kick-off, then sets the time once; a published Season can't be suggested again.
[ "$(pub $A 2030)" = kickoff_missing ] && [ "$(q "select fixtures_published_at is null from app.season where id='$S10'")" = t ] || fail "publish: missing kick-off"
[ "$(ko $A 2031 $M2 3 '2026-11-12 10:00+05:45')|$(pub $A 2032)" = 'ok|ok' ] || fail "publish: ok"
p1=$(q "select fixtures_published_at from app.season where id='$S10'")
[ -n "$p1" ] && [ "$(pub $A 2033)" = ok ] && [ "$(q "select fixtures_published_at from app.season where id='$S10'")" = "$p1" ] || fail "publish: twice"
[ "$(sf $A 2034 "$(fx 500 2)" true)|$(ms)" = 'fixtures_published|2' ] || fail "publish: suggest again"
# Edits still save after publishing (before the Season starts).
[ "$(sw $A 2035 $M1 4 $M2 4)|$(ko $A 2036 $M1 5 '2026-11-13 10:00+05:45')" = 'ok|ok' ] || fail "publish: edits after"
# Leaks: another Tournament sees no published time on this Season.
[ "$(as $B "select count(*) from app.season where fixtures_published_at is not null")" = 0 ] || fail "leak: published Season visible"
q "update app.season set fixtures_published_at = null, starts_on = null, ends_on = null where id='$S10'" >/dev/null

# After the Season starts the Draw is locked.
q "update app.season set status = 'started' where id='$S10'" >/dev/null
[ "$(un $A 1970 1)|$(rnd $A 1971)|$(pl $A 1972 1 0 1)" = 'season_started|season_started|season_started' ] || fail "draw: started Season still changes"
[ "$(as $A "select count(*) from app.draw_slot")" = 8 ] || fail "draw: a locked Draw changed"
# The Season has started: Fixtures can't be suggested or replaced.
[ "$(sf $A 1980 "$(fx 400 3)" true)|$(ms)" = 'confirmation_required|2' ] || fail "fixtures: allowed after start"
[ "$(sw $A 2040 $M1 6 $M2 5)|$(ko $A 2041 $M1 6 '2026-11-13 10:00+05:45')|$(pub $A 2042)" = 'confirmation_required|confirmation_required|confirmation_required' ] || fail "fixtures: arranged after start without confirming"

# --- Standings and knockout progression (Story 3.4). A organises T7 (S11: 2 groups of 3, X1..X3 in Group A, X4..X6 in Group B,
# semi-finals A1 v B2 and B1 v A2, then the Final); B and G1 do not. Results are seeded with SQL: no command writes a score yet.
T7=11111111-0000-4000-8000-0000000000d7 S11=21111111-0000-4000-8000-0000000000d7
xt() { printf '74111111-0000-4000-8000-%012d' "$1"; }
xm() { printf '75111111-0000-4000-8000-%012d' "$1"; }
shoot() { tc "$1" "record_tiebreak_shootout('$(cmd "$2")', '$S11', '$(sid "$2")', '$(xt "$3")', '$(xt "$4")')"; }
st() { as $A "select string_agg(s.grp||'.'||s.pos||'='||t.code||':'||s.pts||(case when s.provisional then '?' else '' end), ' ' order by s.grp, s.pos)
  from app.standings('$S11') s join app.team t on t.id = s.team_id"; }
sides() { as $A "select string_agg(coalesce(h.code, r.home_src, '-')||'v'||coalesce(a.code, r.away_src, '-'), ' ' order by m.ord)
  from app.match_sides('$S11') r join app.match m on m.id = r.match_id left join app.team h on h.id = r.home_team_id
  left join app.team a on a.id = r.away_team_id where m.stage = 'knockout'"; }
gm() { q "insert into app.match (id, tournament_id, season_id, stage, round, ord, home_team_id, away_team_id) values ('$(xm "$1")', '$T7', '$S11', 'group', 'Group', $1, '$(xt "$2")', '$(xt "$3")')" >/dev/null; }
fin() { q "update app.match set status = 'finished', hg = $2, ag = $3 where id = '$(xm "$1")'" >/dev/null; }
[ "$(create $A 2100 $T7 $S11 'Standings Cup')" != "" ] || fail "standings: fixture"
q "update app.season set structure = 'groups_knockout', group_count = 2, teams_per_group = 3, qualifiers_per_group = 2 where id='$S11'" >/dev/null
for i in 1 2 3 4 5 6; do
  q "insert into app.team (id, tournament_id, season_id, name, code, status) values ('$(xt $i)', '$T7', '$S11', 'Standing team $i', 'X$i', 'approved');
     insert into app.draw_slot (id, tournament_id, season_id, grp, pos, team_id) values (gen_random_uuid(), '$T7', '$S11', $(( (i - 1) / 3 + 1 )), $(( (i - 1) % 3 + 1 )), '$(xt $i)')" >/dev/null
done
gm 1 1 2; gm 2 2 3; gm 3 3 1; gm 4 4 5; gm 5 5 6; gm 6 4 6
q "insert into app.match (id, tournament_id, season_id, stage, round, label, ord, home_src, away_src) values
  ('$(xm 20)', '$T7', '$S11', 'knockout', 'SF', 'SF1', 20, 'A1', 'B2'), ('$(xm 21)', '$T7', '$S11', 'knockout', 'SF', 'SF2', 21, 'B1', 'A2'),
  ('$(xm 22)', '$T7', '$S11', 'knockout', 'Final', 'Final', 22, 'Winner SF1', 'Winner SF2')" >/dev/null
# No result yet: every row on 0, no shootout needed, labels kept.
[ "$(st)" = '1.1=X1:0 1.2=X2:0 1.3=X3:0 2.1=X4:0 2.2=X5:0 2.3=X6:0' ] || fail "standings: empty table $(st)"
[ "$(sides)" = 'A1vB2 B1vA2 Winner SF1vWinner SF2' ] || fail "standings: labels $(sides)"
# Fences: another Tournament's Organiser reads nothing and records nothing; anon can't call; no client writes; helpers closed.
[ "$(as $B "select count(*) from app.standings('$S11')")|$(as $B "select count(*) from app.match_sides('$S11')")|$(as $A "select count(*) from app.match_sides('$S11')")" = '0|0|9' ] \
  || fail "leak: another Tournament reads standings or sides"
[ "$(as $B "select count(*) from app.tiebreak_shootout")|$(as $B "select count(*) from app.match where season_id = '$S11'")" = '0|0' ] || fail "leak: shootouts or Matches visible"
for f in "standings('$S11')" "match_sides('$S11')" "record_tiebreak_shootout('$(cmd 2101)', '$S11', '$(sid 2101)', '$(xt 1)', '$(xt 2)')" "standings_calc('$S11')" "match_resolve('$S11')"; do
  out=$(as anon "select * from app.$f" 2>&1 || true)
  [[ $out == *"permission denied for function"* ]] || fail "anon: can execute $f: $out"
done
for f in "standings_calc('$S11')" "match_resolve('$S11')"; do
  out=$(as $A "select * from app.$f" 2>&1 || true)
  [[ $out == *"permission denied for function"* ]] || fail "Organiser can execute $f: $out"
done
out=$(as anon "select count(*) from app.tiebreak_shootout" 2>&1 || true)
[[ $out == *"permission denied"* ]] || fail "leak: anon reads shootouts: $out"
out=$(as $A "insert into app.tiebreak_shootout (id, tournament_id, season_id, winner_team_id, loser_team_id) values (gen_random_uuid(), '$T7', '$S11', '$(xt 1)', '$(xt 2)')" 2>&1 || true)
[[ $out == *"permission denied"* ]] || fail "Organiser can write tiebreak_shootout: $out"
[ "$(shoot $A 2102 1 2)" = season_setup ] || fail "shootout: allowed in setup"
q "update app.season set status = 'registration' where id='$S11'; update app.season set status = 'started' where id='$S11'" >/dev/null
for who in $B $G1; do
  [ "$(shoot $who 2103 1 2)" = not_authorized ] || fail "leak: $who recorded a shootout"
  redo 2103
done
# Group A: three Teams each beat one other 1-0. One Match open: no group yet, A1 unresolved and nothing provisional.
fin 1 1 0; fin 2 1 0
[ "$(st)" = '1.1=X1:3 1.2=X2:3 1.3=X3:0 2.1=X4:0 2.2=X5:0 2.3=X6:0' ] || fail "standings: partial $(st)"
[ "$(sides)" = 'A1vB2 B1vA2 Winner SF1vWinner SF2' ] || fail "standings: an unfinished group resolved $(sides)"
fin 3 1 0; fin 4 1 0; fin 5 1 0; fin 6 1 0
# Level on points, head-to-head points and goal difference, no shootout: provisional, and the knockout slots already resolve.
[ "$(st)" = '1.1=X1:3? 1.2=X2:3? 1.3=X3:3? 2.1=X4:6 2.2=X5:3 2.3=X6:0' ] || fail "standings: provisional $(st)"
[ "$(sides)" = 'X1vX5 X4vX2 Winner SF1vWinner SF2' ] || fail "standings: slots $(sides)"
[ "$(as $A "select s.shootout_with = '$(xt 2)' from app.standings('$S11') s where s.team_id = '$(xt 1)'")" = t ] || fail "standings: shootout_with"
# Knockout Matches never count in a table.
q "update app.match set status = 'finished', hg = 5, ag = 0 where id = '$(xm 20)'" >/dev/null
[ "$(st)" = '1.1=X1:3? 1.2=X2:3? 1.3=X3:3? 2.1=X4:6 2.2=X5:3 2.3=X6:0' ] || fail "standings: a knockout Match counted $(st)"
q "update app.match set status = 'scheduled', hg = null, ag = null, home_team_id = null, away_team_id = null where id = '$(xm 20)'" >/dev/null
# Record the shootout: not needed for Teams that are not level, other Season or other Teams; the order flips; goals and points stay.
[ "$(shoot $A 2110 4 5)|$(shoot $A 2111 1 6)|$(shoot $A 2112 1 99)" = 'shootout_not_needed|shootout_not_needed|shootout_not_needed' ] || fail "shootout: not needed"
[ "$(shoot $A 2113 1 3)" = shootout_not_needed ] || fail "shootout: Teams that are not next to each other in the tie"
[ "$(as $A "select count(*) from app.tiebreak_shootout")" = 0 ] || fail "shootout: a refusal wrote"
r=$(as $A "select app.record_tiebreak_shootout('$(cmd 2114)', '$S11', '$(sid 2114)', '$(xt 2)', '$(xt 1)')")
[ "$(q "select r->>'ok' from (select '$r'::jsonb r) x")" = true ] || fail "shootout: $r"
[ "$(as $A "select app.record_tiebreak_shootout('$(cmd 2114)', '$S11', '$(sid 2114)', '$(xt 2)', '$(xt 1)')")" = "$r" ] \
  && [ "$(as $A "select count(*) from app.tiebreak_shootout")" = 1 ] || fail "shootout: replay"
[ "$(q "select count(*)||':'||bool_and(actor = '$A') from app.activity_log where command_id='$(cmd 2114)' and table_name = 'tiebreak_shootout' and op = 'insert'")" = '1:true' ] \
  || fail "shootout: log row"
[ "$(st)" = '1.1=X2:3 1.2=X1:3? 1.3=X3:3? 2.1=X4:6 2.2=X5:3 2.3=X6:0' ] || fail "shootout: order did not flip $(st)"
[ "$(as $A "select string_agg(s.gf||'-'||s.ga, ',' order by s.pos) from app.standings('$S11') s where s.grp = 1")" = '1-1,1-1,1-1' ] || fail "shootout: goals changed"
[ "$(sides)" = 'X2vX5 X4vX1 Winner SF1vWinner SF2' ] || fail "shootout: slots did not follow $(sides)"
# A knockout Match level after play is decided by its shootout; level with none stays unresolved.
q "update app.match set status = 'finished', hg = 2, ag = 2, home_pens = 4, away_pens = 3 where id = '$(xm 20)'" >/dev/null
q "update app.match set status = 'finished', hg = 1, ag = 1 where id = '$(xm 21)'" >/dev/null
[ "$(sides)" = 'X2vX5 X4vX1 X2vWinner SF2' ] || fail "knockout: pens winner $(sides)"
out=$(q "update app.match set home_pens = 2, away_pens = 2 where id = '$(xm 21)'" 2>&1 || true)
[[ $out == *violates* ]] || fail "knockout: level shootout accepted: $out"
q "update app.match set home_pens = 3, away_pens = 2 where id = '$(xm 21)'" >/dev/null
[ "$(sides)" = 'X2vX5 X4vX1 X2vX4' ] || fail "knockout: Final sides $(sides)"
# Freeze: the Final goes live with X2 v X4 written into it; then a result or a shootout that changes them is refused.
q "update app.match set status = 'live' where id = '$(xm 22)'" >/dev/null
[ "$(q "select h.code||'v'||a.code from app.match m join app.team h on h.id = m.home_team_id join app.team a on a.id = m.away_team_id where m.id = '$(xm 22)'")" = X2vX4 ] \
  || fail "freeze: sides not written"
out=$(q "update app.match set hg = 1, ag = 3, home_pens = null, away_pens = null where id = '$(xm 20)'" 2>&1 || true)
[[ $out == *downstream_started* ]] || fail "freeze: result change allowed: $out"
[ "$(q "select hg||'-'||ag from app.match where id = '$(xm 20)'")" = 2-2 ] || fail "freeze: the refused change wrote"
[ "$(shoot $A 2120 1 3)" = downstream_started ] && [ "$(as $A "select count(*) from app.tiebreak_shootout")" = 1 ] || fail "freeze: shootout allowed"
# A change that leaves every frozen side as it is still saves.
q "update app.match set hg = 3, ag = 3, home_pens = 5, away_pens = 4 where id = '$(xm 20)'" >/dev/null
[ "$(sides)" = 'X2vX5 X4vX1 X2vX4' ] || fail "freeze: harmless change moved the sides $(sides)"
# Frozen sides are kept when the Match is read back, whatever the label would say now.
[ "$(as $A "select count(*) from app.match_sides('$S11') r where r.match_id = '$(xm 22)' and r.home_team_id = r.home_resolved and r.away_team_id = r.away_resolved")" = 1 ] \
  || fail "freeze: resolved differs from frozen"

# League: one table, every approved Team, league Matches only.
q "delete from app.match where season_id = '$S11'; delete from app.draw_slot where season_id = '$S11'; delete from app.tiebreak_shootout where season_id = '$S11';
   update app.season set structure = 'league' where id = '$S11'" >/dev/null
q "insert into app.match (id, tournament_id, season_id, stage, round, ord, home_team_id, away_team_id, status, hg, ag) values
  ('$(xm 1)', '$T7', '$S11', 'league', 'League', 1, '$(xt 1)', '$(xt 2)', 'finished', 3, 1),
  ('$(xm 2)', '$T7', '$S11', 'group', 'Group', 2, '$(xt 3)', '$(xt 2)', 'finished', 9, 0)" >/dev/null
[ "$(as $A "select string_agg(s.grp||'.'||s.pos||'='||t.code||':'||s.pts, ' ' order by s.pos) from app.standings('$S11') s join app.team t on t.id = s.team_id")" = '0.1=X1:3 0.2=X3:0 0.3=X4:0 0.4=X5:0 0.5=X6:0 0.6=X2:0' ] \
  || fail "standings: League $(as $A "select string_agg(s.pos||t.code||s.pts, ' ' order by s.pos) from app.standings('$S11') s join app.team t on t.id = s.team_id")"

# Parity with matchday/league.js: Season 1 and the league.test.js cases, in a throwaway Season, must give the same order.
T8=11111111-0000-4000-8000-0000000000d8 S12=21111111-0000-4000-8000-0000000000d8
[ "$(create $A 2200 $T8 $S12 'Parity Cup')" != "" ] || fail "parity: fixture"
command -v node >/dev/null || fail "parity: node is needed"
PG_CONTAINER=$name PARITY_TOURNAMENT=$T8 PARITY_SEASON=$S12 node "$dir/standings.parity.mjs" || fail "parity: standings differ from matchday/league.js"

# --- Start the tournament (Story 3.5). A organises T9 (S13: 2 groups of 2, teams Y1..Y4 approved); B and G1 do not.
T9=11111111-0000-4000-8000-0000000000d9 S13=21111111-0000-4000-8000-0000000000d9
yt() { printf '76111111-0000-4000-8000-%012d' "$1"; }
ss() { tc "$1" "start_season('$(cmd "$2")', '$S13')"; }
sc() { as "$1" "select app.start_check('$S13')->>'$2'"; }
yslot() { q "insert into app.draw_slot (id, tournament_id, season_id, grp, pos, team_id) values (gen_random_uuid(), '$T9', '$S13', $(( ($1 - 1) / 2 + 1 )), $(( ($1 - 1) % 2 + 1 )), '$(yt $1)')" >/dev/null; }
[ "$(create $A 2300 $T9 $S13 'Start Cup')" != "" ] || fail "start: fixture"
q "update app.season set structure = 'groups_knockout', group_count = 2, teams_per_group = 2, qualifiers_per_group = 1 where id='$S13'" >/dev/null
for i in 1 2 3 4; do
  q "insert into app.team (id, tournament_id, season_id, name, code, status) values ('$(yt $i)', '$T9', '$S13', 'Start team $i', 'Y$i', 'approved')" >/dev/null
done
# Not in setup (or later): refused with the Season's own code.
[ "$(ss $A 2301)" = season_setup ] || fail "start: allowed in setup"
q "update app.season set status = 'registration' where id='$S13'" >/dev/null
# Fences: another Tournament's Organiser and an anonymous Team manager can't start or read; anon can't call.
for who in $B $G1; do
  [ "$(ss $who 2302)" = not_authorized ] || fail "leak: $who started the Season"
  redo 2302
done
[ "$(as $B "select app.start_check('$S13') is null")|$(as $A "select app.start_check('$S13') is null")" = 't|f' ] || fail "leak: another Tournament reads start_check"
for f in "start_season('$(cmd 2303)', '$S13')" "start_check('$S13')"; do
  out=$(as anon "select app.$f" 2>&1 || true)
  [[ $out == *"permission denied for function"* ]] || fail "anon: can execute $f: $out"
done
st9() { q "select status from app.season where id='$S13'"; }
blocked() { # $1 command number, $2 expected reason: start_blocked with the same text as start_check, nothing changed
  local r; r=$(as $A "select app.start_season('$(cmd "$1")', '$S13')")
  [ "$(q "select (r->>'code')||'|'||(r->>'message') from (select \$j\$$r\$j\$::jsonb r) x")" = "start_blocked|$2" ] || fail "start: $2 / $r"
  [ "$(sc $A reason)|$(sc $A ready)|$(st9)" = "$2|false|registration" ] || fail "start_check: $2 / $(sc $A reason)"
}
# No Teams approved (under two).
q "update app.team set status = 'withdrawn' where season_id='$S13'" >/dev/null
blocked 2304 "Can't start yet: no Teams approved."
# One approved Team and one pending: the approval reason comes first.
q "update app.team set status = 'approved' where code = 'Y1' and season_id='$S13'; update app.team set status = 'submitted' where code = 'Y2' and season_id='$S13'" >/dev/null
blocked 2340 "Can't start yet: 1 Team still needs approval (Y2)"
# Needs approval: one Team (singular), two (plural, in code order); a withdrawn Team is ignored.
q "update app.team set status = 'approved' where season_id='$S13' and code <> 'Y2'; update app.team set status = 'withdrawn' where code = 'Y4' and season_id='$S13'" >/dev/null
q "update app.team set status = 'approved' where code = 'Y4' and season_id='$S13'" >/dev/null
q "update app.team set status = 'submitted' where code = 'Y2' and season_id='$S13'" >/dev/null
blocked 2305 "Can't start yet: 1 Team still needs approval (Y2)"
[ "$(as $A "select app.start_check('$S13')->'teams'->0->>'id'")" = "$(yt 2)" ] || fail "start_check: teams list"
q "update app.team set status = 'returned' where code = 'Y1' and season_id='$S13'" >/dev/null
blocked 2306 "Can't start yet: 2 Teams still need approval (Y1, Y2)"
q "update app.team set status = 'approved' where season_id='$S13'" >/dev/null
# Draw incomplete: nobody placed, then two placed.
blocked 2307 "Can't start yet: 4 Teams aren't in the Draw (Y1, Y2, Y3, Y4)"
yslot 1; yslot 2
blocked 2308 "Can't start yet: 2 Teams aren't in the Draw (Y3, Y4)"
yslot 3
blocked 2309 "Can't start yet: 1 Team isn't in the Draw (Y4)"
yslot 4
# Unpublished.
blocked 2310 "Can't start yet: publish the Fixtures first."
q "update app.season set fixtures_published_at = now() where id='$S13'" >/dev/null
# Ready; a withdrawn Team is ignored, whether placed or not.
q "insert into app.team (id, tournament_id, season_id, name, code, status) values ('$(yt 9)', '$T9', '$S13', 'Gone', 'YW', 'withdrawn')" >/dev/null
[ "$(sc $A reason)|$(sc $A ready)" = 'Ready to start: 4 Teams approved, Draw recorded.|true' ] || fail "start_check: ready $(sc $A reason)"
# Exactly one approved Team and nothing else in the way.
q "update app.team set status = 'withdrawn' where season_id='$S13' and code <> 'Y1'" >/dev/null
blocked 2341 "Can't start yet: only 1 Team approved."
q "update app.team set status = 'approved' where season_id='$S13' and code <> 'YW'" >/dev/null
# Another Tournament's Organiser still can't; the refused ids wrote nothing; the Season is still in registration.
[ "$(st9)" = registration ] || fail "start: a refusal moved the Season"
# Start: one answer, logged once, repeat answers alike, a second command says season_started, locks hold.
r1=$(as $A "select app.start_season('$(cmd 2311)', '$S13')")
[ "$(q "select (r->>'ok')||(r->>'code' is null)::text from (select '$r1'::jsonb r) x")" = truetrue ] && [ "$(st9)" = started ] || fail "start: $r1"
[ "$(as $A "select app.start_season('$(cmd 2311)', '$S13')")" = "$r1" ] || fail "start: repeat answered differently"
[ "$(q "select count(*)||':'||bool_and(actor = '$A')||':'||bool_and(after->>'status' = 'started' and before->>'status' = 'registration') from app.activity_log where command_id='$(cmd 2311)' and table_name = 'season' and op = 'update'")" = '1:true:true' ] \
  || fail "start: log row"
[ "$(ss $A 2312)" = season_started ] || fail "start: twice"
[ "$(tc $A "place_team_in_draw('$(cmd 2313)', '$S13', '$(sid 2313)', '$(yt 1)', 1, 1)")|$(tc $A "unplace_team_from_draw('$(cmd 2314)', '$S13', '$(yt 1)')")|$(tc $A "publish_fixtures('$(cmd 2315)', '$S13')")" \
  = 'season_started|season_started|confirmation_required' ] || fail "start: Draw or Fixtures still editable"
[ "$(tc $A "set_lineup_rules('$(cmd 2316)', '$S13', 1, 5, 5)")" = season_started ] || fail "start: setup still editable"
# Nothing moves a started Season back.
out=$(q "update app.season set status = 'registration' where id='$S13'" 2>&1 || true)
[[ $out == *"cannot change from started to registration"* ]] || fail "start: moved back: $out"
# A League needs no Draw.
T10=11111111-0000-4000-8000-0000000000da S14=21111111-0000-4000-8000-0000000000da
[ "$(create $A 2320 $T10 $S14 'League Start')" != "" ] || fail "start: league fixture"
q "update app.season set structure = 'league', status = 'registration', fixtures_published_at = now() where id='$S14';
   insert into app.team (id, tournament_id, season_id, name, code, status) values ('$(yt 21)', '$T10', '$S14', 'L1', 'L1', 'approved'), ('$(yt 22)', '$T10', '$S14', 'L2', 'L2', 'approved')" >/dev/null
[ "$(as $A "select app.start_check('$S14')->>'reason'")" = 'Ready to start: 2 Teams approved.' ] || fail "start_check: League text"
[ "$(tc $A "start_season('$(cmd 2321)', '$S14')")" = ok ] || fail "start: League"

# --- Finish the season (Story 3.8). S13 (T9) is started; A organises it, B and G1 do not.
fm() { printf '77111111-0000-4000-8000-%012d' "$1"; }
fs() { tc "$1" "finish_season('$(cmd "$2")', '$S13')"; }
fc() { as "$1" "select app.finish_check('$S13')->>'$2'"; }
fblocked() { # $1 command number, $2 expected reason
  local r; r=$(as $A "select app.finish_season('$(cmd "$1")', '$S13')")
  [ "$(q "select (r->>'code')||'|'||(r->>'message') from (select \$j\$$r\$j\$::jsonb r) x")" = "finish_blocked|$2" ] || fail "finish: $2 / $r"
  [ "$(fc $A reason)|$(fc $A ready)|$(st9)" = "$2|false|started" ] || fail "finish_check: $2 / $(fc $A reason)"
}
for who in $B $G1; do
  [ "$(fs $who 2600)" = not_authorized ] || fail "leak: $who finished the Season"
  redo 2600
done
[ "$(as $B "select app.finish_check('$S13') is null")|$(as $A "select app.finish_check('$S13') is null")" = 't|f' ] || fail "leak: another Tournament reads finish_check"
for f in "finish_season('$(cmd 2601)', '$S13')" "finish_check('$S13')"; do
  out=$(as anon "select app.$f" 2>&1 || true)
  [[ $out == *"permission denied for function"* ]] || fail "anon: can execute $f: $out"
done
# Wrong status: registration is refused with the Season's own code.
[ "$(fs $A 2602)" = finish_blocked ] || fail "finish: no Matches"
fblocked 2603 "Can't finish yet: there are no Matches."
q "insert into app.match (id, tournament_id, season_id, stage, round, ord, home_team_id, away_team_id, status, hg, ag) values
  ('$(fm 1)', '$T9', '$S13', 'group', 'Group', 1, '$(yt 1)', '$(yt 2)', 'finished', 1, 0),
  ('$(fm 2)', '$T9', '$S13', 'group', 'Group', 2, '$(yt 3)', '$(yt 4)', 'scheduled', null, null),
  ('$(fm 3)', '$T9', '$S13', 'group', 'Group', 3, '$(yt 1)', '$(yt 3)', 'scheduled', null, null),
  ('$(fm 4)', '$T9', '$S13', 'group', 'Group', 4, '$(yt 2)', '$(yt 4)', 'scheduled', null, null)" >/dev/null
fblocked 2604 "Can't finish yet: 3 Matches aren't finished."
q "update app.match set status = 'finished', hg = 2, ag = 2 where id in ('$(fm 2)', '$(fm 3)')" >/dev/null
fblocked 2605 "Can't finish yet: 1 Match isn't finished."
q "update app.match set status = 'finished', hg = 0, ag = 3 where id = '$(fm 4)'" >/dev/null
[ "$(fc $A reason)|$(fc $A ready)" = "Ready to finish: every Match is finished.|true" ] || fail "finish_check: ready $(fc $A reason)"
# An unverified scan of the Season (a finished Season's scans go).
q "insert into storage.objects (bucket_id, name) values ('eligibility-scans', '$T9/fin.webp');
   insert into app.eligibility_record (id, tournament_id, player_id, season_id, document_type, document_number, scan_path, scan_name)
     values ('b1111111-0000-4000-8000-0000000000f1', '$T9', '$Q2', '$S13', 'emis', '5', '$T9/fin.webp', 'fin.jpg')" >/dev/null
[ "$(svc "select count(*) from app.scans_to_delete() n where n = '$T9/fin.webp'")" = 0 ] || fail "finish: scan listed while started"
[ "$(st9)" = started ] || fail "finish: a refusal moved the Season"
r1=$(as $A "select app.finish_season('$(cmd 2606)', '$S13')")
[ "$(q "select (r->>'ok')||(r->>'code' is null)::text from (select '$r1'::jsonb r) x")" = truetrue ] && [ "$(st9)" = finished ] || fail "finish: $r1"
[ "$(as $A "select app.finish_season('$(cmd 2606)', '$S13')")" = "$r1" ] || fail "finish: repeat answered differently"
[ "$(q "select count(*)||':'||bool_and(actor = '$A')||':'||bool_and(after->>'status' = 'finished' and before->>'status' = 'started') from app.activity_log where command_id='$(cmd 2606)' and table_name = 'season' and op = 'update'")" = '1:true:true' ] \
  || fail "finish: log row"
[ "$(fs $A 2607)" = season_finished ] || fail "finish: twice"
[ "$(svc "select count(*) from app.scans_to_delete() n where n = '$T9/fin.webp'")" = 1 ] || fail "finish: the scan is not listed for deletion"
# Locked for good, confirmed or not.
[ "$(tc $A "set_kick_off('$(cmd 2608)', '$S13', '$(fm 1)', 1, now(), true)")|$(tc $A "set_kick_off('$(cmd 2609)', '$S13', '$(fm 1)', 1, now())")" = 'season_finished|season_finished' ] || fail "finish: kick-off still editable"
[ "$(tc $A "edit_player('$(cmd 2610)', '$(yt 1)', '$(sid 2610)', 1, 'x', null, null, null, null, true)")|$(tc $A "add_player('$(cmd 2611)', '$(yt 1)', '$(sid 2611)', 'x', 1, '$grown', true, null, true)")" = 'season_finished|season_finished' ] || fail "finish: Squad still editable"
[ "$(tc $A "record_tiebreak_shootout('$(cmd 2612)', '$S13', '$(sid 2612)', '$(yt 1)', '$(yt 2)')")|$(tc $A "set_lineup_rules('$(cmd 2613)', '$S13', 1, 5, 5)")" = 'season_finished|season_finished' ] || fail "finish: shootout or setup still editable"
out=$(q "update app.season set status = 'started' where id='$S13'" 2>&1 || true)
[[ $out == *"cannot change from finished to started"* ]] || fail "finish: unfinished: $out"
# Wrong status: a Season in setup.
S15=21111111-0000-4000-8000-0000000000db T11=11111111-0000-4000-8000-0000000000db
[ "$(create $A 2616 $T11 $S15 'Setup Finish')" != "" ] && [ "$(tc $A "finish_season('$(cmd 2614)', '$S15')")" = season_setup ] || fail "finish: allowed outside started"

# --- Confirm before changes after start (Story 3.6, FR-16). A organises T5 (S6 started, Team Z) and T1 (S9 started) and S10's
# Fixtures M1, M2 (started above). Every Squad and Fixture command needs confirmed => true once the Season has started; a
# Registration link never passes (season_started); other Tournaments' Organisers are refused; rules text stays locked.
ZP=91111111-0000-4000-8000-0000000000a8 ZS=a1111111-0000-4000-8000-0000000000a8 ZR=b2111111-0000-4000-8000-0000000000a8
ZV=c2111111-0000-4000-8000-0000000000a8
zn() { q "select count(*) from app.squad_entry where team_id='$Z'"; }
zsh() { q "select shirt_number from app.squad_entry where player_id='$ZP'"; }
n0=$(zn)
addp() { tc $A "add_player('$(cmd "$1")', '$Z', '$ZP', 'Ram Thapa', 7, '$grown', false$2)"; }
[ "$(addp 2401 '')|$(zn)" = "confirmation_required|$n0" ] || fail "confirm: Player added unconfirmed: $(addp 2401 '')"
[ "$(addp 2401 ', confirmed => false')|$(zn)" = "confirmation_required|$n0" ] || fail "confirm: Player added with confirmed false"
[ "$(addp 2402 ', confirmed => true')|$(zn)" = "ok|$((n0 + 1))" ] || fail "confirm: Player not added once confirmed"
[ "$(addp 2402 ', confirmed => true')|$(zn)" = "ok|$((n0 + 1))" ] || fail "confirm: confirmed replay added again"
[ "$(q "select count(*)||':'||bool_and(actor = '$A') from app.activity_log where command_id='$(cmd 2402)' and table_name = 'squad_entry' and op = 'insert'")" = '1:true' ] \
  || fail "confirm: add not logged with the actor"
ep2() { tc $A "edit_player('$(cmd "$1")', '$Z', '$ZP', $(pv $ZP), shirt_number => $2$3)"; }
[ "$(ep2 2403 9 '')|$(zsh)" = "confirmation_required|7" ] || fail "confirm: shirt changed unconfirmed"
[ "$(ep2 2404 9 ', confirmed => true')|$(zsh)" = "ok|9" ] || fail "confirm: shirt not changed once confirmed"
[ "$(q "select (before->>'shirt_number')||'>'||(after->>'shirt_number')||':'||(actor = '$A')::text from app.activity_log where command_id='$(cmd 2404)' and table_name = 'squad_entry' and op = 'update'")" = '7>9:true' ] \
  || fail "confirm: shirt change log row"
zst() { tc $A "$1('$(cmd "$2")', '$Z', $3$4)"; }
sc() { q "select count(*) from app.staff where team_id='$Z'"; }
s0=$(sc)
[ "$(zst add_staff 2405 "'$ZS', 'Hari Rana', 'coach'" '')|$(sc)" = "confirmation_required|$s0" ] || fail "confirm: Staff added unconfirmed"
[ "$(zst add_staff 2406 "'$ZS', 'Hari Rana', 'coach'" ', confirmed => true')|$(sc)" = "ok|$((s0 + 1))" ] || fail "confirm: Staff not added once confirmed"
sv() { q "select version from app.staff where id='$ZS'"; }
[ "$(zst edit_staff 2407 "'$ZS', $(sv), name => 'Hari R'" '')|$(zst edit_staff 2408 "'$ZS', $(sv), name => 'Hari R'" ', confirmed => true')|$(q "select name from app.staff where id='$ZS'")" \
  = 'confirmation_required|ok|Hari R' ] || fail "confirm: edit_staff"
[ "$(zst add_eligibility 2409 "'$ZP', '$ZR', 'passport', 'N1234567'" '')|$(zst add_eligibility 2410 "'$ZP', '$ZR', 'passport', 'N1234567'" ', confirmed => true')" = 'confirmation_required|ok' ] \
  || fail "confirm: add_eligibility"
[ "$(zst edit_eligibility 2411 "'$ZP', 1, document_number => 'N7654321'" '')|$(zst edit_eligibility 2412 "'$ZP', 1, document_number => 'N7654321'" ', confirmed => true')" = 'confirmation_required|ok' ] \
  || fail "confirm: edit_eligibility"
ph="'$T5/$Z/$ZP/$ZV.webp', true"
[ "$(zst set_photo 2413 "'$ZP', $(pv $ZP), $ph" '')|$(zst set_photo 2414 "'$ZP', $(pv $ZP), $ph" ', confirmed => true')" = 'confirmation_required|ok' ] || fail "confirm: set_photo"
[ "$(zst remove_staff 2415 "'$ZS', $(sv)" '')|$(sc)" = "confirmation_required|$((s0 + 1))" ] || fail "confirm: Staff removed unconfirmed"
[ "$(zst remove_staff 2416 "'$ZS', $(sv)" ', confirmed => true')|$(sc)" = "ok|$s0" ] || fail "confirm: Staff not removed once confirmed"
[ "$(zst remove_player 2417 "'$ZP', $(pv $ZP)" '')|$(zn)" = "confirmation_required|$((n0 + 1))" ] || fail "confirm: Player removed unconfirmed"
[ "$(zst remove_player 2418 "'$ZP', $(pv $ZP)" ', confirmed => true')|$(zn)" = "ok|$n0" ] || fail "confirm: Player not removed once confirmed"
# Another Tournament's Organiser, a Registration link and anon never pass, confirmed or not; a link says season_started.
addp2() { tc $1 "add_player('$(cmd "$2")', '$Z', '$ZP', 'Ram Thapa', 7, '$grown', false, confirmed => $3)"; }
for c in true false; do
  [ "$(addp2 $B 2420 $c)" = not_authorized ] || fail "leak: another Tournament's Organiser added a Player (confirmed $c)"
  [ "$(addp2 $G3 2421 $c)" = season_started ] || fail "confirm: Registration link changed a started Season (confirmed $c)"
  redo 2420; redo 2421
done
for f in "add_player('$(cmd 2422)', '$Z', '$ZP', 'x', 7, '$grown', false, confirmed => true)" "set_kick_off('$(cmd 2422)', '$S10', '$M1', 1, now(), confirmed => true)"; do
  out=$(as anon "select app.$f" 2>&1 || true)
  [[ $out == *"permission denied for function"* ]] || fail "anon: can execute $f: $out"
done
[ "$(zn)|$(q "select count(*) from app.player where id='$ZP'")" = "$n0|0" ] || fail "confirm: a refused command wrote"
# Before start nothing changes: a command carrying confirmed behaves as without it (S5 is in registration).
[ "$(tc $A "add_player('$(cmd 2423)', '$X', '$ZP', 'Pre Start', 31, '$grown', false)")|$(tc $A "edit_player('$(cmd 2424)', '$X', '$ZP', $(pv $ZP), shirt_number => 32, confirmed => true)")" = 'ok|ok' ] \
  || fail "confirm: registration needs no confirmation"
# Fixtures: M1 and M2 in S10 (started).
mv() { q "select version from app.match where id='$1'"; }
kick() { q "select kick_off from app.match where id='$M1'"; }
k0=$(kick)
[ "$(ko $A 2430 $M1 $(mv $M1) '2026-11-13 09:30+05:45')|$(kick)" = "confirmation_required|$k0" ] || fail "confirm: kick-off moved unconfirmed"
kc() { tc $A "set_kick_off('$(cmd "$1")', '$S10', '$M1', $(mv $M1), '2026-11-13 09:30+05:45'::timestamptz, confirmed => true)"; }
[ "$(kc 2431)|$(kick)" = "ok|2026-11-13 03:45:00+00" ] || fail "confirm: kick-off not moved once confirmed: $(kick)"
[ "$(q "select count(*)||':'||bool_and(actor = '$A' and (before->>'kick_off') is distinct from (after->>'kick_off')) from app.activity_log where command_id='$(cmd 2431)' and table_name = 'match' and op = 'update'")" = '1:true' ] \
  || fail "confirm: kick-off log row"
o1=$(q "select ord from app.match where id='$M1'")
[ "$(sw $A 2432 $M1 $(mv $M1) $M2 $(mv $M2))|$(q "select ord from app.match where id='$M1'")" = "confirmation_required|$o1" ] || fail "confirm: swapped unconfirmed"
[ "$(tc $A "swap_fixtures('$(cmd 2433)', '$S10', '$M1', $(mv $M1), '$M2', $(mv $M2), confirmed => true)")|$(q "select ord from app.match where id='$M1'")" != "ok|$o1" ] \
  || fail "confirm: swap not applied once confirmed"
for who in $B $G1; do
  [ "$(tc $who "set_kick_off('$(cmd 2434)', '$S10', '$M1', $(mv $M1), now(), confirmed => true)")" = not_authorized ] || fail "leak: $who moved a kick-off after start"
  redo 2434
done
# The description alone can change after start (S10, started); rules and the photo-consent statement stay locked.
[ "$(rules $A 2440 $S10 $(q "select version from app.season where id='$S10'") "description => 'Open for all'")|$(q "select description from app.season where id='$S10'")" = 'ok|Open for all' ] \
  || fail "description: refused after start"
[ "$(rules $A 2441 $S10 $(q "select version from app.season where id='$S10'") "rules => 'x'")|$(rules $A 2442 $S10 $(q "select version from app.season where id='$S10'") "description => 'y', photo_consent => 'z'")" \
  = 'season_started|season_started' ] || fail "description: rules or consent changed after start"
[ "$(rules $B 2443 $S10 $(q "select version from app.season where id='$S10'") "description => 'Stolen'")" = not_authorized ] || fail "leak: description changed by another Tournament's Organiser"

# --- Activity view (Story 3.7): who, Team, Match and Season of each log row; read-only; members only.
av() { as $A "select $1 from app.activity_view where $2"; }
[ "$(av "who||'|'||match_id||'|'||(season_id = '$S10')||'|'||coalesce(team_id::text, '-')" "command_id = '$(cmd 2431)' and table_name = 'match'")" = "a@x.test|$M1|true|-" ] \
  || fail "activity view: kick-off row"
[ "$(av "team_id||'|'||(after->>'date_of_birth')" "command_id = '$(cmd 2402)' and table_name = 'player'")" = "$Z|date_of_birth" ] \
  || fail "activity view: Player row's Team, or its date of birth shown by value: $(av "table_name||':'||coalesce(team_id::text,'-')||':'||coalesce(after->>'date_of_birth','-')" "command_id = '$(cmd 2402)'")"
[ "$(av "team_id" "command_id = '$(cmd 2418)' and table_name = 'player' and op = 'delete'")" = "$Z" ] || fail "activity view: removed Player's Team"
[ "$(av "team_id||'|'||(season_id = (select season_id from app.team where id = '$Z'))" "command_id = '$(cmd 2402)' and table_name = 'squad_entry'")" = "$Z|true" ] \
  || fail "activity view: Squad entry row"
[ "$(av "team_ids::text" "command_id = '$(cmd 2431)' and table_name = 'match'")" = "$(q "select array_remove(array[home_team_id, away_team_id], null)::text from app.match where id='$M1'")" ] \
  || fail "activity view: Match row's team_ids"
# Personal fields: a shirt-number edit leaves the date of birth plain; a date-of-birth edit logs it as changed.
q "set app.command_id = '$(cmd 2490)'; update app.player set name = name || '' where id = (select p.id from app.player p where p.date_of_birth is not null limit 1); update app.player set date_of_birth = date_of_birth + 1 where id = (select p.id from app.player p where p.date_of_birth is not null limit 1); reset app.command_id" >/dev/null
[ "$(q "select string_agg(coalesce(after->>'date_of_birth', '-'), ',' order by id) from app.activity_log where command_id = '$(cmd 2490)' and table_name = 'player'")" = 'date_of_birth,date_of_birth:changed' ] \
  || fail "personal field: unchanged not plain, or edit not marked changed"
q "update app.match set kick_off = kick_off where id='$M1'" >/dev/null
[ "$(av "count(*)" "who = 'System' and match_id = '$M1'")" = 1 ] || fail "activity view: a change with no actor is not System"
[ "$(av "who" "actor = '$G1' limit 1")" = "$(q "select 'Team manager (' || t.code || ')' from app.registration_grant g join app.team t on t.id = g.team_id where g.id = '$G1'")" ] \
  || fail "activity view: a Registration link is not named as its Team manager"
[ "$(av "count(*)" "season_id is null and table_name = 'tournament'")" -ge 1 ] || fail "activity view: Tournament-wide rows have a Season"
[ "$(as $A "select count(*) from app.activity_view")" = "$(as $A "select count(*) from app.activity_log")" ] || fail "activity view: rows differ from the log"
for who in $B $G1; do
  [ "$(as $who "select count(*) from app.activity_view where tournament_id = (select tournament_id from app.team where id = '$Z')")" = 0 ] || fail "leak: $who reads the Activity view"
done
for f in "select count(*) from app.activity_view" "select app.actor_name('$T5', '$A')"; do
  out=$(as anon "$f" 2>&1 || true)
  [[ $out == *"permission denied"* ]] || fail "anon: reads the Activity view: $out"
done
[ "$(as $B "select app.actor_name('$T5', '$A')")" = "" ] || fail "leak: another Tournament's Organiser looks up an email"
for f in "insert into app.activity_view (id) values (1)" "update app.activity_view set who = 'x'" "delete from app.activity_view"; do
  out=$(as $A "$f" 2>&1 || true)
  [[ $out == *"permission denied"* || $out == *"cannot "* ]] || fail "Organiser writes the Activity view: $f: $out"
done

# --- Scorer link and number-matching approval (Story 4.1). A organises T14 (S17 in setup, S18 started); B organises T2. D1 to D4 are
# anonymous phones. The server stores only the token's hash; the number of a request comes back to its phone, and the right number
# approves it. A device reads nothing; the Organiser reads the devices of their Tournament.
T14=11111111-0000-4000-8000-0000000000e1 S17=21111111-0000-4000-8000-0000000000e1 S18=21111111-0000-4000-8000-0000000000e2
D1=f2111111-0000-4000-8000-000000000001 D2=f2111111-0000-4000-8000-000000000002 D3=f2111111-0000-4000-8000-000000000003
D4=f2111111-0000-4000-8000-000000000004
STK=ScorerTokenAbCdEfGhIjKlMnOpQrStUvWxYz012345 STK2=ScorerTokenZyXwVuTsRqPoNmLkJiHgFeDcBa9876543
q "insert into auth.users (id, is_anonymous) values ('$D1', true), ('$D2', true), ('$D3', true), ('$D4', true)" >/dev/null
[ "$(create $A 2700 $T14 $S17 'Scorer Cup' | grep -c '"ok": true')" = 1 ] || fail "scorer: fixture tournament"
q "insert into app.season (id, tournament_id, number, status) values ('$S18', '$T14', 2, 'started')" >/dev/null
sl() { tc "$1" "create_scorer_link('$(cmd "$2")', '$3', '$(hash "$4")')"; }
rq() { local l=${4//\'/\'\'}; as "$1" "select app.request_scorer_approval('$(cmd "$2")', '$3', '$l')"; }
rqc() { local l=${4//\'/\'\'}; as "$1" "select case when (r->>'ok')::boolean then 'ok' else r->>'code' end from app.request_scorer_approval('$(cmd "$2")', '$3', '$l') r"; }
dv() { q "select status from app.scorer_device where id='$1'"; }
num() { q "select '$1'::jsonb->>'number'"; }
did() { q "select '$1'::jsonb->>'device_id'"; }
st() { as "$1" "select coalesce((select status||'|'||label from app.scorer_status() limit 1), 'none')"; }
approve() { tc "$1" "approve_scorer_device('$(cmd "$2")', '$S17', '$3', $4)"; }
# Fences: another Tournament's Organiser, a phone and anon can't make or end a link; nothing changes.
[ "$(sl $B 2701 $S17 $STK)|$(sl $D1 2702 $S17 $STK)" = 'not_authorized|not_authorized' ] || fail "leak: link made by another Tournament or a phone"
[ "$(tc $B "revoke_scorer_link('$(cmd 2703)', '$S17')")" = not_authorized ] || fail "leak: link revoked by another Tournament"
for f in "create_scorer_link('$(cmd 2704)', '$S17', '$(hash $STK)')" "request_scorer_approval('$(cmd 2704)', '$STK', 'x')" "scorer_status()"; do
  out=$(as anon "select app.$f" 2>&1 || true)
  [[ $out == *"permission denied for function"* ]] || fail "anon: can execute $f: $out"
done
[ "$(q "select count(*) from app.season where scorer_token_hash is not null")" = 0 ] || fail "scorer: a refused command made a link"
# No link yet: a request is link_dead and writes no device; so is a bad token.
[ "$(rqc $D1 2705 $STK "Bikash's phone")" = link_dead ] || fail "scorer: request without a link"
# Create: only the hash is stored; a bad hash is refused; the S17 link works in a Season in setup.
[ "$(tc $A "create_scorer_link('$(cmd 2706)', '$S17', 'nothex')")" = token_invalid ] || fail "scorer: bad hash accepted"
[ "$(sl $A 2707 $S17 $STK)" = ok ] || fail "scorer: link not made"
[ "$(q "select scorer_token_hash from app.season where id='$S17'")" = "$(hash $STK)" ] || fail "scorer: hash not stored"
[ "$(q "select count(*) from app.season where scorer_token_hash = '$STK'")" = 0 ] || fail "scorer: token stored in the clear"
[ "$(q "select count(*)||':'||bool_and(actor = '$A') from app.activity_log where command_id='$(cmd 2707)' and table_name = 'season' and op = 'update'")" = '1:true' ] \
  || fail "scorer: link not logged"
# Request: a number 10 to 99, pending for 10 minutes; a repeat answers alike; the phone reads only its own status.
r1=$(rq $D1 2708 $STK "  Bikash's phone ")
[ "$(q "select (r->>'ok')||(r->>'status')||((r->>'number')::int between 10 and 99)::text from (select '$r1'::jsonb r) x")" = truependingtrue ] || fail "scorer: request answer $r1"
[ "$(rq $D1 2708 $STK "  Bikash's phone ")" = "$r1" ] || fail "scorer: repeat answered differently"
DV1=$(did "$r1")
[ "$(q "select count(*) from app.scorer_device where user_id='$D1'")|$(dv $DV1)|$(q "select label from app.scorer_device where id='$DV1'")" = "1|pending|Bikash's phone" ] || fail "scorer: device row"
[ "$(q "select round(extract(epoch from expires_at - created_at))::int from app.scorer_device where id='$DV1'")" = 600 ] || fail "scorer: not 10 minutes"
[ "$(q "select (number_hash = encode(sha256(convert_to(id::text || ':' || '$(num "$r1")', 'UTF8')), 'hex'))::text from app.scorer_device where id='$DV1'")" = true ] \
  || fail "scorer: number hash"
[ "$(st $D1)" = "pending|Bikash's phone" ] || fail "scorer: status of a pending phone: $(st $D1)"
[ "$(st $D2)|$(st $A)" = 'none|none' ] || fail "scorer: status of another user"
# A pending phone reads nothing: not its device row, not the Season, and the number is not in any table it can read.
[ "$(as $D1 "select (select count(*) from app.scorer_device)||'/'||(select count(*) from app.season)||'/'||(select count(*) from app.activity_log)")" = 0/0/0 ] \
  || fail "leak: a pending phone reads rows"
[ "$(as $B "select count(*) from app.scorer_device")" = 0 ] || fail "leak: another Tournament reads devices"
[ "$(as $A "select count(*) from app.scorer_device where status = 'pending'")" = 1 ] || fail "scorer: the Organiser does not read the device"
# Label rules and bad links.
[ "$(rqc $D2 2709 $STK '')|$(rqc $D2 2710 $STK "$(printf 'x%.0s' $(seq 41))")|$(rqc $D2 2711 $STK 'a'$'\t''b')" = 'label_invalid|label_invalid|label_invalid' ] || fail "scorer: bad labels accepted"
[ "$(rqc $D2 2712 ${STK/S/T} 'Phone')|$(rqc $D2 2713 '' 'Phone')" = 'link_dead|link_dead' ] || fail "scorer: wrong token accepted"
[ "$(rqc $A 2714 $STK 'Organiser phone')" = not_authorized ] || fail "scorer: an Organiser asked for approval"
[ "$(q "select count(*) from app.scorer_device")" = 1 ] || fail "scorer: a refused request wrote a device"
# Approve: fences, then a wrong number rejects (the phone must ask again), the right one approves.
NUM1=$(num "$r1"); WRONG=$((NUM1 == 99 ? 98 : NUM1 + 1))
[ "$(approve $B 2715 $DV1 $NUM1)|$(approve $D1 2716 $DV1 $NUM1)|$(dv $DV1)" = 'not_authorized|not_authorized|pending' ] || fail "leak: approval by another Tournament or the phone itself"
[ "$(tc $B "revoke_scorer_device('$(cmd 2717)', '$S17', '$DV1')")" = not_authorized ] || fail "leak: device revoked by another Tournament"
[ "$(approve $A 2718 $DV1 $WRONG)|$(dv $DV1)|$(st $D1)" = "number_mismatch|rejected|rejected|Bikash's phone" ] || fail "scorer: wrong number: $(approve $A 2719 $DV1 $WRONG) $(st $D1)"
[ "$(approve $A 2719 $DV1 $NUM1)" = request_closed ] || fail "scorer: a rejected request was approved"
# Ask again: a new row and a new request; the older pending one of the phone is rejected.
r2=$(rq $D1 2720 $STK "Bikash's phone"); DV2=$(did "$r2")
[ "$(q "select count(*) from app.scorer_device where user_id='$D1'")|$(dv $DV2)" = '2|pending' ] || fail "scorer: ask again"
r3=$(rq $D1 2721 $STK "Bikash's phone"); DV3=$(did "$r3")
[ "$(dv $DV2)|$(dv $DV3)" = 'rejected|pending' ] || fail "scorer: an older pending request stayed pending"
NUM3=$(num "$r3")
[ "$(approve $A 2722 $DV3 $NUM3)|$(dv $DV3)|$(st $D1)" = "ok|approved|approved|Bikash's phone" ] || fail "scorer: right number: $(st $D1)"
[ "$(approve $A 2722 $DV3 $NUM3)" = ok ] || fail "scorer: approve repeat answered differently"
# An approved phone still reads no table; scorer_allows is true for its Season only.
[ "$(as $D1 "select (select count(*) from app.scorer_device)||'/'||(select count(*) from app.season)||'/'||(select count(*) from app.tournament)")" = 0/0/0 ] \
  || fail "leak: an approved phone reads rows"
[ "$(q "select app.scorer_allows('$D1', '$S17', now())::text||app.scorer_allows('$D1', '$S18', now())::text||app.scorer_allows('$D2', '$S17', now())::text||app.scorer_allows('$A', '$S17', now())::text")" = truefalsefalsefalse ] \
  || fail "scorer_allows: approved device"
# Asking again while approved changes nothing.
[ "$(rq $D1 2723 $STK 'Other name' | grep -c approved)|$(q "select count(*) from app.scorer_device where user_id='$D1'")" = '1|3' ] || fail "scorer: an approved phone made a new request"
# Expiry: approving a request past its 10 minutes is request_expired and changes nothing; the phone reads expired.
r4=$(rq $D3 2724 $STK "Sita's phone"); DV4=$(did "$r4")
q "update app.scorer_device set expires_at = now() - interval '1 second' where id='$DV4'" >/dev/null
[ "$(approve $A 2725 $DV4 $(num "$r4"))|$(dv $DV4)|$(st $D3)" = "request_expired|pending|expired|Sita's phone" ] || fail "scorer: expired request: $(st $D3)"
r5=$(rq $D3 2726 $STK "Sita's phone"); DV5=$(did "$r5")
[ "$(dv $DV4)|$(dv $DV5)|$(st $D3)" = 'rejected|pending|pending|Sita'"'"'s phone' ] || fail "scorer: ask again after expiry"
# Unknown or another Season's device; a device and a Season that don't belong together.
[ "$(approve $A 2727 $(cmd 9) 10)" = device_missing ] || fail "scorer: unknown device approved"
[ "$(tc $A "approve_scorer_device('$(cmd 2728)', '$S18', '$DV5', $(num "$r5"))")|$(dv $DV5)" = 'device_missing|pending' ] || fail "scorer: a device approved through another Season"
# The Activity log names the phone by its label; personal fields are none; Organisers read it, B and the phone don't.
[ "$(as $A "select who from app.activity_view where command_id = '$(cmd 2722)' and table_name = 'scorer_device' limit 1")" = 'a@x.test' ] || fail "scorer: the approval is not the Organiser's"
[ "$(as $A "select who from app.activity_view where command_id = '$(cmd 2721)' and table_name = 'scorer_device' and op = 'insert'")" = "Bikash's phone" ] \
  || fail "scorer: the request is not named by its label: $(as $A "select who from app.activity_view where command_id = '$(cmd 2721)' and table_name = 'scorer_device'")"
[ "$(as $B "select count(*) from app.activity_view where table_name = 'scorer_device'")|$(as $D1 "select count(*) from app.activity_view")" = '0|0' ] || fail "leak: the Activity log shows devices"
[ "$(as $B "select app.actor_name('$T14', '$D1')")" = "" ] || fail "leak: another Tournament's Organiser looks up a phone's name"
# Revoke: the phone's next status says revoked; the grace window keeps changes entered before the revoke; a pending phone is rejected.
[ "$(tc $A "revoke_scorer_device('$(cmd 2729)', '$S17', '$DV3')")|$(dv $DV3)|$(st $D1)" = "ok|revoked|revoked|Bikash's phone" ] || fail "scorer: revoke"
[ "$(tc $A "revoke_scorer_device('$(cmd 2730)', '$S17', '$DV3')")|$(tc $A "revoke_scorer_device('$(cmd 2731)', '$S17', '$DV5')")|$(dv $DV5)" = 'ok|ok|rejected' ] || fail "scorer: revoke again or revoke a pending request"
[ "$(q "select app.scorer_allows('$D1', '$S17', revoked_at - interval '1 minute')::text||app.scorer_allows('$D1', '$S17', revoked_at + app.grace_window() - interval '1 second')::text||app.scorer_allows('$D1', '$S17', revoked_at + app.grace_window())::text||app.scorer_allows('$D1', '$S17', revoked_at + interval '2 hours')::text from app.scorer_device where id='$DV3'")" = truetruefalsefalse ] \
  || fail "scorer_allows: the grace window"
[ "$(q "select app.scorer_allows('$D3', '$S17', now())::text||app.scorer_allows('$D3', '$S17', now() - interval '1 minute')::text")" = falsefalse ] || fail "scorer_allows: a pending or rejected phone"
# A new link replaces the old: the old token no longer asks; phones already approved stay approved.
[ "$(sl $A 2732 $S17 $STK2)|$(rqc $D4 2733 $STK 'Old link')|$(rqc $D4 2734 $STK2 'New link')" = 'ok|link_dead|ok' ] || fail "scorer: a new link did not replace the old one"
# Revoke the link: nobody asks through it; revoking none is ok; a new link works again.
[ "$(tc $A "revoke_scorer_link('$(cmd 2735)', '$S17')")|$(tc $A "revoke_scorer_link('$(cmd 2736)', '$S17')")|$(rqc $D4 2737 $STK2 'x')" = 'ok|ok|link_dead' ] || fail "scorer: revoke the link"
[ "$(q "select count(*) from app.season where id='$S17' and scorer_token_hash is null")" = 1 ] || fail "scorer: the revoked link remains"
# Any status but finished: a started Season (S18) works; a finished one is season_finished and its link answers link_dead.
[ "$(sl $A 2738 $S18 $STK)|$(rqc $D2 2739 $STK 'Started phone')" = 'ok|ok' ] || fail "scorer: a started Season"
q "update app.season set status = 'finished' where id='$S18'" >/dev/null
[ "$(sl $A 2740 $S18 $STK2)|$(tc $A "revoke_scorer_link('$(cmd 2741)', '$S18')")|$(rqc $D4 2742 $STK 'Late phone')" = 'season_finished|season_finished|link_dead' ] || fail "scorer: a finished Season"
# Isolation: a device of S18 is not allowed in S17, and an approved phone of one Tournament reads nothing of another.
[ "$(q "select app.scorer_allows('$D2', '$S17', now())::text")" = false ] || fail "scorer_allows: another Season"
[ "$(as $D1 "select count(*) from app.team")|$(as $D2 "select count(*) from app.activity_log")|$(as $D1 "select count(*) from app.tournament where id = '$T2'")" = '0|0|0' ] || fail "leak: a phone reads another Tournament"
# The Registration link grant and the phone: a grant holder reads no device and can't use the scorer commands.
[ "$(as $G1 "select count(*) from app.scorer_device")|$(tc $G1 "create_scorer_link('$(cmd 2743)', '$S17', '$(hash $STK)')")|$(approve $G1 2744 $DV3 10)" = '0|not_authorized|not_authorized' ] || fail "leak: a Registration link grant reaches devices"


# --- Pre-match: line-ups, kit colours and On-air Match (Story 4.2). A organises T15 (S19 started, 2 starters and 2 on the bench);
# B organises T2. X1, X2, X3 are approved Teams with Players; M1 and M2 are scheduled (X1 v X2, X1 v X3), M3 is live (X2 v X3), M4 has
# no Teams yet, M5 is finished. D5 and D8 are approved phones of S19, D6 is pending, D7 is approved in S17 (another Season).
T15=11111111-0000-4000-8000-0000000000f1 S19=21111111-0000-4000-8000-0000000000f1
X1=41111111-0000-4000-8000-000000000001 X2=41111111-0000-4000-8000-000000000002 X3=41111111-0000-4000-8000-000000000003
M1=51111111-0000-4000-8000-000000000001 M2=51111111-0000-4000-8000-000000000002 M3=51111111-0000-4000-8000-000000000003
M4=51111111-0000-4000-8000-000000000004 M5=51111111-0000-4000-8000-000000000005
D5=f2111111-0000-4000-8000-000000000005 D6=f2111111-0000-4000-8000-000000000006 D7=f2111111-0000-4000-8000-000000000007
D8=f2111111-0000-4000-8000-000000000008
pl() { printf '61111111-0000-4000-8000-%08d%04d' "$1" "$2"; }   # pl <team 1-3> <shirt>: the Player's id
q "insert into auth.users (id, is_anonymous) values ('$D5', true), ('$D6', true), ('$D7', true), ('$D8', true)" >/dev/null
[ "$(create $A 2800 $T15 21111111-0000-4000-8000-0000000000f0 'Prematch Cup' | grep -c '"ok": true')" = 1 ] || fail "prematch: fixture tournament"
q "insert into app.season (id, tournament_id, number, status, starters, max_bench) values ('$S19', '$T15', 2, 'started', 2, 2)" >/dev/null
q "insert into app.team (id, tournament_id, season_id, name, code, kit_colour, status) values
  ('$X1', '$T15', '$S19', 'Red Tigers', 'RTM', '#ff0000', 'approved'), ('$X2', '$T15', '$S19', 'Eight Eagles', 'RE8', '#0000ff', 'approved'),
  ('$X3', '$T15', '$S19', 'Third Team', 'TTT', null, 'approved')" >/dev/null
for t in 1 2 3; do for n in 1 2 3 4 5; do
  q "insert into app.player (id, tournament_id, name, date_of_birth) values ('$(pl $t $n)', '$T15', 'Player $t-$n', '2000-01-01');
     insert into app.squad_entry (tournament_id, team_id, player_id, shirt_number) values ('$T15', '$(eval echo \$X$t)', '$(pl $t $n)', $n)" >/dev/null
done; done
q "insert into app.match (id, tournament_id, season_id, stage, round, ord, home_team_id, away_team_id, status) values
  ('$M1', '$T15', '$S19', 'group', 'Group A', 1, '$X1', '$X2', 'scheduled'), ('$M2', '$T15', '$S19', 'group', 'Group A', 2, '$X1', '$X3', 'scheduled'),
  ('$M3', '$T15', '$S19', 'group', 'Group A', 3, '$X2', '$X3', 'live'), ('$M5', '$T15', '$S19', 'group', 'Group A', 5, '$X1', '$X3', 'finished');
  insert into app.match (id, tournament_id, season_id, stage, round, ord, home_src, away_src, status) values
  ('$M4', '$T15', '$S19', 'knockout', 'Final', 4, 'Winner SF1', 'Winner SF2', 'scheduled')" >/dev/null
q "insert into app.scorer_device (tournament_id, season_id, user_id, label, status, number_hash, expires_at) values
  ('$T15', '$S19', '$D5', 'Pitch phone', 'approved', repeat('0', 64), now() + interval '1 hour'),
  ('$T15', '$S19', '$D8', 'Bench phone', 'approved', repeat('0', 64), now() + interval '1 hour'),
  ('$T15', '$S19', '$D6', 'Waiting phone', 'pending', repeat('0', 64), now() + interval '1 hour'),
  ('$T14', '$S17', '$D7', 'Other season phone', 'approved', repeat('0', 64), now() + interval '1 hour')" >/dev/null
ts() { tc "$1" "take_scoring('$(cmd "$2")', '$S19', '$3')"; }
tm() { as "$1" "select r->>'message' from app.take_scoring('$(cmd "$2")', '$S19', '$3') r"; }
cm() { as "$1" "select coalesce(app.console_match('$2')::text, 'none')"; }
sc() { q "select coalesce(scoring_device::text, 'none') from app.match where id='$1'"; }
# lu <team> <starter shirts> <bench shirts> <kit>: one side's JSON; shirts are space-separated.
lu() { local t=$1 st= bn= n; for n in $2; do st+="\"$(pl $t "$n")\","; done; for n in ${3:-}; do bn+="\"$(pl $t "$n")\","; done
  printf '{"team_id":"%s","starters":[%s],"bench":[%s],"kit_colour":"%s"}' "$(eval echo \$X$t)" "${st%,}" "${bn%,}" "$4"; }
cl() { tc "$1" "confirm_lineups('$(cmd "$2")', '$S19', '$3', '$4'::jsonb, '$5'::jsonb)"; }
clm() { as "$1" "select r->>'message' from app.confirm_lineups('$(cmd "$2")', '$S19', '$3', '$4'::jsonb, '$5'::jsonb) r"; }
sos() { tc "$1" "show_on_stream('$(cmd "$2")', '$S19', '$3')"; }
air() { q "select coalesce(on_air_match_id::text, 'none') from app.live_state where tournament_id='$T15'"; }
# Isolation first: a pending phone, another Season's phone, a Registration link and another Tournament's Organiser read and change nothing.
for who in $D6 $D7 $G1 $B; do
  [ "$(cm $who $M1)|$(as $who "select count(*) from app.scorer_matches('$S19')")" = 'none|0' ] || fail "leak: $who reads the console"
  [ "$(ts $who 2801 $M1)|$(cl $who 2802 $M1 '{}' '{}')|$(sos $who 2803 $M1)" = 'not_authorized|not_authorized|not_authorized' ] || fail "leak: $who ran a scoring command"
  redo 2801; redo 2802; redo 2803
done
[ "$(sc $M1)|$(q "select count(*) from app.match_lineup")|$(q "select count(*) from app.live_state")" = 'none|0|0' ] || fail "prematch: a refused command wrote"
[ "$(tc $D7 "take_scoring('$(cmd 2804)', '$S17', '$M1')")" = season_setup ] || fail "leak: another Season's phone took scoring through its own Season"
for f in "console_match('$M1')" "scorer_matches('$S19')" "take_scoring('$(cmd 2805)', '$S19', '$M1')" "confirm_lineups('$(cmd 2805)', '$S19', '$M1', '{}', '{}')" "show_on_stream('$(cmd 2805)', '$S19', '$M1')"; do
  out=$(as anon "select app.$f" 2>&1 || true)
  [[ $out == *"permission denied for function"* ]] || fail "anon: can execute $f: $out"
done
# The Organiser and an approved phone read the console: both Teams home first, Squads without date of birth, the Line-up rules.
[ "$(as $A "select (j->'rules'->>'starters')||'|'||(j->'rules'->>'max_bench')||'|'||jsonb_array_length(j->'teams')||'|'||(j->'teams'->0->>'code')||'|'||(j->'teams'->0->>'side')||'|'||jsonb_array_length(j->'teams'->0->'squad')||'|'||(j->>'holder')||'|'||(j->>'held')||'|'||(j->>'on_air') from (select app.console_match('$M1') j) x")" \
  = '2|2|2|RTM|home|5|false|false|false' ] || fail "console_match: Organiser read"
[ "$(cm $D5 $M1 | grep -c 'date_of_birth\|2000-01-01')" = 0 ] || fail "console_match: personal fields in the Squad"
[ "$(cm $D5 $M1)" != none ] || fail "console_match: an approved phone reads nothing"
# take_scoring: the phone becomes the holder, again is ok, another caller reads read-only; a Match with no Teams or a finished one can't be taken.
[ "$(ts $D5 2810 $M1)|$(sc $M1)|$(ts $D5 2811 $M1)|$(ts $D5 2810 $M1)" = "ok|$D5|ok|ok" ] || fail "take_scoring: holder"
[ "$(ts $A 2812 $M1)|$(tm $D8 2813 $M1)|$(sc $M1)" = "scoring_elsewhere|Another phone is scoring this match.|$D5" ] || fail "take_scoring: a second phone took over"
[ "$(as $A "select (j->>'holder')||(j->>'held') from (select app.console_match('$M1') j) x")|$(as $D5 "select (j->>'holder')||(j->>'held') from (select app.console_match('$M1') j) x")" = 'falsetrue|truetrue' ] \
  || fail "console_match: holder flags"
[ "$(ts $D5 2814 $M4)|$(ts $D5 2815 $M5)|$(ts $D5 2816 $(cmd 7))|$(sc $M4)" = 'sides_unknown|match_finished|match_missing|none' ] || fail "take_scoring: unknown sides, finished or missing Match"
[ "$(q "select count(*)||':'||bool_and(actor = '$D5') from app.activity_log where command_id='$(cmd 2810)' and table_name = 'match' and op = 'update'")" = '1:true' ] || fail "take_scoring: not logged"
# confirm_lineups: only the holder; counts in words; Players from the Team's Squad; Teams of the Match; a kit colour.
RED='#ff0000' BLUE='#0000ff'
H=$(lu 1 '1 2' '3' $RED) AW=$(lu 2 '1 2' '' $BLUE)
[ "$(cl $A 2820 $M1 "$H" "$AW")|$(cl $D8 2821 $M1 "$H" "$AW")" = 'not_scoring_device|not_scoring_device' ] || fail "confirm_lineups: a non-holder confirmed"
[ "$(clm $D5 2822 $M1 "$(lu 1 '1' '' $RED)" "$AW")" = "Line-up needs 2 starters. You've picked 1." ] || fail "confirm_lineups: too few starters"
[ "$(clm $D5 2823 $M1 "$H" "$(lu 2 '1 2' '3 4 5' $BLUE)")" = "Bench can hold up to 2. You've picked 3." ] || fail "confirm_lineups: bench too long"
[ "$(cl $D5 2824 $M1 "$(lu 1 '1 2' '' $RED)" "$(lu 2 '1 1' '' $BLUE)")|$(cl $D5 2825 $M1 "$H" "$(lu 3 '1 2' '' $BLUE)")|$(cl $D5 2826 $M1 "$H" "$(lu 1 '1 2' '' $BLUE)")" \
  = 'lineup_invalid|lineup_invalid|lineup_invalid' ] || fail "confirm_lineups: duplicate Player, a Team outside the Match, the same Team twice"
[ "$(cl $D5 2827 $M1 "$H" "$(lu 2 '1 2' '' '#FF0000')")|$(cl $D5 2828 $M1 "$H" "$(lu 2 '1 2' '' red)")|$(cl $D5 2829 $M1 "$H" "$(printf '{"team_id":"%s","starters":["x"]}' $X2)")" \
  = 'lineup_invalid|lineup_invalid|lineup_invalid' ] || fail "confirm_lineups: bad kit colour or bad JSON"
[ "$(cl $D5 2830 $M1 "$(lu 1 '1 2' '' $RED)" "$(printf '{"team_id":"%s","starters":["%s","%s"],"bench":[],"kit_colour":"#0000ff"}' $X2 "$(pl 1 3)" "$(pl 1 4)")")" = lineup_invalid ] \
  || fail "confirm_lineups: another Team's Players"
[ "$(cl $D5 2836 $M1 "$H" "$(printf '{"team_id":"%s","starters":["%s","%s"],"bench":[]}' $X2 "$(pl 2 1)" "$(pl 2 2)")")" = lineup_invalid ] || fail "confirm_lineups: a missing kit colour"
[ "$(sos $A 2837 $M4)" = sides_unknown ] || fail "show_on_stream: a Match with no Teams"
[ "$(q "select count(*) from app.match_lineup")" = 0 ] || fail "confirm_lineups: a refused command wrote"
# Confirm: both sides saved; the repeat answers alike; the console shows them.
[ "$(cl $D5 2831 $M1 "$H" "$AW")|$(cl $D5 2831 $M1 "$H" "$AW")" = 'ok|ok' ] || fail "confirm_lineups: not saved"
[ "$(q "select string_agg(l.side||':'||t.code||':'||l.version||':'||cardinality(l.starters)||':'||cardinality(l.bench)||':'||l.kit_colour, ' ' order by l.side) from app.match_lineup l join app.team t on t.id = l.team_id where l.match_id='$M1'")" \
  = 'away:RE8:1:2:0:#0000ff home:RTM:1:2:1:#ff0000' ] || fail "confirm_lineups: rows"
[ "$(cm $D5 $M1 | grep -c '"version": 1')" -ge 1 ] || fail "console_match: lineups not shown"
[ "$(q "select count(*)||':'||bool_and(actor = '$D5') from app.activity_log where command_id='$(cmd 2831)' and table_name = 'match_lineup' and op = 'insert'")" = '2:true' ] || fail "confirm_lineups: not logged with the phone"
[ "$(as $A "select who from app.activity_view where command_id = '$(cmd 2831)' and table_name = 'match_lineup' limit 1")" = 'Pitch phone' ] || fail "confirm_lineups: the log does not name the phone"
# Swap and re-confirm before kick-off: the sides exchange, versions rise by one, the kit colour of the day can change.
[ "$(cl $D5 2832 $M1 "$AW" "$(lu 1 '1 2' '3 4' '#fafafa')")" = ok ] || fail "confirm_lineups: swap"
[ "$(q "select string_agg(l.side||':'||t.code||':'||l.version||':'||l.kit_colour, ' ' order by l.side) from app.match_lineup l join app.team t on t.id = l.team_id where l.match_id='$M1'")" \
  = 'away:RTM:2:#fafafa home:RE8:2:#0000ff' ] || fail "confirm_lineups: swapped rows"
[ "$(as $D5 "select (j->'teams'->0->>'code')||(j->'teams'->1->>'code') from (select app.console_match('$M1') j) x")" = RE8RTM ] || fail "console_match: swapped order"
# A line-up of a Match that is live can't change; one nobody holds says so.
[ "$(ts $A 2833 $M3)|$(cl $A 2834 $M3 "$(lu 2 '1 2' '' $BLUE)" "$(lu 3 '1 2' '' $RED)")" = 'ok|match_started' ] || fail "confirm_lineups: a live Match"
[ "$(cl $D8 2835 $M2 "$H" "$AW")" = not_scoring_device ] || fail "confirm_lineups: an unheld Match"
# show_on_stream: the holder or an Organiser; the new Match replaces the old; a phone that doesn't hold the Match can't.
[ "$(sos $D5 2840 $M1)|$(air)|$(sos $D8 2841 $M2)|$(air)" = "ok|$M1|not_scoring_device|$M1" ] || fail "show_on_stream: holder or not"
[ "$(sos $A 2842 $M3)|$(air)|$(q "select count(*)||':'||max(version) from app.live_state where tournament_id='$T15'")" = "ok|$M3|1:2" ] || fail "show_on_stream: the Organiser replaced the On-air Match"
[ "$(sos $A 2843 $M3)|$(q "select version from app.live_state where tournament_id='$T15'")|$(sos $A 2844 $M5)|$(sos $A 2845 $(cmd 7))" = 'ok|2|match_finished|match_missing' ] || fail "show_on_stream: again, finished, missing"
[ "$(as $D5 "select (j->>'on_air') from (select app.console_match('$M1') j) x")|$(as $A "select (j->>'on_air') from (select app.console_match('$M3') j) x")" = 'false|true' ] || fail "console_match: on-air flag"
[ "$(as $A "select count(*) from app.live_state")|$(as $B "select count(*) from app.live_state")|$(as $D5 "select count(*) from app.live_state")|$(as $A "select count(*) from app.match_lineup")|$(as $D5 "select count(*) from app.match_lineup")|$(as $B "select count(*) from app.match_lineup")" = '1|0|0|2|0|0' ] \
  || fail "leak: live_state or match_lineup read"
# Matches for a Scorer phone: the next scheduled and the live ones, with who holds them.
[ "$(as $D5 "select string_agg(match_id||':'||status||':'||home_code||':'||away_code||':'||held||':'||mine, ' ' order by ord) from app.scorer_matches('$S19')")" \
  = "$M1:scheduled:RTM:RE8:true:true $M3:live:RE8:TTT:true:false" ] || fail "scorer_matches: $(as $D5 "select string_agg(match_id||':'||status||':'||held||':'||mine, ' ' order by ord) from app.scorer_matches('$S19')")"
[ "$(as $D8 "select count(*) filter (where mine) from app.scorer_matches('$S19')")" = 0 ] || fail "scorer_matches: another phone's Match is mine"
# Nothing writes a score or a status, and a phone writes no table directly.
[ "$(q "select string_agg(status||coalesce(hg::text,'-'), ',' order by ord) from app.match where season_id='$S19'")" = 'scheduled-,scheduled-,live-,scheduled-,finished-' ] || fail "prematch: a Match changed"
for stmt in "update app.match set scoring_device = null" "update app.match_lineup set side = 'home'" "insert into app.live_state (tournament_id) values ('$T15')" "delete from app.match_lineup"; do
  out=$(as $D5 "$stmt" 2>&1 || true)
  [[ $out == *"permission denied"* ]] || fail "a phone wrote directly: $stmt: $out"
done
# Revoked: the next read and command are refused (changes entered before the revoke still count within the grace window).
q "update app.scorer_device set status = 'revoked', revoked_at = now() - interval '2 hours' where user_id = '$D5'" >/dev/null
[ "$(cm $D5 $M1)|$(ts $D5 2850 $M2)|$(sos $D5 2851 $M1)" = 'none|not_authorized|not_authorized' ] || fail "prematch: a revoked phone still works"
# A Season that is not started refuses every scoring command, whoever asks.
q "update app.season set status = 'finished' where id='$S19'" >/dev/null
[ "$(ts $A 2852 $M2)|$(sos $A 2853 $M2)|$(cl $A 2854 $M2 "$H" "$AW")" = 'season_finished|season_finished|season_finished' ] || fail "prematch: a finished Season"


# --- Match clock and periods (Story 4.3). S20 of T15 is started with 2 periods and extra time (2 periods, knockout Matches only).
# X4, X5 play N1 (group, no extra time) and N2 (knockout, extra time); X4 v X6 is N3 (no line-ups). D9 is an approved phone of S20,
# D10 is pending in S20; D7 (S17) and G1 stay outside.
S20=21111111-0000-4000-8000-0000000000f2
X4=41111111-0000-4000-8000-000000000004 X5=41111111-0000-4000-8000-000000000005 X6=41111111-0000-4000-8000-000000000006
N1=51111111-0000-4000-8000-0000000000a1 N2=51111111-0000-4000-8000-0000000000a2 N3=51111111-0000-4000-8000-0000000000a3
D9=f2111111-0000-4000-8000-000000000009 D10=f2111111-0000-4000-8000-00000000000a
q "insert into auth.users (id, is_anonymous) values ('$D9', true), ('$D10', true)" >/dev/null
q "insert into app.season (id, tournament_id, number, status, starters, max_bench, periods, extra_time, extra_time_periods)
   values ('$S20', '$T15', 3, 'started', 2, 2, 2, true, 2)" >/dev/null
q "insert into app.team (id, tournament_id, season_id, name, code, kit_colour, status) values
  ('$X4', '$T15', '$S20', 'Four FC', 'FOU', '#ff0000', 'approved'), ('$X5', '$T15', '$S20', 'Five FC', 'FIV', '#0000ff', 'approved'),
  ('$X6', '$T15', '$S20', 'Six FC', 'SIX', null, 'approved')" >/dev/null
for t in 4 5; do for n in 1 2; do
  q "insert into app.player (id, tournament_id, name, date_of_birth) values ('$(pl $t $n)', '$T15', 'Player $t-$n', '2000-01-01');
     insert into app.squad_entry (tournament_id, team_id, player_id, shirt_number) values ('$T15', '$(eval echo \$X$t)', '$(pl $t $n)', $n)" >/dev/null
done; done
q "insert into app.match (id, tournament_id, season_id, stage, round, ord, home_team_id, away_team_id, status) values
  ('$N1', '$T15', '$S20', 'group', 'Group A', 1, '$X4', '$X5', 'scheduled'), ('$N2', '$T15', '$S20', 'knockout', 'Final', 2, '$X4', '$X5', 'scheduled'),
  ('$N3', '$T15', '$S20', 'group', 'Group A', 3, '$X4', '$X6', 'scheduled')" >/dev/null
q "insert into app.scorer_device (tournament_id, season_id, user_id, label, status, number_hash, expires_at) values
  ('$T15', '$S20', '$D9', 'Clock phone', 'approved', repeat('0', 64), now() + interval '1 hour'),
  ('$T15', '$S20', '$D10', 'Waiting phone', 'pending', repeat('0', 64), now() + interval '1 hour')" >/dev/null
mver() { q "select version from app.match where id='$1'"; }
# ck <user> <command> <n> <match> [extra args]: a clock command at the Match's current version.
ck() { tc "$1" "$2('$(cmd "$3")', '$S20', '$4', $(mver "$4")${5:+, $5})"; }
st() { q "select status||':'||coalesce(clock->>'period', '-')||':'||coalesce(clock->>'running', '-')||':'||coalesce(clock->>'interval', '-') from app.match where id='$1'"; }
evs() { q "select coalesce(string_agg(kind||period, ',' order by created_at, entered_at), 'none') from app.match_event where match_id='$1'"; }
ts20() { tc "$1" "take_scoring('$(cmd "$2")', '$S20', '$3')"; }
# Isolation: a pending phone, another Season's phone, a Registration link and another Tournament's Organiser run and read nothing.
for who in $D10 $D7 $G1 $B; do
  [ "$(ck $who start_clock 2900 $N1)|$(ck $who pause_clock 2901 $N1)|$(ck $who next_period 2902 $N1)|$(ck $who set_clock 2903 $N1 1000)|$(ck $who end_match 2904 $N1)" \
    = 'not_authorized|not_authorized|not_authorized|not_authorized|not_authorized' ] || fail "leak: $who ran a clock command"
  [ "$(cm $who $N1)" = none ] || fail "leak: $who reads the clock"
  for n in 2900 2901 2902 2903 2904; do redo $n; done
done
[ "$(st $N1)|$(evs $N1)" = 'scheduled:-:-:-|none' ] || fail "clock: a refused command wrote"
for f in "start_clock('$(cmd 2905)', '$S20', '$N1', 1)" "pause_clock('$(cmd 2905)', '$S20', '$N1', 1)" "next_period('$(cmd 2905)', '$S20', '$N1', 1)" \
  "set_clock('$(cmd 2905)', '$S20', '$N1', 1, 1000)" "end_match('$(cmd 2905)', '$S20', '$N1', 1)" "match_score('$N1')" "clock_step('$D9', 'start', '$(cmd 2905)', '$S20', '$N1', 1, now(), null)"; do
  out=$(as anon "select app.$f" 2>&1 || true)
  [[ $out == *"permission denied for function"* ]] || fail "anon: can execute $f: $out"
done
# The helpers are not callable by an approved phone either.
for f in "match_score('$N1')" "clock_step('$D9', 'start', '$(cmd 2905)', '$S20', '$N1', 1, now(), null)"; do
  out=$(as $D9 "select app.$f" 2>&1 || true)
  [[ $out == *"permission denied for function"* ]] || fail "phone: can execute $f: $out"
done
# Not the holder; no line-ups yet.
[ "$(ck $D9 start_clock 2906 $N1)" = not_scoring_device ] || fail "clock: a phone that holds nothing started the clock"
[ "$(ts20 $D9 2907 $N1)|$(ts20 $D9 2908 $N3)|$(ck $D9 start_clock 2909 $N3)|$(ck $A start_clock 2910 $N1)" = 'ok|ok|lineups_missing|not_scoring_device' ] || fail "clock: line-ups or holder"
[ "$(st $N3)|$(st $N1)" = 'scheduled:-:-:-|scheduled:-:-:-' ] || fail "clock: lineups_missing changed the Match"
LA=$(lu 4 '1 2' '' '#ff0000') LB=$(lu 5 '1 2' '' '#0000ff')
[ "$(tc $D9 "confirm_lineups('$(cmd 2911)', '$S20', '$N1', '$LA'::jsonb, '$LB'::jsonb)")" = ok ] || fail "clock: confirm line-ups"
# Start: a stale version is a conflict that writes nothing; the first start puts the Match live in period 1 with a divider.
[ "$(tc $D9 "start_clock('$(cmd 2912)', '$S20', '$N1', 99)")" = version_conflict ] || fail "start_clock: a stale version"
[ "$(st $N1)" = 'scheduled:-:-:-' ] || fail "start_clock: a stale version wrote"
[ "$(tc $D9 "start_clock('$(cmd 2960)', '$S20', '$N1', $(mver $N1), now() - interval '1 day')")|$(q "select (clock->>'anchor_at')::timestamptz >= now() - app.grace_window() - interval '1 minute' from app.match where id='$N1'")" = 'ok|t' ] || fail "start_clock: a stale at started the clock hours in"
q "update app.match set clock = null, status = 'scheduled', version = version + 1 where id='$N1'; delete from app.match_event where match_id='$N1'" >/dev/null
[ "$(ck $D9 start_clock 2913 $N1)|$(st $N1)|$(evs $N1)" = 'ok|live:1:true:false|period_start1' ] || fail "start_clock: first start"
[ "$(q "select hg is null and ag is null from app.match where id='$N1'")" = t ] || fail "start_clock: a score was written"
[ "$(tc $D9 "start_clock('$(cmd 2913)', '$S20', '$N1', 1)")|$(evs $N1)" = 'ok|period_start1' ] || fail "start_clock: the same command twice"
[ "$(ck $D9 start_clock 2914 $N1)|$(ck $D9 set_clock 2915 $N1 -5)|$(ck $D9 set_clock 2916 $N1 30000000)" = 'clock_invalid|clock_invalid|clock_invalid' ] || fail "clock: start while running, or a clock out of range"
# The clock reads elapsed_ms plus the time since anchor_at: pause 125 s later keeps about 125 s; the time of the change is clamped.
q "update app.match set clock = jsonb_set(clock, '{anchor_at}', to_jsonb(now() - interval '125 seconds')) where id='$N1'" >/dev/null
[ "$(ck $D9 pause_clock 2917 $N1)|$(q "select ((clock->>'elapsed_ms')::int between 125000 and 130000)||':'||(clock->>'running') from app.match where id='$N1'")" = 'ok|true:false' ] || fail "pause_clock: elapsed"
[ "$(ck $D9 pause_clock 2918 $N1)" = clock_invalid ] || fail "pause_clock: already paused"
E1=$(q "select clock->>'elapsed_ms' from app.match where id='$N1'")
# at before the last change counts as the last change (no time passes); at in the future counts as now.
[ "$(tc $D9 "start_clock('$(cmd 2919)', '$S20', '$N1', $(mver $N1), now() - interval '1 day')")|$(tc $D9 "pause_clock('$(cmd 2920)', '$S20', '$N1', $(mver $N1), now() - interval '2 days')")|$(q "select clock->>'elapsed_ms' from app.match where id='$N1'")" = "ok|ok|$E1" ] \
  || fail "clock: an at before the last change moved the clock"
[ "$(tc $D9 "start_clock('$(cmd 2921)', '$S20', '$N1', $(mver $N1), now() + interval '1 hour')")|$(q "select (clock->>'anchor_at')::timestamptz <= now() from app.match where id='$N1'")" = 'ok|t' ] || fail "clock: an at in the future"
# Correct the clock: 14:00 now; the Match, the event and the Activity log say so; the clock keeps running.
[ "$(ck $D9 set_clock 2922 $N1 840000)|$(q "select (clock->>'elapsed_ms')||':'||(clock->>'running') from app.match where id='$N1'")" = 'ok|840000:true' ] || fail "set_clock"
[ "$(q "select count(*) from app.activity_log where command_id='$(cmd 2922)' and table_name = 'match' and op = 'update'")|$(q "select count(*) from app.match_event where id='$(cmd 2922)' and kind='clock_set' and minute=14")" = '1|1' ] || fail "set_clock: not logged"
# Periods: 2 periods, a group Match has no extra time. Interval, 2nd period, then only End the match.
[ "$(ck $D9 next_period 2923 $N1)|$(st $N1)" = 'ok|live:1:false:true' ] || fail "next_period: into the interval"
[ "$(ck $D9 start_clock 2924 $N1)|$(ck $D9 pause_clock 2925 $N1)" = 'clock_invalid|clock_invalid' ] || fail "clock: running an interval"
[ "$(ck $D9 next_period 2926 $N1)|$(st $N1)|$(q "select clock->>'elapsed_ms' from app.match where id='$N1'")" = 'ok|live:2:true:false|0' ] || fail "next_period: 2nd half"
[ "$(ck $D9 next_period 2927 $N1)|$(evs $N1)" = 'clock_invalid|period_start1,clock_set1,period_end1,period_start2' ] || fail "next_period: a group Match has no extra time: $(evs $N1)"
[ "$(q "select string_agg(score_home||'-'||score_away, ',') from app.match_event where match_id='$N1' and kind like 'period%'")" = '0-0,0-0,0-0' ] || fail "next_period: dividers carry the score"
# End the match: finished, the score from match_score, nothing typed; then every clock command is match_finished.
[ "$(ck $D9 end_match 2928 $N1)|$(st $N1)|$(q "select hg||'-'||ag from app.match where id='$N1'")|$(evs $N1 | grep -o 'match_end2')" = 'ok|finished:2:false:false|0-0|match_end2' ] || fail "end_match"
[ "$(ck $D9 start_clock 2929 $N1)|$(ck $D9 next_period 2930 $N1)|$(ck $D9 end_match 2931 $N1)|$(ck $D9 set_clock 2932 $N1 1000)" = 'match_finished|match_finished|match_finished|match_finished' ] || fail "clock: a finished Match"
# Extra time: a knockout Match from the last regular period; extra-time periods follow the same pattern; no step after the last one.
[ "$(ts20 $D9 2940 $N2)|$(tc $D9 "confirm_lineups('$(cmd 2941)', '$S20', '$N2', '$LA'::jsonb, '$LB'::jsonb)")|$(ck $D9 start_clock 2942 $N2)" = 'ok|ok|ok' ] || fail "extra time: start"
seq=
for n in 2943 2944 2945 2946 2947 2948; do seq+="$(ck $D9 next_period $n $N2)|$(st $N2); "; done
[ "$seq" = 'ok|live:1:false:true; ok|live:2:true:false; ok|live:3:true:false; ok|live:3:false:true; ok|live:4:true:false; clock_invalid|live:4:true:false; ' ] || fail "extra time: $seq"
[ "$(ck $D9 end_match 2949 $N2)|$(st $N2)|$(evs $N2)" = 'ok|finished:4:false:false|period_start1,period_end1,period_start2,period_start3,period_end3,period_start4,match_end4' ] \
  || fail "extra time: end $(evs $N2) $(st $N2)"
# The console: clock, score, rules and the events newest first, the same for the phone and the Organiser; no personal fields.
[ "$(as $D9 "select (j->'rules'->>'periods')||'|'||(j->'rules'->>'extra_time_periods')||'|'||(j->'clock'->>'period')||'|'||(j->'score'->>'home')||'|'||jsonb_array_length(j->'events')||'|'||(j->'events'->0->>'kind')||'|'||(j->'events'->-1->>'kind') from (select app.console_match('$N2') j) x")" \
  = '2|2|4|0|7|match_end|period_start' ] || fail "console_match: N2"
[ "$(as $A "select (j->'rules'->>'extra_time_periods')||'|'||(j->'match'->>'version')||'|'||(j->'clock'->>'elapsed_ms') from (select app.console_match('$N1') j) x")" = "0|$(mver $N1)|$(q "select clock->>'elapsed_ms' from app.match where id='$N1'")" ] || fail "console_match: N1 group Match"
[ "$(as $A "select app.console_match('$N3')->'clock'->>'period'")|$(as $A "select jsonb_array_length(app.console_match('$N3')->'events')")" = '0|0' ] || fail "console_match: an unstarted Match"
# Reads and writes: Organisers read the events of their Tournament only; a phone and another Tournament's Organiser read none; nobody writes.
[ "$(as $A "select count(*) from app.match_event")|$(as $B "select count(*) from app.match_event")|$(as $D9 "select count(*) from app.match_event")|$(as $G1 "select count(*) from app.match_event")" = '12|0|0|0' ] || fail "leak: match_event read"
for stmt in "insert into app.match_event (id, tournament_id, season_id, match_id, kind, period, minute, entered_at) values (gen_random_uuid(), '$T15', '$S20', '$N3', 'period_start', 1, 0, now())" \
  "update app.match_event set minute = 0" "delete from app.match_event" "update app.match set clock = null" "update app.match set hg = 9, ag = 9"; do
  out=$(as $D9 "$stmt" 2>&1 || true)
  [[ $out == *"permission denied"* ]] || fail "a phone wrote directly: $stmt: $out"
  out=$(as $A "$stmt" 2>&1 || true)
  [[ $out == *"permission denied"* ]] || fail "an Organiser wrote directly: $stmt: $out"
done
# Only the Match's own commands wrote hg and ag; the other Match has no score.
[ "$(q "select string_agg(coalesce(hg::text, '-'), ',' order by ord) from app.match where season_id='$S20'")" = '0,0,-' ] || fail "clock: scores"
# A revoked phone and a finished Season: refused.
q "update app.scorer_device set status = 'revoked', revoked_at = now() - interval '2 hours' where user_id = '$D9'" >/dev/null
[ "$(ck $D9 start_clock 2950 $N3)|$(cm $D9 $N3)" = 'not_authorized|none' ] || fail "clock: a revoked phone still works"
q "update app.season set status = 'finished' where id='$S20'" >/dev/null
[ "$(ck $A start_clock 2951 $N3)|$(ck $A end_match 2952 $N3)" = 'season_finished|season_finished' ] || fail "clock: a finished Season"

# --- Goals (Story 4.4). S21 of T15: X7 v X8 in W1 (live, line-ups as listed), W2 (live, line-ups swapped), W3 (scheduled). D11 is an approved phone of
# S21, D12 is pending; D7 (S17), D9 (S20, revoked), G1 and Organiser B stay outside. A is an Organiser of T15 who does not hold scoring.
S21=21111111-0000-4000-8000-0000000000f3
X7=42111111-0000-4000-8000-000000000007 X8=42111111-0000-4000-8000-000000000008
W1=52111111-0000-4000-8000-0000000000b1 W2=52111111-0000-4000-8000-0000000000b2 W3=52111111-0000-4000-8000-0000000000b3
D11=f3111111-0000-4000-8000-00000000000b D12=f3111111-0000-4000-8000-00000000000c
q "insert into auth.users (id, is_anonymous) values ('$D11', true), ('$D12', true)" >/dev/null
q "insert into app.season (id, tournament_id, number, status, starters, max_bench, periods) values ('$S21', '$T15', 4, 'started', 2, 2, 2)" >/dev/null
q "insert into app.team (id, tournament_id, season_id, name, code, kit_colour, status) values
  ('$X7', '$T15', '$S21', 'Seven FC', 'SEV', '#ff0000', 'approved'), ('$X8', '$T15', '$S21', 'Eight FC', 'EIG', '#0000ff', 'approved')" >/dev/null
for t in 7 8; do for n in 1 2 3; do
  q "insert into app.player (id, tournament_id, name, date_of_birth) values ('$(pl $t $n)', '$T15', 'Player $t-$n', '2000-01-01');
     insert into app.squad_entry (tournament_id, team_id, player_id, shirt_number) values ('$T15', '$(eval echo \$X$t)', '$(pl $t $n)', $n)" >/dev/null
done; done
q "insert into app.match (id, tournament_id, season_id, stage, round, ord, home_team_id, away_team_id, status) values
  ('$W1', '$T15', '$S21', 'group', 'Group A', 1, '$X7', '$X8', 'scheduled'), ('$W2', '$T15', '$S21', 'group', 'Group A', 2, '$X7', '$X8', 'scheduled'),
  ('$W3', '$T15', '$S21', 'group', 'Group A', 3, '$X7', '$X8', 'scheduled')" >/dev/null
q "insert into app.scorer_device (tournament_id, season_id, user_id, label, status, number_hash, expires_at) values
  ('$T15', '$S21', '$D11', 'Goal phone', 'approved', repeat('0', 64), now() + interval '1 hour'),
  ('$T15', '$S21', '$D12', 'Waiting phone', 'pending', repeat('0', 64), now() + interval '1 hour')" >/dev/null
# gl <user> <n> <match> <team> <player|null> [own] [minute]: record_goal in period 1. gx <user> <command> <n> <goal n> [args]: a goal command at the goal's version.
gl() { local p=$5; [ "$p" = null ] || p="'$p'"; tc "$1" "record_goal('$(cmd "$2")', '$S21', '$3', '$4', $p, ${6:-false}, 1, ${7:-3})"; }
gver() { q "select version from app.match_event where id='$(cmd "$1")'"; }
gx() { tc "$1" "$2('$(cmd "$3")', '$S21', '$(cmd "$4")', $(gver "$4")${5:+, $5})"; }
gscore() { q "select coalesce(hg::text, '-')||'-'||coalesce(ag::text, '-') from app.match where id='$1'"; }
gcount() { q "select count(*) from app.match_event where match_id='$1' and kind='goal'"; }
gck() { tc "$1" "$2('$(cmd "$3")', '$S21', '$4', $(mver "$4"))"; }
for who in $D12 $D7 $D9 $G1 $B; do
  [ "$(gl $who 3100 $W1 $X7 $(pl 7 1))|$(tc $who "add_assist('$(cmd 3101)', '$S21', '$(cmd 3100)', 1, '$(pl 7 2)')")|$(tc $who "edit_event('$(cmd 3102)', '$S21', '$(cmd 3100)', 1, null, false, 5)")|$(tc $who "delete_event('$(cmd 3103)', '$S21', '$(cmd 3100)', 1)")" \
    = 'not_authorized|not_authorized|not_authorized|not_authorized' ] || fail "leak: $who ran a goal command"
  [ "$(cm $who $W1)" = none ] || fail "leak: $who reads the goals"
  for n in 3100 3101 3102 3103; do redo $n; done
done
[ "$(gcount $W1)|$(gscore $W1)" = '0|---' ] || fail "goals: a refused command wrote: $(gcount $W1)|$(gscore $W1)"
for f in "record_goal('$(cmd 3104)', '$S21', '$W1', '$X7', null, false, 1, 3)" "add_assist('$(cmd 3104)', '$S21', '$(cmd 3100)', 1, null)" \
  "edit_event('$(cmd 3104)', '$S21', '$(cmd 3100)', 1, null, false, 5)" "delete_event('$(cmd 3104)', '$S21', '$(cmd 3100)', 1)" "match_score('$W1')" "match_goal_score()" \
  "goal_step('$D11', 'record', '$(cmd 3104)', '$S21', '$W1', null, null, '$X7', null, false, 1, 3, now())"; do
  out=$(as anon "select app.$f" 2>&1 || true)
  [[ $out == *"permission denied for function"* ]] || fail "anon: can execute $f: $out"
done
# The helpers are not callable by an approved phone either.
for f in "match_score('$W1')" "match_goal_score()" "goal_step('$D11', 'record', '$(cmd 3104)', '$S21', '$W1', null, null, '$X7', null, false, 1, 3, now())"; do
  out=$(as $D11 "select app.$f" 2>&1 || true)
  [[ $out == *"permission denied for function"* ]] || fail "phone: can execute $f: $out"
done
# Not live, not the holder.
[ "$(gl $D11 3105 $W1 $X7 $(pl 7 1))|$(gl $A 3106 $W1 $X7 $(pl 7 1))" = 'not_scoring_device|not_scoring_device' ] || fail "goals: a phone that holds nothing scored"
[ "$(tc $D11 "take_scoring('$(cmd 3107)', '$S21', '$W1')")|$(tc $D11 "take_scoring('$(cmd 3108)', '$S21', '$W2')")|$(tc $D11 "take_scoring('$(cmd 3109)', '$S21', '$W3')")" = 'ok|ok|ok' ] || fail "goals: take scoring"
[ "$(gl $D11 3110 $W3 $X7 $(pl 7 1))|$(gl $A 3111 $W3 $X7 $(pl 7 1))" = 'match_not_live|not_scoring_device' ] || fail "goals: a Match that is not live"
LA=$(lu 7 '1 2' '' '#ff0000') LB=$(lu 8 '1 2' '' '#0000ff')
[ "$(tc $D11 "confirm_lineups('$(cmd 3112)', '$S21', '$W1', '$LA'::jsonb, '$LB'::jsonb)")|$(tc $D11 "confirm_lineups('$(cmd 3113)', '$S21', '$W2', '$LB'::jsonb, '$LA'::jsonb)")|$(gck $D11 start_clock $((3114)) $W1)|$(gck $D11 start_clock 3115 $W2)" = 'ok|ok|ok|ok' ] \
  || fail "goals: put the Matches live"
M0=$(mver $W1)
# Goal: the score follows from the goal rows, the Match version stays, and the goal is logged.
[ "$(gl $D11 3120 $W1 $X7 $(pl 7 1) false 3)|$(gscore $W1)|$(mver $W1)" = "ok|1-0|$M0" ] || fail "record_goal: score or version"
[ "$(q "select kind||period||':'||minute||':'||own_goal||':'||version||':'||coalesce(deleted_at::text, 'live') from app.match_event where id='$(cmd 3120)'")" = 'goal1:3:false:1:live' ] || fail "record_goal: row"
[ "$(q "select count(*) from app.activity_log where command_id='$(cmd 3120)' and table_name = 'match_event' and op = 'insert'")|$(q "select count(*) from app.activity_log where command_id='$(cmd 3120)' and table_name = 'match' and op = 'update'")" = '1|1' ] || fail "record_goal: not logged"
[ "$(tc $D11 "record_goal('$(cmd 3120)', '$S21', '$W1', '$X7', '$(pl 7 1)', false, 1, 3)")|$(gcount $W1)|$(gscore $W1)" = 'ok|1|1-0' ] || fail "record_goal: the same command twice"
# Own goal for X8 and an unknown scorer for X7.
[ "$(gl $D11 3121 $W1 $X8 null true 7)|$(gscore $W1)|$(gl $D11 3122 $W1 $X7 null false 9)|$(gscore $W1)" = 'ok|1-1|ok|2-1' ] || fail "record_goal: own goal or unknown scorer"
[ "$(q "select own_goal||':'||coalesce(player_id::text, 'none') from app.match_event where id='$(cmd 3121)'")" = 'true:none' ] || fail "record_goal: own goal row: $(q "select own_goal||':'||coalesce(player_id::text, 'none') from app.match_event where id='$(cmd 3121)'")"
# Refused goals write nothing.
[ "$(gl $D11 3123 $W1 $X4 null)|$(gl $D11 3124 $W1 $X7 $(pl 8 1))|$(gl $D11 3125 $W1 $X7 $(pl 7 1) true)|$(tc $D11 "record_goal('$(cmd 3126)', '$S21', '$W1', '$X7', null, false, 0, 3)")|$(tc $D11 "record_goal('$(cmd 3127)', '$S21', '$W1', '$X7', null, false, 1, -1)")" \
  = 'team_invalid|player_invalid|player_invalid|goal_invalid|goal_invalid' ] || fail "record_goal: invalid goals"
[ "$(gcount $W1)|$(gscore $W1)" = '3|2-1' ] || fail "record_goal: a refused goal wrote"
# The holder's next clock command still matches the Match version after goals.
[ "$(gck $D11 pause_clock 3128 $W1)" = ok ] || fail "goals: a goal broke the next clock command"
# Assist: a stale version is a conflict with the goal's current fields; the scorer and an own goal take none.
[ "$(tc $D11 "add_assist('$(cmd 3130)', '$S21', '$(cmd 3120)', 9, '$(pl 7 2)')")|$(gver 3120)" = 'version_conflict|1' ] || fail "add_assist: a stale version"
[ "$(as $D11 "select (r->'conflict'->>'current_version')||':'||(r->'conflict'->'current'->>'minute') from app.add_assist('$(cmd 3131)', '$S21', '$(cmd 3120)', 9, '$(pl 7 2)') r")" = '1:3' ] || fail "add_assist: conflict payload"
[ "$(gx $D11 add_assist 3132 3120 "'$(pl 7 1)'")|$(gx $D11 add_assist 3133 3121 "'$(pl 8 1)'")|$(gx $D11 add_assist 3134 3120 "'$(pl 8 2)'")" = 'player_invalid|player_invalid|player_invalid' ] || fail "add_assist: invalid assist"
[ "$(gx $D11 add_assist 3135 3120 "'$(pl 7 2)'")|$(gver 3120)|$(q "select assist_id from app.match_event where id='$(cmd 3120)'")" = "ok|2|$(pl 7 2)" ] || fail "add_assist"
# Edit: the scorer and the minute; the version goes up; an assist equal to the new scorer is cleared.
[ "$(gx $D11 edit_event 3136 3120 "'$(pl 7 3)', false, 26")|$(gver 3120)|$(q "select minute||':'||player_id from app.match_event where id='$(cmd 3120)'")|$(q "select assist_id from app.match_event where id='$(cmd 3120)'")" = "ok|3|26:$(pl 7 3)|$(pl 7 2)" ] || fail "edit_event"
[ "$(gx $D11 edit_event 3137 3120 "'$(pl 7 2)', false")|$(q "select coalesce(assist_id::text, 'none')||':'||minute from app.match_event where id='$(cmd 3120)'")|$(gx $D11 edit_event 3138 3120 "'$(pl 8 1)', false")" = 'ok|none:26|player_invalid' ] || fail "edit_event: assist or Squad"
[ "$(tc $D11 "edit_event('$(cmd 3139)', '$S21', '$(cmd 3120)', 1, null, false, 5)")|$(gscore $W1)" = 'version_conflict|2-1' ] || fail "edit_event: a stale version"
# Editing a goal into an own goal clears its assist.
[ "$(gx $D11 add_assist 3144 3120 "'$(pl 7 1)'")|$(gx $D11 edit_event 3145 3120 "null, true")|$(q "select own_goal||':'||coalesce(assist_id::text, 'none') from app.match_event where id='$(cmd 3120)'")" = 'ok|ok|true:none' ] || fail "edit_event: an own goal kept its assist"
# Delete: a soft delete; the score follows; the row stays; a second delete finds nothing.
[ "$(gx $D11 delete_event 3140 3122)|$(gscore $W1)|$(gcount $W1)|$(q "select count(*) from app.match_event where id='$(cmd 3122)' and deleted_at is not null")" = 'ok|1-1|3|1' ] || fail "delete_event"
[ "$(gx $D11 delete_event 3141 3122)|$(gx $D11 edit_event 3142 3122 "null, false, 4")|$(gx $D11 add_assist 3143 3122 null)" = 'event_missing|event_missing|event_missing' ] || fail "delete_event: a deleted goal"
[ "$(q "select count(*) from app.activity_log where command_id='$(cmd 3140)' and table_name = 'match_event' and op = 'update'")" = 1 ] || fail "delete_event: not logged"
# The console: goals newest first without the deleted one, the Match version, minutes in the rules.
[ "$(as $D11 "select jsonb_array_length(j->'events')||'|'||(j->'score'->>'home')||'-'||(j->'score'->>'away')||'|'||(j->'rules'->>'period_minutes') from (select app.console_match('$W1') j) x")" = '3|1-1|20' ] || fail "console_match: goals"
[ "$(as $D11 "select (j->'events'->0->>'kind')||'|'||(j->'events'->0->>'team_id') from (select app.console_match('$W1') j) x")" = "goal|$X8" ] || fail "console_match: goal fields"
# The score trigger on its own: a goal row written directly moves hg and ag but not the version.
q "insert into app.match_event (id, tournament_id, season_id, match_id, kind, period, minute, entered_at, team_id) values ('$(cmd 3150)', '$T15', '$S21', '$W1', 'goal', 1, 1, now(), '$X8')" >/dev/null
[ "$(gscore $W1)|$(mver $W1)" = "1-2|$(mver $W1)" ] || fail "score trigger: insert"
q "update app.match_event set deleted_at = now() where id='$(cmd 3150)'" >/dev/null
[ "$(gscore $W1)" = 1-1 ] || fail "score trigger: delete"
[ "$(q "select (select count(*) from app.match_score('$W1'))::text || (select hg::text||ag::text from app.match_score('$W1'))")" = '111' ] || fail "match_score"
# Swapped sides: the line-up has X8 at home, the Match's own sides stay (home_team_id X7); the console shows the score in line-up order.
[ "$(gl $D11 3160 $W2 $X8 $(pl 8 1))|$(gscore $W2)" = 'ok|0-1' ] || fail "swapped sides: hg and ag follow the Match's own sides"
[ "$(as $D11 "select (j->'score'->>'home')||'-'||(j->'score'->>'away')||'|'||(j->'teams'->0->>'team_id') from (select app.console_match('$W2') j) x")" = "1-0|$X8" ] || fail "swapped sides: console order"
# End the match after 1-0 on its own sides: finished with hg and ag from the goals; then every goal command is match_not_live.
[ "$(gck $D11 end_match 3161 $W2)|$(q "select status||':'||hg||'-'||ag from app.match where id='$W2'")" = 'ok|finished:0-1' ] || fail "end_match: derived score"
[ "$(gl $D11 3162 $W2 $X7 null)|$(gx $D11 delete_event 3163 3160)|$(gx $D11 edit_event 3164 3160 "null, false, 4")|$(gx $D11 add_assist 3165 3160 null)" = 'match_not_live|match_not_live|match_not_live|match_not_live' ] \
  || fail "goals: a finished Match"
# Reads and writes: Organisers read the events of their Tournament only; nobody writes directly.
[ "$(as $A "select count(*) from app.match_event where match_id in ('$W1', '$W2')")|$(as $B "select count(*) from app.match_event")|$(as $D11 "select count(*) from app.match_event")|$(as $G1 "select count(*) from app.match_event")" = '8|0|0|0' ] || fail "leak: goal rows read"
for stmt in "update app.match_event set deleted_at = now()" "update app.match_event set team_id = null" "delete from app.match_event" "update app.match set hg = 9, ag = 9"; do
  for who in $D11 $A; do
    out=$(as $who "$stmt" 2>&1 || true)
    [[ $out == *"permission denied"* ]] || fail "$who wrote directly: $stmt: $out"
  done
done
[ "$(gscore $W1)|$(gscore $W2)" = '1-1|0-1' ] || fail "goals: scores"
# A finished Season: refused.
q "update app.scorer_device set status = 'revoked', revoked_at = now() - interval '2 hours' where user_id = '$D11'" >/dev/null
[ "$(gl $D11 3170 $W1 $X7 null)|$(cm $D11 $W1)" = 'not_authorized|none' ] || fail "goals: a revoked phone still works"
# A goal entered on the phone before the revoke, replayed inside the grace window, is accepted.
ts=$(q "select (now() - interval '3 hours')::text")
[ "$(as $D11 "set local request.headers to '{\"x-entered-at\":\"$ts\"}'; select case when (r->>'ok')::boolean then 'ok' else r->>'code' end from app.record_goal('$(cmd 3172)', '$S21', '$W1', '$X7', null, false, 1, 5, '$ts'::timestamptz) r")|$(gcount $W1)" = 'ok|5' ] || fail "goals: a goal entered before the revoke"
q "update app.season set status = 'finished' where id='$S21'" >/dev/null
[ "$(gl $A 3171 $W1 $X7 null)" = season_finished ] || fail "goals: a finished Season"

# --- Cards, fouls, subs, timeouts and missed penalties (Story 4.5). S22 of T15 (futsal settings: foul_warning 5, one timeout, rolling subs, 2-minute power
# play): X9 v X10 in EM1 (live, line-ups: starters 1 2, bench 3 4) and EM3 (scheduled). S23 (limited: 2 substitutions, no fouls or timeouts): X11 v X12 in EM2.
# D13 is an approved phone of S22, D14 is pending, D15 is an approved phone of S23; D7 (S17), D9 (S20, revoked), G1 and Organiser B stay outside.
S22=21111111-0000-4000-8000-0000000000f4 S23=21111111-0000-4000-8000-0000000000f5
X9=43111111-0000-4000-8000-000000000009 X10=43111111-0000-4000-8000-000000000010 X11=44111111-0000-4000-8000-000000000011 X12=44111111-0000-4000-8000-000000000012
EM1=53111111-0000-4000-8000-0000000000c1 EM2=53111111-0000-4000-8000-0000000000c2 EM3=53111111-0000-4000-8000-0000000000c3
D13=f4111111-0000-4000-8000-00000000000d D14=f4111111-0000-4000-8000-00000000000e D15=f5111111-0000-4000-8000-00000000000f
q "insert into auth.users (id, is_anonymous) values ('$D13', true), ('$D14', true), ('$D15', true)" >/dev/null
q "insert into app.season (id, tournament_id, number, status, starters, max_bench, periods, period_minutes, substitutions, foul_warning, timeouts_per_period, power_play_minutes)
   values ('$S22', '$T15', 5, 'started', 2, 2, 2, 20, 'rolling', 5, 1, 2)" >/dev/null
q "insert into app.season (id, tournament_id, number, status, starters, max_bench, periods, period_minutes, substitutions, max_substitutions)
   values ('$S23', '$T15', 6, 'started', 2, 2, 2, 45, 'limited', 2)" >/dev/null
q "insert into app.team (id, tournament_id, season_id, name, code, kit_colour, status) values
  ('$X9', '$T15', '$S22', 'Nine FC', 'NIN', '#ff0000', 'approved'), ('$X10', '$T15', '$S22', 'Ten FC', 'TEN', '#0000ff', 'approved'),
  ('$X11', '$T15', '$S23', 'Eleven FC', 'ELE', '#ff0000', 'approved'), ('$X12', '$T15', '$S23', 'Twelve FC', 'TWE', '#0000ff', 'approved')" >/dev/null
for t in 9 10 11 12; do for n in 1 2 3 4; do
  q "insert into app.player (id, tournament_id, name, date_of_birth) values ('$(pl $t $n)', '$T15', 'Player $t-$n', '2000-01-01');
     insert into app.squad_entry (tournament_id, team_id, player_id, shirt_number) values ('$T15', '$(eval echo \$X$t)', '$(pl $t $n)', $n)" >/dev/null
done; done
q "insert into app.match (id, tournament_id, season_id, stage, round, ord, home_team_id, away_team_id, status) values
  ('$EM1', '$T15', '$S22', 'group', 'Group A', 1, '$X9', '$X10', 'scheduled'), ('$EM3', '$T15', '$S22', 'group', 'Group A', 2, '$X9', '$X10', 'scheduled'),
  ('$EM2', '$T15', '$S23', 'group', 'Group A', 1, '$X11', '$X12', 'scheduled')" >/dev/null
q "insert into app.scorer_device (tournament_id, season_id, user_id, label, status, number_hash, expires_at) values
  ('$T15', '$S22', '$D13', 'Event phone', 'approved', repeat('0', 64), now() + interval '1 hour'),
  ('$T15', '$S22', '$D14', 'Waiting phone', 'pending', repeat('0', 64), now() + interval '1 hour'),
  ('$T15', '$S23', '$D15', 'Limited phone', 'approved', repeat('0', 64), now() + interval '1 hour')" >/dev/null
nq() { [ "$1" = null ] && echo null || echo "'$1'"; }
# ev <user> <n> <season> <match> <kind> <team> <player|null> <on|null> <card|null> [period] [minute] [clock_ms]: record_event, period 1 minute 3 by default.
ev() { tc "$1" "record_event('$(cmd "$2")', '$3', '$4', '$5', '$6', $(nq $7), $(nq $8), $(nq $9), ${10:-1}, ${11:-3}, ${12:-180000})"; }
evm() { as "$1" "select r->>'message' from app.record_event('$(cmd "$2")', '$3', '$4', '$5', '$6', $(nq $7), $(nq $8), $(nq $9), ${10:-1}, ${11:-3}, ${12:-180000}) r"; }
# ex <user> <command> <n> <event n> <season> [args]: edit_event, delete_event or add_assist on an event at its current version.
ex() { tc "$1" "$2('$(cmd "$3")', '$5', '$(cmd "$4")', $(gver "$4")${6:+, $6})"; }
ecount() { q "select count(*) from app.match_event where match_id='$1' and kind='$2' and deleted_at is null"; }
pitch() { q "select (select count(*) from unnest(app.on_pitch('$1', '$2')) p where p = any ('{$3}'::uuid[]))||'/'||cardinality(app.on_pitch('$1', '$2'))"; }
# Isolation: a pending phone, another Season's phone, a Registration link and another Tournament's Organiser run and read nothing.
for who in $D14 $D7 $D9 $G1 $B; do
  [ "$(ev $who 3200 $S22 $EM1 foul $X9 null null null)|$(ev $who 3201 $S22 $EM1 card $X9 $(pl 9 1) null red)" = 'not_authorized|not_authorized' ] || fail "leak: $who ran record_event"
  [ "$(cm $who $EM1)" = none ] || fail "leak: $who reads the events"
  for n in 3200 3201; do redo $n; done
done
# A phone of another Season (D15 of S23) cannot name S22's Match through its own Season either: the Match must belong to the Season.
[ "$(ev $D15 3202 $S23 $EM1 foul $X9 null null null)" = 'not_scoring_device' ] || [ "$(ev $D15 3202 $S23 $EM1 foul $X9 null null null)" = 'match_missing' ] || fail "leak: a phone of another Season recorded in this Match"
[ "$(ecount $EM1 foul)" = 0 ] || fail "events: a refused command wrote"
for f in "record_event('$(cmd 3203)', '$S22', '$EM1', 'foul', '$X9', null, null, null, 1, 3, 1000)" "on_pitch('$EM1', '$X9')" \
  "event_step('$D13', '$(cmd 3203)', '$S22', '$EM1', 'foul', '$X9', null, null, null, 1, 3, 1000, now())"; do
  out=$(as anon "select app.$f" 2>&1 || true)
  [[ $out == *"permission denied for function"* ]] || fail "anon: can execute $f: $out"
done
for f in "on_pitch('$EM1', '$X9')" "event_step('$D13', '$(cmd 3203)', '$S22', '$EM1', 'foul', '$X9', null, null, null, 1, 3, 1000, now())"; do
  out=$(as $D13 "select app.$f" 2>&1 || true)
  [[ $out == *"permission denied for function"* ]] || fail "phone: can execute $f: $out"
done
# Not holder, not live.
[ "$(ev $D13 3204 $S22 $EM1 foul $X9 null null null)|$(ev $A 3205 $S22 $EM1 foul $X9 null null null)" = 'not_scoring_device|not_scoring_device' ] || fail "events: a phone that holds nothing recorded"
[ "$(tc $D13 "take_scoring('$(cmd 3206)', '$S22', '$EM1')")|$(tc $D13 "take_scoring('$(cmd 3207)', '$S22', '$EM3')")|$(tc $D15 "take_scoring('$(cmd 3208)', '$S23', '$EM2')")" = 'ok|ok|ok' ] || fail "events: take scoring"
[ "$(ev $D13 3209 $S22 $EM3 foul $X9 null null null)" = match_not_live ] || fail "events: a Match that is not live"
LA=$(lu 9 '1 2' '3 4' '#ff0000') LB=$(lu 10 '1 2' '3 4' '#0000ff') LC=$(lu 11 '1 2' '3 4' '#ff0000') LD=$(lu 12 '1 2' '3 4' '#0000ff')
[ "$(tc $D13 "confirm_lineups('$(cmd 3210)', '$S22', '$EM1', '$LA'::jsonb, '$LB'::jsonb)")|$(tc $D15 "confirm_lineups('$(cmd 3211)', '$S23', '$EM2', '$LC'::jsonb, '$LD'::jsonb)")" = 'ok|ok' ] \
  || fail "events: confirm line-ups"
[ "$(tc $D13 "start_clock('$(cmd 3212)', '$S22', '$EM1', $(mver $EM1))")|$(tc $D15 "start_clock('$(cmd 3213)', '$S23', '$EM2', $(mver $EM2))")" = 'ok|ok' ] || fail "events: put the Matches live"
M0=$(mver $EM1)
# A goal first: the score is 1-0 and no event of these kinds moves it or the Match version.
[ "$(tc $D13 "record_goal('$(cmd 3214)', '$S22', '$EM1', '$X9', '$(pl 9 1)', false, 1, 2)")|$(gscore $EM1)" = 'ok|1-0' ] || fail "events: the first goal"
# Card.
[ "$(ev $D13 3220 $S22 $EM1 card $X9 $(pl 9 1) null yellow 1 4 240000)|$(ev $D13 3221 $S22 $EM1 card $X10 $(pl 10 3) null red 1 5 300000)|$(gscore $EM1)|$(mver $EM1)" = "ok|ok|1-0|$M0" ] || fail "record_event: card, score or version"
[ "$(q "select kind||':'||card||':'||clock_ms||':'||minute||':'||period||':'||version||':'||coalesce(player_on_id::text, '-') from app.match_event where id='$(cmd 3221)'")" = 'card:red:300000:5:1:1:-' ] || fail "record_event: card row"
[ "$(q "select count(*) from app.activity_log where command_id='$(cmd 3220)' and table_name = 'match_event' and op = 'insert'")" = 1 ] || fail "record_event: not logged"
[ "$(ev $D13 3220 $S22 $EM1 card $X9 $(pl 9 1) null yellow 1 4 240000)|$(ecount $EM1 card)" = 'ok|2' ] || fail "record_event: the same command twice"
[ "$(ev $D13 3222 $S22 $EM1 card $X9 $(pl 9 1) null blue)|$(ev $D13 3223 $S22 $EM1 card $X9 null null red)|$(ev $D13 3224 $S22 $EM1 card $X9 $(pl 10 1) null red)|$(ev $D13 3225 $S22 $EM1 card $X11 $(pl 9 1) null red)" \
  = 'event_invalid|player_invalid|player_invalid|team_invalid' ] || fail "record_event: invalid cards"
[ "$(ev $D13 3226 $S22 $EM1 card $X9 $(pl 9 1) null red 0)|$(ev $D13 3227 $S22 $EM1 card $X9 $(pl 9 1) null red 1 -1)|$(ev $D13 3228 $S22 $EM1 card $X9 $(pl 9 1) null red 1 3 -5)|$(ev $D13 3229 $S22 $EM1 bogus $X9 null null null)" \
  = 'event_invalid|event_invalid|event_invalid|event_invalid' ] || fail "record_event: invalid time or kind"
[ "$(ev $D13 3230 $S22 $EM1 card $X9 $(pl 9 1) $(pl 9 2) red)" = player_invalid ] || fail "record_event: a card with a player coming on"
# Foul: needs the Season's foul_warning; a limited Season without it refuses.
[ "$(ev $D13 3231 $S22 $EM1 foul $X9 null null null)|$(ev $D15 3232 $S23 $EM2 foul $X11 null null null)|$(ev $D15 3233 $S23 $EM2 timeout $X11 null null null)" = 'ok|event_not_allowed|event_not_allowed' ] \
  || fail "record_event: foul and timeout need the Season's settings"
[ "$(q "select kind||':'||coalesce(player_id::text, '-')||':'||coalesce(card, '-') from app.match_event where id='$(cmd 3231)'")" = 'foul:-:-' ] || fail "record_event: foul row"
# A period after the Match clock's own is refused; the clock is then moved on so the later periods can be tested.
[ "$(ev $D13 3299 $S22 $EM1 foul $X9 null null null 2)" = event_invalid ] || fail "record_event: a period the clock has not reached"
q "update app.match set clock = jsonb_set(clock, '{period}', '3') where id='$EM1'" >/dev/null
# Timeout: one per Team per regular period, none in extra time; the second is refused with the reason.
[ "$(ev $D13 3235 $S22 $EM1 timeout $X9 null null null)|$(evm $D13 3236 $S22 $EM1 timeout $X9 null null null)|$(ev $D13 3237 $S22 $EM1 timeout $X10 null null null)" = 'ok|NIN has used its timeout this half.|ok' ] \
  || fail "record_event: timeouts"
[ "$(ev $D13 3238 $S22 $EM1 timeout $X9 null null null)|$(ev $D13 3239 $S22 $EM1 timeout $X9 null null null 2 25 60000)|$(evm $D13 3240 $S22 $EM1 timeout $X9 null null null 3 45 60000)|$(ev $D13 3241 $S22 $EM1 timeout $X9 null null null 3 45 60000)" \
  = 'timeout_used|ok|No timeouts in extra time.|timeout_used' ] || fail "record_event: timeouts per period or in extra time"
[ "$(ex $D13 delete_event 3242 3235 $S22)|$(ev $D13 3243 $S22 $EM1 timeout $X9 null null null)" = 'ok|ok' ] || fail "record_event: a deleted timeout is free again"
# Sub: Player 9-1 off, 9-3 on; on the pitch is derived.
[ "$(pitch $EM1 $X9 "$(pl 9 1),$(pl 9 2)")" = '2/2' ] || fail "on_pitch: starters"
[ "$(ev $D13 3250 $S22 $EM1 sub $X9 $(pl 9 1) $(pl 9 3) null)|$(pitch $EM1 $X9 "$(pl 9 2),$(pl 9 3)")|$(pitch $EM1 $X9 "$(pl 9 1)")" = 'ok|2/2|0/2' ] || fail "record_event: sub or on_pitch"
[ "$(q "select player_id||':'||player_on_id from app.match_event where id='$(cmd 3250)'")" = "$(pl 9 1):$(pl 9 3)" ] || fail "record_event: sub row"
[ "$(ev $D13 3251 $S22 $EM1 sub $X9 $(pl 9 1) $(pl 9 4) null)|$(ev $D13 3252 $S22 $EM1 sub $X9 $(pl 9 2) $(pl 9 3) null)|$(ev $D13 3253 $S22 $EM1 sub $X9 $(pl 9 2) $(pl 10 4) null)|$(ev $D13 3254 $S22 $EM1 sub $X9 $(pl 9 2) null null)|$(ev $D13 3255 $S22 $EM1 sub $X9 $(pl 9 2) $(pl 9 2) null)" \
  = 'not_on_pitch|not_on_bench|player_invalid|player_invalid|not_on_bench' ] || fail "record_event: invalid subs"
# Rolling: a subbed-off Player may come back.
[ "$(ev $D13 3256 $S22 $EM1 sub $X9 $(pl 9 2) $(pl 9 1) null)|$(pitch $EM1 $X9 "$(pl 9 1),$(pl 9 3)")" = 'ok|2/2' ] || fail "record_event: a subbed-off Player coming back"
# Deleting the last sub puts 9-2 back on the pitch.
[ "$(ex $D13 delete_event 3257 3256 $S22)|$(pitch $EM1 $X9 "$(pl 9 2),$(pl 9 3)")" = 'ok|2/2' ] || fail "delete_event: a sub is re-derived"
[ "$(ecount $EM1 sub)" = 1 ] || fail "events: sub count"
# A sub a later sub depends on can't be deleted or edited to a Player who is already off; a red-carded Player can't come on.
[ "$(ev $D13 3258 $S22 $EM1 sub $X9 $(pl 9 3) $(pl 9 4) null)|$(ex $D13 delete_event 3300 3250 $S22)|$(ex $D13 edit_event 3301 3258 $S22 "'$(pl 9 1)', false")" = 'ok|not_on_pitch|not_on_pitch' ] || fail "delete_event or edit_event: a sub a later sub depends on"
[ "$(ex $D13 delete_event 3302 3258 $S22)|$(pitch $EM1 $X9 "$(pl 9 2),$(pl 9 3)")|$(ecount $EM1 sub)" = 'ok|2/2|1' ] || fail "delete_event: the last sub"
# Limited (2 substitutions, no coming back).
[ "$(ev $D15 3260 $S23 $EM2 sub $X11 $(pl 11 1) $(pl 11 3) null)|$(ev $D15 3261 $S23 $EM2 sub $X11 $(pl 11 2) $(pl 11 1) null)|$(ev $D15 3262 $S23 $EM2 sub $X11 $(pl 11 2) $(pl 11 4) null)" = 'ok|not_on_bench|ok' ] \
  || fail "record_event: limited subs"
[ "$(evm $D15 3263 $S23 $EM2 sub $X11 $(pl 11 3) $(pl 11 1) null)|$(ev $D15 3264 $S23 $EM2 sub $X12 $(pl 12 1) $(pl 12 3) null)" = 'ELE has used all 2 substitutions.|ok' ] || fail "record_event: subs_used"
[ "$(ev $D15 3265 $S23 $EM2 sub $X11 $(pl 11 3) $(pl 11 1) null)" = subs_used ] || fail "record_event: subs_used code"
# Missed penalty: logged, no score change.
[ "$(ev $D13 3270 $S22 $EM1 missed_penalty $X10 $(pl 10 1) null null 1 8 480000)|$(ev $D13 3271 $S22 $EM1 missed_penalty $X10 null null null)|$(gscore $EM1)" = 'ok|player_invalid|1-0' ] || fail "record_event: missed penalty"
[ "$(ev $D13 3303 $S22 $EM1 sub $X10 $(pl 10 1) $(pl 10 3) null)|$(ev $D13 3304 $S22 $EM1 card $X10 $(pl 10 2) null red)|$(pitch $EM1 $X10 "$(pl 10 1)")" = 'not_on_bench|ok|1/1' ] || fail "record_event: a red-carded Player"
[ "$(ex $D13 delete_event 3305 3304 $S22)|$(pitch $EM1 $X10 "$(pl 10 1),$(pl 10 2)")" = 'ok|2/2' ] || fail "delete_event: a red card is re-derived"
# Edit: another Player (a Squad member), a stale version, the minute only for a foul, no assist.
[ "$(ex $D13 edit_event 3280 3221 $S22 "'$(pl 10 4)', false, 6")|$(gver 3221)|$(q "select player_id||':'||minute||':'||card from app.match_event where id='$(cmd 3221)'")" = "ok|2|$(pl 10 4):6:red" ] || fail "edit_event: a card"
[ "$(ex $D13 edit_event 3281 3221 $S22 "'$(pl 9 1)', false")|$(ex $D13 edit_event 3282 3221 $S22 "null, false")|$(tc $D13 "edit_event('$(cmd 3283)', '$S22', '$(cmd 3221)', 1, '$(pl 10 1)', false, 6)")" = 'player_invalid|player_invalid|version_conflict' ] \
  || fail "edit_event: invalid or stale"
[ "$(ex $D13 edit_event 3284 3231 $S22 "'$(pl 9 1)', false, 9")|$(q "select coalesce(player_id::text, '-')||':'||minute from app.match_event where id='$(cmd 3231)'")" = 'ok|-:9' ] || fail "edit_event: a foul takes the minute only"
[ "$(ex $D13 edit_event 3285 3250 $S22 "'$(pl 9 3)', false, 7")|$(ex $D13 add_assist 3286 3220 $S22 "'$(pl 9 2)'")|$(ex $D13 edit_event 3287 3250 $S22 "'$(pl 9 2)', false, 7")" = 'player_invalid|event_not_allowed|ok' ] || fail "edit_event: a sub, an assist on a card"
[ "$(ex $D13 delete_event 3288 3220 $S22)|$(ecount $EM1 card)|$(ex $D13 delete_event 3289 3220 $S22)|$(ex $D13 edit_event 3290 3220 $S22 "'$(pl 9 1)', false")" = 'ok|1|event_missing|event_missing' ] || fail "delete_event: a card"
[ "$(q "select count(*) from app.activity_log where command_id='$(cmd 3288)' and table_name = 'match_event' and op = 'update'")|$(gscore $EM1)" = '1|1-0' ] || fail "delete_event: not logged or score moved"
# Isolation again, now that events exist: the same phones cannot edit or delete them.
for who in $D14 $D7 $D9 $G1 $B; do
  [ "$(tc $who "edit_event('$(cmd 3291)', '$S22', '$(cmd 3221)', $(gver 3221), null, false, 9)")|$(tc $who "delete_event('$(cmd 3292)', '$S22', '$(cmd 3221)', $(gver 3221))")" = 'not_authorized|not_authorized' ] || fail "leak: $who changed an event"
  redo 3291; redo 3292
done
[ "$(q "select version||':'||coalesce(deleted_at::text, 'live') from app.match_event where id='$(cmd 3221)'")" = '2:live' ] || fail "leak: an event changed"
# The console: the Season's settings and the event fields; deleted events are skipped.
[ "$(as $D13 "select (j->'rules'->>'foul_warning')||'|'||(j->'rules'->>'timeouts_per_period')||'|'||(j->'rules'->>'substitutions')||'|'||(j->'rules'->>'power_play_minutes') from (select app.console_match('$EM1') j) x")" = '5|1|rolling|2' ] || fail "console_match: settings"
[ "$(as $D15 "select (j->'rules'->>'substitutions')||'|'||(j->'rules'->>'max_substitutions')||'|'||coalesce(j->'rules'->>'foul_warning', '-') from (select app.console_match('$EM2') j) x")" = 'limited|2|-' ] || fail "console_match: limited settings"
[ "$(as $D13 "select (e->>'card')||'|'||(e->>'clock_ms')||'|'||(e->>'player_id') from (select jsonb_array_elements(app.console_match('$EM1')->'events') e) x where e->>'id' = '$(cmd 3221)'")" = "red|300000|$(pl 10 4)" ] || fail "console_match: card fields"
[ "$(as $D13 "select (e->>'player_on_id') from (select jsonb_array_elements(app.console_match('$EM1')->'events') e) x where e->>'id' = '$(cmd 3250)'")" = "$(pl 9 3)" ] || fail "console_match: sub fields"
[ "$(as $D13 "select count(*) from (select jsonb_array_elements(app.console_match('$EM1')->'events') e) x where e->>'id' = '$(cmd 3220)'")" = 0 ] || fail "console_match: a deleted event"
# Reads and writes: nobody writes directly.
for stmt in "update app.match_event set card = 'red'" "update app.match_event set deleted_at = now()" "delete from app.match_event" "insert into app.match_event (id, tournament_id, season_id, match_id, kind, period, minute, entered_at) select gen_random_uuid(), tournament_id, season_id, id, 'foul', 1, 1, now() from app.match"; do
  for who in $D13 $A; do
    out=$(as $who "$stmt" 2>&1 || true)
    [[ $out == *"permission denied"* ]] || fail "$who wrote directly: $stmt: $out"
  done
done
# A finished Match refuses every event command; a revoked phone is refused; a finished Season too.
[ "$(tc $D13 "end_match('$(cmd 3293)', '$S22', '$EM1', $(mver $EM1))")|$(q "select status||':'||hg||'-'||ag from app.match where id='$EM1'")" = 'ok|finished:1-0' ] || fail "events: end the Match"
[ "$(ev $D13 3294 $S22 $EM1 foul $X9 null null null)|$(ex $D13 delete_event 3295 3221 $S22)|$(ex $D13 edit_event 3296 3221 $S22 "'$(pl 10 1)', false")" = 'match_not_live|match_not_live|match_not_live' ] || fail "events: a finished Match"
q "update app.scorer_device set status = 'revoked', revoked_at = now() - interval '2 hours' where user_id = '$D15'" >/dev/null
[ "$(ev $D15 3297 $S23 $EM2 foul $X11 null null null)|$(cm $D15 $EM2)" = 'not_authorized|none' ] || fail "events: a revoked phone still works"
q "update app.season set status = 'finished' where id='$S22'" >/dev/null
[ "$(ev $A 3298 $S22 $EM1 foul $X9 null null null)" = season_finished ] || fail "events: a finished Season"

q "create table app.t (id int generated always as identity primary key)" >/dev/null
q "create function app.f() returns int language sql as 'select 1'" >/dev/null
for r in anon authenticated; do
  for p in select insert update delete; do
    [ "$(q "select has_table_privilege('$r','app.t','$p')")" = f ] || fail "New table later: $r has $p"
  done
  [ "$(q "select has_sequence_privilege('$r','app.t_id_seq','usage')")" = f ] || fail "New sequence later: $r has usage"
  [ "$(q "select has_function_privilege('$r','app.f()','execute')")" = f ] || fail "New function later: $r can execute"
done

echo ok
