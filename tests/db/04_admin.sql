\ir _helpers.sql
begin;

select private.configure('https://zdrowko.test', array['admin@example.com'], 'Test <wizyty@zdrowko.test>');
select set_config('t.admin', pg_temp.mk_user('admin@example.com', 'Wiktoria Admin')::text, true);
select set_config('t.anna',  pg_temp.mk_user('anna@example.com', 'Anna Kowalska')::text, true);

select pg_temp.login(current_setting('t.admin')::uuid);
select public.admin_add_slots(((now() at time zone 'Europe/Warsaw')::date + 3), '09:00', '11:00', 60, 0);
select pg_temp.logout();

select pg_temp.login(current_setting('t.anna')::uuid);
select set_config('t.appt',
  public.book_appointment('pierwsza-konsultacja', (select id from public.slots order by starts_at limit 1), 'online', null, null, '+48 600 100 200')::text,
  true);
select pg_temp.logout();

-- Non-admins
select pg_temp.login(current_setting('t.anna')::uuid);
select pg_temp.throws($$select * from public.admin_clients()$$, '%Brak uprawnień%', 'client cannot list clients');
select pg_temp.throws($$select * from public.admin_email_log()$$, '%Brak uprawnień%', 'client cannot read the e-mail log');
select pg_temp.throws($$select * from public.admin_db_tables()$$, '%Brak uprawnień%', 'client cannot list tables');
select pg_temp.throws($$select public.admin_db_rows('profiles')$$, '%Brak uprawnień%', 'client cannot browse tables');
select pg_temp.logout();

select pg_temp.login_anon();
select pg_temp.throws($$select * from public.admin_clients()$$, '%permission denied%', 'anon cannot call admin_clients');
select pg_temp.throws($$select public.admin_db_rows('profiles')$$, '%permission denied%', 'anon cannot call admin_db_rows');
select pg_temp.logout();

-- Admin
select pg_temp.login(current_setting('t.admin')::uuid);
select pg_temp.eq((select count(*) from public.admin_clients()), 2::bigint, 'admin sees all clients');
select pg_temp.eq((select appointments_upcoming from public.admin_clients() where id = current_setting('t.anna')::uuid), 1::bigint,
                  'client overview counts the upcoming appointment');
select pg_temp.eq((select phone from public.admin_clients() where id = current_setting('t.anna')::uuid), '+48 600 100 200',
                  'client overview includes contact data');
select pg_temp.ok((select count(*) from public.admin_email_log()) >= 2, 'admin reads the e-mail log');
select pg_temp.eq((select count(*) from public.admin_db_tables()), 6::bigint, 'six tables are browsable');
select pg_temp.eq((public.admin_db_rows('appointments') ->> 'total')::int, 1, 'appointments table has one row');
select pg_temp.eq((public.admin_db_rows('profiles', 50, 0, 'kowalska') ->> 'total')::int, 1, 'search filters rows');
select pg_temp.eq((public.admin_db_rows('profiles', 1, 1) -> 'rows' -> 0 ->> '_rn'), null::text, 'helper column is not exposed');
select pg_temp.eq(jsonb_array_length(public.admin_db_rows('slots', 1, 0) -> 'rows'), 1, 'limit is applied');
select pg_temp.ok(not (public.admin_db_rows('email_outbox') -> 'rows' -> 0 ? 'html'), 'e-mail bodies are not exposed');
select pg_temp.throws($$select public.admin_db_rows('pg_authid')$$, '%Nieznana tabela%', 'only whitelisted tables');
select pg_temp.throws($$select public.admin_db_rows('profiles; drop table public.profiles')$$, '%Nieznana tabela%',
                      'table name cannot inject SQL');
select pg_temp.logout();

rollback;
