-- Booking: services, slots, appointments and their RPC API.

-- ---------------------------------------------------------------------------
-- Services (offer)
-- ---------------------------------------------------------------------------
create table public.services (
  id            text primary key check (id ~ '^[a-z0-9-]+$'),
  name          text not null,
  description   text,
  price_pln     numeric(8, 2) not null default 0 check (price_pln >= 0),
  duration_min  integer check (duration_min > 0),
  requires_slot boolean not null default true,
  sort          integer not null default 0,
  active        boolean not null default true
);

alter table public.services enable row level security;
revoke all on public.services from anon, authenticated;
grant select on public.services to anon, authenticated;
create policy services_select on public.services
  for select to anon, authenticated
  using (active or (select public.is_admin()));

insert into public.services (id, name, description, price_pln, duration_min, requires_slot, sort) values
  ('pierwsza-konsultacja',    'Pierwsza konsultacja',            'Szczegółowy wywiad zdrowotny i żywieniowy, omówienie celów i zalecenia.', 0,    60,   true,  10),
  ('wizyta-kontrolna',        'Wizyta kontrolna',                'Podsumowanie postępów i modyfikacja zaleceń.',                           50,   40,   true,  20),
  ('analiza-jadlospisu',      'Analiza jadłospisu',              'Ocena dzienniczka żywieniowego z pisemnymi wskazówkami (bez wizyty).',  150,  null, false, 30),
  ('konsultacja-jadlospis-7', 'Konsultacja + jadłospis 7 dni',   'Konsultacja, jadłospis na 7 dni, lista zakupów i przepisy.',            350,  60,   true,  40),
  ('pakiet-miesieczny',       'Pakiet miesięczny',               'Konsultacja, jadłospis na 14 dni, wizyta kontrolna i kontakt mailowy.', 550,  60,   true,  50),
  ('pakiet-3-miesieczny',     'Pakiet 3-miesięczny',             '3 jadłospisy po 14 dni, 3 wizyty kontrolne, stały kontakt mailowy.',    1400, 60,   true,  60)
on conflict (id) do update
  set name = excluded.name, description = excluded.description, price_pln = excluded.price_pln,
      duration_min = excluded.duration_min, requires_slot = excluded.requires_slot, sort = excluded.sort;

-- ---------------------------------------------------------------------------
-- Slots (time windows the dietitian offers)
-- ---------------------------------------------------------------------------
create table public.slots (
  id         uuid primary key default gen_random_uuid(),
  starts_at  timestamptz not null unique,
  ends_at    timestamptz not null,
  created_at timestamptz not null default now(),
  constraint slots_range check (ends_at > starts_at)
);

alter table public.slots enable row level security;
revoke all on public.slots from anon, authenticated;
grant select on public.slots to authenticated;
create policy slots_admin_select on public.slots
  for select to authenticated
  using ((select public.is_admin()));

-- ---------------------------------------------------------------------------
-- Appointments
-- ---------------------------------------------------------------------------
create type public.appointment_status as enum ('pending', 'confirmed', 'rejected', 'cancelled', 'completed');
-- TODO(payments): wire a payment gateway (e.g. Przelewy24 / Stripe). The webhook should call
-- private.mark_paid(); create_payment_session will live next to book_appointment().
create type public.payment_status as enum ('not_required', 'unpaid', 'paid', 'refunded');

create table public.appointments (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles (id) on delete cascade,
  service_id        text not null references public.services (id),
  slot_id           uuid references public.slots (id) on delete set null,
  starts_at         timestamptz,
  ends_at           timestamptz,
  mode              text not null default 'online' check (mode in ('online', 'telefon')),
  client_note       text check (char_length(client_note) <= 2000),
  status            public.appointment_status not null default 'pending',
  admin_message     text check (char_length(admin_message) <= 2000),
  decided_at        timestamptz,
  cancelled_at      timestamptz,
  cancelled_by      text check (cancelled_by in ('client', 'admin')),
  price_pln         numeric(8, 2) not null default 0,
  payment_status    public.payment_status not null default 'not_required',
  payment_provider  text,
  payment_reference text,
  paid_at           timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create unique index appointments_one_active_per_slot
  on public.appointments (slot_id) where status in ('pending', 'confirmed');
create index appointments_user_idx on public.appointments (user_id, created_at desc);
create index appointments_starts_idx on public.appointments (starts_at);

create trigger appointments_touch before update on public.appointments
  for each row execute function private.touch_updated_at();

alter table public.appointments enable row level security;
revoke all on public.appointments from anon, authenticated;
grant select on public.appointments to authenticated;
create policy appointments_select on public.appointments
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

-- One-time decision token sent to the admin by e-mail (never readable through the API).
create table private.appointment_tokens (
  token          text primary key default encode(extensions.gen_random_bytes(24), 'hex'),
  appointment_id uuid not null unique references public.appointments (id) on delete cascade,
  created_at     timestamptz not null default now(),
  used_at        timestamptz
);

-- ---------------------------------------------------------------------------
-- RPC: free slots (public)
-- ---------------------------------------------------------------------------
create or replace function public.get_free_slots(p_from timestamptz default null, p_to timestamptz default null)
returns table (id uuid, starts_at timestamptz, ends_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.starts_at, s.ends_at
    from public.slots s
   cross join private.settings cfg
   where cfg.id
     and s.starts_at >= greatest(coalesce(p_from, now()), now() + make_interval(hours => cfg.min_notice_hours))
     and s.starts_at <  coalesce(p_to, now() + interval '120 days')
     and not exists (
       select 1 from public.appointments a
        where a.slot_id = s.id and a.status in ('pending', 'confirmed'))
   order by s.starts_at
$$;

-- ---------------------------------------------------------------------------
-- RPC: book an appointment (signed-in users)
-- ---------------------------------------------------------------------------
create or replace function public.book_appointment(
  p_service_id text,
  p_slot_id    uuid default null,
  p_mode       text default 'online',
  p_note       text default null,
  p_full_name  text default null,
  p_phone      text default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_cfg     private.settings;
  v_service public.services;
  v_slot    public.slots;
  v_id      uuid;
begin
  if v_uid is null then
    raise exception 'Zaloguj się, aby umówić wizytę.' using errcode = '42501';
  end if;

  select * into v_cfg from private.settings where id;

  select * into v_service from public.services where id = p_service_id and active;
  if not found then
    raise exception 'Nie znaleziono wybranej usługi.' using errcode = 'P0002';
  end if;

  if coalesce(p_mode, '') not in ('online', 'telefon') then
    raise exception 'Nieprawidłowa forma wizyty.' using errcode = '22023';
  end if;

  if (select count(*) from public.appointments a where a.user_id = v_uid and a.status = 'pending')
       >= v_cfg.max_pending_per_user then
    raise exception 'Masz już % rezerwacje czekające na potwierdzenie.', v_cfg.max_pending_per_user
      using errcode = 'P0001';
  end if;

  if v_service.requires_slot then
    if p_slot_id is null then
      raise exception 'Wybierz termin wizyty.' using errcode = '22023';
    end if;
    select * into v_slot from public.slots where id = p_slot_id for update;
    if not found then
      raise exception 'Wybrany termin nie istnieje.' using errcode = 'P0002';
    end if;
    if v_slot.starts_at < now() + make_interval(hours => v_cfg.min_notice_hours) then
      raise exception 'Ten termin jest już niedostępny.' using errcode = 'P0001';
    end if;
    if exists (select 1 from public.appointments a
                where a.slot_id = v_slot.id and a.status in ('pending', 'confirmed')) then
      raise exception 'Ten termin został właśnie zarezerwowany. Wybierz inny.' using errcode = 'P0001';
    end if;
  end if;

  -- Make sure a profile exists and keep contact data fresh.
  insert into public.profiles (id, email)
  select u.id, coalesce(u.email, '') from auth.users u where u.id = v_uid
  on conflict (id) do nothing;

  update public.profiles
     set full_name = coalesce(nullif(trim(p_full_name), ''), full_name),
         phone     = coalesce(nullif(trim(p_phone), ''), phone)
   where id = v_uid;

  if (select nullif(trim(coalesce(full_name, '')), '') from public.profiles where id = v_uid) is null then
    raise exception 'Podaj imię i nazwisko.' using errcode = '22023';
  end if;

  insert into public.appointments
    (user_id, service_id, slot_id, starts_at, ends_at, mode, client_note, price_pln, payment_status)
  values
    (v_uid, v_service.id, v_slot.id, v_slot.starts_at, v_slot.ends_at, p_mode,
     nullif(left(trim(coalesce(p_note, '')), 2000), ''), v_service.price_pln,
     case when v_service.price_pln > 0 then 'unpaid' else 'not_required' end::public.payment_status)
  returning id into v_id;

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: client cancels own appointment
-- ---------------------------------------------------------------------------
create or replace function public.cancel_my_appointment(p_id uuid) returns public.appointment_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_a public.appointments;
begin
  select * into v_a from public.appointments where id = p_id and user_id = auth.uid() for update;
  if not found then
    raise exception 'Nie znaleziono wizyty.' using errcode = 'P0002';
  end if;
  if v_a.status not in ('pending', 'confirmed') then
    raise exception 'Tej wizyty nie można już odwołać.' using errcode = 'P0001';
  end if;
  if v_a.starts_at is not null and v_a.starts_at <= now() then
    raise exception 'Wizyta już się rozpoczęła.' using errcode = 'P0001';
  end if;
  update public.appointments
     set status = 'cancelled', cancelled_at = now(), cancelled_by = 'client'
   where id = p_id;
  return 'cancelled';
end;
$$;

-- ---------------------------------------------------------------------------
-- Decisions (admin): via e-mail token or via the admin panel
-- ---------------------------------------------------------------------------
create or replace function private.apply_decision(p_id uuid, p_decision text, p_message text)
returns public.appointment_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_a      public.appointments;
  v_status public.appointment_status;
begin
  select * into v_a from public.appointments where id = p_id for update;
  if not found then
    raise exception 'Nie znaleziono wizyty.' using errcode = 'P0002';
  end if;
  if v_a.status <> 'pending' then
    raise exception 'Ta rezerwacja została już obsłużona (status: %).', v_a.status using errcode = 'P0001';
  end if;
  v_status := case p_decision when 'confirm' then 'confirmed' when 'reject' then 'rejected' end;
  if v_status is null then
    raise exception 'Nieznana decyzja.' using errcode = '22023';
  end if;
  update public.appointments
     set status = v_status, decided_at = now(),
         admin_message = nullif(left(trim(coalesce(p_message, '')), 2000), '')
   where id = p_id;
  update private.appointment_tokens set used_at = now() where appointment_id = p_id and used_at is null;
  return v_status;
end;
$$;

create or replace function public.get_appointment_by_token(p_token text)
returns table (
  id           uuid,
  status       public.appointment_status,
  service_name text,
  price_pln    numeric,
  starts_at    timestamptz,
  ends_at      timestamptz,
  mode         text,
  client_note  text,
  client_name  text,
  client_email text,
  client_phone text,
  created_at   timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select a.id, a.status, s.name, a.price_pln, a.starts_at, a.ends_at, a.mode, a.client_note,
         p.full_name, p.email, p.phone, a.created_at
    from private.appointment_tokens t
    join public.appointments a on a.id = t.appointment_id
    join public.services s on s.id = a.service_id
    join public.profiles p on p.id = a.user_id
   where t.token = p_token
$$;

create or replace function public.decide_appointment(p_token text, p_decision text, p_message text default null)
returns public.appointment_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  select t.appointment_id into v_id from private.appointment_tokens t where t.token = p_token;
  if v_id is null then
    raise exception 'Link jest nieprawidłowy lub wygasł.' using errcode = 'P0002';
  end if;
  return private.apply_decision(v_id, p_decision, p_message);
end;
$$;

create or replace function public.admin_set_status(
  p_id      uuid,
  p_status  public.appointment_status,
  p_message text default null
) returns public.appointment_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_a public.appointments;
begin
  if not public.is_admin() then
    raise exception 'Brak uprawnień.' using errcode = '42501';
  end if;
  select * into v_a from public.appointments where id = p_id for update;
  if not found then
    raise exception 'Nie znaleziono wizyty.' using errcode = 'P0002';
  end if;

  if v_a.status = 'pending' and p_status in ('confirmed', 'rejected') then
    return private.apply_decision(p_id, case p_status when 'confirmed' then 'confirm' else 'reject' end, p_message);
  elsif v_a.status in ('pending', 'confirmed') and p_status = 'cancelled' then
    update public.appointments
       set status = 'cancelled', cancelled_at = now(), cancelled_by = 'admin',
           admin_message = coalesce(nullif(left(trim(coalesce(p_message, '')), 2000), ''), admin_message)
     where id = p_id;
  elsif v_a.status = 'confirmed' and p_status = 'completed' then
    update public.appointments set status = 'completed' where id = p_id;
  else
    raise exception 'Nie można zmienić statusu z % na %.', v_a.status, p_status using errcode = 'P0001';
  end if;
  return p_status;
end;
$$;

-- ---------------------------------------------------------------------------
-- Slot management (admin)
-- ---------------------------------------------------------------------------
create or replace function public.admin_add_slots(
  p_day          date,
  p_from         time,
  p_to           time,
  p_duration_min integer default 60,
  p_break_min    integer default 0
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tz    text;
  v_ts    timestamp;
  v_until timestamp;
  v_start timestamptz;
  v_end   timestamptz;
  v_count integer := 0;
begin
  if not public.is_admin() then
    raise exception 'Brak uprawnień.' using errcode = '42501';
  end if;
  if p_duration_min not between 10 and 480 or coalesce(p_break_min, 0) not between 0 and 240 then
    raise exception 'Nieprawidłowa długość wizyty lub przerwy.' using errcode = '22023';
  end if;
  if p_to <= p_from then
    raise exception 'Godzina końca musi być późniejsza niż początku.' using errcode = '22023';
  end if;

  select timezone into v_tz from private.settings where id;
  if p_day < (now() at time zone v_tz)::date then
    raise exception 'Nie można dodawać terminów w przeszłości.' using errcode = '22023';
  end if;

  v_ts    := p_day + p_from;
  v_until := p_day + p_to;
  while v_ts + make_interval(mins => p_duration_min) <= v_until loop
    v_start := v_ts at time zone v_tz;
    v_end   := (v_ts + make_interval(mins => p_duration_min)) at time zone v_tz;
    if v_start > now() and not exists (
         select 1 from public.slots s
          where tstzrange(s.starts_at, s.ends_at) && tstzrange(v_start, v_end)) then
      insert into public.slots (starts_at, ends_at) values (v_start, v_end);
      v_count := v_count + 1;
    end if;
    v_ts := v_ts + make_interval(mins => p_duration_min + coalesce(p_break_min, 0));
  end loop;
  return v_count;
end;
$$;

create or replace function public.admin_delete_slot(p_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Brak uprawnień.' using errcode = '42501';
  end if;
  if exists (select 1 from public.appointments a where a.slot_id = p_id and a.status in ('pending', 'confirmed')) then
    raise exception 'Ten termin jest zarezerwowany. Najpierw odwołaj wizytę.' using errcode = 'P0001';
  end if;
  delete from public.slots where id = p_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Payments (TODO): called by a future payment webhook handler.
-- ---------------------------------------------------------------------------
create or replace function private.mark_paid(p_id uuid, p_provider text, p_reference text) returns void
language sql
security definer
set search_path = ''
as $$
  update public.appointments
     set payment_status = 'paid', payment_provider = p_provider, payment_reference = p_reference, paid_at = now()
   where id = p_id and payment_status = 'unpaid'
$$;

-- ---------------------------------------------------------------------------
-- Function privileges (PostgREST exposes only what anon/authenticated may execute)
-- ---------------------------------------------------------------------------
revoke execute on function public.get_free_slots(timestamptz, timestamptz) from public;
revoke execute on function public.book_appointment(text, uuid, text, text, text, text) from public;
revoke execute on function public.cancel_my_appointment(uuid) from public;
revoke execute on function public.get_appointment_by_token(text) from public;
revoke execute on function public.decide_appointment(text, text, text) from public;
revoke execute on function public.admin_set_status(uuid, public.appointment_status, text) from public;
revoke execute on function public.admin_add_slots(date, time, time, integer, integer) from public;
revoke execute on function public.admin_delete_slot(uuid) from public;

revoke execute on function public.book_appointment(text, uuid, text, text, text, text) from anon;
revoke execute on function public.cancel_my_appointment(uuid) from anon;
revoke execute on function public.admin_set_status(uuid, public.appointment_status, text) from anon;
revoke execute on function public.admin_add_slots(date, time, time, integer, integer) from anon;
revoke execute on function public.admin_delete_slot(uuid) from anon;

grant execute on function public.get_free_slots(timestamptz, timestamptz) to anon, authenticated;
grant execute on function public.get_appointment_by_token(text) to anon, authenticated;
grant execute on function public.decide_appointment(text, text, text) to anon, authenticated;
grant execute on function public.book_appointment(text, uuid, text, text, text, text) to authenticated;
grant execute on function public.cancel_my_appointment(uuid) to authenticated;
grant execute on function public.admin_set_status(uuid, public.appointment_status, text) to authenticated;
grant execute on function public.admin_add_slots(date, time, time, integer, integer) to authenticated;
grant execute on function public.admin_delete_slot(uuid) to authenticated;
