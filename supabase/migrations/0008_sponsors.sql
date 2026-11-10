-- 0008_sponsors.sql: setup wizard step 7 (Story 1.13). The Season's Sponsors (logo, optional ad images, a one-line
-- caption, their order) and four commands. Images live in the tournament-assets bucket (0004) under <tournament_id>/.
-- Finishing the wizard is the existing set_setup_step(7). The founder applies this in the Supabase SQL Editor as
-- `postgres`: test first, then live. Safe to run twice.

-- Table ------------------------------------------------------------------------------------------

-- caption: the Sponsor's name or one short line, shown in lists, on Graphics and on the Overlay ticker.
-- sort: the order on Graphics and the ticker (0 first); it is not part of the versioned content (reorder_sponsors).
create table if not exists app.sponsor (
  id uuid primary key,
  tournament_id uuid not null references app.tournament (id),
  season_id uuid not null references app.season (id),
  logo_path text not null,
  ad_paths text[] not null default '{}' check (cardinality(ad_paths) <= 5),
  caption text not null check (char_length(caption) between 1 and 120 and caption !~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029]'),
  sort int not null default 0,
  created_at timestamptz not null default now(),
  version int not null default 1
);
create index if not exists sponsor_season_idx on app.sponsor (season_id, sort);

create or replace trigger log_change after insert or update or delete on app.sponsor
  for each row execute function app.log_change();

alter table app.sponsor enable row level security;
drop policy if exists member_read on app.sponsor;
create policy member_read on app.sponsor for select to authenticated using (app.is_member(tournament_id));
revoke all on app.sponsor from public, anon, authenticated;
grant select on app.sponsor to authenticated;

-- Sponsors stay editable after registration opens and once the Season starts (a new Sponsor can join mid-Season);
-- a finished Season's Sponsors stay as they were.
insert into app.season_action values ('edit_sponsors', 'setup'), ('edit_sponsors', 'registration'), ('edit_sponsors', 'started')
on conflict do nothing;

-- Helper -----------------------------------------------------------------------------------------

-- The first problem with a Sponsor's values, as a command code, or null. Paths must be files in the Tournament's
-- folder; at most 5 distinct ad images. Commands call it; clients get no grant.
create or replace function app.sponsor_invalid(p_tournament_id uuid, p_caption text, p_logo_path text, p_ad_paths text[])
returns text language sql immutable security definer set search_path = '' as $$
  select case
    when p_caption is null or char_length(p_caption) not between 1 and 120 or p_caption ~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029]'
      then 'caption_invalid'
    when p_logo_path is null or p_logo_path !~ ('^' || p_tournament_id::text || '/[A-Za-z0-9_-][A-Za-z0-9._-]{0,120}$')
      then 'logo_invalid'
    when p_ad_paths is null or cardinality(p_ad_paths) > 5 or array_position(p_ad_paths, null) is not null
      or cardinality(p_ad_paths) <> (select count(distinct x) from unnest(p_ad_paths) x)
      or exists (select 1 from unnest(p_ad_paths) x
                 where x !~ ('^' || p_tournament_id::text || '/[A-Za-z0-9_-][A-Za-z0-9._-]{0,120}$'))
      then 'ads_invalid'
  end
$$;

-- Commands ---------------------------------------------------------------------------------------

-- Adds a Sponsor at the end of the Season's list. Insert-only: a reused id is already_exists. Its answer carries no
-- version (the outbox would file it under the scope); a new Sponsor is version 1.
create or replace function app.add_sponsor(
  command_id uuid, sponsor_id uuid, season_id uuid, caption text, logo_path text, ad_paths text[] default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'edit_sponsors', jsonb_build_object('season_id', season_id));
  r jsonb;
  t uuid;
  c text := regexp_replace(caption, '^\s+|\s+$', '', 'g');
  bad text;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  -- Locked, so two adds at once can't both pass the limit or take the same place.
  select x.tournament_id into t from app.season x where x.id = season_id for update;
  bad := app.sponsor_invalid(t, c, logo_path, ad_paths);
  if bad is not null then
    r := jsonb_build_object('ok', false, 'code', bad, 'message', 'A Sponsor value is not valid.');
  elsif (select count(*) from app.sponsor x where x.season_id = season_id) >= 30 then
    r := jsonb_build_object('ok', false, 'code', 'sponsors_full', 'message', 'A Season can have at most 30 Sponsors.');
  else
    begin
      insert into app.sponsor (id, tournament_id, season_id, logo_path, ad_paths, caption, sort)
      values (sponsor_id, t, season_id, logo_path, ad_paths, c,
              coalesce((select max(x.sort) + 1 from app.sponsor x where x.season_id = season_id), 0));
      r := jsonb_build_object('ok', true, 'code', null, 'message', 'Sponsor added.');
    exception when unique_violation then
      r := jsonb_build_object('ok', false, 'code', 'already_exists', 'message', 'That id is already used.');
    end;
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- Changes a Sponsor's caption, logo or ad images. null = unchanged; ad_paths replaces the whole list. A stale
-- expected_version writes nothing and returns the conflict envelope (app/README.md).
create or replace function app.edit_sponsor(
  command_id uuid, sponsor_id uuid, season_id uuid, expected_version int, caption text default null,
  logo_path text default null, ad_paths text[] default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'edit_sponsors', jsonb_build_object('season_id', season_id));
  r jsonb;
  cur app.sponsor;
  c text := regexp_replace(caption, '^\s+|\s+$', '', 'g');
  bad text;
  who text;
  who_at timestamptz;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  select * into cur from app.sponsor x where x.id = sponsor_id and x.season_id = season_id for update;
  if not found then
    r := jsonb_build_object('ok', false, 'code', 'sponsor_missing', 'message', 'That Sponsor was deleted.');
  elsif cur.version is distinct from expected_version then
    select coalesce(split_part(u.email, '@', 1), ''), l.at into who, who_at
    from app.activity_log l left join auth.users u on u.id = l.actor
    where l.tournament_id = cur.tournament_id and l.table_name = 'sponsor' and l.row_id = cur.id order by l.id desc limit 1;
    r := jsonb_build_object('ok', false, 'code', 'version_conflict', 'message', 'Someone else changed this first.',
      'conflict', jsonb_build_object('current_version', cur.version,
        'current', jsonb_build_object('caption', cur.caption, 'logo_path', cur.logo_path, 'ad_paths', cur.ad_paths),
        'changed_by', coalesce(who, ''), 'changed_at', coalesce(who_at, now())));
  else
    bad := app.sponsor_invalid(cur.tournament_id, coalesce(c, cur.caption), coalesce(logo_path, cur.logo_path),
                               coalesce(ad_paths, cur.ad_paths));
    if bad is not null then
      r := jsonb_build_object('ok', false, 'code', bad, 'message', 'A Sponsor value is not valid.');
    else
      update app.sponsor x set caption = coalesce(c, x.caption), logo_path = coalesce(logo_path, x.logo_path),
        ad_paths = coalesce(ad_paths, x.ad_paths), version = x.version + 1
      where x.id = cur.id;
      r := jsonb_build_object('ok', true, 'code', null, 'message', 'Sponsor updated.', 'version', cur.version + 1);
    end if;
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- Deletes a Sponsor. A stale expected_version writes nothing and returns the conflict envelope; a Sponsor already
-- gone is ok. Its files stay in the bucket (a later cleanup removes files nothing refers to).
create or replace function app.delete_sponsor(command_id uuid, sponsor_id uuid, season_id uuid, expected_version int)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'edit_sponsors', jsonb_build_object('season_id', season_id));
  r jsonb;
  cur app.sponsor;
  who text;
  who_at timestamptz;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  select * into cur from app.sponsor x where x.id = sponsor_id and x.season_id = season_id for update;
  if not found then
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Sponsor already deleted.');
  elsif cur.version is distinct from expected_version then
    select coalesce(split_part(u.email, '@', 1), ''), l.at into who, who_at
    from app.activity_log l left join auth.users u on u.id = l.actor
    where l.tournament_id = cur.tournament_id and l.table_name = 'sponsor' and l.row_id = cur.id order by l.id desc limit 1;
    r := jsonb_build_object('ok', false, 'code', 'version_conflict', 'message', 'Someone else changed this first.',
      'conflict', jsonb_build_object('current_version', cur.version,
        'current', jsonb_build_object('caption', cur.caption, 'logo_path', cur.logo_path, 'ad_paths', cur.ad_paths),
        'changed_by', coalesce(who, ''), 'changed_at', coalesce(who_at, now())));
  else
    delete from app.sponsor x where x.id = cur.id;
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Sponsor deleted.');
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

-- Puts the Season's Sponsors in this order: the listed ones first, then any not listed (added on another device) in
-- their current order; ids not in the Season are ignored. The order is last-writer-wins and bumps no version, so it
-- never conflicts with an edit.
create or replace function app.reorder_sponsors(command_id uuid, season_id uuid, sponsor_ids uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'edit_sponsors', jsonb_build_object('season_id', season_id));
  r jsonb;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  if sponsor_ids is null or array_position(sponsor_ids, null) is not null
     or cardinality(sponsor_ids) <> (select count(distinct x) from unnest(sponsor_ids) x) then
    r := jsonb_build_object('ok', false, 'code', 'sponsors_invalid', 'message', 'The Sponsor order is not valid.');
  else
    with o as (
      select x.id, (row_number() over (order by array_position(sponsor_ids, x.id) nulls last, x.sort, x.created_at, x.id) - 1)::int n
      from app.sponsor x where x.season_id = season_id)
    update app.sponsor x set sort = o.n from o where x.id = o.id and x.sort <> o.n;
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Sponsor order saved.');
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

revoke all on function app.sponsor_invalid(uuid, text, text, text[]),
  app.add_sponsor(uuid, uuid, uuid, text, text, text[]),
  app.edit_sponsor(uuid, uuid, uuid, int, text, text, text[]),
  app.delete_sponsor(uuid, uuid, uuid, int),
  app.reorder_sponsors(uuid, uuid, uuid[]) from public, anon, authenticated;
grant execute on function app.add_sponsor(uuid, uuid, uuid, text, text, text[]),
  app.edit_sponsor(uuid, uuid, uuid, int, text, text, text[]),
  app.delete_sponsor(uuid, uuid, uuid, int),
  app.reorder_sponsors(uuid, uuid, uuid[]) to authenticated;
