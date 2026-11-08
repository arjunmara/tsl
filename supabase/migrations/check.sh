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
helpers="{is_member,season_allows,authorize,claim_command,finish_command,log_change,season_status_guard,activity_log_immutable}"
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
[ "$(q "select '$r1'::jsonb->>'ok'")" = true ] || fail "create: $r1"
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
