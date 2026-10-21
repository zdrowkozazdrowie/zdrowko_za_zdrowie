\ir _helpers.sql
begin;

select private.configure('https://zdrowko.test', array['admin@example.com'], 'Test <wizyty@zdrowko.test>');
select set_config('t.admin', pg_temp.mk_user('admin@example.com', 'Wiktoria Admin')::text, true);
select set_config('t.anna',  pg_temp.mk_user('anna@example.com', 'Anna Kowalska')::text, true);
select set_config('t.ola',   pg_temp.mk_user('ola@example.com', 'Ola Zielińska')::text, true);

select pg_temp.login(current_setting('t.admin')::uuid);
select public.admin_add_slots((now() at time zone 'Europe/Warsaw')::date + 5, '10:00', '12:00', 60, 0);
select pg_temp.logout();

select pg_temp.login(current_setting('t.anna')::uuid);
select set_config('t.appt', public.book_appointment('pierwsza-konsultacja',
  (select id from public.get_free_slots() limit 1))::text, true);
select pg_temp.throws($$select public.save_questionnaire(current_setting('t.appt')::uuid, '{"plec":"Kobieta"}')$$,
                      '%potwierdzonych%', 'questionnaire is locked until the visit is confirmed');
select pg_temp.logout();

select set_config('t.token', (select token from private.appointment_tokens
                               where appointment_id = current_setting('t.appt')::uuid), true);
select public.decide_appointment(current_setting('t.token'), 'confirm');

-- Draft autosave
select pg_temp.login(current_setting('t.anna')::uuid);
select pg_temp.ok((public.save_questionnaire(current_setting('t.appt')::uuid,
                     '{"plec":"Kobieta","dane":{"wiek":"34"}}', 3)).submitted_at is null, 'draft is saved without submitting');
select pg_temp.eq((select current_step from public.questionnaires where appointment_id = current_setting('t.appt')::uuid),
                  3, 'progress step is stored');
select pg_temp.throws($$select public.save_questionnaire(current_setting('t.appt')::uuid, '[1,2]')$$,
                      '%Nieprawidłowe%', 'answers must be a JSON object');
select pg_temp.throws($$select public.save_questionnaire(current_setting('t.appt')::uuid, '{"a":1}', null, true, false)$$,
                      '%zgodę%', 'submitting requires health data consent');
select pg_temp.throws($$insert into public.questionnaires (appointment_id, user_id) values (current_setting('t.appt')::uuid, auth.uid())$$,
                      '%permission denied%', 'client cannot write the table directly');
select pg_temp.logout();

select pg_temp.eq((select count(*) from private.email_outbox where kind = 'admin_questionnaire_submitted'), 0::bigint,
                  'drafts do not notify the admin');

-- Submit
select pg_temp.login(current_setting('t.anna')::uuid);
select pg_temp.ok((public.save_questionnaire(current_setting('t.appt')::uuid,
                     '{"plec":"Kobieta","dane":{"wiek":"34"},"alkohol":"Rzadziej"}', 55, true, true)).submitted_at is not null,
                  'questionnaire is submitted');
select pg_temp.ok((select health_consent_at is not null from public.questionnaires
                    where appointment_id = current_setting('t.appt')::uuid), 'consent timestamp is stored');
select public.save_questionnaire(current_setting('t.appt')::uuid, '{"plec":"Kobieta","uwagi":"poprawka"}', 55, true, true);
select pg_temp.eq((select answers ->> 'uwagi' from public.questionnaires where appointment_id = current_setting('t.appt')::uuid),
                  'poprawka', 'client can correct a submitted questionnaire');
select pg_temp.logout();

select pg_temp.eq((select count(*) from private.email_outbox where kind = 'admin_questionnaire_submitted'), 1::bigint,
                  'admin is notified once about the submission');

-- Isolation
select pg_temp.login(current_setting('t.ola')::uuid);
select pg_temp.eq((select count(*) from public.questionnaires), 0::bigint, 'other clients cannot read the questionnaire');
select pg_temp.throws($$select public.save_questionnaire(current_setting('t.appt')::uuid, '{}')$$,
                      '%Nie znaleziono%', 'other clients cannot write the questionnaire');
select pg_temp.logout();

select pg_temp.login(current_setting('t.admin')::uuid);
select pg_temp.eq((select answers ->> 'plec' from public.questionnaires where appointment_id = current_setting('t.appt')::uuid),
                  'Kobieta', 'admin reads questionnaire answers');
select pg_temp.logout();

-- Lab results storage: policy logic (paths <user_id>/<appointment_id>/<file>)
select set_config('t.path', current_setting('t.anna') || '/' || current_setting('t.appt') || '/morfologia.pdf', true);
select pg_temp.ok((select count(*) = 3 from pg_policies where schemaname = 'storage' and tablename = 'objects'
                    and policyname like 'wyniki_badan_%'), 'storage policies for lab results exist');
select pg_temp.ok((select public from storage.buckets where id = 'wyniki-badan') is false, 'lab results bucket is private');
select pg_temp.login(current_setting('t.anna')::uuid);
select pg_temp.ok(public.owns_appointment_folder(current_setting('t.path')), 'client may use own visit folder');
select pg_temp.ok(not public.owns_appointment_folder(current_setting('t.anna') || '/' || gen_random_uuid() || '/x.pdf'),
                  'client may not use a visit that is not theirs');
select pg_temp.ok(not public.owns_appointment_folder('x.pdf'), 'files outside a visit folder are rejected');
select pg_temp.logout();
select pg_temp.login(current_setting('t.ola')::uuid);
select pg_temp.ok(not public.owns_appointment_folder(current_setting('t.path')), 'other clients may not use someone else''s folder');
select pg_temp.logout();

rollback;
