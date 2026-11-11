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
helpers="{is_member,season_allows,authorize,claim_command,finish_command,log_change,season_status_guard,activity_log_immutable,server_now,report_client_error,is_asset_member,lineup_violations,sponsor_invalid,organisers,lock_membership,invite_preview,granted_team,registration_form,conflict,registration_rules,can_upload_scan,registration_eligibility,eligibility_invalid,can_use_photo,can_read_scan,scans_to_delete,scans_deleted}"
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
q "update app.season set photo_consent = 'Photos may be posted.', starts_on = '2026-12-01', ends_on = '2026-12-10' where id='$S2'" >/dev/null
[ "$(op $B 331 $S2)" = setup_incomplete ] || fail "open_registration: no deadline"
q "update app.season set registration_deadline = '2026-11-20' where id='$S2'" >/dev/null
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
q "update app.season set status = 'registration', registration_deadline = '2026-11-20' where id = '$S5';
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
    when a.t in ('integer'::regtype, 'smallint'::regtype, 'numeric'::regtype) then '1' when a.t = 'boolean'::regtype then 'true' when a.t = 'date'::regtype then '''2026-12-01'''
    when a.t in ('text[]'::regtype, 'uuid[]'::regtype, 'jsonb'::regtype) then '''{}''' else '''x''' end), ', ' order by a.o)
    from unnest(p.proargnames, p.proargtypes::oid[]::regtype[]) with ordinality a(n, t, o))), E'\n' order by p.proname)
  from pg_proc p where p.pronamespace = 'app'::regnamespace and p.prorettype = 'jsonb'::regtype
    and p.proname <> all ('$helpers'::name[] || '{redeem_registration_link,edit_team,discard_command,add_player,edit_player,remove_player,add_staff,edit_staff,remove_staff,submit_team,add_eligibility,edit_eligibility,set_photo}'::name[])")
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
[ "$(seen $G1)|$(form $G1)" = "$X|Grant Cup|1|registration|2026-11-20" ] || fail "grant: G1's reads"
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
  = 'player:photo_path:true,staff:photo_path:true' ] || fail "set_photo: log rows, or the path logged by value"
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
