-- 0026_activity_view.sql: browse the Activity log (Story 3.7, FR-17). A read-only view of app.activity_log with who made each change,
-- the Team and Match it concerns, and its Season. security_invoker: the log's own RLS applies (members of the Tournament only), so
-- another Tournament's Organiser, a Registration link and anon read no rows. Nothing writes log rows here.
-- The founder applies this in the Supabase SQL Editor as `postgres`: test first, then live. Safe to run twice.

-- log_change: as in 0018, except that on an UPDATE a personal field whose value changed is logged as "<field>:changed" (unchanged
-- stays the plain field name), so the log can say which personal fields were edited without keeping a value.
create or replace function app.log_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  b jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  a jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  k text;
  edited boolean;
  actor uuid := nullif(current_setting('app.actor', true), '')::uuid;
  why text := nullif(current_setting('app.reason', true), '');
begin
  if tg_nargs < 2 then
    raise exception 'log_change on app.%: declare the personal fields as the second trigger argument', tg_table_name;
  end if;
  foreach k in array tg_argv[1]::text[] loop
    edited := case when tg_op = 'UPDATE' then (b -> k) is distinct from (a -> k) else false end;
    if jsonb_typeof(b -> k) <> 'null' then b := jsonb_set(b, array[k], to_jsonb(k)); end if;
    if jsonb_typeof(a -> k) <> 'null' then a := jsonb_set(a, array[k], to_jsonb(case when edited then k || ':changed' else k end)); end if;
  end loop;
  if why is null and actor is not null then
    select t.reopen_reason into why from app.registration_grant g join app.team t on t.id = g.team_id
      join app.season s on s.id = t.season_id
    where g.id = actor and t.reopen_reason is not null
      and now() >= ((s.registration_deadline + 1)::timestamp) at time zone 'Asia/Kathmandu';
  end if;
  insert into app.activity_log (tournament_id, actor, command_id, table_name, row_id, op, before, after, reason)
  values (
    (coalesce(a, b) ->> tg_argv[0])::uuid,
    actor,
    nullif(current_setting('app.command_id', true), '')::uuid,
    tg_table_name,
    (coalesce(a, b) ->> 'id')::uuid,
    lower(tg_op), b, a,
    why);
  return null;
end $$;

-- Names an actor: null = System; an anonymous user (a Registration link) = "Team manager (CODE)"; else the sign-in email.
-- Only for a member of the Tournament, so it can't be used to look up anyone's email.
create or replace function app.actor_name(p_tournament_id uuid, p_actor uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when not app.is_member(p_tournament_id) then null
    when p_actor is null then 'System'
    when u.is_anonymous then 'Team manager' || coalesce((select ' (' || t.code || ')' from app.registration_grant g
      join app.team t on t.id = g.team_id where g.id = p_actor), '')
    else coalesce(u.email, 'Unknown')
  end
  from (select 1) x left join auth.users u on u.id = p_actor
$$;

create or replace view app.activity_view with (security_invoker = true) as
select l.id, l.tournament_id, l.at, l.actor, l.command_id, app.actor_name(l.tournament_id, l.actor) as who, l.table_name, l.row_id, l.op,
  l.before, l.after, l.reason, tm.team_id,
  case when l.table_name = 'match' then array_remove(array[(c.j ->> 'home_team_id')::uuid, (c.j ->> 'away_team_id')::uuid], null)
    when tm.team_id is not null then array[tm.team_id] else '{}'::uuid[] end as team_ids,
  case when l.table_name = 'match' then l.row_id end as match_id,
  case when l.table_name = 'season' then l.row_id
    else coalesce((c.j ->> 'season_id')::uuid, (select t.season_id from app.team t where t.id = tm.team_id)) end as season_id
from app.activity_log l
cross join lateral (select coalesce(l.after, l.before) as j) c
cross join lateral (select case
  when l.table_name = 'team' then l.row_id
  when l.table_name in ('squad_entry', 'staff', 'draw_slot') then (c.j ->> 'team_id')::uuid
  when l.table_name in ('player', 'eligibility_record', 'photo_consent') then coalesce(
    -- The Squad entry the same command added or removed, else the Player's latest Squad entry now.
    (select (coalesce(g.after, g.before) ->> 'team_id')::uuid from app.activity_log g
      where g.command_id = l.command_id and g.table_name = 'squad_entry' limit 1),
    (select e.team_id from app.squad_entry e
      where e.player_id = case when l.table_name = 'player' then l.row_id else (c.j ->> 'player_id')::uuid end
      order by e.created_at desc limit 1))
  end as team_id) tm;

revoke all on app.activity_view from public, anon, authenticated;
grant select on app.activity_view to authenticated;
revoke all on function app.actor_name(uuid, uuid) from public, anon, authenticated;
grant execute on function app.actor_name(uuid, uuid) to authenticated;
