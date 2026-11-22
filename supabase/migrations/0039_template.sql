-- 0039_template.sql: the Tournament's Graphic Template (Story 5.7, FR-39). One column, 'classic' by default, and the command set_template. Every Graphic
-- of the Tournament renders in it the next time it opens; nothing stores a Template per Graphic. The change shows in the Activity log. The founder
-- applies this in the Supabase SQL Editor as `postgres`: test first, then live. Safe to run twice.

alter table app.tournament add column if not exists template text not null default 'classic';
alter table app.tournament drop constraint if exists tournament_template_check;
alter table app.tournament add constraint tournament_template_check check (template in ('classic', 'split', 'minimal'));

-- Sets the Template. A stale expected_version writes nothing and returns the conflict envelope.
create or replace function app.set_template(command_id uuid, tournament_id uuid, template text, expected_version int)
returns jsonb language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  actor uuid := auth.uid();
  denied text := app.authorize(actor, 'set_template', jsonb_build_object('tournament_id', tournament_id));
  r jsonb;
  cur app.tournament;
  who text;
  who_at timestamptz;
begin
  if denied is not null then
    return jsonb_build_object('ok', false, 'code', denied, 'message', 'Not allowed.');
  end if;
  r := app.claim_command(actor, command_id);
  if r is not null then return r; end if;
  perform set_config('app.actor', actor::text, true), set_config('app.command_id', command_id::text, true);

  select * into cur from app.tournament x where x.id = tournament_id for update;
  if template is null or template not in ('classic', 'split', 'minimal') then
    r := jsonb_build_object('ok', false, 'code', 'template_invalid', 'message', 'That template doesn''t exist.');
  elsif cur.version is distinct from expected_version then
    select coalesce(split_part(u.email, '@', 1), ''), l.at into who, who_at
    from app.activity_log l left join auth.users u on u.id = l.actor
    where l.tournament_id = cur.id order by l.id desc limit 1;
    r := jsonb_build_object('ok', false, 'code', 'version_conflict', 'message', 'Someone else changed this first.',
      'conflict', jsonb_build_object('current_version', cur.version, 'current', jsonb_build_object('template', cur.template),
        'changed_by', coalesce(who, ''), 'changed_at', coalesce(who_at, now())));
  else
    update app.tournament x set template = template, version = x.version + 1 where x.id = cur.id;
    r := jsonb_build_object('ok', true, 'code', null, 'message', 'Template saved.', 'version', cur.version + 1);
  end if;
  perform app.finish_command(actor, command_id, r);
  return r;
end $$;

revoke all on function app.set_template(uuid, uuid, text, int) from public, anon, authenticated;
grant execute on function app.set_template(uuid, uuid, text, int) to authenticated;
