-- 0020_chit_draw.sql: record the live chit Draw (Story 3.1). One table, app.draw_slot: a row exists only while a Team
-- sits in a slot (placing inserts, sending it back deletes). grp is the group number (1 = Group A), or 0 for a
-- knockout-only bracket; pos is the slot number inside it. Only approved Teams of the same Season can be placed. The
-- Draw is recorded while the Season is in registration. The founder applies this in the Supabase SQL Editor as
-- `postgres`: test first, then live. Safe to run twice.

create table if not exists app.draw_slot (
  id uuid primary key,
  tournament_id uuid not null references app.tournament (id),
  season_id uuid not null references app.season (id),
  grp int not null check (grp >= 0),
  pos int not null check (pos >= 1),
  team_id uuid not null references app.team (id),
  created_at timestamptz not null default now(),
  version int not null default 1
);
create unique index if not exists draw_slot_place_idx on app.draw_slot (season_id, grp, pos);
create unique index if not exists draw_slot_team_idx on app.draw_slot (season_id, team_id);

-- No personal fields here.
create or replace trigger log_change after insert or update or delete on app.draw_slot
  for each row execute function app.log_change('tournament_id', '{}');

alter table app.draw_slot enable row level security;
drop policy if exists member_read on app.draw_slot;
create policy member_read on app.draw_slot for select to authenticated using (app.is_member(tournament_id));
revoke all on app.draw_slot from public, anon, authenticated;
grant select on app.draw_slot to authenticated;

insert into app.season_action values ('edit_draw', 'registration') on conflict do nothing;

-- Every slot the Season's Structure offers: groups x teams per group, or one bracket slot per approved Team. A League
-- (or no Structure yet) has no Draw: no rows.
create or replace function app.draw_slots(p_season_id uuid) returns table (grp int, pos int)
language sql stable security definer set search_path = '' as $$
  select case when s.structure = 'groups_knockout' then g else 0 end, p from app.season s
    cross join lateral generate_series(1, case when s.structure = 'groups_knockout' then s.group_count else 1 end) g
    cross join lateral generate_series(1, case when s.structure = 'groups_knockout' then s.teams_per_group
      else (select count(*)::int from app.team t where t.season_id = s.id and t.status = 'approved') end) p
  where s.id = p_season_id and s.structure in ('groups_knockout', 'knockout')
$$;

-- Commands ---------------------------------------------------------------------------------------
-- A slot in the result is (grp, pos). The conflict envelope is used when the slot is already taken: "Use mine" resends
-- with expected_version = the occupant's version, which replaces the occupant (who goes back to the chips).

-- Places an approved Team in an empty slot. slot_id is the new row's client id.
create or replace function app.place_team_in_draw(
  command_id uuid, season_id uuid, slot_id uuid, team_id uuid, grp int, pos int, expected_version int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'edit_draw', jsonb_build_object('season_id', season_id));
  r jsonb;
  sn app.season;
  tm app.team;
  mine app.draw_slot;
  occ app.draw_slot;
  who text;
  who_at timestamptz;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  select * into sn from app.season x where x.id = season_id for update;
  select * into tm from app.team t where t.id = team_id;
  select * into mine from app.draw_slot d where d.season_id = sn.id and d.team_id = tm.id;
  select * into occ from app.draw_slot d where d.season_id = sn.id and d.grp = grp and d.pos = pos;
  if sn.structure is null or sn.structure not in ('groups_knockout', 'knockout') then
    r := jsonb_build_object('ok', false, 'code', 'no_draw', 'message', 'This Structure has no Draw.');
  elsif tm.id is null or tm.season_id <> sn.id or tm.status <> 'approved' then
    r := jsonb_build_object('ok', false, 'code', 'team_not_approved', 'message', 'Only approved Teams can be placed in the Draw.');
  elsif not exists (select 1 from app.draw_slots(sn.id) s where s.grp = grp and s.pos = pos) then
    r := jsonb_build_object('ok', false, 'code', 'slot_invalid', 'message', 'That slot is not in the Draw.');
  elsif exists (select 1 from app.draw_slot d where d.id = slot_id) then
    r := jsonb_build_object('ok', false, 'code', 'already_exists', 'message', 'That placement already exists.');
  elsif mine.id is not null and mine.grp = grp and mine.pos = pos then
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Already placed.', 'version', mine.version);
  elsif mine.id is not null then
    r := jsonb_build_object('ok', false, 'code', 'team_placed', 'message', 'That Team is already placed in another slot.');
  elsif occ.id is not null and occ.version is distinct from expected_version then
    select coalesce(split_part(u.email, '@', 1), ''), l.at into who, who_at
    from app.activity_log l left join auth.users u on u.id = l.actor
    where l.tournament_id = occ.tournament_id and l.table_name = 'draw_slot' and l.row_id = occ.id order by l.id desc limit 1;
    r := jsonb_build_object('ok', false, 'code', 'version_conflict', 'message', 'Someone else placed a Team in that slot first.',
      'conflict', jsonb_build_object('current_version', occ.version, 'current', jsonb_build_object('team_id', occ.team_id),
        'changed_by', coalesce(who, ''), 'changed_at', coalesce(who_at, now())));
  else
    if occ.id is not null then delete from app.draw_slot d where d.id = occ.id; end if;
    insert into app.draw_slot (id, tournament_id, season_id, grp, pos, team_id) values (slot_id, sn.tournament_id, sn.id, grp, pos, tm.id);
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Placed.', 'version', 1,
      'complete', not exists (select 1 from app.team t where t.season_id = sn.id and t.status = 'approved'
        and not exists (select 1 from app.draw_slot d where d.team_id = t.id)));
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- Sends a Team back to the chips. Already unplaced is ok.
create or replace function app.unplace_team_from_draw(command_id uuid, season_id uuid, team_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'edit_draw', jsonb_build_object('season_id', season_id));
  r jsonb;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  perform 1 from app.season x where x.id = season_id for update;
  delete from app.draw_slot d where d.season_id = season_id and d.team_id = team_id;
  r := jsonb_build_object('ok', true, 'code', null, 'message', 'Sent back.');
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- Places every approved Team still on the chips into the empty slots at random, in one command. Placed Teams stay.
create or replace function app.place_rest_at_random(command_id uuid, season_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'edit_draw', jsonb_build_object('season_id', season_id));
  r jsonb;
  sn app.season;
  n int;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  select * into sn from app.season x where x.id = season_id for update;
  if sn.structure is null or sn.structure not in ('groups_knockout', 'knockout') then
    r := jsonb_build_object('ok', false, 'code', 'no_draw', 'message', 'This Structure has no Draw.');
  else
    with spare as (
      select t.id, row_number() over (order by random()) n from app.team t
      where t.season_id = sn.id and t.status = 'approved' and not exists (select 1 from app.draw_slot d where d.team_id = t.id)),
    empty as (
      select s.grp, s.pos, row_number() over (order by s.grp, s.pos) n from app.draw_slots(sn.id) s
      where not exists (select 1 from app.draw_slot d where d.season_id = sn.id and d.grp = s.grp and d.pos = s.pos)),
    put as (
      insert into app.draw_slot (id, tournament_id, season_id, grp, pos, team_id)
      select gen_random_uuid(), sn.tournament_id, sn.id, e.grp, e.pos, p.id from spare p join empty e using (n) returning 1)
    select count(*) into n from put;
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Placed the rest.', 'placed', n,
      'complete', not exists (select 1 from app.team t where t.season_id = sn.id and t.status = 'approved'
        and not exists (select 1 from app.draw_slot d where d.team_id = t.id)));
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

revoke all on function app.draw_slots(uuid) from public, anon, authenticated;
revoke all on function app.place_team_in_draw(uuid, uuid, uuid, uuid, int, int, int),
  app.unplace_team_from_draw(uuid, uuid, uuid), app.place_rest_at_random(uuid, uuid) from public, anon, authenticated;
grant execute on function app.place_team_in_draw(uuid, uuid, uuid, uuid, int, int, int),
  app.unplace_team_from_draw(uuid, uuid, uuid), app.place_rest_at_random(uuid, uuid) to authenticated;
