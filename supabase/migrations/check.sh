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
create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz);
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
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets (id), name text, owner uuid);
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated;
grant select, insert, update, delete on storage.objects to anon, authenticated;
create function storage.foldername(name text) returns text[] language plpgsql as $$
declare _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1:array_length(_parts, 1) - 1];
end $$;
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
helpers="{is_member,season_allows,authorize,claim_command,finish_command,log_change,season_status_guard,activity_log_immutable,server_now,report_client_error,is_asset_member,lineup_violations,sponsor_invalid,organisers,lock_membership,invite_preview}"
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
        exception when insufficient_privilege then null;
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
   create trigger log_change after insert on app.probe_person for each row execute function app.log_change();
   insert into app.probe_person values ('$S3', '$T3', 'kid@x.test', '98000', 'Ram');
   drop table app.probe_person" >/dev/null
[ "$(q "select (after->>'email')||(after->>'phone')||(after->>'nick') from app.activity_log where row_id='$S3'")" = emailphoneRam ] || fail "personal fields logged"

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
