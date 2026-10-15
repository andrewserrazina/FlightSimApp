-- FlightSimApp v0.1 baseline schema for Supabase PostgreSQL.
-- REVIEW before deploying. Apply in controlled migration; do not run against production unreviewed.
-- Auth users are managed by Supabase auth.users.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.airlines (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  is_system boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.airline_memberships (
  airline_id uuid not null references public.airlines(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('pilot','dispatcher','admin')),
  created_at timestamptz not null default now(),
  primary key (airline_id, user_id)
);

create table if not exists public.aircraft (
  id uuid primary key default gen_random_uuid(),
  airline_id uuid references public.airlines(id) on delete set null,
  registration text,
  aircraft_type text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.flight_schedules (
  id uuid primary key default gen_random_uuid(),
  airline_id uuid references public.airlines(id) on delete cascade,
  flight_number text not null,
  departure_icao char(4) not null,
  arrival_icao char(4) not null,
  scheduled_off_block_utc timestamptz,
  scheduled_on_block_utc timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.flights (
  id uuid primary key default gen_random_uuid(),
  pilot_user_id uuid not null references auth.users(id) on delete cascade,
  airline_id uuid references public.airlines(id) on delete set null,
  aircraft_id uuid references public.aircraft(id) on delete set null,
  schedule_id uuid references public.flight_schedules(id) on delete set null,
  flight_number text,
  departure_icao char(4),
  destination_icao char(4),
  status text not null default 'planned' check (status in ('planned','preparing','boarding','ready','taxi_out','airborne','approach','landed','taxi_in','completed','cancelled','aborted','diverted')),
  planned_off_block_utc timestamptz,
  actual_off_block_utc timestamptz,
  actual_takeoff_utc timestamptz,
  actual_landing_utc timestamptz,
  actual_on_block_utc timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists flights_pilot_date_idx on public.flights(pilot_user_id, created_at desc);

create table if not exists public.simulator_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  flight_id uuid references public.flights(id) on delete set null,
  simulator text not null check (simulator in ('msfs2020','msfs2024','mock')),
  connection_state text not null default 'disconnected',
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  last_seq bigint not null default 0,
  created_at timestamptz not null default now(),
  unique (id, user_id)
);
create index if not exists simulator_sessions_flight_idx on public.simulator_sessions(flight_id);

create table if not exists public.flight_events (
  id uuid primary key,
  flight_id uuid not null references public.flights(id) on delete cascade,
  simulator_session_id uuid references public.simulator_sessions(id) on delete set null,
  event_type text not null,
  schema_version integer not null check (schema_version > 0),
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  session_seq bigint,
  source text not null,
  source_kind text not null check (source_kind in ('observed','inferred','simulated','authoritative','user')),
  payload jsonb not null default '{}'::jsonb,
  quality jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (simulator_session_id, session_seq)
);
create index if not exists flight_events_flight_time_idx on public.flight_events(flight_id, occurred_at);

create table if not exists public.dispatch_releases (
  id uuid primary key default gen_random_uuid(),
  flight_id uuid not null references public.flights(id) on delete cascade,
  revision integer not null check (revision > 0),
  source text not null,
  source_reference text,
  released_at timestamptz,
  ofp jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (flight_id, revision)
);

create table if not exists public.passenger_manifests (
  id uuid primary key default gen_random_uuid(),
  flight_id uuid not null unique references public.flights(id) on delete cascade,
  passenger_count integer not null check (passenger_count >= 0),
  bag_count integer check (bag_count >= 0),
  cargo_weight_kg numeric(12,2) check (cargo_weight_kg >= 0),
  synthetic_data boolean not null default true,
  manifest_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.turnaround_tasks (
  id uuid primary key default gen_random_uuid(),
  flight_id uuid not null references public.flights(id) on delete cascade,
  task_kind text not null,
  provider text not null default 'internal',
  state text not null check (state in ('pending','active','done','blocked','cancelled')),
  target_end_utc timestamptz,
  actual_end_utc timestamptz,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.operational_restrictions (
  id uuid primary key default gen_random_uuid(),
  flight_id uuid not null references public.flights(id) on delete cascade,
  restriction_type text not null check (restriction_type in ('tobt','tsat','ctot','edct','other')),
  effective_time_utc timestamptz,
  jurisdiction text not null check (jurisdiction in ('faa','eurocontrol','other','simulated')),
  source_kind text not null check (source_kind in ('simulated','authoritative','user')),
  source_name text not null,
  source_reference text,
  valid_from timestamptz,
  valid_to timestamptz,
  reason text,
  created_at timestamptz not null default now(),
  check (source_kind <> 'authoritative' or source_reference is not null)
);

create table if not exists public.flight_debriefs (
  id uuid primary key default gen_random_uuid(),
  flight_id uuid not null unique references public.flights(id) on delete cascade,
  schema_version integer not null default 1,
  metrics jsonb not null default '{}'::jsonb,
  observations jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

-- Billing projections must only be written by trusted backend service credentials.
create table if not exists public.billing_customers (
  user_id uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id text unique not null,
  created_at timestamptz not null default now()
);
create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider_subscription_id text not null unique,
  plan_code text not null,
  status text not null,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  updated_at timestamptz not null default now()
);
create index if not exists subscriptions_user_idx on public.subscriptions(user_id);
create table if not exists public.billing_webhook_receipts (
  provider_event_id text primary key,
  event_type text not null,
  processed_at timestamptz not null default now()
);

-- RLS: pilot-scoped resources. Service-role jobs must enforce equivalent ownership invariants.
alter table public.profiles enable row level security;
alter table public.airlines enable row level security;
alter table public.airline_memberships enable row level security;
alter table public.aircraft enable row level security;
alter table public.flight_schedules enable row level security;
alter table public.flights enable row level security;
alter table public.simulator_sessions enable row level security;
alter table public.flight_events enable row level security;
alter table public.dispatch_releases enable row level security;
alter table public.passenger_manifests enable row level security;
alter table public.turnaround_tasks enable row level security;
alter table public.operational_restrictions enable row level security;
alter table public.flight_debriefs enable row level security;
alter table public.billing_customers enable row level security;
alter table public.subscriptions enable row level security;
alter table public.billing_webhook_receipts enable row level security;

create policy profile_select_self on public.profiles for select to authenticated using (user_id = (select auth.uid()));
create policy profile_insert_self on public.profiles for insert to authenticated with check (user_id = (select auth.uid()));
create policy profile_update_self on public.profiles for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- System-managed airline entities are read-only to clients for pilot-first release.
create policy airline_read_system on public.airlines for select to authenticated using (is_system = true);
create policy aircraft_read_system on public.aircraft for select to authenticated using (airline_id in (select id from public.airlines where is_system = true));
create policy schedules_read_system on public.flight_schedules for select to authenticated using (airline_id in (select id from public.airlines where is_system = true));
-- No client policies for airline_memberships yet (future admin service only).

create policy flights_read_self on public.flights for select to authenticated using (pilot_user_id = (select auth.uid()));
create policy flights_create_self on public.flights for insert to authenticated with check (pilot_user_id = (select auth.uid()));
create policy flights_update_self on public.flights for update to authenticated using (pilot_user_id = (select auth.uid())) with check (pilot_user_id = (select auth.uid()));
create policy sessions_read_self on public.simulator_sessions for select to authenticated using (user_id = (select auth.uid()));
create policy sessions_create_self on public.simulator_sessions for insert to authenticated with check (user_id = (select auth.uid()) and (flight_id is null or exists (select 1 from public.flights f where f.id = flight_id and f.pilot_user_id = (select auth.uid()))));
create policy sessions_update_self on public.simulator_sessions for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()) and (flight_id is null or exists (select 1 from public.flights f where f.id = flight_id and f.pilot_user_id = (select auth.uid()))));

-- Child tables: client may read own flight data. Writes should go through ownership-validating API,
-- not arbitrary client mutations of simulation/event/billing integrity records.
create policy events_read_self on public.flight_events for select to authenticated using (exists (select 1 from public.flights f where f.id = flight_id and f.pilot_user_id = (select auth.uid())));
create policy dispatch_read_self on public.dispatch_releases for select to authenticated using (exists (select 1 from public.flights f where f.id = flight_id and f.pilot_user_id = (select auth.uid())));
create policy manifests_read_self on public.passenger_manifests for select to authenticated using (exists (select 1 from public.flights f where f.id = flight_id and f.pilot_user_id = (select auth.uid())));
create policy turnaround_read_self on public.turnaround_tasks for select to authenticated using (exists (select 1 from public.flights f where f.id = flight_id and f.pilot_user_id = (select auth.uid())));
create policy restrictions_read_self on public.operational_restrictions for select to authenticated using (exists (select 1 from public.flights f where f.id = flight_id and f.pilot_user_id = (select auth.uid())));
create policy debrief_read_self on public.flight_debriefs for select to authenticated using (exists (select 1 from public.flights f where f.id = flight_id and f.pilot_user_id = (select auth.uid())));
create policy billing_customer_read_self on public.billing_customers for select to authenticated using (user_id = (select auth.uid()));
create policy subscription_read_self on public.subscriptions for select to authenticated using (user_id = (select auth.uid()));
-- No authenticated user write policies for billing tables or webhook receipts.

-- Hardening before production: privileges/RLS review, service endpoints with owner validation,
-- referenced-airline access constraints for flights and aircraft, append-only release/events,
-- child/session ownership invariant for service writes, data retention and deletion policy,
-- migration/idempotency execution framework, and security integration tests.
