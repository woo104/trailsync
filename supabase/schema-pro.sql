-- TrailSync Pro features: multiple bikes with tire setups, and a 1-5 "setup feel" rating per ride.
-- Run once in Supabase: SQL Editor -> New query -> paste -> Run. Safe to run again.
-- Until this runs, rides and profiles still sync, but ratings and extra bikes are not saved to your account.

alter table public.profiles add column if not exists garage jsonb;

alter table public.rides add column if not exists rating smallint;
alter table public.rides drop constraint if exists rides_rating_range;
alter table public.rides add constraint rides_rating_range check (rating between 1 and 5);

-- Make the API see the new columns straight away.
notify pgrst, 'reload schema';
