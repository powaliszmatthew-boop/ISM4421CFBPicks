-- Already applied to the shared Supabase project (ISM4421NFLPicks). Kept here as a record.
-- The bets, bet_legs and user_settings tables come from the NFL repo's migrations.
-- Bets from the NFL site and the college football site share one account but stay separate.
alter table public.bets add column sport text not null default 'nfl' check (sport in ('nfl', 'cfb'));
create index bets_user_sport_idx on public.bets (user_id, sport, placed_on desc);
-- create_parlay now reads p_bet->>'sport' (default 'nfl'); see the NFL repo for the full function.
