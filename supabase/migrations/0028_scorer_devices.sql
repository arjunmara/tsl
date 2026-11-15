-- 0028_scorer_devices.sql: the Scorer link and number-matching approval (Story 4.1, FR-3, AD-13). A Season has at most one live Scorer
-- link (a token hash on app.season; the client sends the hash, as for Registration links). A volunteer's phone opens the link, signs in
-- anonymously and asks to be a Scorer (request_scorer_approval): the server makes an app.scorer_device row and answers a two-digit
-- number, valid for 10 minutes. The Organiser's phone shows three numbers; tapping the right one (approve_scorer_device) approves the
-- phone, a wrong one rejects it. Until approved a device reads nothing: no policy grants it any row, and it learns its own status only
-- through app.scorer_status(). revoke_scorer_device cuts it off; app.scorer_allows is the one question later commands ask (a revoked
-- device still counts for changes entered before the revoke plus app.grace_window()). All Organiser commands work in every Season
-- status except finished. The founder applies this in the Supabase SQL Editor as `postgres`: test first, then live. Safe to run twice.

-- scorer_token_hash: SHA-256 of the live Scorer link's token, 64 lower-case hex; null = no live link.
alter table app.season add column if not exists scorer_token_hash text unique check (scorer_token_hash ~ '^[0-9a-f]{64}$');

-- One row per request from a phone. user_id: the phone's anonymous user. number_hash: sha256 of "<id>:<number>" (the number is 10 to 99;
-- the Organiser's phone finds the right one by hashing). status: pending, approved, rejected (wrong number, a newer request, or revoked
-- while pending) or revoked (an approved phone cut off; revoked_at set). A pending row past expires_at counts as expired.
create table if not exists app.scorer_device (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references app.tournament (id),
  season_id uuid not null references app.season (id),
  user_id uuid not null references auth.users (id) on delete cascade,
  label text not null check (char_length(label) between 1 and 40),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'revoked')),
  number_hash text not null check (number_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  version int not null default 1
);
create index if not exists scorer_device_user_idx on app.scorer_device (user_id, created_at desc);

-- The label is a name for a phone, not personal data.
create or replace trigger log_change after insert or update or delete on app.scorer_device
  for each row execute function app.log_change('tournament_id', '{}');

-- Organisers read their Tournament's devices; a device (or anyone else) reads none.
alter table app.scorer_device enable row level security;
drop policy if exists member_read on app.scorer_device;
create policy member_read on app.scorer_device for select to authenticated using (app.is_member(tournament_id));
revoke all on app.scorer_device from public, anon, authenticated;
grant select on app.scorer_device to authenticated;

insert into app.season_action values ('manage_scorers', 'setup'), ('manage_scorers', 'registration'), ('manage_scorers', 'started')
on conflict do nothing;

-- Helpers ----------------------------------------------------------------------------------------

-- The caller's own requests, newest first: id, Season, status (pending, expired, approved, rejected, revoked), label and expiry. A phone
-- picks the one it kept for the link it opened.
create or replace function app.scorer_status()
returns table (id uuid, season_id uuid, status text, label text, expires_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select d.id, d.season_id, case when d.status = 'pending' and d.expires_at <= now() then 'expired' else d.status end, d.label, d.expires_at
  from app.scorer_device d where d.user_id = auth.uid() order by d.created_at desc
$$;

-- True for an approved, unrevoked device of the Season; or a revoked one while the change was entered before the revoke plus the grace
-- window (p_entered_at null = now). For the scoring commands of Stories 4.4 and later.
create or replace function app.scorer_allows(p_actor uuid, p_season_id uuid, p_entered_at timestamptz) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app.scorer_device d where d.user_id = p_actor and d.season_id = p_season_id
    and (d.status = 'approved' or (d.status = 'revoked' and coalesce(p_entered_at, now()) < d.revoked_at + app.grace_window())))
$$;

-- authorize: as in 0025, plus request_scorer_approval: only an anonymous user may ask (the command checks the link itself).
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
    if p_action in ('redeem_registration_link', 'request_scorer_approval') then return null; end if;
    if p_action = 'discard_command' and t is null and s is null then return null; end if;
    if p_action <> all (array['edit_team', 'edit_squad', 'submit_team']) or tm is null or not exists (
        select 1 from app.registration_grant g join app.registration_link l on l.id = g.link_id and l.revoked_at is null
        where g.id = p_actor and g.team_id = tm) then
      return 'not_authorized';
    end if;
    if st = 'withdrawn' then return 'team_withdrawn'; end if;
    if st = 'approved' then return 'team_approved'; end if;
    return app.season_allows(s, p_action, tm);
  end if;
  if confirmed is null then return 'email_not_verified'; end if;
  if p_action in ('redeem_registration_link', 'request_scorer_approval') then return 'not_authorized'; end if;
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
  if s is not null then return app.season_allows(s, p_action, null, coalesce((p_target ->> 'confirmed')::boolean, false)); end if;
  return null;
end $$;

-- actor_name: as in 0026; a phone with a Scorer request in the Tournament is named by its label ("Bikash's phone").
create or replace function app.actor_name(p_tournament_id uuid, p_actor uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when not app.is_member(p_tournament_id) then null
    when p_actor is null then 'System'
    when u.is_anonymous then coalesce(
      (select d.label from app.scorer_device d where d.user_id = p_actor and d.tournament_id = p_tournament_id order by d.created_at desc limit 1),
      'Team manager' || coalesce((select ' (' || t.code || ')' from app.registration_grant g
        join app.team t on t.id = g.team_id where g.id = p_actor), ''))
    else coalesce(u.email, 'Unknown')
  end
  from (select 1) x left join auth.users u on u.id = p_actor
$$;

-- Commands ---------------------------------------------------------------------------------------

-- Makes the Season's Scorer link: the new hash replaces the old one, so the old link stops working for new requests at once.
-- Phones already approved stay approved.
create or replace function app.create_scorer_link(command_id uuid, season_id uuid, token_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'manage_scorers', jsonb_build_object('season_id', season_id));
  r jsonb;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  if token_hash is null or token_hash !~ '^[0-9a-f]{64}$' then
    r := jsonb_build_object('ok', false, 'code', 'token_invalid', 'message', 'The link is not valid.');
  else
    begin
      update app.season x set scorer_token_hash = token_hash where x.id = season_id;
      r := jsonb_build_object('ok', true, 'code', null, 'message', 'Scorer link made.');
    exception when unique_violation then
      r := jsonb_build_object('ok', false, 'code', 'already_exists', 'message', 'That id is already used.');
    end;
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- Ends the Season's Scorer link. Revoking when there is none is ok. Approved phones stay approved (revoke them one by one).
create or replace function app.revoke_scorer_link(command_id uuid, season_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'manage_scorers', jsonb_build_object('season_id', season_id));
  r jsonb;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  update app.season x set scorer_token_hash = null where x.id = season_id and x.scorer_token_hash is not null;
  r := jsonb_build_object('ok', true, 'code', null, 'message', 'Scorer link revoked.');
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- A phone asks to be a Scorer through the live link (the server hashes the token). Dead, replaced or unknown links, and a finished
-- Season, answer link_dead. A phone already approved in the Season is told so and gets no new row. Otherwise any older pending
-- request of this phone is rejected and a new one made; the answer carries the device id, the number (10 to 99) and its expiry.
create or replace function app.request_scorer_approval(command_id uuid, token text, label text)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'request_scorer_approval', '{}'::jsonb);
  r jsonb;
  sn app.season;
  l text := regexp_replace(label, '^\s+|\s+$', '', 'g');
  n int;
  d uuid := gen_random_uuid();
  exp timestamptz := now() + interval '10 minutes';
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  select * into sn from app.season s
  where s.scorer_token_hash = encode(sha256(convert_to(coalesce(token, ''), 'UTF8')), 'hex');
  if not found or app.season_allows(sn.id, 'manage_scorers') is not null then
    r := jsonb_build_object('ok', false, 'code', 'link_dead', 'message', 'This link no longer works.');
  elsif char_length(coalesce(l, '')) not between 1 and 40 or l ~ '[\u0001-\u001f\u007f-\u009f  ]' then
    r := jsonb_build_object('ok', false, 'code', 'label_invalid', 'message', 'Name this phone in 1 to 40 characters.');
  elsif exists (select 1 from app.scorer_device x where x.user_id = actor and x.season_id = sn.id and x.status = 'approved') then
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'This phone is already approved.', 'status', 'approved',
      'device_id', (select x.id from app.scorer_device x where x.user_id = actor and x.season_id = sn.id and x.status = 'approved'
        order by x.created_at desc limit 1));
  else
    n := 10 + floor(random() * 90)::int;
    update app.scorer_device x set status = 'rejected', version = x.version + 1 where x.user_id = actor and x.status = 'pending';
    insert into app.scorer_device (id, tournament_id, season_id, user_id, label, number_hash, expires_at)
    values (d, sn.tournament_id, sn.id, actor, l, encode(sha256(convert_to(d::text || ':' || n, 'UTF8')), 'hex'), exp);
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Request sent.', 'status', 'pending', 'device_id', d, 'number', n,
      'expires_at', exp);
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- The Organiser taps a number: the right one approves the pending phone, a wrong one rejects it (it must ask again). A request past
-- its expiry is request_expired and changes nothing.
create or replace function app.approve_scorer_device(command_id uuid, season_id uuid, device_id uuid, number int)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'manage_scorers', jsonb_build_object('season_id', season_id));
  r jsonb;
  cur app.scorer_device;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  select * into cur from app.scorer_device x where x.id = device_id and x.season_id = season_id for update;
  if not found then
    r := jsonb_build_object('ok', false, 'code', 'device_missing', 'message', 'That request no longer exists.');
  elsif cur.status <> 'pending' then
    r := jsonb_build_object('ok', false, 'code', 'request_closed', 'message', 'That request was already answered.');
  elsif cur.expires_at <= now() then
    r := jsonb_build_object('ok', false, 'code', 'request_expired', 'message', 'That request expired.');
  elsif cur.number_hash is distinct from encode(sha256(convert_to(cur.id::text || ':' || coalesce(number::text, ''), 'UTF8')), 'hex') then
    update app.scorer_device x set status = 'rejected', version = x.version + 1 where x.id = cur.id;
    r := jsonb_build_object('ok', false, 'code', 'number_mismatch', 'message', 'That number did not match.');
  else
    update app.scorer_device x set status = 'approved', version = x.version + 1 where x.id = cur.id;
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Phone approved.');
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- Cuts a phone off: an approved one becomes revoked (its next read or poll says so), a pending one is rejected. Already ended is ok.
create or replace function app.revoke_scorer_device(command_id uuid, season_id uuid, device_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'manage_scorers', jsonb_build_object('season_id', season_id));
  r jsonb;
  cur app.scorer_device;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  select * into cur from app.scorer_device x where x.id = device_id and x.season_id = season_id for update;
  if not found then
    r := jsonb_build_object('ok', false, 'code', 'device_missing', 'message', 'That request no longer exists.');
  else
    if cur.status = 'approved' then
      update app.scorer_device x set status = 'revoked', revoked_at = now(), version = x.version + 1 where x.id = cur.id;
    elsif cur.status = 'pending' then
      update app.scorer_device x set status = 'rejected', version = x.version + 1 where x.id = cur.id;
    end if;
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Phone revoked.');
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

revoke all on function app.scorer_status(), app.scorer_allows(uuid, uuid, timestamptz), app.create_scorer_link(uuid, uuid, text),
  app.revoke_scorer_link(uuid, uuid), app.request_scorer_approval(uuid, text, text), app.approve_scorer_device(uuid, uuid, uuid, int),
  app.revoke_scorer_device(uuid, uuid, uuid), app.actor_name(uuid, uuid) from public, anon, authenticated;
grant execute on function app.scorer_status(), app.create_scorer_link(uuid, uuid, text), app.revoke_scorer_link(uuid, uuid),
  app.request_scorer_approval(uuid, text, text), app.approve_scorer_device(uuid, uuid, uuid, int),
  app.revoke_scorer_device(uuid, uuid, uuid), app.actor_name(uuid, uuid) to authenticated;
