-- ============================================================================
-- Punctuality Tracker — Supabase schema
-- Replaces Firebase Firestore collections + rules + indexes + Cloud Functions.
-- Run in: Supabase Dashboard → SQL Editor (or `supabase db push`).
-- ============================================================================

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- 1. profiles  (was Firestore collection `users`, doc id = uid)
--    One row per auth user; created automatically by the trigger below.
-- ----------------------------------------------------------------------------
create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  name       text not null,
  email      text not null,
  role       text not null default 'employee' check (role in ('employee', 'admin')),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- Auto-create the profile on signup. The app passes the name via
-- signUp(options.data.full_name) → raw_user_meta_data.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, name, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1), 'Employee'),
    new.email
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ----------------------------------------------------------------------------
-- 2. qr_codes  (was Firestore collection `qrCodes`)
-- ----------------------------------------------------------------------------
create table if not exists public.qr_codes (
  id          uuid primary key default gen_random_uuid(),
  code        text not null,
  status      text not null default 'active' check (status in ('active', 'revoked')),
  active_from timestamptz not null default now(),
  revoked_at  timestamptz,
  revoked_by  uuid references auth.users (id) on delete set null,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now()
);

create unique index if not exists qr_codes_code_key on public.qr_codes (code);
create index if not exists qr_codes_status_active_idx on public.qr_codes (status, active_from desc);

-- ----------------------------------------------------------------------------
-- 3. app_settings  (was Firestore document settings/currentQr)
--    One JSONB row per key.
-- ----------------------------------------------------------------------------
create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 4. attendance  (was Firestore collection `attendance`)
-- ----------------------------------------------------------------------------
create table if not exists public.attendance (
  id                  uuid primary key default gen_random_uuid(),
  employee_id         uuid not null references auth.users (id) on delete cascade,
  employee_name       text not null,
  employee_email      text not null,
  action              text not null check (action in ('arrive', 'leave')),
  qr_id               uuid references public.qr_codes (id) on delete set null,
  scanned_code        text not null,
  local_scanned_at    timestamptz not null,
  server_received_at  timestamptz not null default now(),
  queued_offline      boolean not null default false,
  status              text not null default 'accepted',
  device_info         jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now()
);

-- Mirrors firestore.indexes.json
create index if not exists attendance_employee_time_idx on public.attendance (employee_id, local_scanned_at desc);
create index if not exists attendance_received_idx on public.attendance (server_received_at desc);
create index if not exists attendance_employee_action_received_idx on public.attendance (employee_id, action, server_received_at desc);

-- ----------------------------------------------------------------------------
-- 5. Row Level Security  (replaces firestore.rules)
-- ----------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.qr_codes enable row level security;
alter table public.app_settings enable row level security;
alter table public.attendance enable row level security;

-- SECURITY DEFINER helper so admin checks do not recurse into RLS.
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

grant execute on function public.is_admin() to anon, authenticated;

-- profiles: own row, or admin reads everything
drop policy if exists "profiles_select_own_or_admin" on public.profiles;
create policy "profiles_select_own_or_admin" on public.profiles
  for select using (auth.uid() = id or public.is_admin());

-- profiles: a user can only ever self-create an employee/active row with their own email
drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own" on public.profiles
  for insert with check (
    auth.uid() = id
    and role = 'employee'
    and active = true
    and email = coalesce(auth.jwt() ->> 'email', '')
  );

-- profiles: users may edit their own row, but cannot self-promote / self-deactivate
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id)
  with check (auth.uid() = id and role = 'employee' and active = true);

-- profiles: admins may update anyone (role changes are made as admin / via SQL editor)
drop policy if exists "profiles_update_admin" on public.profiles;
create policy "profiles_update_admin" on public.profiles
  for update using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "profiles_delete_admin" on public.profiles;
create policy "profiles_delete_admin" on public.profiles
  for delete using (public.is_admin());

-- attendance: employees read their own rows, admins read all; nobody writes directly
drop policy if exists "attendance_select_own_or_admin" on public.attendance;
create policy "attendance_select_own_or_admin" on public.attendance
  for select using (public.is_admin() or auth.uid() = employee_id);

-- qr_codes: admin read only (writes happen only inside regenerate_qr())
drop policy if exists "qr_codes_select_admin" on public.qr_codes;
create policy "qr_codes_select_admin" on public.qr_codes
  for select using (public.is_admin());

-- app_settings: admin read only (written only by regenerate_qr())
drop policy if exists "app_settings_select_admin" on public.app_settings;
create policy "app_settings_select_admin" on public.app_settings
  for select using (public.is_admin());

-- ----------------------------------------------------------------------------
-- 6. RPC functions  (replace Firebase Cloud Functions, incl. admin checks)
-- ----------------------------------------------------------------------------

-- regenerate_qr(): admin only. Revokes the current QR and issues a new one.
create or replace function public.regenerate_qr()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_current jsonb;
  v_new_code text;
  v_new_qr_id uuid;
  v_now timestamptz := now();
begin
  if v_uid is null then
    raise exception 'Authentication required.';
  end if;

  select * into v_profile from public.profiles where id = v_uid;
  if not found then
    raise exception 'User profile not found.';
  end if;

  if v_profile.role <> 'admin' then
    raise exception 'Admin access required.';
  end if;

  v_new_code := 'ATT-' || upper(encode(gen_random_bytes(8), 'hex'));

  select value into v_current from public.app_settings where key = 'currentQr';

  if v_current is not null and v_current ->> 'qrId' is not null then
    update public.qr_codes
       set status = 'revoked', revoked_at = v_now, revoked_by = v_uid
     where id = (v_current ->> 'qrId')::uuid
       and status = 'active';
  end if;

  insert into public.qr_codes (code, status, active_from, revoked_at, revoked_by, created_by)
  values (v_new_code, 'active', v_now, null, null, v_uid)
  returning id into v_new_qr_id;

  insert into public.app_settings (key, value, updated_at)
  values (
    'currentQr',
    jsonb_build_object('qrId', v_new_qr_id, 'code', v_new_code, 'generatedAt', v_now, 'generatedBy', v_uid),
    v_now
  )
  on conflict (key) do update
    set value = excluded.value, updated_at = excluded.updated_at;

  return jsonb_build_object('success', true, 'code', v_new_code, 'generatedAt', v_now);
end;
$$;

-- submit_attendance(): all validation that used to live in the Cloud Function.
create or replace function public.submit_attendance(
  p_scanned_code text,
  p_action text,
  p_local_scanned_at timestamptz,
  p_device_info jsonb default '{}'::jsonb,
  p_queued_offline boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_qr public.qr_codes%rowtype;
  v_last public.attendance%rowtype;
  v_now timestamptz := now();
  v_attendance_id uuid;
begin
  if v_uid is null then
    raise exception 'Authentication required.';
  end if;

  if p_scanned_code is null or btrim(p_scanned_code) = '' then
    raise exception 'scannedCode is required.';
  end if;

  if p_action not in ('arrive', 'leave') then
    raise exception 'action must be arrive or leave.';
  end if;

  if p_local_scanned_at is null then
    raise exception 'Invalid date format.';
  end if;

  select * into v_profile from public.profiles where id = v_uid;
  if not found then
    raise exception 'User profile not found.';
  end if;

  if v_profile.active = false then
    raise exception 'User is inactive.';
  end if;

  select * into v_qr from public.qr_codes where code = p_scanned_code limit 1;
  if not found then
    raise exception 'QR code is invalid.';
  end if;

  if v_qr.status <> 'active'
     or p_local_scanned_at < v_qr.active_from
     or (v_qr.revoked_at is not null and p_local_scanned_at > v_qr.revoked_at) then
    raise exception 'QR code was not valid at the claimed scan time.';
  end if;

  select * into v_last
    from public.attendance
   where employee_id = v_uid and action = p_action
   order by server_received_at desc
   limit 1;

  if found then
    if abs(extract(epoch from (p_local_scanned_at - coalesce(v_last.local_scanned_at, v_last.server_received_at)))) < 120 then
      raise exception 'Duplicate scan detected within 2 minutes.';
    end if;
  end if;

  insert into public.attendance (
    employee_id, employee_name, employee_email, action, qr_id, scanned_code,
    local_scanned_at, server_received_at, queued_offline, status, device_info
  ) values (
    v_uid, v_profile.name, v_profile.email, p_action, v_qr.id, p_scanned_code,
    p_local_scanned_at, v_now, coalesce(p_queued_offline, false), 'accepted',
    coalesce(p_device_info, '{}'::jsonb)
  )
  returning id into v_attendance_id;

  return jsonb_build_object(
    'success', true,
    'attendanceId', v_attendance_id,
    'action', p_action,
    'localScannedAt', p_local_scanned_at,
    'serverReceivedAt', v_now,
    'queuedOffline', coalesce(p_queued_offline, false)
  );
end;
$$;

grant execute on function public.regenerate_qr() to authenticated;
grant execute on function public.submit_attendance(text, text, timestamptz, jsonb, boolean) to authenticated;

-- Privileges: anon/authenticated get table access and RLS decides; service_role bypasses RLS.
grant usage on schema public to anon, authenticated;
grant all on all tables in schema public to anon, authenticated;
grant all on all sequences in schema public to anon, authenticated;

-- ----------------------------------------------------------------------------
-- 7. Realtime  (replaces Firestore onSnapshot)
--    Postgres Changes only delivers rows the subscriber's RLS SELECT allows.
--    If this DO block prints a notice, enable Realtime for `attendance` and
--    `app_settings` in Dashboard → Database → Replication (and add via SQL
--    `alter publication supabase_realtime add table ...`).
-- ----------------------------------------------------------------------------
do $$
begin
  begin
    alter publication supabase_realtime add table public.attendance;
  exception when duplicate_object then null; end;

  begin
    alter publication supabase_realtime add table public.app_settings;
  exception when duplicate_object then null; end;

exception when undefined_object then
  raise notice 'supabase_realtime publication does not exist — enable Realtime in Dashboard → Database → Replication';
end $$;
