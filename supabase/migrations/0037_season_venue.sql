-- 0037_season_venue.sql: the Season's venue (Story 5.1, FR-30). One optional field, 1 to 80 characters, shown on the Result Graphic and
-- its caption; blank means none. It is set next to the dates in setup and stays editable after the Season starts (action edit_venue,
-- like the description), so the dates themselves stay locked. The founder applies this in the Supabase SQL Editor as `postgres`:
-- test first, then live. Safe to run twice.

alter table app.season add column if not exists venue text;
alter table app.season drop constraint if exists season_venue_length;
alter table app.season add constraint season_venue_length check (venue is null or char_length(venue) between 1 and 80);

insert into app.season_action (action, status) values ('edit_venue', 'setup'), ('edit_venue', 'registration'), ('edit_venue', 'started')
on conflict do nothing;

-- Sets the venue; '' (or only spaces) clears it. A stale expected_version writes nothing and returns the conflict envelope.
create or replace function app.set_season_venue(command_id uuid, season_id uuid, expected_version int, venue text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'edit_venue', jsonb_build_object('season_id', season_id));
  r jsonb;
  cur app.season;
  v text := nullif(regexp_replace(venue, '^\s+|\s+$', '', 'g'), '');
  who text;
  who_at timestamptz;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  select * into cur from app.season x where x.id = season_id for update;
  if char_length(v) > 80 or v ~ '[\u0001-\u001f\u007f-\u009f]' then
    r := jsonb_build_object('ok', false, 'code', 'venue_invalid', 'message', 'Venue must be 1 to 80 characters.');
  elsif cur.version is distinct from expected_version then
    select coalesce(split_part(u.email, '@', 1), ''), l.at into who, who_at
    from app.activity_log l left join auth.users u on u.id = l.actor
    where l.tournament_id = cur.tournament_id and l.table_name = 'season' and l.row_id = cur.id order by l.id desc limit 1;
    r := jsonb_build_object('ok', false, 'code', 'version_conflict', 'message', 'Someone else changed this first.',
      'conflict', jsonb_build_object('current_version', cur.version, 'current', jsonb_build_object('venue', coalesce(cur.venue, '')),
        'changed_by', coalesce(who, ''), 'changed_at', coalesce(who_at, now())));
  else
    update app.season x set venue = v, version = x.version + 1 where x.id = cur.id;
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Season updated.', 'version', cur.version + 1);
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

revoke all on function app.set_season_venue(uuid, uuid, int, text) from public, anon, authenticated;
grant execute on function app.set_season_venue(uuid, uuid, int, text) to authenticated;
