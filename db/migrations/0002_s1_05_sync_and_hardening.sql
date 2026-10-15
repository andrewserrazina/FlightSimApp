-- FlightSimApp S1-05: cloud sync schema + access-control hardening on top of 0001_baseline_schema.sql.
-- REVIEW before deploying. Tested only against the local stack in infra/supabase-local.
-- Never apply to production without review. Idempotent where practical.
--
-- Access model (pilot-first, single owner per flight):
--   * Every user-owned row carries the owner's auth.uid(); clients can never choose another owner.
--   * Completed flights and their events/interruptions are immutable for clients (append-only sync).
--   * Owners may delete their own flights (cascade) — needed for account data deletion.
--   * Anonymous clients get no privileges on private tables at all (defence in depth on top of RLS).
--   * Future airline-wide access will be added as additional, explicit policies; none exist yet.

-- ---------------------------------------------------------------------------------------------
-- 1. Flights: columns for recorded desktop flights
-- ---------------------------------------------------------------------------------------------
alter table public.flights
  add column if not exists completion text check (completion in ('arrival_confirmed','landing_confirmed','user_confirmed_without_evidence')),
  add column if not exists simulator text check (simulator in ('mock','msfs2020','msfs2024')),
  add column if not exists simulator_version text check (char_length(simulator_version) <= 64),
  add column if not exists aircraft_title text check (char_length(aircraft_title) <= 256),
  add column if not exists aircraft_icao text check (char_length(aircraft_icao) <= 8),
  add column if not exists started_at_utc timestamptz,
  add column if not exists ended_at_utc timestamptz,
  add column if not exists airborne_seconds numeric(10,1) check (airborne_seconds >= 0),
  add column if not exists started_airborne boolean,
  add column if not exists source text not null default 'cloud' check (source in ('cloud','desktop_recorder')),
  add column if not exists client_schema_version integer check (client_schema_version > 0),
  add column if not exists received_at timestamptz not null default now();

create index if not exists flights_pilot_ended_idx on public.flights (pilot_user_id, ended_at_utc desc);

-- Identity columns can never change after insert (no ownership transfer, no id rewrite).
create or replace function public.flights_guard_identity() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.id is distinct from old.id or new.pilot_user_id is distinct from old.pilot_user_id
     or new.created_at is distinct from old.created_at or new.received_at is distinct from old.received_at
     or new.source is distinct from old.source then
    raise exception 'flight identity fields are immutable' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists flights_guard_identity on public.flights;
create trigger flights_guard_identity before update on public.flights
  for each row execute function public.flights_guard_identity();
revoke all on function public.flights_guard_identity() from public, anon, authenticated;

-- Replace 0001's flight policies with explicit per-operation policies.
drop policy if exists flights_read_self on public.flights;
drop policy if exists flights_create_self on public.flights;
drop policy if exists flights_update_self on public.flights;
drop policy if exists flights_select_own on public.flights;
drop policy if exists flights_insert_own on public.flights;
drop policy if exists flights_update_own_open on public.flights;
drop policy if exists flights_delete_own on public.flights;

create policy flights_select_own on public.flights for select to authenticated
  using (pilot_user_id = (select auth.uid()));
-- Owner is forced to the caller; airline/aircraft references must be system-managed rows only.
create policy flights_insert_own on public.flights for insert to authenticated
  with check (
    pilot_user_id = (select auth.uid())
    and (airline_id is null or exists (select 1 from public.airlines a where a.id = airline_id and a.is_system))
    and (aircraft_id is null or exists (select 1 from public.aircraft c join public.airlines a on a.id = c.airline_id where c.id = aircraft_id and a.is_system))
    and (schedule_id is null or exists (select 1 from public.flight_schedules s join public.airlines a on a.id = s.airline_id where s.id = schedule_id and a.is_system))
  );
-- Only still-open cloud flights (future planning features) may be updated; terminal flights are immutable.
create policy flights_update_own_open on public.flights for update to authenticated
  using (pilot_user_id = (select auth.uid()) and source = 'cloud' and status not in ('completed','cancelled','aborted','diverted'))
  with check (pilot_user_id = (select auth.uid()) and source = 'cloud');
create policy flights_delete_own on public.flights for delete to authenticated
  using (pilot_user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------------------------
-- 2. Flight events: append-only lifecycle events from the desktop recorder
-- ---------------------------------------------------------------------------------------------
alter table public.flight_events
  add column if not exists flight_seq integer check (flight_seq > 0),
  add column if not exists from_phase text check (char_length(from_phase) <= 32),
  add column if not exists to_phase text check (char_length(to_phase) <= 32),
  add column if not exists lifecycle_source text check (lifecycle_source in ('detected','user','system'));
create unique index if not exists flight_events_flight_seq_uq on public.flight_events (flight_id, flight_seq);

drop policy if exists events_read_self on public.flight_events;
drop policy if exists events_select_own on public.flight_events;
drop policy if exists events_insert_own on public.flight_events;
create policy events_select_own on public.flight_events for select to authenticated
  using (exists (select 1 from public.flights f where f.id = flight_id and f.pilot_user_id = (select auth.uid())));
-- The parent flight AND any referenced simulator session must belong to the caller: no FK path to
-- attach rows to someone else's flight or session.
create policy events_insert_own on public.flight_events for insert to authenticated
  with check (
    exists (select 1 from public.flights f where f.id = flight_id and f.pilot_user_id = (select auth.uid()))
    and (simulator_session_id is null or exists (select 1 from public.simulator_sessions s where s.id = simulator_session_id and s.user_id = (select auth.uid())))
  );
-- No UPDATE/DELETE policies: events are append-only for clients (rows go away only with their flight).

-- ---------------------------------------------------------------------------------------------
-- 3. Flight interruptions (new)
-- ---------------------------------------------------------------------------------------------
create table if not exists public.flight_interruptions (
  flight_id uuid not null references public.flights(id) on delete cascade,
  started_at timestamptz not null,
  ended_at timestamptz,
  cause text not null check (cause in ('app_closed','bridge_lost','simulator_disconnected','telemetry_stale')),
  resolution text check (resolution in ('auto_resumed','user_resumed','flight_ended')),
  received_at timestamptz not null default now(),
  primary key (flight_id, started_at),
  check (ended_at is null or ended_at >= started_at)
);
alter table public.flight_interruptions enable row level security;
drop policy if exists interruptions_select_own on public.flight_interruptions;
drop policy if exists interruptions_insert_own on public.flight_interruptions;
create policy interruptions_select_own on public.flight_interruptions for select to authenticated
  using (exists (select 1 from public.flights f where f.id = flight_id and f.pilot_user_id = (select auth.uid())));
create policy interruptions_insert_own on public.flight_interruptions for insert to authenticated
  with check (exists (select 1 from public.flights f where f.id = flight_id and f.pilot_user_id = (select auth.uid())));

-- ---------------------------------------------------------------------------------------------
-- 4. Privileges: explicit grants instead of relying on platform defaults
-- ---------------------------------------------------------------------------------------------
revoke all on public.flights, public.flight_events, public.flight_interruptions, public.simulator_sessions,
  public.profiles, public.dispatch_releases, public.passenger_manifests, public.turnaround_tasks,
  public.operational_restrictions, public.flight_debriefs, public.billing_customers, public.subscriptions,
  public.billing_webhook_receipts, public.airline_memberships
  from anon;
revoke all on public.flights, public.flight_events, public.flight_interruptions from authenticated;
grant select, insert, delete on public.flights to authenticated;
grant update (status, actual_off_block_utc, actual_takeoff_utc, actual_landing_utc, actual_on_block_utc, updated_at, flight_number, departure_icao, destination_icao, planned_off_block_utc)
  on public.flights to authenticated;
grant select, insert on public.flight_events to authenticated;
grant select, insert on public.flight_interruptions to authenticated;
-- Billing records are written only by the server-side (service role) webhook handler.
revoke insert, update, delete on public.billing_customers, public.subscriptions, public.billing_webhook_receipts from authenticated;

-- ---------------------------------------------------------------------------------------------
-- 5. Profiles: created by the server when an account is created (not by clients)
-- ---------------------------------------------------------------------------------------------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.profiles (user_id) values (new.id) on conflict (user_id) do nothing;
  return new;
end $$;
revoke all on function public.handle_new_user() from public, anon, authenticated;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();
drop policy if exists profile_delete_self on public.profiles;
create policy profile_delete_self on public.profiles for delete to authenticated using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------------------------
-- 6. Sync RPC: one atomic, idempotent upload of a completed flight. SECURITY INVOKER: every
--    statement runs under the caller's RLS policies; it adds validation, not privilege.
-- ---------------------------------------------------------------------------------------------
create or replace function public.sync_completed_flight(p_flight jsonb, p_events jsonb, p_interruptions jsonb)
returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
  v_inserted boolean;
  v_events int;
  v_interruptions int;
begin
  if v_uid is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if jsonb_typeof(p_flight) <> 'object' or jsonb_typeof(p_events) <> 'array' or jsonb_typeof(p_interruptions) <> 'array' then
    raise exception 'invalid payload shape' using errcode = '22023';
  end if;
  if jsonb_array_length(p_events) > 2000 or jsonb_array_length(p_interruptions) > 200 then
    raise exception 'payload too large' using errcode = '54000';
  end if;
  if p_flight->>'status' is distinct from 'completed' then
    raise exception 'only completed flights can be synchronised' using errcode = '22023';
  end if;
  v_id := (p_flight->>'id')::uuid;

  insert into public.flights (id, pilot_user_id, status, completion, simulator, simulator_version, aircraft_title, aircraft_icao,
    departure_icao, destination_icao, started_at_utc, ended_at_utc, actual_takeoff_utc, actual_landing_utc,
    airborne_seconds, started_airborne, source, client_schema_version)
  values (v_id, v_uid, 'completed', p_flight->>'completion', p_flight->>'simulator', p_flight->>'simulator_version',
    p_flight->>'aircraft_title', p_flight->>'aircraft_icao', p_flight->>'origin_icao', p_flight->>'destination_icao',
    (p_flight->>'started_at_utc')::timestamptz, (p_flight->>'ended_at_utc')::timestamptz,
    (p_flight->>'takeoff_at_utc')::timestamptz, (p_flight->>'landing_at_utc')::timestamptz,
    (p_flight->>'airborne_seconds')::numeric, (p_flight->>'started_airborne')::boolean, 'desktop_recorder',
    coalesce((p_flight->>'client_schema_version')::int, 1))
  on conflict (id) do nothing
  returning true into v_inserted;

  -- If the id already exists but is not visible to this caller, it belongs to someone else:
  -- refuse without revealing anything about it.
  if not exists (select 1 from public.flights where id = v_id) then
    raise exception 'flight id is not available' using errcode = '42501';
  end if;

  insert into public.flight_events (id, flight_id, event_type, schema_version, occurred_at, flight_seq, source, source_kind,
    lifecycle_source, from_phase, to_phase, payload, quality)
  select (e->>'event_id')::uuid, v_id, e->>'kind', 1, (e->>'occurred_at_utc')::timestamptz, (e->>'seq')::int,
    'flightsim-desktop', case e->>'source' when 'user' then 'user' when 'detected' then 'inferred' else 'observed' end,
    e->>'source', e->>'from_phase', e->>'to_phase', coalesce(e->'details', '{}'::jsonb), '{}'::jsonb
  from jsonb_array_elements(p_events) e
  on conflict do nothing;

  insert into public.flight_interruptions (flight_id, started_at, ended_at, cause, resolution)
  select v_id, (i->>'started_at_utc')::timestamptz, (i->>'ended_at_utc')::timestamptz, i->>'cause', i->>'resolution'
  from jsonb_array_elements(p_interruptions) i
  on conflict do nothing;

  select count(*) into v_events from public.flight_events where flight_id = v_id;
  select count(*) into v_interruptions from public.flight_interruptions where flight_id = v_id;
  return jsonb_build_object('flight_id', v_id, 'created', coalesce(v_inserted, false), 'event_count', v_events, 'interruption_count', v_interruptions);
end $$;
revoke all on function public.sync_completed_flight(jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.sync_completed_flight(jsonb, jsonb, jsonb) to authenticated;

-- Read-only verification view: what the cloud holds for each of the caller's flights.
create or replace view public.flight_sync_status with (security_invoker = true) as
  select f.id as flight_id, f.received_at,
    (select count(*) from public.flight_events e where e.flight_id = f.id) as event_count,
    (select count(*) from public.flight_interruptions i where i.flight_id = f.id) as interruption_count
  from public.flights f;
revoke all on public.flight_sync_status from anon;
grant select on public.flight_sync_status to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 7. Entitlements (read-only for clients; server-authoritative; no billing logic here)
-- ---------------------------------------------------------------------------------------------
create or replace view public.my_entitlements with (security_invoker = true) as
  select s.user_id, s.plan_code, s.status, s.current_period_end
  from public.subscriptions s;
revoke all on public.my_entitlements from anon;
grant select on public.my_entitlements to authenticated;
