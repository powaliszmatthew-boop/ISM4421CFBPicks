-- Already applied to the shared Supabase project. Kept here as a record.
-- College football lines from many sportsbooks (The Odds API), fetched by the database on a
-- schedule and cached here. The API key lives in Vault (secret name 'odds_api_key'), added with:
--   select vault.create_secret('<key>', 'odds_api_key', 'The Odds API key for college football lines');
create extension if not exists http with schema extensions;
create extension if not exists pg_cron;

create table public.odds_cache (
  id smallint primary key default 1 check (id = 1),
  fetched_at timestamptz,
  status integer,
  remaining text,
  body jsonb,
  error text
);
alter table public.odds_cache enable row level security;
create policy "Signed-in users read the odds cache" on public.odds_cache for select to authenticated using (true);
revoke all on public.odds_cache from anon, authenticated;
grant select on public.odds_cache to authenticated;

-- One refresh: 3 markets x up to 10 named books = 3 credits. A failed call keeps the last good lines.
create function public.refresh_cfb_odds()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  api_key text;
  res extensions.http_response;
  left_credits text;
  url text;
begin
  select decrypted_secret into api_key from vault.decrypted_secrets where name = 'odds_api_key';
  if api_key is null then
    update public.odds_cache set error = 'No odds_api_key in Vault' where id = 1;
    return 'no key';
  end if;
  url := 'https://api.the-odds-api.com/v4/sports/americanfootball_ncaaf/odds'
      || '?apiKey=' || api_key
      || '&markets=h2h,spreads,totals&oddsFormat=american&dateFormat=iso'
      || '&bookmakers=hardrockbet_fl,hardrockbet,draftkings,fanduel,betmgm,williamhill_us,espnbet,fanatics,betrivers,bovada';
  res := extensions.http_get(url);
  select h.value into left_credits from unnest(res.headers) h where lower(h.field) = 'x-requests-remaining';
  insert into public.odds_cache (id) values (1) on conflict (id) do nothing;
  if res.status = 200 then
    update public.odds_cache set fetched_at = now(), status = res.status, remaining = left_credits,
      body = res.content::jsonb, error = null where id = 1;
  else
    update public.odds_cache set status = res.status, remaining = coalesce(left_credits, remaining),
      error = left(res.content, 500) where id = 1;
  end if;
  return res.status::text || ' (credits left: ' || coalesce(left_credits, '?') || ')';
end;
$$;
revoke all on function public.refresh_cfb_odds() from public, anon, authenticated;

-- Every 5 hours from August through January (about 450 credits a month, inside the free 500).
select cron.schedule('refresh-cfb-odds', '7 */5 * 1,8-12 *', 'select public.refresh_cfb_odds()');
