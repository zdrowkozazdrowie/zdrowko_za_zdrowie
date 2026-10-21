-- Questionnaire links. The admin sends a secret link by any channel (SMS, WhatsApp, e-mail) and the
-- person fills in the questionnaire without signing in. Two kinds of links:
--   * appointment link – created for every appointment; answers belong to that appointment,
--   * standalone link  – created by the admin before any appointment exists (questionnaire with a label);
--                        it can be attached to an appointment later.
-- Lab results uploaded through a link live under "link/<token>/<file>" in the "wyniki-badan" bucket.
-- Resetting a link revokes the old token (it stops working) but its folder stays readable for admins.

-- ---------------------------------------------------------------------------
-- Questionnaires get their own id; appointment and user become optional.
-- ---------------------------------------------------------------------------
alter table public.questionnaires add column id uuid not null default gen_random_uuid();
alter table public.questionnaires add column label text check (char_length(label) <= 200);
alter table public.questionnaires drop constraint questionnaires_pkey;
alter table public.questionnaires add primary key (id);
alter table public.questionnaires add constraint questionnaires_appointment_id_key unique (appointment_id);
alter table public.questionnaires alter column appointment_id drop not null;
alter table public.questionnaires alter column user_id drop not null;
alter table public.questionnaires add constraint questionnaires_owner
  check (appointment_id is not null or label is not null);
comment on column public.questionnaires.label is 'Podpis kwestionariusza bez wizyty (np. imię osoby).';

-- ---------------------------------------------------------------------------
-- Links
-- ---------------------------------------------------------------------------
create table private.questionnaire_links (
  token            text primary key default encode(extensions.gen_random_bytes(24), 'hex'),
  appointment_id   uuid references public.appointments (id) on delete cascade,
  questionnaire_id uuid references public.questionnaires (id) on delete cascade,
  created_at       timestamptz not null default now(),
  revoked_at       timestamptz,
  constraint questionnaire_links_target check ((appointment_id is null) <> (questionnaire_id is null))
);
create unique index questionnaire_links_active_appointment
  on private.questionnaire_links (appointment_id) where revoked_at is null and appointment_id is not null;
create unique index questionnaire_links_active_questionnaire
  on private.questionnaire_links (questionnaire_id) where revoked_at is null and questionnaire_id is not null;

insert into private.questionnaire_links (appointment_id)
select a.id from public.appointments a;

create or replace function private.on_appointment_link() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into private.questionnaire_links (appointment_id) values (new.id);
  return new;
end;
$$;

-- Fires before "appointments_created" (alphabetical order), so notification e-mails can include the link.
create trigger appointments_a_link
  after insert on public.appointments
  for each row execute function private.on_appointment_link();

create or replace function private.link_url(p_token text) returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.site_url || '/kwestionariusz.html?t=' || p_token from private.settings s where s.id
$$;

create or replace function private.questionnaire_url(p_appointment_id uuid) returns text
language sql
stable
security definer
set search_path = ''
as $$
  select private.link_url(l.token)
    from private.questionnaire_links l
   where l.appointment_id = p_appointment_id and l.revoked_at is null
$$;

-- Resolves an active token. Appointment links work while the appointment is pending or confirmed.
create or replace function private.resolve_link(p_token text, out questionnaire_id uuid, out appointment_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  l private.questionnaire_links;
  v_status public.appointment_status;
begin
  select * into l from private.questionnaire_links where token = p_token and revoked_at is null;
  if not found then
    raise exception 'Link jest nieprawidłowy lub został wyłączony. Poproś o nowy.' using errcode = 'P0002';
  end if;
  if l.appointment_id is not null then
    select a.status into v_status from public.appointments a where a.id = l.appointment_id;
    if v_status not in ('pending', 'confirmed') then
      raise exception 'Ta wizyta nie jest już aktywna, więc kwestionariusz jest zamknięty.' using errcode = 'P0001';
    end if;
    appointment_id := l.appointment_id;
    select q.id into questionnaire_id from public.questionnaires q where q.appointment_id = l.appointment_id;
  else
    questionnaire_id := l.questionnaire_id;
    select q.appointment_id into appointment_id from public.questionnaires q where q.id = l.questionnaire_id;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Saving (shared by signed-in clients and links)
-- ---------------------------------------------------------------------------
create or replace function private.check_answers(p_answers jsonb, p_submit boolean, p_health_consent boolean)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then
    raise exception 'Nieprawidłowe odpowiedzi.' using errcode = '22023';
  end if;
  if octet_length(p_answers::text) > 200000 then
    raise exception 'Odpowiedzi są zbyt długie.' using errcode = '22023';
  end if;
  if p_submit and not coalesce(p_health_consent, false) then
    raise exception 'Zaznacz zgodę na przetwarzanie danych o zdrowiu.' using errcode = '22023';
  end if;
end;
$$;

-- Upserts the questionnaire of an appointment.
create or replace function private.save_for_appointment(
  p_appointment_id uuid,
  p_answers        jsonb,
  p_step           integer,
  p_submit         boolean,
  p_health_consent boolean
) returns public.questionnaires
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_q public.questionnaires;
begin
  perform private.check_answers(p_answers, p_submit, p_health_consent);
  insert into public.questionnaires as q
    (appointment_id, user_id, answers, current_step, health_consent_at, submitted_at)
  select a.id, a.user_id, p_answers, coalesce(p_step, -1),
         case when p_submit then now() end, case when p_submit then now() end
    from public.appointments a
   where a.id = p_appointment_id
  on conflict (appointment_id) do update
    set answers           = excluded.answers,
        current_step      = coalesce(p_step, q.current_step),
        health_consent_at = case when p_submit then now() else q.health_consent_at end,
        submitted_at      = case when p_submit then now() else q.submitted_at end
  returning * into v_q;
  return v_q;
end;
$$;

create or replace function private.save_by_id(
  p_questionnaire_id uuid,
  p_answers          jsonb,
  p_step             integer,
  p_submit           boolean,
  p_health_consent   boolean
) returns public.questionnaires
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_q public.questionnaires;
begin
  perform private.check_answers(p_answers, p_submit, p_health_consent);
  update public.questionnaires q
     set answers           = p_answers,
         current_step      = coalesce(p_step, q.current_step),
         health_consent_at = case when p_submit then now() else q.health_consent_at end,
         submitted_at      = case when p_submit then now() else q.submitted_at end
   where q.id = p_questionnaire_id
  returning * into v_q;
  return v_q;
end;
$$;

create or replace function public.save_questionnaire(
  p_appointment_id uuid,
  p_answers        jsonb,
  p_step           integer default null,
  p_submit         boolean default false,
  p_health_consent boolean default false
) returns public.questionnaires
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_a   public.appointments;
begin
  if v_uid is null then
    raise exception 'Zaloguj się, aby wypełnić kwestionariusz.' using errcode = '42501';
  end if;
  select * into v_a from public.appointments where id = p_appointment_id and user_id = v_uid;
  if not found then
    raise exception 'Nie znaleziono wizyty.' using errcode = 'P0002';
  end if;
  if v_a.status <> 'confirmed' then
    raise exception 'Kwestionariusz jest dostępny dla potwierdzonych wizyt.' using errcode = 'P0001';
  end if;
  return private.save_for_appointment(v_a.id, p_answers, p_step, p_submit, p_health_consent);
end;
$$;

-- ---------------------------------------------------------------------------
-- Link API (anon)
-- ---------------------------------------------------------------------------
create or replace function public.get_questionnaire_by_link(p_token text)
returns table (
  questionnaire_id uuid,
  label            text,
  appointment_id   uuid,
  status           public.appointment_status,
  service_name     text,
  starts_at        timestamptz,
  answers          jsonb,
  current_step     integer,
  submitted_at     timestamptz,
  updated_at       timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r record;
begin
  select * into r from private.resolve_link(p_token);
  return query
    select q.id, q.label, a.id, a.status, s.name, a.starts_at, q.answers, q.current_step, q.submitted_at, q.updated_at
      from (select 1) one
      left join public.questionnaires q on q.id = r.questionnaire_id
      left join public.appointments a on a.id = r.appointment_id
      left join public.services s on s.id = a.service_id;
end;
$$;

create or replace function public.save_questionnaire_by_link(
  p_token          text,
  p_answers        jsonb,
  p_step           integer default null,
  p_submit         boolean default false,
  p_health_consent boolean default false
) returns table (submitted_at timestamptz, updated_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  r   record;
  v_q public.questionnaires;
begin
  select * into r from private.resolve_link(p_token);
  if r.questionnaire_id is not null then
    v_q := private.save_by_id(r.questionnaire_id, p_answers, p_step, p_submit, p_health_consent);
  else
    v_q := private.save_for_appointment(r.appointment_id, p_answers, p_step, p_submit, p_health_consent);
  end if;
  return query select v_q.submitted_at, v_q.updated_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin API
-- ---------------------------------------------------------------------------
create or replace function private.link_info(p_appointment_id uuid, p_questionnaire_id uuid) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'questionnaire_id', p_questionnaire_id,
    'url', (select private.link_url(l.token) from private.questionnaire_links l
             where l.revoked_at is null
               and (l.appointment_id = p_appointment_id or l.questionnaire_id = p_questionnaire_id)
             order by l.appointment_id nulls last, l.created_at desc limit 1),
    'folders', coalesce((select jsonb_agg('link/' || l.token order by l.created_at)
                           from private.questionnaire_links l
                          where l.appointment_id = p_appointment_id or l.questionnaire_id = p_questionnaire_id),
                        '[]'::jsonb))
$$;

-- Link of an appointment (p_appointment_id) or of a questionnaire (p_questionnaire_id); p_reset issues a new one.
create or replace function public.admin_questionnaire_link(
  p_appointment_id   uuid default null,
  p_questionnaire_id uuid default null,
  p_reset            boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_q uuid := p_questionnaire_id;
begin
  if not public.is_admin() then
    raise exception 'Brak uprawnień.' using errcode = '42501';
  end if;
  if (p_appointment_id is null) = (p_questionnaire_id is null) then
    raise exception 'Podaj wizytę albo kwestionariusz.' using errcode = '22023';
  end if;

  if p_appointment_id is not null then
    if not exists (select 1 from public.appointments where id = p_appointment_id) then
      raise exception 'Nie znaleziono wizyty.' using errcode = 'P0002';
    end if;
    select q.id into v_q from public.questionnaires q where q.appointment_id = p_appointment_id;
    if p_reset then
      update private.questionnaire_links set revoked_at = now()
       where revoked_at is null and (appointment_id = p_appointment_id or questionnaire_id = v_q);
    end if;
    if not exists (select 1 from private.questionnaire_links
                    where revoked_at is null and appointment_id = p_appointment_id) then
      insert into private.questionnaire_links (appointment_id) values (p_appointment_id);
    end if;
  else
    if not exists (select 1 from public.questionnaires where id = p_questionnaire_id) then
      raise exception 'Nie znaleziono kwestionariusza.' using errcode = 'P0002';
    end if;
    select q.appointment_id into p_appointment_id from public.questionnaires q where q.id = p_questionnaire_id;
    if p_reset then
      update private.questionnaire_links set revoked_at = now()
       where revoked_at is null and questionnaire_id = p_questionnaire_id;
    end if;
    if not exists (select 1 from private.questionnaire_links
                    where revoked_at is null and questionnaire_id = p_questionnaire_id) then
      insert into private.questionnaire_links (questionnaire_id) values (p_questionnaire_id);
    end if;
  end if;
  return private.link_info(p_appointment_id, v_q);
end;
$$;

-- Questionnaire for someone without an appointment yet.
create or replace function public.admin_create_questionnaire(p_label text) returns jsonb
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
  if nullif(trim(coalesce(p_label, '')), '') is null then
    raise exception 'Podaj, dla kogo jest kwestionariusz (np. imię i nazwisko).' using errcode = '22023';
  end if;
  insert into public.questionnaires (label) values (left(trim(p_label), 200)) returning id into v_id;
  insert into private.questionnaire_links (questionnaire_id) values (v_id);
  return private.link_info(null, v_id);
end;
$$;

create or replace function public.admin_attach_questionnaire(p_questionnaire_id uuid, p_appointment_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
begin
  if not public.is_admin() then
    raise exception 'Brak uprawnień.' using errcode = '42501';
  end if;
  select a.user_id into v_user from public.appointments a where a.id = p_appointment_id;
  if v_user is null then
    raise exception 'Nie znaleziono wizyty.' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.questionnaires where appointment_id = p_appointment_id) then
    raise exception 'Ta wizyta ma już kwestionariusz.' using errcode = 'P0001';
  end if;
  update public.questionnaires
     set appointment_id = p_appointment_id, user_id = v_user
   where id = p_questionnaire_id and appointment_id is null;
  if not found then
    raise exception 'Kwestionariusz nie istnieje albo jest już przypisany do wizyty.' using errcode = 'P0001';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Lab results through a link: link/<token>/<file>
-- ---------------------------------------------------------------------------
create or replace function public.link_folder_writable(p_name text) returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (storage.foldername(p_name))[1] = 'link'
     and exists (
       select 1
         from private.questionnaire_links l
         left join public.appointments a on a.id = l.appointment_id
        where l.token = (storage.foldername(p_name))[2]
          and l.revoked_at is null
          and (l.appointment_id is null or a.status in ('pending', 'confirmed')))
$$;

create policy "wyniki_link_insert" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'wyniki-badan' and public.link_folder_writable(name));

create policy "wyniki_link_select" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'wyniki-badan' and public.link_folder_writable(name));

create policy "wyniki_link_delete" on storage.objects
  for delete to anon, authenticated
  using (bucket_id = 'wyniki-badan' and public.link_folder_writable(name));

-- ---------------------------------------------------------------------------
-- Notifications: confirmation e-mail points to the link; submission e-mail supports standalone questionnaires.
-- ---------------------------------------------------------------------------
create or replace function private.on_appointment_status_changed() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cfg     private.settings;
  v_client  public.profiles;
  v_service public.services;
  v_admin   text;
  v_msg     text;
  v_hello   text;
begin
  select * into v_cfg from private.settings where id;
  select * into v_client from public.profiles where id = new.user_id;
  select * into v_service from public.services where id = new.service_id;
  v_msg := case when new.admin_message is not null
                then '<p style="background:#ecf8ed;border-radius:12px;padding:12px 14px">'
                     || replace(private.h(new.admin_message), E'\n', '<br>') || '</p>'
                else '' end;
  v_hello := '<p>Cześć' || coalesce(' ' || private.h(split_part(v_client.full_name, ' ', 1)), '') || ',</p>';

  if new.status = 'confirmed' then
    perform private.enqueue_email(
      v_client.email,
      'Wizyta potwierdzona – wypełnij kwestionariusz',
      private.email_layout('Twoja wizyta jest potwierdzona',
        v_hello
        || '<p>Potwierdzam wizytę. Przed spotkaniem wypełnij proszę kwestionariusz. Zajmie ok. 10 minut, '
        || 'a dzięki niemu przygotuję plan dopasowany do Ciebie. Możesz też dołączyć wyniki badań.</p>'
        || v_msg
        || private.appointment_details_html(new.id, false)
        || private.email_button('Wypełnij kwestionariusz',
             coalesce(private.questionnaire_url(new.id), v_cfg.site_url || '/kwestionariusz.html?wizyta=' || new.id))),
      'client_confirmed', new.id);

  elsif new.status = 'rejected' then
    perform private.enqueue_email(
      v_client.email,
      'Rezerwacja niepotwierdzona – ' || v_service.name,
      private.email_layout('Nie mogę potwierdzić tego terminu',
        v_hello
        || '<p>Niestety nie mogę potwierdzić tej rezerwacji. Wybierz proszę inny termin albo napisz do mnie.</p>'
        || v_msg
        || private.appointment_details_html(new.id, false)
        || private.email_button('Wybierz inny termin', v_cfg.site_url || '/#umow')),
      'client_rejected', new.id);

  elsif new.status = 'cancelled' and new.cancelled_by = 'client' then
    foreach v_admin in array v_cfg.admin_emails loop
      perform private.enqueue_email(
        v_admin,
        'Wizyta odwołana przez klienta – ' || coalesce(v_client.full_name, v_client.email),
        private.email_layout('Klient odwołał wizytę',
          private.appointment_details_html(new.id, true)
          || private.email_button('Panel administratora', v_cfg.site_url || '/admin.html', true)),
        'admin_cancelled_by_client', new.id);
    end loop;

  elsif new.status = 'cancelled' and new.cancelled_by = 'admin' then
    perform private.enqueue_email(
      v_client.email,
      'Wizyta odwołana – ' || v_service.name,
      private.email_layout('Wizyta została odwołana',
        v_hello
        || '<p>Muszę odwołać tę wizytę. Przepraszam za kłopot. Wybierz proszę nowy termin.</p>'
        || v_msg
        || private.appointment_details_html(new.id, false)
        || private.email_button('Wybierz nowy termin', v_cfg.site_url || '/#umow')),
      'client_cancelled_by_admin', new.id);
  end if;

  return new;
end;
$$;

create or replace function private.on_questionnaire_submitted() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cfg    private.settings;
  v_client public.profiles;
  v_who    text;
  v_admin  text;
begin
  select * into v_cfg from private.settings where id;
  select * into v_client from public.profiles where id = new.user_id;
  v_who := coalesce(v_client.full_name, v_client.email, new.label, 'Klient');
  foreach v_admin in array v_cfg.admin_emails loop
    perform private.enqueue_email(
      v_admin,
      'Kwestionariusz wypełniony – ' || v_who,
      private.email_layout('Nowy kwestionariusz',
        '<p>' || private.h(v_who) || ' wypełnił(a) kwestionariusz'
        || case when new.appointment_id is null then ' (bez umówionej wizyty).' else ' przed wizytą.' end || '</p>'
        || coalesce(private.appointment_details_html(new.appointment_id, true), '')
        || private.email_button('Zobacz odpowiedzi', v_cfg.site_url || '/admin.html#kwestionariusz-' || new.id)),
      'admin_questionnaire_submitted', new.appointment_id);
  end loop;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke execute on function public.get_questionnaire_by_link(text) from public;
revoke execute on function public.save_questionnaire_by_link(text, jsonb, integer, boolean, boolean) from public;
revoke execute on function public.link_folder_writable(text) from public;
revoke execute on function public.admin_questionnaire_link(uuid, uuid, boolean) from public, anon;
revoke execute on function public.admin_create_questionnaire(text) from public, anon;
revoke execute on function public.admin_attach_questionnaire(uuid, uuid) from public, anon;
grant execute on function public.get_questionnaire_by_link(text) to anon, authenticated;
grant execute on function public.save_questionnaire_by_link(text, jsonb, integer, boolean, boolean) to anon, authenticated;
grant execute on function public.link_folder_writable(text) to anon, authenticated;
grant execute on function public.admin_questionnaire_link(uuid, uuid, boolean) to authenticated;
grant execute on function public.admin_create_questionnaire(text) to authenticated;
grant execute on function public.admin_attach_questionnaire(uuid, uuid) to authenticated;
