-- 0009_co_organisers.sql: invite and remove co-organisers (Story 1.14). Invites are shared as a link for now (no email:
-- that needs the product domain and an Edge Function, deferred). The founder applies this in the Supabase SQL Editor as
-- `postgres`: test first, then live. Safe to run twice.

-- Table ------------------------------------------------------------------------------------------

-- One invite to organise a Tournament. email: lower case, as typed by the inviter. token: the secret in the invite link
-- (244 random bits, base64url); only that Tournament's Organisers can read it, and the Activity log keeps it by name only.
-- Pending = not accepted, not cancelled, not expired.
create table if not exists app.organiser_invite (
  id uuid primary key,
  tournament_id uuid not null references app.tournament (id),
  email text not null check (email = lower(email) and char_length(email) between 3 and 254),
  token text not null unique check (char_length(token) >= 40),
  invited_by uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid,
  cancelled_at timestamptz,
  version int not null default 1
);
create index if not exists organiser_invite_tournament_idx on app.organiser_invite (tournament_id, email);

create or replace trigger log_change after insert or update or delete on app.organiser_invite
  for each row execute function app.log_change();

alter table app.organiser_invite enable row level security;
drop policy if exists member_read on app.organiser_invite;
create policy member_read on app.organiser_invite for select to authenticated using (app.is_member(tournament_id));
revoke all on app.organiser_invite from public, anon, authenticated;
grant select on app.organiser_invite to authenticated;

-- Helpers ----------------------------------------------------------------------------------------

-- log_change: as in 0002, plus `token` among the fields logged by name only (an invite token is a secret).
create or replace function app.log_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  b jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  a jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  k text;
begin
  foreach k in array array['email', 'phone', 'date_of_birth', 'guardian_name', 'document_number', 'token'] loop
    if b ? k then b := jsonb_set(b, array[k], to_jsonb(k)); end if;
    if a ? k then a := jsonb_set(a, array[k], to_jsonb(k)); end if;
  end loop;
  insert into app.activity_log (tournament_id, actor, command_id, table_name, row_id, op, before, after, reason)
  values (
    (coalesce(a, b) ->> coalesce(tg_argv[0], 'tournament_id'))::uuid,
    nullif(current_setting('app.actor', true), '')::uuid,
    nullif(current_setting('app.command_id', true), '')::uuid,
    tg_table_name,
    (coalesce(a, b) ->> 'id')::uuid,
    lower(tg_op), b, a,
    nullif(current_setting('app.reason', true), ''));
  return null;
end $$;

-- authorize: as in 0003, plus accept_invite, which any signed-in, verified account may call (the invite decides).
create or replace function app.authorize(p_actor uuid, p_action text, p_target jsonb) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  confirmed timestamptz;
  t uuid := (p_target ->> 'tournament_id')::uuid;
  s uuid := (p_target ->> 'season_id')::uuid;
begin
  if p_actor is null then return 'not_signed_in'; end if;
  select email_confirmed_at into confirmed from auth.users where id = p_actor;
  if not found then return 'not_signed_in'; end if;
  if confirmed is null then return 'email_not_verified'; end if;
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

-- A Tournament's Organisers with their sign-in emails, oldest first; no rows unless the caller is one of them.
-- Read-only (clients cannot read auth.users).
create or replace function app.organisers(p_tournament_id uuid)
returns table (user_id uuid, email text, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select m.user_id, coalesce(u.email, ''), m.created_at
  from app.organiser_membership m left join auth.users u on u.id = m.user_id
  where m.tournament_id = p_tournament_id and app.is_member(p_tournament_id)
  order by m.created_at, m.user_id
$$;

-- Locks the Tournament row, so membership and invite changes for one Tournament run one at a time, and says whether
-- the actor is (still) one of its Organisers once the lock is held.
create or replace function app.lock_membership(p_tournament_id uuid, p_actor uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from app.tournament where id = p_tournament_id for update;
  return exists (select 1 from app.organiser_membership m where m.tournament_id = p_tournament_id and m.user_id = p_actor);
end $$;

-- Commands ---------------------------------------------------------------------------------------

-- Invites an email to organise this Tournament. Insert-only (a reused id is already_exists). Answers with the token for
-- the link and when it expires (14 days).
create or replace function app.invite_organiser(command_id uuid, invite_id uuid, tournament_id uuid, email text)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'manage_organisers', jsonb_build_object('tournament_id', tournament_id));
  r jsonb;
  -- Spaces and invisible characters pasted from chat apps around the address are dropped; any left inside refuse it.
  e text := lower(regexp_replace(email, '^[\s\u00a0\u200b-\u200d\u2060\ufeff]+|[\s\u00a0\u200b-\u200d\u2060\ufeff]+$', '', 'g'));
  tok text := translate(encode(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid()), 'base64'), '+/=', '-_');
  exp timestamptz := now() + interval '14 days';
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  if not app.lock_membership(tournament_id, actor) then
    r := jsonb_build_object('ok', false, 'code', 'not_authorized', 'message', 'Not allowed.');
  elsif e is null or char_length(e) > 254 or e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
        or e ~ '[\u0001-\u0020\u007f-\u00a0\u200b-\u200d\u2028\u2029\u2060\ufeff]' then
    r := jsonb_build_object('ok', false, 'code', 'email_invalid', 'message', 'That email address is not valid.');
  elsif exists (select 1 from app.organiser_membership m join auth.users u on u.id = m.user_id
                where m.tournament_id = tournament_id and lower(u.email) = e) then
    r := jsonb_build_object('ok', false, 'code', 'already_organiser', 'message', 'That person already organises this tournament.');
  elsif exists (select 1 from app.organiser_invite i where i.tournament_id = tournament_id and i.email = e
                and i.accepted_at is null and i.cancelled_at is null and i.expires_at > now()) then
    r := jsonb_build_object('ok', false, 'code', 'already_invited', 'message', 'That email already has an invite waiting.');
  else
    begin
      insert into app.organiser_invite (id, tournament_id, email, token, invited_by, expires_at)
      values (invite_id, tournament_id, e, tok, actor, exp);
      r := jsonb_build_object('ok', true, 'code', null, 'message', 'Invite made.', 'token', tok, 'expires_at', exp);
    exception when unique_violation then
      r := jsonb_build_object('ok', false, 'code', 'already_exists', 'message', 'That id is already used.');
    end;
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- Cancels a pending invite: its link stops working. Cancelling one already cancelled or expired is ok; a used one is
-- invite_used.
create or replace function app.cancel_invite(command_id uuid, invite_id uuid, tournament_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'manage_organisers', jsonb_build_object('tournament_id', tournament_id));
  r jsonb;
  cur app.organiser_invite;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  if not app.lock_membership(tournament_id, actor) then
    r := jsonb_build_object('ok', false, 'code', 'not_authorized', 'message', 'Not allowed.');
  else
    select * into cur from app.organiser_invite i where i.id = invite_id and i.tournament_id = tournament_id for update;
    if not found then
      r := jsonb_build_object('ok', false, 'code', 'invite_missing', 'message', 'That invite does not exist.');
    elsif cur.accepted_at is not null then
      r := jsonb_build_object('ok', false, 'code', 'invite_used', 'message', 'That invite has already been used.');
    else
      update app.organiser_invite i set cancelled_at = now(), version = i.version + 1
      where i.id = cur.id and i.cancelled_at is null;
      r := jsonb_build_object('ok', true, 'code', null, 'message', 'Invite cancelled.');
    end if;
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- Accepts an invite: the caller becomes an Organiser of that one Tournament. Only for the invited email (signed in and
-- verified, which authorize checks); any other account gets invite_wrong_email and nothing changes. Strangers learn
-- nothing more about an invite than that it isn't theirs.
create or replace function app.accept_invite(command_id uuid, token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'accept_invite', '{}');
  r jsonb;
  t uuid;
  cur app.organiser_invite;
  me text;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  select i.tournament_id into t from app.organiser_invite i where i.token = token;
  if t is not null then
    perform app.lock_membership(t, actor);
    select * into cur from app.organiser_invite i where i.token = token for update;
  end if;
  select lower(u.email) into me from auth.users u where u.id = actor;
  if t is null then
    r := jsonb_build_object('ok', false, 'code', 'invite_missing', 'message', 'That invite does not exist.');
  elsif me is distinct from cur.email then
    r := jsonb_build_object('ok', false, 'code', 'invite_wrong_email', 'message', 'This invite is for a different email.');
  elsif cur.accepted_at is not null then
    if cur.accepted_by = actor and exists (select 1 from app.organiser_membership m
                                           where m.tournament_id = t and m.user_id = actor) then
      r := jsonb_build_object('ok', true, 'code', null, 'message', 'Invite already accepted.', 'tournament_id', t);
    else
      r := jsonb_build_object('ok', false, 'code', 'invite_used', 'message', 'That invite has already been used.');
    end if;
  elsif cur.cancelled_at is not null then
    r := jsonb_build_object('ok', false, 'code', 'invite_cancelled', 'message', 'That invite was cancelled.');
  elsif cur.expires_at <= now() then
    r := jsonb_build_object('ok', false, 'code', 'invite_expired', 'message', 'That invite has expired.');
  else
    insert into app.organiser_membership (tournament_id, user_id) values (t, actor) on conflict do nothing;
    update app.organiser_invite i set accepted_at = now(), accepted_by = actor, version = i.version + 1 where i.id = cur.id;
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'You now organise this tournament.', 'tournament_id', t);
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- Removes an Organiser (yourself included) from this Tournament: their access ends at once. Their pending invites, and
-- any pending invite to their email, are cancelled too. The last Organiser can't be removed (last_organiser); removing
-- someone who isn't an Organiser is ok.
create or replace function app.remove_organiser(command_id uuid, tournament_id uuid, user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'manage_organisers', jsonb_build_object('tournament_id', tournament_id));
  r jsonb;
  gone text;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  -- Locked and re-checked: two Organisers removing each other at once can't both succeed, and can't leave none.
  if not app.lock_membership(tournament_id, actor) then
    r := jsonb_build_object('ok', false, 'code', 'not_authorized', 'message', 'Not allowed.');
  elsif not exists (select 1 from app.organiser_membership m where m.tournament_id = tournament_id and m.user_id = user_id) then
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Already removed.');
  elsif (select count(*) from app.organiser_membership m where m.tournament_id = tournament_id) <= 1 then
    r := jsonb_build_object('ok', false, 'code', 'last_organiser', 'message', 'A tournament needs at least one organiser.');
  else
    select lower(u.email) into gone from auth.users u where u.id = user_id;
    delete from app.organiser_membership m where m.tournament_id = tournament_id and m.user_id = user_id;
    update app.organiser_invite i set cancelled_at = now(), version = i.version + 1
    where i.tournament_id = tournament_id and i.accepted_at is null and i.cancelled_at is null
      and (i.invited_by = user_id or i.email = gone);
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Organiser removed.');
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

revoke all on function app.organisers(uuid), app.lock_membership(uuid, uuid),
  app.invite_organiser(uuid, uuid, uuid, text), app.cancel_invite(uuid, uuid, uuid),
  app.accept_invite(uuid, text), app.remove_organiser(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function app.organisers(uuid),
  app.invite_organiser(uuid, uuid, uuid, text), app.cancel_invite(uuid, uuid, uuid),
  app.accept_invite(uuid, text), app.remove_organiser(uuid, uuid, uuid) to authenticated;
