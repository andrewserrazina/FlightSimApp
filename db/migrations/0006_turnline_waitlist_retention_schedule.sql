create extension if not exists pg_cron;
select cron.schedule('turnline-waitlist-retention','15 3 * * *',$$select public.turnline_waitlist_retention_cleanup();$$);