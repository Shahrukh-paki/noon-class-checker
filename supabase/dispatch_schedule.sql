-- Starts the GitHub checker on time from Supabase (pg_cron + pg_net), instead of GitHub's own
-- timer, which started runs 6-9 hours late. Times are UTC (Pakistan = UTC+5).
--
-- BEFORE running this file, store the GitHub token once (SQL editor, your own token in the quotes):
--   select vault.create_secret('github_pat_...', 'github_checker_dispatch_token');
-- To replace it later:
--   select vault.update_secret((select id from vault.secrets where name = 'github_checker_dispatch_token'), 'github_pat_...');

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

create or replace function public.dispatch_class_checker(p_mode text, p_run_until text default null)
returns bigint
language sql
security definer
set search_path = public, extensions
as $$
  select net.http_post(
    url := 'https://api.github.com/repos/Shahrukh-paki/noon-class-checker/actions/workflows/check.yml/dispatches',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'github_checker_dispatch_token' limit 1),
      'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28',
      'User-Agent', 'nts-class-checker',
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object(
      'ref', 'main',
      'inputs', jsonb_build_object('mode', p_mode, 'run_until_pkt', coalesce(p_run_until, ''), 'max_minutes', '345')
    )
  );
$$;

-- Only the database itself (pg_cron) may call it; not the app's anon/authenticated users.
revoke execute on function public.dispatch_class_checker(text, text) from public, anon, authenticated;

-- Re-running this file replaces the jobs instead of adding duplicates.
select cron.unschedule(jobname) from cron.job
 where jobname in ('class-checker-am', 'class-checker-pm', 'class-checker-keepalive');

-- Mon-Fri 07:35 PKT: check until 13:15 PKT (covers Summer and Winter Shift 1-2).
select cron.schedule('class-checker-am', '35 2 * * 1-5', $$select public.dispatch_class_checker('check', '13:15')$$);
-- Mon-Fri 13:15 PKT: check until 18:20 PKT (covers Shift 2-3).
select cron.schedule('class-checker-pm', '15 8 * * 1-5', $$select public.dispatch_class_checker('check', '18:20')$$);
-- Every 2 hours, every day (weekends too): renew the Noon sign-in so it never expires.
select cron.schedule('class-checker-keepalive', '10 */2 * * *', $$select public.dispatch_class_checker('keepalive')$$);

-- Check afterwards:
--   select jobname, schedule, active from cron.job where jobname like 'class-checker%';
--   select id, status_code, left(content::text, 200) from net._http_response order by id desc limit 5;  -- 204 = GitHub accepted
