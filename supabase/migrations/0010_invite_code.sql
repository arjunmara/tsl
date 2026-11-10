-- 0010_invite_code.sql: invite by emailed code (Story 1.14b). The invite page shows a signed-out visitor which
-- Tournament and which email the invite is for, then signs them in with a code emailed to that address. The founder
-- applies this in the Supabase SQL Editor as `postgres`: test first, then live. Safe to run twice.

-- What an invite link is for, readable without signing in (the token is the secret). One row for a known token, none
-- otherwise. status: pending, used, cancelled or expired; the email and Tournament name only while pending, so a dead
-- link tells nobody whom it was for. Read-only.
create or replace function app.invite_preview(p_token text)
returns table (status text, email text, tournament_name text)
language sql stable security definer set search_path = '' as $$
  select x.s, case when x.s = 'pending' then i.email end, case when x.s = 'pending' then t.name end
  from app.organiser_invite i
  join app.tournament t on t.id = i.tournament_id
  cross join lateral (select case when i.accepted_at is not null then 'used' when i.cancelled_at is not null then 'cancelled'
                                  when i.expires_at <= now() then 'expired' else 'pending' end) x(s)
  where i.token = p_token
$$;

revoke all on function app.invite_preview(text) from public, anon, authenticated;
grant execute on function app.invite_preview(text) to anon, authenticated;
