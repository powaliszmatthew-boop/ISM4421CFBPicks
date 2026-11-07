-- Applied to the shared GridIron Edge Supabase project. Kept here as a record.
-- Saved college player props for the Player props page. Same shape as the NFL site's public.props,
-- in their own table so neither site lists the other's props. Teams are ESPN team IDs, and week is
-- the site's week number (bowl and playoff weeks are 100 + week).
create table public.cfb_props (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  season smallint not null,
  week smallint not null check (week between 1 and 120),
  game_id text not null check (char_length(game_id) <= 40),
  player_id text not null check (char_length(player_id) <= 20),
  player_name text not null check (char_length(player_name) <= 80),
  team text check (char_length(team) <= 12),
  opponent text check (char_length(opponent) <= 12),
  stat text not null check (char_length(stat) <= 30),
  line numeric(7, 1) not null check (line >= 0),
  over_odds integer check (over_odds <= -100 or over_odds >= 100),
  under_odds integer check (under_odds <= -100 or under_odds >= 100),
  book text check (char_length(book) <= 40),
  notes text check (char_length(notes) <= 500),
  -- The model's view while the game was upcoming, so past props are graded on the pre-game price.
  model_mean numeric(8, 2),
  model_side text check (model_side in ('over', 'under')),
  model_prob numeric(6, 5) check (model_prob between 0 and 1),
  model_ev numeric(8, 5),
  priced_at timestamptz
);
create index cfb_props_user_idx on public.cfb_props (user_id, season desc, week desc);

alter table public.cfb_props enable row level security;
create policy "Users read own cfb props" on public.cfb_props for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users add own cfb props" on public.cfb_props for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users change own cfb props" on public.cfb_props for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users delete own cfb props" on public.cfb_props for delete to authenticated using ((select auth.uid()) = user_id);

revoke all on public.cfb_props from anon, authenticated;
grant select, insert, update, delete on public.cfb_props to authenticated;
