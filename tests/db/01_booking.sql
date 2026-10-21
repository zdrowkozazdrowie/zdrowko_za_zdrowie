\ir _helpers.sql
begin;

select private.configure('https://zdrowko.test', array['Admin@Example.com'], 'Test <wizyty@zdrowko.test>');
select set_config('t.admin',  pg_temp.mk_user('admin@example.com', 'Wiktoria Admin')::text, true);
select set_config('t.anna',   pg_temp.mk_user('anna@example.com', 'Anna Kowalska')::text, true);
select set_config('t.bartek', pg_temp.mk_user('bartek@example.com', 'Bartek Nowak')::text, true);
select set_config('t.noname', pg_temp.mk_user('noname@example.com')::text, true);
select set_config('t.fake',   pg_temp.mk_user('admin2@example.com', 'Fake', false)::text, true);
update private.settings set admin_emails = array_append(admin_emails, 'admin2@example.com');

select pg_temp.eq((select count(*) from public.profiles), 5::bigint, 'profiles are created for new auth users');
select pg_temp.eq((select full_name from public.profiles where id = current_setting('t.anna')::uuid),
                  'Anna Kowalska', 'profile full_name comes from user metadata');

-- Admin rights
select pg_temp.login(current_setting('t.admin')::uuid);
select pg_temp.ok(public.is_admin(), 'admin e-mail (case-insensitive) grants admin rights');
select set_config('t.day', ((now() at time zone 'Europe/Warsaw')::date + 3)::text, true);
select pg_temp.eq(public.admin_add_slots(current_setting('t.day')::date, '09:00', '12:00', 60, 0), 3,
                  'admin creates three 60-minute slots');
select pg_temp.eq(public.admin_add_slots(current_setting('t.day')::date, '09:00', '12:00', 60, 0), 0,
                  'overlapping slots are not duplicated');
select pg_temp.throws($$select public.admin_add_slots(current_date - 2, '09:00', '12:00')$$,
                      '%przeszłości%', 'slots in the past are rejected');
select pg_temp.logout();

select pg_temp.login(current_setting('t.fake')::uuid);
select pg_temp.ok(not public.is_admin(), 'listed admin e-mail without confirmation is not an admin');
select pg_temp.logout();

select set_config('t.slot1', (select id::text from public.slots order by starts_at limit 1), true);
select set_config('t.slot2', (select id::text from public.slots order by starts_at offset 1 limit 1), true);
select set_config('t.slot3', (select id::text from public.slots order by starts_at offset 2 limit 1), true);

-- Anonymous visitor
select pg_temp.login_anon();
select pg_temp.eq((select count(*) from public.get_free_slots()), 3::bigint, 'anon sees free slots');
select pg_temp.eq((select count(*) from public.services), 6::bigint, 'anon sees active services');
select pg_temp.throws($$select public.book_appointment('pierwsza-konsultacja', current_setting('t.slot1')::uuid)$$,
                      '%permission denied%', 'anon cannot book');
select pg_temp.throws($$select * from public.slots$$, '%permission denied%', 'anon cannot read slots table');
select pg_temp.logout();

-- Anna books
select pg_temp.login(current_setting('t.anna')::uuid);
select set_config('t.appt',
  public.book_appointment('pierwsza-konsultacja', current_setting('t.slot1')::uuid, 'online', 'Mam <b>Hashimoto</b>', null, '+48 600 100 200')::text,
  true);
select pg_temp.eq((select status::text from public.appointments where id = current_setting('t.appt')::uuid), 'pending',
                  'new booking is pending');
select pg_temp.eq((select payment_status::text from public.appointments where id = current_setting('t.appt')::uuid),
                  'not_required', 'free service needs no payment');
select pg_temp.eq((select phone from public.profiles where id = current_setting('t.anna')::uuid), '+48 600 100 200',
                  'booking stores the phone number in the profile');
select pg_temp.eq((select count(*) from public.get_free_slots()), 2::bigint, 'booked slot disappears from free slots');
select pg_temp.throws($$update public.appointments set status = 'confirmed'$$, '%permission denied%',
                      'client cannot change appointments directly');
select pg_temp.throws($$select * from private.appointment_tokens$$, '%permission denied%',
                      'client cannot read decision tokens');
select pg_temp.throws($$select public.admin_set_status(current_setting('t.appt')::uuid, 'confirmed')$$, '%Brak uprawnień%',
                      'client cannot use admin RPC');
select pg_temp.throws($$select public.book_appointment('wizyta-kontrolna')$$, '%Wybierz termin%',
                      'slot is required for visits');
select set_config('t.order', public.book_appointment('analiza-jadlospisu')::text, true);
select pg_temp.eq((select payment_status::text from public.appointments where id = current_setting('t.order')::uuid),
                  'unpaid', 'paid service without slot can be ordered and is unpaid');
select pg_temp.logout();

-- E-mails for the new booking (no Resend key -> stored as skipped)
select pg_temp.eq((select count(*) from private.email_outbox
                    where kind = 'admin_new_booking' and appointment_id = current_setting('t.appt')::uuid
                      and to_email = 'admin@example.com'), 1::bigint, 'admin gets a new-booking e-mail');
select pg_temp.eq((select count(*) from private.email_outbox
                    where kind = 'client_booking_received' and to_email = 'anna@example.com'
                      and appointment_id = current_setting('t.appt')::uuid), 1::bigint, 'client gets an acknowledgement');
select pg_temp.ok((select bool_and(status = 'skipped') from private.email_outbox), 'without API key e-mails are skipped');
select pg_temp.ok((select html like '%Mam &lt;b&gt;Hashimoto&lt;/b&gt;%' from private.email_outbox
                    where kind = 'admin_new_booking' and appointment_id = current_setting('t.appt')::uuid
                      and to_email = 'admin@example.com'),
                  'user input is HTML-escaped in e-mails');
select set_config('t.token', (select token from private.appointment_tokens
                               where appointment_id = current_setting('t.appt')::uuid), true);
select pg_temp.ok((select html like '%/potwierdz.html?t=' || current_setting('t.token') || '&amp;decyzja=potwierdz%'
                     from private.email_outbox
                    where kind = 'admin_new_booking' and appointment_id = current_setting('t.appt')::uuid
                      and to_email = 'admin@example.com'),
                  'admin e-mail contains the confirmation link');

-- Bartek: conflicts and isolation
select pg_temp.login(current_setting('t.bartek')::uuid);
select pg_temp.throws($$select public.book_appointment('pierwsza-konsultacja', current_setting('t.slot1')::uuid)$$,
                      '%właśnie zarezerwowany%', 'a slot cannot be double-booked');
select pg_temp.eq((select count(*) from public.appointments), 0::bigint, 'client does not see other clients'' appointments');
select pg_temp.eq((select count(*) from public.profiles), 1::bigint, 'client sees only own profile');
select pg_temp.throws($$select public.book_appointment('nie-ma-takiej', current_setting('t.slot2')::uuid)$$,
                      '%Nie znaleziono%', 'unknown service is rejected');
select pg_temp.throws($$select public.book_appointment('pierwsza-konsultacja', current_setting('t.slot2')::uuid, 'teleport')$$,
                      '%forma%', 'invalid mode is rejected');
select pg_temp.logout();

select pg_temp.login(current_setting('t.noname')::uuid);
select pg_temp.throws($$select public.book_appointment('pierwsza-konsultacja', current_setting('t.slot2')::uuid)$$,
                      '%imię i nazwisko%', 'name is required to book');
select pg_temp.logout();

-- Decision through the e-mail link (anonymous request with the token)
select pg_temp.login_anon();
select pg_temp.eq((select client_email from public.get_appointment_by_token(current_setting('t.token'))),
                  'anna@example.com', 'token shows booking details');
select pg_temp.eq((select count(*) from public.get_appointment_by_token('zly-token')), 0::bigint, 'wrong token shows nothing');
select pg_temp.throws($$select public.decide_appointment('zly-token', 'confirm')$$, '%nieprawidłowy%', 'wrong token is rejected');
select pg_temp.eq(public.decide_appointment(current_setting('t.token'), 'confirm', 'Do zobaczenia!')::text, 'confirmed',
                  'admin confirms via e-mail link');
select pg_temp.throws($$select public.decide_appointment(current_setting('t.token'), 'reject')$$, '%już obsłużona%',
                      'a decision cannot be made twice');
select pg_temp.logout();

select pg_temp.ok((select html like '%/kwestionariusz.html?wizyta=' || current_setting('t.appt') || '%'
                          and html like '%Do zobaczenia!%'
                     from private.email_outbox
                    where kind = 'client_confirmed' and to_email = 'anna@example.com'),
                  'client gets confirmation with questionnaire link and admin message');

-- Pending limit
select pg_temp.login(current_setting('t.bartek')::uuid);
select public.book_appointment('analiza-jadlospisu');
select public.book_appointment('analiza-jadlospisu');
select public.book_appointment('analiza-jadlospisu');
select pg_temp.throws($$select public.book_appointment('analiza-jadlospisu')$$, '%czekające na potwierdzenie%',
                      'pending bookings per user are limited');
select pg_temp.logout();

-- Admin view and actions
select pg_temp.login(current_setting('t.admin')::uuid);
select pg_temp.eq((select count(*) from public.appointments), 5::bigint, 'admin sees all appointments');
select pg_temp.eq((select count(*) from public.profiles), 5::bigint, 'admin sees all profiles');
select pg_temp.throws($$select public.admin_delete_slot(current_setting('t.slot1')::uuid)$$, '%zarezerwowany%',
                      'booked slot cannot be deleted');
select public.admin_delete_slot(current_setting('t.slot3')::uuid);
select pg_temp.eq((select count(*) from public.slots), 2::bigint, 'free slot can be deleted');
select pg_temp.eq(public.admin_set_status(current_setting('t.order')::uuid, 'rejected', 'Proszę o kontakt')::text,
                  'rejected', 'admin rejects from the panel');
select pg_temp.throws($$select public.admin_set_status(current_setting('t.order')::uuid, 'completed')$$,
                      '%Nie można zmienić%', 'invalid status transition is rejected');
select pg_temp.logout();

select pg_temp.eq((select count(*) from private.email_outbox where kind = 'client_rejected' and to_email = 'anna@example.com'),
                  1::bigint, 'client is told about the rejection');

-- Client cancels
select pg_temp.login(current_setting('t.anna')::uuid);
select pg_temp.eq(public.cancel_my_appointment(current_setting('t.appt')::uuid)::text, 'cancelled', 'client cancels own visit');
select pg_temp.throws($$select public.cancel_my_appointment(current_setting('t.appt')::uuid)$$, '%nie można już%',
                      'cancelled visit cannot be cancelled again');
select pg_temp.eq((select count(*) from public.get_free_slots()), 2::bigint, 'cancelled slot is free again');
select pg_temp.logout();

select pg_temp.eq((select count(*) from private.email_outbox where kind = 'admin_cancelled_by_client' and to_email = 'admin@example.com'), 1::bigint,
                  'admin is notified about client cancellation');

rollback;
