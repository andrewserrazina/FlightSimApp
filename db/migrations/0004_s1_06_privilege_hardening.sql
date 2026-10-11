-- S1-06: defence-in-depth privilege hardening (found by the generic catalog test).
-- Supabase's default privileges give anon/authenticated TRUNCATE, REFERENCES and TRIGGER on every
-- public table. TRUNCATE is NOT subject to row-level security. PostgREST never issues it, so it is not
-- reachable through the API today, but no client role should hold it. Idempotent; forward-only.

revoke truncate, references, trigger on all tables in schema public from anon, authenticated;

-- Future tables created by the migration role do not get them either.
alter default privileges in schema public revoke truncate, references, trigger on tables from anon, authenticated;

-- Tables with RLS and no client policies are server-only: grant clients nothing at all.
revoke all on public.airline_memberships, public.billing_webhook_receipts from anon, authenticated;
