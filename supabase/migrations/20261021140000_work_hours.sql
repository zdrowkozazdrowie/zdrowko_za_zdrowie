-- Working hours: the admin defines a weekly schedule and days off; bookable slots are generated from it
-- for the next booking_horizon_days (kept up to date daily by pg_cron and after every change).
-- Clients still book only free slots (public.get_free_slots), so nothing changes on their side.
-- One-off slots added by hand (admin_add_slots) keep working next to the generated ones.

alter table private.settings
  add column booking_horizon_days integer not null default 56 check (booking_horizon_days between 7 and 180);

alter table public.slots add column generated boolean not null default false;
comment on column public.slots.generated is 'Termin utworzony automatycznie z godzin pracy (work_hours).';

-- ---------------------------------------------------------------------------
-- Weekly schedule (ISO weekday: 1 = Monday … 7 = Sunday, local time of settings.timezone)
-- ---------------------------------------------------------------------------
create table public.work_hours (
  id        uuid primary key default gen_random_uuid(),
  weekday   smallint not null check (weekday between 1 and 7),
  starts_at time not null,
  ends_at   time not null,
  slot_min  integer not null default 60 check (slot_min between 10 and 480),
  break_min integer not null default 0 check (break_min between 0 and 240),
  constraint work_hours_range check (ends_at > starts_at)
);
create index work_hours_weekday_idx on public.work_hours (weekday, starts_at);

alter table public.work_hours enable row level security;
revoke all on public.work_hours from anon, authenticated;
grant select on public.work_hours to authenticated;
create policy work_hours_admin_select on public.work_hours
  for select to authenticated using ((select public.is_admin()));

-- ---------------------------------------------------------------------------
-- Days off / blocked hours (whole day when both times are null)
-- ---------------------------------------------------------------------------
create table public.time_off (
  id         uuid primary key default gen_random_uuid(),
  day        date not null,
  starts_at  time,
  ends_at    time,
  note       text check (char_length(note) <= 200),
  created_at timestamptz not null default now(),
  constraint time_off_range check (
    (starts_at is null and ends_at is null) or (starts_at is not null and ends_at is not null and ends_at > starts_at))
);
create index time_off_day_idx on public.time_off (day);

alter table public.time_off enable row level security;
revoke all on public.time_off from anon, authenticated;
grant select on public.time_off to authenticated;
create policy time_off_admin_select on public.time_off
  for select to authenticated using ((select public.is_admin()));

-- Local range [from, to) of a time_off row as timestamptz.
create or replace function private.time_off_range(t public.time_off, p_tz text) returns tstzrange
language sql
stable
set search_path = ''
as $$
  select tstzrange(
    (t.day + coalesce(t.starts_at, time '00:00')) at time zone p_tz,
    case when t.ends_at is null then (t.day + 1)::timestamp at time zone p_tz
         else (t.day + t.ends_at) at time zone p_tz end)
$$;

-- ---------------------------------------------------------------------------
-- Slot generation
-- ---------------------------------------------------------------------------
-- Slots the schedule wants within the horizon (future only, minus time off).
create or replace function private.wanted_slots()
returns table (starts_at timestamptz, ends_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  with cfg as (
    select s.timezone as tz, s.booking_horizon_days as horizon, (now() at time zone s.timezone)::date as today
      from private.settings s where s.id
  ), grid as (
    select ts at time zone cfg.tz as starts_at,
           (ts + make_interval(mins => r.slot_min)) at time zone cfg.tz as ends_at
      from cfg
     cross join generate_series(cfg.today, cfg.today + cfg.horizon, interval '1 day') as d(day)
      join public.work_hours r on r.weekday = extract(isodow from d.day)
     cross join lateral generate_series(
             d.day::date + r.starts_at,
             d.day::date + r.ends_at - make_interval(mins => r.slot_min),
             make_interval(mins => r.slot_min + r.break_min)) as ts
  )
  select g.starts_at, g.ends_at
    from grid g, cfg
   where g.starts_at > now()
     and not exists (select 1 from public.time_off t
                      where t.day >= cfg.today - 1
                        and private.time_off_range(t, cfg.tz) && tstzrange(g.starts_at, g.ends_at))
$$;

create or replace function private.sync_slots() returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tz    text;
  v_today date;
begin
  select timezone into v_tz from private.settings where id;
  v_today := (now() at time zone v_tz)::date;

  -- Remove free future slots that no longer fit the schedule (generated ones) or fall into time off (any).
  delete from public.slots s
   where s.starts_at > now()
     and not exists (select 1 from public.appointments a
                      where a.slot_id = s.id and a.status in ('pending', 'confirmed'))
     and (
       (s.generated and not exists (select 1 from private.wanted_slots() w
                                     where w.starts_at = s.starts_at and w.ends_at = s.ends_at))
       or exists (select 1 from public.time_off t
                   where t.day >= v_today - 1
                     and private.time_off_range(t, v_tz) && tstzrange(s.starts_at, s.ends_at)));

  -- Add missing ones (never overlapping an existing slot, e.g. a booked or hand-made one).
  insert into public.slots (starts_at, ends_at, generated)
  select w.starts_at, w.ends_at, true
    from private.wanted_slots() w
   where not exists (select 1 from public.slots s
                      where tstzrange(s.starts_at, s.ends_at) && tstzrange(w.starts_at, w.ends_at))
  on conflict (starts_at) do nothing;
end;
$$;

select cron.schedule('sync-slots', '15 2 * * *', 'select private.sync_slots()');

-- ---------------------------------------------------------------------------
-- Admin API
-- ---------------------------------------------------------------------------
create or replace function private.parse_rules(p_rules jsonb)
returns table (n bigint, weekday smallint, starts_at time, ends_at time)
language sql
immutable
set search_path = ''
as $$
  select r.n, (r.v ->> 'weekday')::smallint, (r.v ->> 'from')::time, (r.v ->> 'to')::time
    from jsonb_array_elements(p_rules) with ordinality as r(v, n)
$$;

-- Replaces the whole weekly schedule. p_rules: [{"weekday":1,"from":"09:00","to":"15:00"}, …]
create or replace function public.admin_set_work_hours(
  p_rules        jsonb,
  p_slot_min     integer default 60,
  p_break_min    integer default 0,
  p_horizon_days integer default null
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_free integer;
begin
  if not public.is_admin() then
    raise exception 'Brak uprawnień.' using errcode = '42501';
  end if;
  if p_rules is null or jsonb_typeof(p_rules) <> 'array' then
    raise exception 'Nieprawidłowe godziny pracy.' using errcode = '22023';
  end if;
  if coalesce(p_slot_min, 0) not between 10 and 480 or coalesce(p_break_min, 0) not between 0 and 240 then
    raise exception 'Nieprawidłowa długość wizyty lub przerwy.' using errcode = '22023';
  end if;

  begin
    perform (r ->> 'weekday')::smallint, (r ->> 'from')::time, (r ->> 'to')::time
       from jsonb_array_elements(p_rules) as r;
  exception when others then
    raise exception 'Nieprawidłowe godziny pracy.' using errcode = '22023';
  end;

  if exists (select 1 from private.parse_rules(p_rules)
              where weekday is null or weekday not between 1 and 7
                 or starts_at is null or ends_at is null or ends_at <= starts_at) then
    raise exception 'Godzina końca musi być późniejsza niż początku.' using errcode = '22023';
  end if;
  if exists (select 1 from private.parse_rules(p_rules) a join private.parse_rules(p_rules) b
                on a.weekday = b.weekday and a.n < b.n
               and a.starts_at < b.ends_at and b.starts_at < a.ends_at) then
    raise exception 'Przedziały godzin w jednym dniu nakładają się.' using errcode = '22023';
  end if;
  if exists (select 1 from private.parse_rules(p_rules) where ends_at - starts_at < make_interval(mins => p_slot_min)) then
    raise exception 'Przedział jest krótszy niż jedna wizyta.' using errcode = '22023';
  end if;

  delete from public.work_hours where true;
  insert into public.work_hours (weekday, starts_at, ends_at, slot_min, break_min)
  select weekday, starts_at, ends_at, p_slot_min, coalesce(p_break_min, 0) from private.parse_rules(p_rules);
  if p_horizon_days is not null then
    update private.settings set booking_horizon_days = p_horizon_days where id;
  end if;

  perform private.sync_slots();
  select count(*) into v_free from public.get_free_slots();
  return v_free;
end;
$$;

create or replace function public.admin_add_time_off(
  p_day  date,
  p_from time default null,
  p_to   time default null,
  p_note text default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not public.is_admin() then
    raise exception 'Brak uprawnień.' using errcode = '42501';
  end if;
  if (p_from is null) <> (p_to is null) or p_to <= p_from then
    raise exception 'Podaj godziny od–do albo zaznacz cały dzień.' using errcode = '22023';
  end if;
  insert into public.time_off (day, starts_at, ends_at, note)
  values (p_day, p_from, p_to, nullif(left(trim(coalesce(p_note, '')), 200), ''))
  returning id into v_id;
  perform private.sync_slots();
  return v_id;
end;
$$;

create or replace function public.admin_delete_time_off(p_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Brak uprawnień.' using errcode = '42501';
  end if;
  delete from public.time_off where id = p_id;
  perform private.sync_slots();
end;
$$;

-- Deleting a generated slot blocks its hours, otherwise the next sync would bring it back.
create or replace function public.admin_delete_slot(p_id uuid) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_s  public.slots;
  v_tz text;
begin
  if not public.is_admin() then
    raise exception 'Brak uprawnień.' using errcode = '42501';
  end if;
  if exists (select 1 from public.appointments a where a.slot_id = p_id and a.status in ('pending', 'confirmed')) then
    raise exception 'Ten termin jest zarezerwowany. Najpierw odwołaj wizytę.' using errcode = 'P0001';
  end if;
  select * into v_s from public.slots where id = p_id;
  if v_s.generated then
    select timezone into v_tz from private.settings where id;
    insert into public.time_off (day, starts_at, ends_at, note)
    values ((v_s.starts_at at time zone v_tz)::date, (v_s.starts_at at time zone v_tz)::time,
            (v_s.ends_at at time zone v_tz)::time, 'Usunięty termin');
  end if;
  delete from public.slots where id = p_id;
end;
$$;

create or replace function public.admin_booking_settings() returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Brak uprawnień.' using errcode = '42501';
  end if;
  return (select jsonb_build_object('horizon_days', s.booking_horizon_days, 'min_notice_hours', s.min_notice_hours,
                                    'timezone', s.timezone)
            from private.settings s where s.id);
end;
$$;

-- Admin database browser: include the new tables.
create or replace function public.admin_db_tables()
returns table (name text, label text, row_count bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Brak uprawnień.' using errcode = '42501';
  end if;
  return query
    select t.name, t.label, t.cnt
      from (values
        ('profiles',       'Klienci (profile)',  (select count(*) from public.profiles)),
        ('appointments',   'Wizyty',             (select count(*) from public.appointments)),
        ('questionnaires', 'Kwestionariusze',    (select count(*) from public.questionnaires)),
        ('slots',          'Terminy',            (select count(*) from public.slots)),
        ('work_hours',     'Godziny pracy',      (select count(*) from public.work_hours)),
        ('time_off',       'Dni wolne',          (select count(*) from public.time_off)),
        ('services',       'Usługi',             (select count(*) from public.services)),
        ('email_outbox',   'Wysłane e-maile',    (select count(*) from private.email_outbox))
      ) as t(name, label, cnt);
end;
$$;

create or replace function public.admin_db_rows(
  p_table  text,
  p_limit  integer default 50,
  p_offset integer default 0,
  p_search text default null
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_source text;
  v_order  text;
  v_rows   jsonb;
  v_total  bigint;
  v_limit  integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_like   text := '%' || coalesce(nullif(trim(p_search), ''), '') || '%';
begin
  if not public.is_admin() then
    raise exception 'Brak uprawnień.' using errcode = '42501';
  end if;

  case p_table
    when 'profiles'       then v_source := 'select * from public.profiles';                v_order := 'created_at desc';
    when 'appointments'   then v_source := 'select * from public.appointments';            v_order := 'created_at desc';
    when 'questionnaires' then v_source := 'select * from public.questionnaires';          v_order := 'updated_at desc';
    when 'slots'          then v_source := 'select * from public.slots';                   v_order := 'starts_at desc';
    when 'work_hours'     then v_source := 'select * from public.work_hours';              v_order := 'weekday, starts_at';
    when 'time_off'       then v_source := 'select * from public.time_off';                v_order := 'day desc';
    when 'services'       then v_source := 'select * from public.services';                v_order := 'sort';
    when 'email_outbox'   then
      v_source := 'select id, to_email, subject, kind, appointment_id, status, attempts, last_error, created_at, last_attempt_at, sent_at from private.email_outbox';
      v_order  := 'id desc';
    else
      raise exception 'Nieznana tabela.' using errcode = '22023';
  end case;

  execute format(
    'with src as (%s), hit as (select * from src s where $1 = ''%%%%'' or to_jsonb(s)::text ilike $1)
     select (select count(*) from hit),
            coalesce((select jsonb_agg(to_jsonb(h) - ''_rn'' order by h._rn)
                        from (select *, row_number() over (order by %s) as _rn from hit) h
                       where h._rn > $3 and h._rn <= $3 + $2), ''[]''::jsonb)',
    v_source, v_order)
    into v_total, v_rows
    using v_like, v_limit, v_offset;

  return jsonb_build_object('total', v_total, 'rows', v_rows, 'limit', v_limit, 'offset', v_offset);
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke execute on function public.admin_set_work_hours(jsonb, integer, integer, integer) from public, anon;
revoke execute on function public.admin_add_time_off(date, time, time, text) from public, anon;
revoke execute on function public.admin_delete_time_off(uuid) from public, anon;
revoke execute on function public.admin_booking_settings() from public, anon;
grant execute on function public.admin_set_work_hours(jsonb, integer, integer, integer) to authenticated;
grant execute on function public.admin_add_time_off(date, time, time, text) to authenticated;
grant execute on function public.admin_delete_time_off(uuid) to authenticated;
grant execute on function public.admin_booking_settings() to authenticated;
