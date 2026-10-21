-- Admin dashboard API: clients overview, e-mail log and a read-only database browser.
-- Every function checks public.is_admin(); none of them is executable by anon.

create or replace function public.admin_clients()
returns table (
  id                    uuid,
  email                 text,
  full_name             text,
  phone                 text,
  created_at            timestamptz,
  appointments_total    bigint,
  appointments_upcoming bigint,
  last_visit_at         timestamptz,
  next_visit_at         timestamptz,
  questionnaires_sent   bigint
)
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
    select p.id, p.email, p.full_name, p.phone, p.created_at,
           count(a.id),
           count(a.id) filter (where a.status in ('pending', 'confirmed') and (a.starts_at is null or a.starts_at > now())),
           max(a.starts_at) filter (where a.status in ('confirmed', 'completed') and a.starts_at <= now()),
           min(a.starts_at) filter (where a.status in ('pending', 'confirmed') and a.starts_at > now()),
           (select count(*) from public.questionnaires q where q.user_id = p.id and q.submitted_at is not null)
      from public.profiles p
      left join public.appointments a on a.user_id = p.id
     group by p.id
     order by coalesce(min(a.starts_at) filter (where a.status in ('pending', 'confirmed') and a.starts_at > now()),
                       'infinity'::timestamptz),
              p.created_at desc;
end;
$$;

create or replace function public.admin_email_log(p_limit integer default 100)
returns table (
  id             bigint,
  to_email       text,
  subject        text,
  kind           text,
  appointment_id uuid,
  status         text,
  attempts       integer,
  last_error     text,
  created_at     timestamptz,
  sent_at        timestamptz
)
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
    select o.id, o.to_email, o.subject, o.kind, o.appointment_id, o.status, o.attempts, o.last_error,
           o.created_at, o.sent_at
      from private.email_outbox o
     order by o.id desc
     limit least(greatest(coalesce(p_limit, 100), 1), 500);
end;
$$;

-- Read-only database browser. Only whitelisted tables; e-mail bodies are not exposed.
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

revoke execute on function public.admin_clients() from public, anon;
revoke execute on function public.admin_email_log(integer) from public, anon;
revoke execute on function public.admin_db_tables() from public, anon;
revoke execute on function public.admin_db_rows(text, integer, integer, text) from public, anon;
grant execute on function public.admin_clients() to authenticated;
grant execute on function public.admin_email_log(integer) to authenticated;
grant execute on function public.admin_db_tables() to authenticated;
grant execute on function public.admin_db_rows(text, integer, integer, text) to authenticated;
