-- 0012_registration_grant.sql: a Team manager opens the Registration link and edits Team details (Story 2.2).
-- Redeeming a link gives the anonymous session that sent it a grant for exactly that link's Team in its Season. The grant
-- works only while its link is active: revoking or reissuing the link cuts every read and command at once. Needs
-- Supabase anonymous sign-ins on (app/README.md, Auth). The founder applies this in the Supabase SQL Editor as
-- `postgres`: test first, then live. Safe to run twice.

-- Tables -----------------------------------------------------------------------------------------

-- id: the anonymous user's id. One grant per user: redeeming another link replaces it. team_id, season_id and
-- tournament_id are copied from the link's Team when redeemed.
create table if not exists app.registration_grant (
  id uuid primary key references auth.users (id) on delete cascade,
  link_id uuid not null references app.registration_link (id),
  team_id uuid not null references app.team (id),
  season_id uuid not null references app.season (id),
  tournament_id uuid not null references app.tournament (id),
  created_at timestamptz not null default now()
);

create or replace trigger log_change after insert or update or delete on app.registration_grant
  for each row execute function app.log_change();

-- Organisers read their Tournament's grants (who opened which link); a grant holder reads nothing here.
alter table app.registration_grant enable row level security;
drop policy if exists member_read on app.registration_grant;
create policy member_read on app.registration_grant for select to authenticated using (app.is_member(tournament_id));
revoke all on app.registration_grant from public, anon, authenticated;
grant select on app.registration_grant to authenticated;

-- Organisers may edit a Team while setup or registration is open; a Team manager too, through their grant.
insert into app.season_action values ('edit_team', 'setup'), ('edit_team', 'registration') on conflict do nothing;

-- Helpers ----------------------------------------------------------------------------------------

-- The Team the caller's grant is for, while its link is active; null otherwise (and for anyone without a grant).
create or replace function app.granted_team() returns uuid
language sql stable security definer set search_path = '' as $$
  select g.team_id from app.registration_grant g
  join app.registration_link l on l.id = g.link_id and l.revoked_at is null
  where g.id = auth.uid()
$$;

-- A grant holder reads their own Team, and no other row of any table.
drop policy if exists grant_read on app.team;
create policy grant_read on app.team for select to authenticated using (id = (select app.granted_team()));

-- What the Registration link form shows besides the Team: one row for a live grant, none otherwise. No setup data.
create or replace function app.registration_form()
returns table (tournament_name text, season_number int, season_status text, registration_deadline date)
language sql stable security definer set search_path = '' as $$
  select t.name, s.number, s.status, s.registration_deadline
  from app.team x join app.season s on s.id = x.season_id join app.tournament t on t.id = x.tournament_id
  where x.id = app.granted_team()
$$;

-- authorize: as in 0009, plus team_id targets (resolved to their Season) and anonymous Team managers. An anonymous user
-- may only redeem a link, discard their own refused change, and run grant actions on the Team of their live grant.
create or replace function app.authorize(p_actor uuid, p_action text, p_target jsonb) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  confirmed timestamptz;
  anonymous boolean;
  t uuid := (p_target ->> 'tournament_id')::uuid;
  s uuid := (p_target ->> 'season_id')::uuid;
  tm uuid := (p_target ->> 'team_id')::uuid;
  ts uuid;
begin
  if p_actor is null then return 'not_signed_in'; end if;
  select u.email_confirmed_at, coalesce(u.is_anonymous, false) into confirmed, anonymous from auth.users u where u.id = p_actor;
  if not found then return 'not_signed_in'; end if;
  if tm is not null then
    select x.season_id into ts from app.team x where x.id = tm;
    if ts is null or ts <> coalesce(s, ts) then return 'not_authorized'; end if;
    s := ts;
  end if;
  if anonymous then
    if p_action = 'redeem_registration_link' then return null; end if;
    if p_action = 'discard_command' and t is null and s is null then return null; end if;
    if p_action <> all (array['edit_team']) or tm is null or not exists (
        select 1 from app.registration_grant g join app.registration_link l on l.id = g.link_id and l.revoked_at is null
        where g.id = p_actor and g.team_id = tm) then
      return 'not_authorized';
    end if;
    return app.season_allows(s, p_action);
  end if;
  if confirmed is null then return 'email_not_verified'; end if;
  if p_action = 'redeem_registration_link' then return 'not_authorized'; end if;
  if p_action = 'create_tournament' then return null; end if;
  if p_action in ('discard_command', 'accept_invite') and t is null and s is null then return null; end if;
  if s is not null then
    select tournament_id into t from app.season where id = s;
  end if;
  if t is null or not exists (select 1 from app.organiser_membership m
                              where m.tournament_id = t and m.user_id = p_actor) then
    return 'not_authorized';
  end if;
  if s is not null then return app.season_allows(s, p_action); end if;
  return null;
end $$;

-- Commands ---------------------------------------------------------------------------------------

-- Redeems a Registration link for the calling anonymous user: the token is hashed here and must match an active link.
-- Unknown, revoked and replaced links all answer link_dead. Redeeming again (the same or another link) replaces the
-- grant. The answer carries the Team's id.
create or replace function app.redeem_registration_link(command_id uuid, token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'redeem_registration_link', '{}'::jsonb);
  r jsonb;
  l app.registration_link;
  x app.team;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  select * into l from app.registration_link k
  where k.token_hash = encode(sha256(convert_to(coalesce(token, ''), 'UTF8')), 'hex') and k.revoked_at is null;
  if not found then
    r := jsonb_build_object('ok', false, 'code', 'link_dead', 'message', 'This link no longer works.');
  else
    select * into x from app.team k where k.id = l.team_id;
    insert into app.registration_grant as g (id, link_id, team_id, season_id, tournament_id)
    values (actor, l.id, x.id, x.season_id, x.tournament_id)
    on conflict (id) do update set link_id = excluded.link_id, team_id = excluded.team_id, season_id = excluded.season_id,
      tournament_id = excluded.tournament_id, created_at = now()
    where g.link_id <> excluded.link_id;
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Link opened.', 'team_id', x.id);
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- Changes a Team's name, Team code or kit colour. null = unchanged. A stale expected_version writes nothing and returns
-- the conflict envelope; changed_by is a role ("Organiser" or "Team manager"), never an email, since a Team manager sees it.
create or replace function app.edit_team(
  command_id uuid, team_id uuid, expected_version int, name text default null, code text default null,
  kit_colour text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'edit_team', jsonb_build_object('team_id', team_id));
  r jsonb;
  cur app.team;
  n text := regexp_replace(name, '^\s+|\s+$', '', 'g');
  c text := upper(regexp_replace(code, '^\s+|\s+$', '', 'g'));
  k text := lower(kit_colour);
  who text;
  who_at timestamptz;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  select * into cur from app.team x where x.id = team_id for update;
  if cur.version is distinct from expected_version then
    select case when u.id is null then '' when u.is_anonymous then 'Team manager' else 'Organiser' end, l.at into who, who_at
    from app.activity_log l left join auth.users u on u.id = l.actor
    where l.tournament_id = cur.tournament_id and l.table_name = 'team' and l.row_id = cur.id order by l.id desc limit 1;
    r := jsonb_build_object('ok', false, 'code', 'version_conflict', 'message', 'Someone else changed this first.',
      'conflict', jsonb_build_object('current_version', cur.version,
        'current', jsonb_build_object('name', cur.name, 'code', cur.code, 'kit_colour', cur.kit_colour),
        'changed_by', coalesce(who, ''), 'changed_at', coalesce(who_at, now())));
  elsif n is null and c is null and k is null then
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Nothing to change.', 'version', cur.version);
  elsif n is not null and (char_length(n) not between 1 and 80 or n ~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029]') then
    r := jsonb_build_object('ok', false, 'code', 'name_invalid', 'message', 'Name must be 1 to 80 characters.');
  elsif c is not null and c !~ '^[A-Z0-9]{2,5}$' then
    r := jsonb_build_object('ok', false, 'code', 'code_invalid', 'message', 'Team code must be 2 to 5 letters or digits.');
  elsif k is not null and k !~ '^#[0-9a-f]{6}$' then
    r := jsonb_build_object('ok', false, 'code', 'colour_invalid', 'message', 'Kit colour must be #rrggbb.');
  else
    begin
      update app.team x set name = coalesce(n, x.name), code = coalesce(c, x.code), kit_colour = coalesce(k, x.kit_colour),
        version = x.version + 1
      where x.id = cur.id;
      r := jsonb_build_object('ok', true, 'code', null, 'message', 'Team updated.', 'version', cur.version + 1);
    exception when unique_violation then
      r := jsonb_build_object('ok', false, 'code', 'team_code_taken', 'message', 'That Team code is already used in this Season.');
    end;
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

revoke all on function app.granted_team(), app.registration_form(), app.redeem_registration_link(uuid, text),
  app.edit_team(uuid, uuid, int, text, text, text) from public, anon, authenticated;
grant execute on function app.granted_team(), app.registration_form(), app.redeem_registration_link(uuid, text),
  app.edit_team(uuid, uuid, int, text, text, text) to authenticated;
