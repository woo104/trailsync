-- TrailSync database schema for Supabase
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.

-- ---------- Bike profile (one per user) ----------
create table if not exists public.profiles (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  bike_name    text,
  fork_model   text,
  shock_model  text,
  rider_weight numeric check (rider_weight is null or rider_weight between 0 and 1000),
  updated_at   timestamptz not null default now()
);

-- ---------- Ride logs ----------
-- One row per ride at a bike park / trail system.
-- trails holds every trail ridden, each with its own condition and surface tags:
--   [{"name": "A-Line", "condition": "dusty", "surfaces": ["bumps", "blown"]}, ...]
create table if not exists public.rides (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at     timestamptz not null default now(),
  trail_system   text not null check (length(trail_system) between 1 and 200),
  trails         jsonb not null default '[]'::jsonb check (jsonb_typeof(trails) = 'array'),
  front_psi      numeric check (front_psi is null or front_psi between 0 and 100),
  rear_psi       numeric check (rear_psi is null or rear_psi between 0 and 100),
  front_clickers integer check (front_clickers is null or front_clickers between 0 and 100),
  rear_clickers  integer check (rear_clickers is null or rear_clickers between 0 and 100),
  notes          text check (notes is null or length(notes) <= 5000),
  bike_name      text
);

create index if not exists rides_user_created_idx on public.rides (user_id, created_at desc);

-- ---------- Row Level Security: each rider only ever sees their own data ----------
alter table public.profiles enable row level security;
alter table public.rides    enable row level security;

drop policy if exists "profiles: own row" on public.profiles;
create policy "profiles: own row" on public.profiles
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "rides: read own"   on public.rides;
drop policy if exists "rides: insert own" on public.rides;
drop policy if exists "rides: update own" on public.rides;
drop policy if exists "rides: delete own" on public.rides;

create policy "rides: read own" on public.rides
  for select to authenticated using (user_id = (select auth.uid()));
create policy "rides: insert own" on public.rides
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "rides: update own" on public.rides
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "rides: delete own" on public.rides
  for delete to authenticated using (user_id = (select auth.uid()));
