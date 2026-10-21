\ir _helpers.sql
begin;

select private.configure('https://zdrowko.test', array['admin@example.com'], 'Test <wizyty@zdrowko.test>');
select set_config('t.admin', pg_temp.mk_user('admin@example.com', 'Wiktoria Admin')::text, true);
select set_config('t.anna',  pg_temp.mk_user('anna@example.com', 'Anna Kowalska')::text, true);
select set_config('t.ola',   pg_temp.mk_user('ola@example.com', 'Ola Nowak')::text, true);

select pg_temp.login(current_setting('t.admin')::uuid);
select public.admin_add_slots(((now() at time zone 'Europe/Warsaw')::date + 3), '09:00', '12:00', 60, 0);
select pg_temp.logout();
select set_config('t.slot1', (select id::text from public.slots order by starts_at limit 1), true);
select set_config('t.slot2', (select id::text from public.slots order by starts_at offset 1 limit 1), true);

select pg_temp.login(current_setting('t.anna')::uuid);
select set_config('t.appt', public.book_appointment('pierwsza-konsultacja', current_setting('t.slot1')::uuid)::text, true);
select pg_temp.logout();
select pg_temp.login(current_setting('t.ola')::uuid);
select set_config('t.appt2', public.book_appointment('wizyta-kontrolna', current_setting('t.slot2')::uuid)::text, true);
select pg_temp.logout();

-- Every appointment gets a link
select pg_temp.eq((select count(*) from private.questionnaire_links where appointment_id = current_setting('t.appt')::uuid
                    and revoked_at is null), 1::bigint, 'new appointment gets an active link');
select set_config('t.token', (select token from private.questionnaire_links where appointment_id = current_setting('t.appt')::uuid), true);
select pg_temp.eq(length(current_setting('t.token')), 48, 'token is 48 hex characters');

-- Admin reads the link
select pg_temp.login(current_setting('t.anna')::uuid);
select pg_temp.throws($$select public.admin_questionnaire_link(current_setting('t.appt')::uuid)$$, '%Brak uprawnień%',
                      'client cannot read links');
select pg_temp.logout();
select pg_temp.login_anon();
select pg_temp.throws($$select public.admin_questionnaire_link(current_setting('t.appt')::uuid)$$, '%permission denied%',
                      'anon cannot call admin_questionnaire_link');
select pg_temp.throws($$select * from private.questionnaire_links$$, '%permission denied%', 'anon cannot read tokens');
select pg_temp.logout();

select pg_temp.login(current_setting('t.admin')::uuid);
select pg_temp.eq(public.admin_questionnaire_link(current_setting('t.appt')::uuid) ->> 'url',
                  'https://zdrowko.test/kwestionariusz.html?t=' || current_setting('t.token'), 'admin gets the link URL');
select pg_temp.logout();

-- Anonymous person with the link (appointment still pending)
select pg_temp.login_anon();
select pg_temp.eq((select service_name from public.get_questionnaire_by_link(current_setting('t.token'))),
                  'Pierwsza konsultacja', 'link shows the appointment');
select pg_temp.eq((select answers from public.get_questionnaire_by_link(current_setting('t.token'))), null::jsonb,
                  'nothing saved yet');
select public.save_questionnaire_by_link(current_setting('t.token'), '{"plec":"Kobieta"}', 2);
select pg_temp.eq((select answers ->> 'plec' from public.get_questionnaire_by_link(current_setting('t.token'))), 'Kobieta',
                  'draft is saved through the link');
select pg_temp.throws($$select public.save_questionnaire_by_link(current_setting('t.token'), '{}', null, true, false)$$,
                      '%zgodę%', 'submitting through the link requires consent');
select public.save_questionnaire_by_link(current_setting('t.token'), '{"plec":"Kobieta","dane":{"imie":"Anna"}}', 54, true, true);
select pg_temp.throws($$select public.get_questionnaire_by_link('deadbeef')$$, '%nieprawidłowy%', 'unknown token is rejected');
select pg_temp.throws($$select * from public.questionnaires$$, '%permission denied%', 'anon cannot read questionnaires');
select pg_temp.ok(public.link_folder_writable('link/' || current_setting('t.token') || '/wyniki.pdf'), 'link folder is writable');
select pg_temp.ok(not public.link_folder_writable('link/' || repeat('0', 48) || '/wyniki.pdf'), 'other link folders are not');
select pg_temp.ok(not public.link_folder_writable(current_setting('t.token') || '/wyniki.pdf'), 'path must start with link/');
select pg_temp.logout();

select pg_temp.ok((select submitted_at is not null and user_id = current_setting('t.anna')::uuid
                     from public.questionnaires where appointment_id = current_setting('t.appt')::uuid),
                  'answers are stored for the appointment and its client');
select pg_temp.eq((select count(*) from private.email_outbox where kind = 'admin_questionnaire_submitted'
                    and appointment_id = current_setting('t.appt')::uuid), 1::bigint, 'admin is notified about the submission');

-- The signed-in client sees the same questionnaire
select pg_temp.login(current_setting('t.anna')::uuid);
select pg_temp.eq((select answers -> 'dane' ->> 'imie' from public.questionnaires where appointment_id = current_setting('t.appt')::uuid),
                  'Anna', 'client sees answers given through the link');
select pg_temp.logout();

-- Reset revokes the old token
select pg_temp.login(current_setting('t.admin')::uuid);
select set_config('t.url2', public.admin_questionnaire_link(current_setting('t.appt')::uuid, null, true) ->> 'url', true);
select pg_temp.ok(current_setting('t.url2') not like '%' || current_setting('t.token'), 'reset issues a new token');
select pg_temp.eq(jsonb_array_length(public.admin_questionnaire_link(current_setting('t.appt')::uuid) -> 'folders'), 2,
                  'old link folder stays visible to the admin');
select pg_temp.logout();
select pg_temp.login_anon();
select pg_temp.throws($$select public.get_questionnaire_by_link(current_setting('t.token'))$$, '%wyłączony%',
                      'revoked link stops working');
select pg_temp.ok(not public.link_folder_writable('link/' || current_setting('t.token') || '/x.pdf'), 'revoked link cannot upload');
select pg_temp.logout();

-- Inactive appointment closes its link
select pg_temp.login(current_setting('t.admin')::uuid);
select public.admin_set_status(current_setting('t.appt2')::uuid, 'rejected');
select pg_temp.logout();
select set_config('t.token2', (select token from private.questionnaire_links where appointment_id = current_setting('t.appt2')::uuid), true);
select pg_temp.login_anon();
select pg_temp.throws($$select public.get_questionnaire_by_link(current_setting('t.token2'))$$,
                      '%nie jest już aktywna%', 'link of a rejected appointment is closed');
select pg_temp.logout();

-- Standalone questionnaire (no appointment yet)
select pg_temp.login(current_setting('t.admin')::uuid);
select pg_temp.throws($$select public.admin_create_questionnaire('  ')$$, '%dla kogo%', 'label is required');
select set_config('t.q', public.admin_create_questionnaire('Basia (test SQL)') ->> 'questionnaire_id', true);
select pg_temp.logout();
select set_config('t.qtoken', (select token from private.questionnaire_links where questionnaire_id = current_setting('t.q')::uuid), true);

select pg_temp.login_anon();
select pg_temp.eq((select label from public.get_questionnaire_by_link(current_setting('t.qtoken'))), 'Basia (test SQL)',
                  'standalone link opens without an appointment');
select pg_temp.eq((select service_name from public.get_questionnaire_by_link(current_setting('t.qtoken'))), null::text,
                  'standalone link has no appointment');
select public.save_questionnaire_by_link(current_setting('t.qtoken'), '{"plec":"Kobieta"}', 1, true, true);
select pg_temp.ok(public.link_folder_writable('link/' || current_setting('t.qtoken') || '/a.pdf'), 'standalone link can upload');
select pg_temp.logout();

select pg_temp.ok((select submitted_at is not null and appointment_id is null and user_id is null
                     from public.questionnaires where id = current_setting('t.q')::uuid), 'standalone answers are stored');
select pg_temp.eq((select count(*) from private.email_outbox where kind = 'admin_questionnaire_submitted'
                    and subject like '%Basia (test SQL)%'), 1::bigint, 'admin is notified about a standalone questionnaire');

-- Clients do not see standalone questionnaires
select pg_temp.login(current_setting('t.ola')::uuid);
select pg_temp.eq((select count(*) from public.questionnaires where id = current_setting('t.q')::uuid), 0::bigint,
                  'clients cannot read standalone questionnaires');
select pg_temp.throws(format($$select public.admin_attach_questionnaire(%L, %L)$$, current_setting('t.q'), current_setting('t.appt2')),
                      '%Brak uprawnień%', 'client cannot attach questionnaires');
select pg_temp.logout();

-- Attach to an appointment later
select pg_temp.login(current_setting('t.admin')::uuid);
select pg_temp.throws(format($$select public.admin_attach_questionnaire(%L, %L)$$, current_setting('t.q'), current_setting('t.appt')),
                      '%ma już kwestionariusz%', 'cannot attach to an appointment that has a questionnaire');
select public.admin_attach_questionnaire(current_setting('t.q')::uuid, current_setting('t.appt2')::uuid);
select pg_temp.throws(format($$select public.admin_attach_questionnaire(%L, %L)$$, current_setting('t.q'), current_setting('t.appt2')),
                      '%ma już kwestionariusz%', 'cannot attach twice');
select pg_temp.logout();
select pg_temp.login(current_setting('t.ola')::uuid);
select pg_temp.eq((select answers ->> 'plec' from public.questionnaires where appointment_id = current_setting('t.appt2')::uuid),
                  'Kobieta', 'attached questionnaire belongs to the client');
select pg_temp.logout();

rollback;
