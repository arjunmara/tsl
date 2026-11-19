-- 0036_legacy_mirror.sql: TSL Season 2 on today's overlay (Story 4.10, FR-24, AR-38, AD-16). The old PRISM overlay only reads
-- public.live, so while the founder has switched a Season on in app.legacy_mirror (Tournament, Season: a row he adds by hand, see the
-- README), the Match on air in that Season is copied one way into public.live.state: names, kit colours, score, period and clock.
-- Nothing else in public is written (no legacy matches, goals, seasons, squad). `match` is set to null so the legacy score_to_live
-- trigger never overwrites the score from a stale legacy match. Triggers on app.live_state, app.match and app.match_lineup call one
-- function; any error in it is a warning in the Supabase logs and the scoring command still succeeds. Dropped when the Stage 2
-- Overlay ships. The founder applies this in the Supabase SQL Editor as `postgres`: test first, then live. Safe to run twice.

create table if not exists app.legacy_mirror (
  tournament_id uuid not null references app.tournament (id) on delete cascade,
  season_id uuid not null references app.season (id) on delete cascade,
  primary key (tournament_id, season_id)
);
-- No personal fields; the switch being flipped shows in the Activity log.
create or replace trigger log_change after insert or update or delete on app.legacy_mirror
  for each row execute function app.log_change('tournament_id', '{}');
alter table app.legacy_mirror enable row level security;
revoke all on app.legacy_mirror from public, anon, authenticated;

create or replace function app.legacy_mirror_push() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  j jsonb := to_jsonb(case when tg_op = 'DELETE' then old else new end);
  mid uuid := (case tg_table_name when 'live_state' then j ->> 'on_air_match_id' when 'match' then j ->> 'id' else j ->> 'match_id' end)::uuid;
  m app.match;
  sn app.season;
  r record;
  sc record;
  c jsonb;
  ht uuid; atm uuid;
  per int; regular int; brk boolean; el bigint;
  swap boolean;
  hk text; ak text; hn text; an text; p text;
  n int;
begin
  if mid is null then return null; end if;
  select * into m from app.match x where x.id = mid;
  if not found or not exists (select 1 from app.legacy_mirror l where l.tournament_id = m.tournament_id and l.season_id = m.season_id)
    or not exists (select 1 from app.live_state s where s.tournament_id = m.tournament_id and s.on_air_match_id = m.id) then
    return null;
  end if;
  select * into sn from app.season x where x.id = m.season_id;
  select x.home_team_id as h, x.away_team_id as a into r from app.match_resolve(m.season_id) x where x.match_id = m.id;
  -- Sides come from the line-up when it names them, else from the Match.
  select l.team_id, l.kit_colour into ht, hk from app.match_lineup l where l.match_id = m.id and l.side = 'home';
  select l.team_id, l.kit_colour into atm, ak from app.match_lineup l where l.match_id = m.id and l.side = 'away';
  -- A missing side takes the Match's other Team (the one the present line-up does not use).
  if ht is null and atm is null then ht := r.h; atm := r.a;
  elsif ht is null then ht := case when atm = r.h then r.a else r.h end;
  elsif atm is null then atm := case when ht = r.h then r.a else r.h end; end if;
  swap := ht is not distinct from r.a and atm is not distinct from r.h;
  select * into sc from app.match_score(m.id);
  select t.name, coalesce(hk, t.kit_colour, '') into hn, hk from app.team t where t.id = ht;
  select t.name, coalesce(ak, t.kit_colour, '') into an, ak from app.team t where t.id = atm;

  c := coalesce(m.clock, '{"running": false, "anchor_at": null, "elapsed_ms": 0, "period": 0, "interval": false}');
  per := coalesce((c ->> 'period')::int, 0); brk := coalesce((c ->> 'interval')::boolean, false); regular := coalesce(sn.periods, 2);
  p := case when m.status = 'finished' then 'Full Time'
    when per > regular then 'Extra Time'
    when brk then case when per < regular then 'Half Time' else 'Full Time' end
    when per <= 1 then '1st Half' else '2nd Half' end;
  el := coalesce((c ->> 'elapsed_ms')::bigint, 0);

  update public.live set state = coalesce(state, '{}'::jsonb) || jsonb_build_object(
    'match', null, 'home', coalesce(hn, ''), 'away', coalesce(an, ''), 'hc', coalesce(hk, ''), 'ac', coalesce(ak, ''),
    'hs', case when swap then sc.ag else sc.hg end, 'as', case when swap then sc.hg else sc.ag end,
    'period', p, 'elapsed', el / 1000,
    'since', case when coalesce((c ->> 'running')::boolean, false) then floor(extract(epoch from (c ->> 'anchor_at')::timestamptz) * 1000)::bigint end)
  where id = 1;
  get diagnostics n = row_count;
  if n = 0 then raise warning 'legacy_mirror: no public.live row'; end if;
  return null;
exception when others then
  raise warning 'legacy_mirror: % (%)', sqlerrm, sqlstate;
  return null;
end $$;
revoke all on function app.legacy_mirror_push() from public, anon, authenticated;

create or replace trigger legacy_mirror after insert or update of on_air_match_id on app.live_state
  for each row execute function app.legacy_mirror_push();
create or replace trigger legacy_mirror after update on app.match
  for each row execute function app.legacy_mirror_push();
create or replace trigger legacy_mirror after insert or update or delete on app.match_lineup
  for each row execute function app.legacy_mirror_push();
