-- S1-07: privilege verification for the complete public schema (run after all migrations, as postgres).
-- Fails (ERROR) on the first violated rule. Used by the cloud-integration CI job and
-- docs/security/database-privileges.md. Read-only except for a rolled-back probe table.
\set ON_ERROR_STOP on

-- 1. No client role holds TRUNCATE / REFERENCES / TRIGGER on any public relation (TRUNCATE bypasses RLS).
do $$
declare bad text;
begin
  select string_agg(format('%s:%s:%s', c.relname, r.rolname, p.priv), ', ') into bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  cross join (values ('anon'), ('authenticated')) r(rolname)
  cross join (values ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) p(priv)
  where c.relkind in ('r', 'v', 'm', 'p', 'f') and has_table_privilege(r.rolname, c.oid, p.priv);
  if bad is not null then raise exception 'client roles hold dangerous privileges: %', bad; end if;
end $$;

-- 2. Every public table has row-level security enabled.
do $$
declare bad text;
begin
  select string_agg(c.relname, ', ') into bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  where c.relkind in ('r', 'p') and not c.relrowsecurity;
  if bad is not null then raise exception 'tables without RLS: %', bad; end if;
end $$;

-- 3. Server-only tables: no client privileges at all.
do $$
declare bad text;
begin
  select string_agg(format('%s:%s:%s', t, r, p), ', ') into bad
  from unnest(array['airline_memberships', 'billing_webhook_receipts', 'turnline_waitlist']) t
  cross join unnest(array['anon', 'authenticated']) r
  cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
  where has_table_privilege(r, format('public.%I', t), p);
  if bad is not null then raise exception 'server-only tables reachable by clients: %', bad; end if;
end $$;

-- 4. The intended service roles keep what they need: service_role (edge functions, future webhooks)
--    has full DML on every public table; postgres owns every public relation (migrations).
do $$
declare bad text;
begin
  select string_agg(format('%s:%s', c.relname, p), ', ') into bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p
  where c.relkind in ('r', 'p') and not has_table_privilege('service_role', c.oid, p);
  if bad is not null then raise exception 'service_role lacks: %', bad; end if;
  select string_agg(c.relname || ' owned by ' || pg_get_userbyid(c.relowner), ', ') into bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  where c.relkind in ('r', 'v', 'm', 'p') and pg_get_userbyid(c.relowner) <> 'postgres';
  if bad is not null then raise exception 'unexpected owners: %', bad; end if;
end $$;

-- 5. The privileges the desktop app relies on are still there (sync, entitlements, catalog).
do $$
declare bad text;
begin
  select string_agg(format('%s:%s', t, p), ', ') into bad
  from (values ('flights', 'SELECT'), ('flights', 'INSERT'), ('flights', 'DELETE'),
               ('flight_events', 'SELECT'), ('flight_events', 'INSERT'),
               ('flight_interruptions', 'SELECT'), ('flight_interruptions', 'INSERT'),
               ('profiles', 'SELECT'), ('profiles', 'UPDATE'),
               ('flight_sync_status', 'SELECT'), ('my_entitlements', 'SELECT'), ('subscriptions', 'SELECT'),
               ('airlines', 'SELECT'), ('aircraft', 'SELECT'), ('flight_schedules', 'SELECT')) x(t, p)
  where not has_table_privilege('authenticated', format('public.%I', t), p);
  if bad is not null then raise exception 'authenticated lost required privileges: %', bad; end if;
  if not has_function_privilege('authenticated', 'public.sync_completed_flight(jsonb, jsonb, jsonb)', 'EXECUTE') then
    raise exception 'authenticated cannot execute sync_completed_flight';
  end if;
end $$;

-- 6. Future tables created by the migration role (postgres) get no TRUNCATE/REFERENCES/TRIGGER for clients.
begin;
create table public.__privilege_probe (id int);
do $$
begin
  if has_table_privilege('anon', 'public.__privilege_probe', 'TRUNCATE')
     or has_table_privilege('authenticated', 'public.__privilege_probe', 'TRUNCATE')
     or has_table_privilege('authenticated', 'public.__privilege_probe', 'TRIGGER')
     or has_table_privilege('authenticated', 'public.__privilege_probe', 'REFERENCES') then
    raise exception 'default privileges still grant TRUNCATE/TRIGGER/REFERENCES on new tables';
  end if;
end $$;
rollback;

select 'privileges verified' as result;
