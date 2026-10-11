-- Turnline prelaunch marketing list. Apply only to an approved staging project.
-- Private tables: no browser-side direct access; Edge Function validates CAPTCHA and sends confirmation.
create table if not exists public.turnline_waitlist (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  email_normalized text generated always as (lower(btrim(email))) stored,
  consented_at timestamptz not null,
  confirmed_at timestamptz,
  unsubscribed_at timestamptz,
  source text not null default 'turnline_waitlist',
  utm_source text,
  utm_medium text,
  utm_campaign text,
  verification_hash text not null,
  verification_expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint waitlist_email_length check (length(email) between 3 and 254),
  constraint waitlist_email_shape check (position('@' in email)>1),
  constraint waitlist_source_length check (length(source)<=100),
  constraint waitlist_utm_lengths check (length(coalesce(utm_source,''))<=100 and length(coalesce(utm_medium,''))<=100 and length(coalesce(utm_campaign,''))<=100)
);
create unique index if not exists waitlist_email_unique on public.turnline_waitlist(email_normalized);
create index if not exists waitlist_confirmed_idx on public.turnline_waitlist(confirmed_at) where unsubscribed_at is null;
alter table public.turnline_waitlist enable row level security;
alter table public.turnline_waitlist force row level security;
revoke all on schema marketing from public, anon, authenticated;
revoke all on all tables in schema marketing from public, anon, authenticated;
-- Only the Edge Function's service role uses this table. No end-user RLS policies.
grant usage on schema marketing to service_role;
grant select,insert,update on public.turnline_waitlist to service_role;
-- All subscriber exports must filter: confirmed_at is not null AND unsubscribed_at is null.
