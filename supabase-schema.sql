-- haloe — Supabase schema for the client intake flow.
-- Migrated from Cloudflare D1 (Aug 2026). Mirrors the old two-table model:
-- one client per person (upserted on email), one intake_forms row per submission.
--
-- Run this in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- Safe to re-run: uses IF NOT EXISTS and idempotent policy guards.

-- ------------------------------------------------------------------ --
-- clients — one row per person, matched on the unique email.
-- ------------------------------------------------------------------ --
create table if not exists public.clients (
  id            bigint generated always as identity primary key,
  full_name     text not null,
  email         text not null unique,          -- unique = target for the upsert
  phone         text,
  date_of_birth text,
  created_at    timestamptz not null default now()
);

-- ------------------------------------------------------------------ --
-- intake_forms — one row per submission, linked back to the client.
-- Text columns hold free-text / Yes-No answers; booleans hold the acks
-- and the five required consents.
-- ------------------------------------------------------------------ --
create table if not exists public.intake_forms (
  id                      bigint generated always as identity primary key,
  client_id               bigint not null references public.clients(id) on delete cascade,

  -- Step 1 — logistics
  area_postcode           text,
  package                 text,
  emergency_contact_name  text,
  emergency_contact_phone text,
  gp_name                 text,
  age_confirmed           text,

  -- Step 2 — general health
  has_conditions          text,
  medical_conditions      text,
  takes_medication        text,
  current_medications     text,
  has_allergies           text,
  allergies               text,
  had_hijama_before       text,
  main_concern            text,

  -- Step 3 — safety screen
  is_pregnant             text,
  breastfeeding           text,
  takes_blood_thinners    text,
  bleeding_disorder       text,
  diabetes_status         text,
  chemo_or_radiotherapy   text,
  has_anaemia             text,
  infectious_condition    text,
  recent_surgery          text,
  blood_pressure          text,
  skin_condition          text,
  pacemaker_epilepsy      text,
  safety_notes            text,

  -- Step 4 — acknowledgements & consents (booleans)
  before_after_ack        boolean not null default false,
  consent_accurate_info   boolean not null default false,
  consent_complementary   boolean not null default false,
  consent_treatment       boolean not null default false,
  consent_notify_changes  boolean not null default false,
  consent_data_storage    boolean not null default false,

  -- Step 5 — signature
  photo_consent           text,
  signature_name          text,
  signature_date          text,
  signature_path          text,   -- drawn signature, e.g. 'signatures/42.png' (private Storage bucket; see supabase-intake-signature.sql)

  created_at              timestamptz not null default now()
);

create index if not exists intake_forms_client_id_idx on public.intake_forms(client_id);

-- ------------------------------------------------------------------ --
-- Row Level Security — deny-all by default. No policies are created, so
-- the public anon / authenticated keys can read or write NOTHING. The
-- Cloudflare Function uses the service-role key, which bypasses RLS, so
-- inserts still work. This is what keeps client health data private.
-- ------------------------------------------------------------------ --
alter table public.clients      enable row level security;
alter table public.intake_forms enable row level security;

-- ------------------------------------------------------------------ --
-- Grant table privileges to service_role ONLY (the role the Cloudflare
-- Function's secret key maps to). This is required because the project
-- was created with "automatically expose new tables" OFF, so new tables
-- get no API-role grants by default. We deliberately do NOT grant anon /
-- authenticated — the public must never read client health data. The
-- service_role bypasses RLS, so these grants are what let the Function
-- write. Without them, inserts fail with "permission denied" (SQLSTATE 42501).
-- ------------------------------------------------------------------ --
grant select, insert, update, delete on public.clients      to service_role;
grant select, insert, update, delete on public.intake_forms to service_role;

-- "Modesty and care" consent (Oct 2026): required on every NEW intake submission; null on older rows (never backfilled).
-- consent_modesty_at is stamped by the Function (server time), not by the browser.
alter table public.intake_forms add column if not exists consent_modesty boolean;
alter table public.intake_forms add column if not exists consent_modesty_at timestamptz;

-- Added 6 Nov 2026: form types, risk flags and the intake failure log — see supabase-intake-types.sql.
