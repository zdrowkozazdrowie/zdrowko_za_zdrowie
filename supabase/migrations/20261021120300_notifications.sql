-- E-mail notifications: templates + triggers on appointments and questionnaires.

create or replace function private.email_layout(p_title text, p_body text) returns text
language sql
immutable
set search_path = ''
as $$
  select
    '<!doctype html><html lang="pl"><body style="margin:0;background:#f2f7f3;font-family:Arial,Helvetica,sans-serif;color:#1d2b24">'
 || '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f7f3;padding:24px 0">'
 || '<tr><td align="center"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
 || 'style="max-width:560px;background:#ffffff;border-radius:16px;padding:28px">'
 || '<tr><td style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#1f8a2c;font-weight:bold;padding-bottom:6px">Zdrówko za zdrowie</td></tr>'
 || '<tr><td style="font-size:22px;font-weight:bold;padding-bottom:16px">' || private.h(p_title) || '</td></tr>'
 || '<tr><td style="font-size:15px;line-height:1.6">' || p_body || '</td></tr>'
 || '<tr><td style="padding-top:24px;font-size:12px;color:#5b6b63">mgr Wiktoria Przybylak · Dietetyk kliniczny</td></tr>'
 || '</table></td></tr></table></body></html>'
$$;

create or replace function private.email_button(p_label text, p_url text, p_secondary boolean default false) returns text
language sql
immutable
set search_path = ''
as $$
  select '<a href="' || private.h(p_url) || '" style="display:inline-block;margin:8px 8px 0 0;padding:12px 22px;border-radius:999px;'
      || 'text-decoration:none;font-weight:bold;'
      || case when p_secondary then 'background:#ffffff;color:#1d2b24;border:2px solid #4ecbd2'
              else 'background:#3cb54a;color:#ffffff;border:2px solid #3cb54a' end
      || '">' || private.h(p_label) || '</a>'
$$;

create or replace function private.appointment_details_html(p_id uuid, p_for_admin boolean) returns text
language sql
stable
security definer
set search_path = ''
as $$
  select '<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:8px 0 12px;font-size:14px">'
      || string_agg('<tr><td style="padding:6px 12px 6px 0;color:#5b6b63;white-space:nowrap;vertical-align:top">'
                    || private.h(k) || '</td><td style="padding:6px 0">' || private.h(v) || '</td></tr>', '' order by ord)
      || '</table>'
    from public.appointments a
    join public.services s on s.id = a.service_id
    join public.profiles p on p.id = a.user_id
   cross join lateral (values
       (1, 'Usługa', s.name),
       (2, 'Termin', private.fmt_ts(a.starts_at)),
       (3, 'Forma', case a.mode when 'online' then 'online (wideorozmowa)' else 'telefonicznie' end),
       (4, 'Cena', case when a.price_pln = 0 then 'bezpłatnie' else to_char(a.price_pln, 'FM999990') || ' zł' end),
       (5, 'Klient', case when p_for_admin then p.full_name end),
       (6, 'E-mail', case when p_for_admin then p.email end),
       (7, 'Telefon', case when p_for_admin then p.phone end),
       (8, 'Uwagi', a.client_note)
     ) as d(ord, k, v)
   where a.id = p_id and v is not null
$$;

-- New booking -> token + e-mail to admins (confirm / reject) + acknowledgement to the client.
create or replace function private.on_appointment_created() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cfg     private.settings;
  v_token   text;
  v_client  public.profiles;
  v_service public.services;
  v_admin   text;
  v_link    text;
begin
  insert into private.appointment_tokens (appointment_id) values (new.id) returning token into v_token;

  select * into v_cfg from private.settings where id;
  select * into v_client from public.profiles where id = new.user_id;
  select * into v_service from public.services where id = new.service_id;
  v_link := v_cfg.site_url || '/potwierdz.html?t=' || v_token;

  foreach v_admin in array v_cfg.admin_emails loop
    perform private.enqueue_email(
      v_admin,
      'Nowa rezerwacja: ' || v_service.name || ' – ' || coalesce(v_client.full_name, v_client.email),
      private.email_layout('Nowa rezerwacja wizyty',
        '<p>Pojawiła się nowa rezerwacja. Potwierdź ją, a klient dostanie od razu link do kwestionariusza.</p>'
        || private.appointment_details_html(new.id, true)
        || private.email_button('Potwierdź wizytę', v_link || '&decyzja=potwierdz')
        || private.email_button('Odrzuć', v_link || '&decyzja=odrzuc', true)
        || '<p style="font-size:13px;color:#5b6b63;margin-top:18px">Wszystkie rezerwacje znajdziesz też w '
        || '<a href="' || private.h(v_cfg.site_url || '/admin.html') || '">panelu administratora</a>.</p>'),
      'admin_new_booking', new.id);
  end loop;

  perform private.enqueue_email(
    v_client.email,
    'Otrzymałam Twoją rezerwację – ' || v_service.name,
    private.email_layout('Dziękuję za rezerwację!',
      '<p>Cześć' || coalesce(' ' || private.h(split_part(v_client.full_name, ' ', 1)), '') || ',</p>'
      || '<p>Twoja rezerwacja czeka na potwierdzenie. Gdy ją potwierdzę, dostaniesz e-mail z krótkim kwestionariuszem do wypełnienia przed wizytą.</p>'
      || private.appointment_details_html(new.id, false)
      || private.email_button('Moje wizyty', v_cfg.site_url || '/konto.html', true)),
    'client_booking_received', new.id);

  return new;
end;
$$;

create trigger appointments_created
  after insert on public.appointments
  for each row execute function private.on_appointment_created();

-- Status changes -> e-mails.
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
        || private.email_button('Wypełnij kwestionariusz', v_cfg.site_url || '/kwestionariusz.html?wizyta=' || new.id)),
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

create trigger appointments_status_changed
  after update of status on public.appointments
  for each row when (old.status is distinct from new.status)
  execute function private.on_appointment_status_changed();

-- First questionnaire submission -> e-mail to admins.
create or replace function private.on_questionnaire_submitted() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cfg    private.settings;
  v_client public.profiles;
  v_admin  text;
begin
  select * into v_cfg from private.settings where id;
  select * into v_client from public.profiles where id = new.user_id;
  foreach v_admin in array v_cfg.admin_emails loop
    perform private.enqueue_email(
      v_admin,
      'Kwestionariusz wypełniony – ' || coalesce(v_client.full_name, v_client.email),
      private.email_layout('Nowy kwestionariusz',
        '<p>' || private.h(coalesce(v_client.full_name, v_client.email)) || ' wypełnił(a) kwestionariusz przed wizytą.</p>'
        || private.appointment_details_html(new.appointment_id, true)
        || private.email_button('Zobacz odpowiedzi', v_cfg.site_url || '/admin.html#wizyta-' || new.appointment_id)),
      'admin_questionnaire_submitted', new.appointment_id);
  end loop;
  return new;
end;
$$;

create trigger questionnaires_submitted_insert
  after insert on public.questionnaires
  for each row when (new.submitted_at is not null)
  execute function private.on_questionnaire_submitted();

create trigger questionnaires_submitted_update
  after update of submitted_at on public.questionnaires
  for each row when (old.submitted_at is null and new.submitted_at is not null)
  execute function private.on_questionnaire_submitted();
