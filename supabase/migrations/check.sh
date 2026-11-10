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
helpers="{is_member,season_allows,authorize,claim_command,finish_command,log_change,season_status_guard,activity_log_immutable,server_now,report_client_error,is_asset_member}"
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
