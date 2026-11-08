-- 0001_app_schema.sql: the empty `app` schema for the new app, beside the legacy `public` one.
-- The founder applies this in the Supabase SQL Editor: test project first, then live.
-- Agents never apply migrations. Safe to run twice. Changes no existing object in `public`;
-- the global default revoke at the end affects only functions the migrating role creates later,
-- and Supabase's `public` defaults keep anon/authenticated EXECUTE there.
--
-- Every later table, sequence and function in `app` starts with no access for client roles,
-- so each migration must grant exactly what it needs.

create schema if not exists app;

grant usage on schema app to anon, authenticated, service_role;

alter default privileges in schema app revoke all on tables    from public, anon, authenticated;
alter default privileges in schema app revoke all on sequences from public, anon, authenticated;
alter default privileges in schema app revoke all on functions from public, anon, authenticated;

-- Postgres grants EXECUTE on new functions to PUBLIC through a built-in *global* default that a
-- per-schema revoke cannot remove (per-schema revokes only undo per-schema grants). This global
-- revoke applies to functions the migrating role creates in any schema. Legacy `public` functions
-- that already exist keep their grants, and Supabase's own `public` defaults still grant EXECUTE
-- to anon/authenticated/service_role there.
alter default privileges revoke execute on functions from public;
