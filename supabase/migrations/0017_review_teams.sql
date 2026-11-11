-- 0017_review_teams.sql: approve, return or withdraw a Team (Story 2.8). Status gains 'withdrawn'; a returned Team carries
-- the Organiser's note for its manager. What a status locks: an approved Team is read-only for its manager (the Organiser
-- may still edit, or return it); a withdrawn Team is read-only for everyone. A submitted Team stays editable for its
-- manager, and approve_team re-checks the Line-up rules, so a Squad changed after sending can't be approved below them.
-- app.draw_team is the read the Draw (Epic 3) uses: approved Teams only. The founder applies this in the Supabase SQL
-- Editor as `postgres`: test first, then live. Safe to run twice.

alter table app.team drop constraint if exists team_status_check;
alter table app.team add constraint team_status_check
  check (status in ('invited', 'submitted', 'approved', 'returned', 'withdrawn'));
-- return_note: the Organiser's reason in words, shown to the Team manager while the Team is returned. Not personal.
alter table app.team add column if not exists return_note text
  check (char_length(return_note) between 1 and 500);

-- Teams are reviewed while setup or registration is open.
insert into app.season_action values ('review_team', 'setup'), ('review_team', 'registration') on conflict do nothing;

-- The Teams the Draw may place: approved (so not withdrawn). security_invoker: the reader's RLS applies, so an Organiser
-- sees only their Tournaments' Teams and a Registration grant at most its own.
create or replace view app.draw_team with (security_invoker = true) as
  select t.id, t.tournament_id, t.season_id, t.name, t.code, t.kit_colour from app.team t where t.status = 'approved';
revoke all on app.draw_team from public, anon, authenticated;
grant select on app.draw_team to authenticated;

-- authorize: as in 0013, plus the Team's status. A withdrawn Team refuses every command but review_team (team_withdrawn);
-- an approved Team refuses its manager's grant actions (team_approved).
create or replace function app.authorize(p_actor uuid, p_action text, p_target jsonb) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  confirmed timestamptz;
  anonymous boolean;
  t uuid := (p_target ->> 'tournament_id')::uuid;
  s uuid := (p_target ->> 'season_id')::uuid;
  tm uuid := (p_target ->> 'team_id')::uuid;
  ts uuid;
  st text;
begin
  if p_actor is null then return 'not_signed_in'; end if;
  select u.email_confirmed_at, coalesce(u.is_anonymous, false) into confirmed, anonymous from auth.users u where u.id = p_actor;
  if not found then return 'not_signed_in'; end if;
  if tm is not null then
    select x.season_id, x.status into ts, st from app.team x where x.id = tm;
    if ts is null or ts <> coalesce(s, ts) then return 'not_authorized'; end if;
    s := ts;
  end if;
  if anonymous then
    if p_action = 'redeem_registration_link' then return null; end if;
    if p_action = 'discard_command' and t is null and s is null then return null; end if;
    if p_action <> all (array['edit_team', 'edit_squad', 'submit_team']) or tm is null or not exists (
        select 1 from app.registration_grant g join app.registration_link l on l.id = g.link_id and l.revoked_at is null
        where g.id = p_actor and g.team_id = tm) then
      return 'not_authorized';
    end if;
    if st = 'withdrawn' then return 'team_withdrawn'; end if;
    if st = 'approved' then return 'team_approved'; end if;
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
  if st = 'withdrawn' and p_action <> 'review_team' then return 'team_withdrawn'; end if;
  if s is not null then return app.season_allows(s, p_action); end if;
  return null;
end $$;

-- Commands ---------------------------------------------------------------------------------------
-- Status is not versioned content (as submit_team in 0013): each command checks the status it starts from instead, so
-- two Organisers reviewing at once never overwrite each other silently. Organisers only; a grant is not_authorized.

-- Approves a submitted Team whose whole Squad and Staff meet the Line-up rules (else the reasons in words).
create or replace function app.approve_team(command_id uuid, team_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'review_team', jsonb_build_object('team_id', team_id));
  r jsonb;
  x app.team;
  why text[];
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  select * into x from app.team t where t.id = team_id for update;
  why := app.lineup_violations(x.season_id, jsonb_build_object('complete', true,
    'players', coalesce((select jsonb_agg(e.player_id) from app.squad_entry e where e.team_id = x.id), '[]'::jsonb),
    'staff', coalesce((select jsonb_agg(s.role) from app.staff s where s.team_id = x.id), '[]'::jsonb)));
  if x.status = 'approved' then
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Already approved.');
  elsif x.status = 'withdrawn' then
    r := jsonb_build_object('ok', false, 'code', 'team_withdrawn', 'message', 'This Team was withdrawn.');
  elsif x.status <> 'submitted' then
    r := jsonb_build_object('ok', false, 'code', 'team_not_submitted', 'message', 'This Team has not been sent for review.');
  elsif cardinality(why) > 0 then
    r := jsonb_build_object('ok', false, 'code', 'lineup_violation', 'message', array_to_string(why, ' '));
  else
    update app.team t set status = 'approved' where t.id = x.id;
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Approved.');
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- Returns a submitted or approved Team to its manager with a note (1–500 characters, trimmed): status returned, so the
-- manager can edit and send it again.
create or replace function app.return_team(command_id uuid, team_id uuid, note text)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'review_team', jsonb_build_object('team_id', team_id));
  r jsonb;
  x app.team;
  n text := btrim(note);
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  select * into x from app.team t where t.id = team_id for update;
  if n is null or char_length(n) not between 1 and 500 then
    r := jsonb_build_object('ok', false, 'code', 'note_invalid', 'message', 'Write a note of 1 to 500 characters.');
  elsif x.status = 'withdrawn' then
    r := jsonb_build_object('ok', false, 'code', 'team_withdrawn', 'message', 'This Team was withdrawn.');
  elsif x.status not in ('submitted', 'approved') then
    r := jsonb_build_object('ok', false, 'code', 'team_not_submitted', 'message', 'This Team has not been sent for review.');
  else
    update app.team t set status = 'returned', return_note = n where t.id = x.id;
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Returned.');
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- Withdraws a Team in any status: it leaves the Draw and its form turns read-only for everyone. Withdrawn again is ok.
-- The Registration link keeps working for reading.
create or replace function app.withdraw_team(command_id uuid, team_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'review_team', jsonb_build_object('team_id', team_id));
  r jsonb;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  update app.team t set status = 'withdrawn' where t.id = team_id and t.status <> 'withdrawn';
  r := jsonb_build_object('ok', true, 'code', null, 'message', 'Withdrawn.');
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

revoke all on function app.approve_team(uuid, uuid), app.return_team(uuid, uuid, text), app.withdraw_team(uuid, uuid)
  from public, anon, authenticated;
grant execute on function app.approve_team(uuid, uuid), app.return_team(uuid, uuid, text), app.withdraw_team(uuid, uuid)
  to authenticated;
