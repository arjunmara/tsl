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
