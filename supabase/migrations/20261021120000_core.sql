-- Core: extensions, private schema, settings, secrets, helpers, profiles, admin check.
-- All business logic lives in Postgres and is exposed to the frontend through PostgREST
-- (tables protected by RLS + RPC functions in the "public" schema).

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_net;   -- async HTTP (schema "net"), used to send e-mails via Resend
create extension if not exists pg_cron;  -- schedules the e-mail queue worker

-- Private schema: never exposed through PostgREST.
create schema if not exists private;
revoke all on schema private from public;
revoke all on schema private from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Settings (single row). Values are set per environment by CI via private.configure().
-- ---------------------------------------------------------------------------
create table private.settings (
  id               boolean primary key default true check (id),
  site_url         text    not null default 'http://127.0.0.1:4173',
  admin_emails     text[]  not null default '{}',
  email_from       text    not null default 'Zdrówko za zdrowie <onboarding@resend.dev>',
  email_reply_to   text,
  timezone         text    not null default 'Europe/Warsaw',
  min_notice_hours integer not null default 12 check (min_notice_hours >= 0),
  max_pending_per_user integer not null default 3 check (max_pending_per_user > 0)
);
insert into private.settings default values;

create or replace function private.configure(
  p_site_url     text,
  p_admin_emails text[],
  p_email_from   text,
  p_reply_to     text default null
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update private.settings
     set site_url       = rtrim(p_site_url, '/'),
         admin_emails   = coalesce(
                            (select array_agg(distinct lower(trim(e)))
                               from unnest(p_admin_emails) as e
                              where trim(e) <> ''),
                            '{}'),
         email_from     = p_email_from,
         email_reply_to = nullif(trim(coalesce(p_reply_to, '')), '')
   where id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Secrets (Supabase Vault). CI stores the Resend API key with private.set_secret().
-- ---------------------------------------------------------------------------
create or replace function private.get_secret(p_name text) returns text
language sql
stable
security definer
set search_path = ''
as $$
  select ds.decrypted_secret from vault.decrypted_secrets ds where ds.name = p_name limit 1
$$;

create or replace function private.set_secret(p_name text, p_value text) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  select s.id into v_id from vault.secrets s where s.name = p_name;
  if v_id is null then
    perform vault.create_secret(p_value, p_name);
  else
    perform vault.update_secret(v_id, p_value);
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function private.h(p text) returns text
language sql
immutable
set search_path = ''
as $$
  select replace(replace(replace(replace(replace(coalesce(p, ''),
         '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'), '''', '&#39;')
$$;

create or replace function private.fmt_ts(p timestamptz) returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
           when p is null then 'termin do ustalenia'
           else (array['niedziela','poniedziałek','wtorek','środa','czwartek','piątek','sobota'])
                  [extract(dow from p at time zone s.timezone)::int + 1]
                || ', ' || to_char(p at time zone s.timezone, 'DD.MM.YYYY, "godz." HH24:MI')
         end
    from private.settings s
   where s.id
$$;

create or replace function private.touch_updated_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin check. Admins are users with a confirmed e-mail listed in settings.admin_emails.
-- Lives in "public" because RLS policies (evaluated as the caller) need to call it.
-- ---------------------------------------------------------------------------
create or replace function public.is_admin() returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from auth.users u
      cross join private.settings s
     where s.id
       and u.id = (select auth.uid())
       and u.email_confirmed_at is not null
       and lower(u.email) = any (s.admin_emails)
  )
$$;
revoke execute on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Profiles (1:1 with auth.users)
-- ---------------------------------------------------------------------------
create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text not null,
  full_name  text check (char_length(full_name) <= 200),
  phone      text check (char_length(phone) <= 40),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.profiles is 'Dane kontaktowe użytkownika. Tworzone automatycznie po rejestracji.';

create trigger profiles_touch before update on public.profiles
  for each row execute function private.touch_updated_at();

alter table public.profiles enable row level security;
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (full_name, phone) on public.profiles to authenticated;

create policy profiles_select on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or (select public.is_admin()));

create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

create or replace function private.handle_new_user() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    coalesce(new.email, ''),
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', '')), '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

create or replace function private.handle_user_email_change() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles set email = coalesce(new.email, '') where id = new.id;
  return new;
end;
$$;

create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row when (old.email is distinct from new.email)
  execute function private.handle_user_email_change();

-- ---------------------------------------------------------------------------
-- E-mail outbox. Mails are sent from Postgres through pg_net -> Resend API.
-- Without a "resend_api_key" secret (local dev, CI) mails are stored as "skipped".
-- ---------------------------------------------------------------------------
create table private.email_outbox (
  id              bigint generated always as identity primary key,
  to_email        text not null,
  subject         text not null,
  html            text not null,
  kind            text not null,
  appointment_id  uuid,
  status          text not null default 'queued'
                  check (status in ('queued', 'sending', 'sent', 'failed', 'skipped')),
  attempts        integer not null default 0,
  request_id      bigint,
  last_error      text,
  created_at      timestamptz not null default now(),
  last_attempt_at timestamptz,
  sent_at         timestamptz
);
create index email_outbox_status_idx on private.email_outbox (status) where status in ('queued', 'sending');

create or replace function private.dispatch_email(p_id bigint) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r     private.email_outbox;
  v_cfg private.settings;
  v_key text;
  v_req bigint;
begin
  select * into r from private.email_outbox where id = p_id for update;
  if not found or r.status in ('sent', 'skipped', 'failed') then
    return;
  end if;

  v_key := private.get_secret('resend_api_key');
  if coalesce(v_key, '') = '' then
    update private.email_outbox
       set status = 'skipped', last_error = 'Brak sekretu resend_api_key w Vault'
     where id = p_id;
    return;
  end if;

  select * into v_cfg from private.settings where id;

  v_req := net.http_post(
    url     := 'https://api.resend.com/emails',
    body    := jsonb_strip_nulls(jsonb_build_object(
                 'from',     v_cfg.email_from,
                 'to',       jsonb_build_array(r.to_email),
                 'subject',  r.subject,
                 'html',     r.html,
                 'reply_to', v_cfg.email_reply_to)),
    headers := jsonb_build_object(
                 'Authorization',   'Bearer ' || v_key,
                 'Content-Type',    'application/json',
                 'Idempotency-Key', 'outbox-' || r.id),
    timeout_milliseconds := 10000
  );

  update private.email_outbox
     set status = 'sending', attempts = attempts + 1, request_id = v_req, last_attempt_at = now()
   where id = p_id;
end;
$$;

create or replace function private.enqueue_email(
  p_to             text,
  p_subject        text,
  p_html           text,
  p_kind           text,
  p_appointment_id uuid default null
) returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  if coalesce(trim(p_to), '') = '' then
    return null;
  end if;
  insert into private.email_outbox (to_email, subject, html, kind, appointment_id)
  values (trim(p_to), p_subject, p_html, p_kind, p_appointment_id)
  returning id into v_id;
  perform private.dispatch_email(v_id);
  return v_id;
end;
$$;

-- Worker (pg_cron, every minute): reads pg_net responses, marks sent/failed, retries up to 5x.
create or replace function private.process_email_queue() returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  for r in
    select o.id, o.attempts, o.last_attempt_at,
           resp.id is not null as has_resp, resp.status_code, resp.timed_out, resp.error_msg,
           left(resp.content::text, 500) as content
      from private.email_outbox o
      left join net._http_response resp on resp.id = o.request_id
     where o.status = 'sending'
     for update of o skip locked
  loop
    if r.has_resp and r.status_code between 200 and 299 then
      update private.email_outbox set status = 'sent', sent_at = now(), last_error = null where id = r.id;
    elsif r.has_resp or r.last_attempt_at < now() - interval '15 minutes' then
      update private.email_outbox
         set last_error = coalesce(r.error_msg, 'HTTP ' || r.status_code || ': ' || r.content, 'Brak odpowiedzi'),
             status     = case when r.attempts >= 5 then 'failed' else 'queued' end
       where id = r.id;
    end if;
  end loop;

  for r in
    select o.id from private.email_outbox o
     where o.status = 'queued'
       and (o.last_attempt_at is null or o.last_attempt_at < now() - make_interval(mins => 2 * o.attempts))
     order by o.id
     limit 50
  loop
    perform private.dispatch_email(r.id);
  end loop;
end;
$$;

select cron.schedule('process-email-queue', '* * * * *', 'select private.process_email_queue()');
