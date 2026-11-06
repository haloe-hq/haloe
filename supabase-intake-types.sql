-- Intake form types, risk flags and a failure log (6 Nov 2026).
-- Safe to run more than once. Run in the Supabase SQL editor.
--
-- The form works WITHOUT this (intake-submit.js falls back to the classic columns and notes the form type in them), but
-- until it is run the form type, the extra answers and the risk flags are not stored as such, and failures are not logged.

alter table public.intake_forms add column if not exists form_type text not null default 'hijama';
alter table public.intake_forms add column if not exists answers jsonb;
alter table public.intake_forms add column if not exists risk_flags text[];

-- A trace of every failed submission: what went wrong, when, on what kind of device. Never answers or health details.
create table if not exists public.intake_errors (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  stage       text,        -- 'client' (the page could not send) or 'server' (the Function refused it / hit an error)
  status      integer,     -- HTTP status, 0 = no connection
  message     text,        -- short and scrubbed of emails/numbers
  form_type   text,
  user_agent  text
);
alter table public.intake_errors enable row level security;
-- No policy for anon/authenticated: only the service-role key (the Function) writes. The practitioner can read it:
drop policy if exists admin_read_intake_errors on public.intake_errors;
create policy admin_read_intake_errors on public.intake_errors for select to authenticated using (public.is_admin());
