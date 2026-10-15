-- Turnline waitlist intake limits and data retention. Staging only.
create table if not exists public.turnline_waitlist_rate_limits (
  bucket text not null,
  window_start timestamptz not null,
  attempts integer not null check (attempts >= 1),
  primary key (bucket,window_start)
);
alter table public.turnline_waitlist_rate_limits enable row level security;
alter table public.turnline_waitlist_rate_limits force row level security;
revoke all on public.turnline_waitlist_rate_limits from public,anon,authenticated;
grant select,insert,update,delete on public.turnline_waitlist_rate_limits to service_role;

create or replace function public.turnline_waitlist_check_limit(p_bucket text,p_limit integer)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_count integer;
begin
 if length(p_bucket) < 10 or length(p_bucket) > 180 or p_limit < 1 or p_limit > 10000 then
   raise exception 'invalid rate limit parameters';
 end if;
 insert into public.turnline_waitlist_rate_limits(bucket,window_start,attempts)
 values(p_bucket,date_trunc('hour',now()),1)
 on conflict(bucket,window_start) do update
   set attempts=public.turnline_waitlist_rate_limits.attempts+1
 returning attempts into v_count;
 return v_count <= p_limit;
end $$;
revoke all on function public.turnline_waitlist_check_limit(text,integer) from public,anon,authenticated;
grant execute on function public.turnline_waitlist_check_limit(text,integer) to service_role;

create or replace function public.turnline_waitlist_retention_cleanup()
returns void language plpgsql security invoker set search_path = '' as $$
begin
 delete from public.turnline_waitlist
 where (confirmed_at is null and updated_at < now()-interval '30 days')
    or (unsubscribed_at is not null and unsubscribed_at < now()-interval '30 days')
    or (confirmed_at is not null and unsubscribed_at is null and updated_at < now()-interval '24 months');
 delete from public.turnline_waitlist_rate_limits where window_start < now()-interval '2 days';
end $$;
revoke all on function public.turnline_waitlist_retention_cleanup() from public,anon,authenticated;
grant execute on function public.turnline_waitlist_retention_cleanup() to service_role;
