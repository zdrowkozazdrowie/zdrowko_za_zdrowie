\ir _helpers.sql
begin;

select private.configure('https://zdrowko.test', array['admin@example.com'], 'Test <wizyty@zdrowko.test>');
update private.settings set booking_horizon_days = 28, min_notice_hours = 0;
select set_config('t.admin', pg_temp.mk_user('admin@example.com', 'Wiktoria Admin')::text, true);
select set_config('t.anna',  pg_temp.mk_user('anna@example.com', 'Anna Kowalska')::text, true);
delete from public.slots;

-- Only admins manage the schedule
select pg_temp.login(current_setting('t.anna')::uuid);
select pg_temp.throws($$select public.admin_set_work_hours('[]')$$, '%Brak uprawnień%', 'client cannot set working hours');
select pg_temp.throws($$select public.admin_add_time_off(current_date + 1)$$, '%Brak uprawnień%', 'client cannot add time off');
select pg_temp.eq((select count(*) from public.work_hours), 0::bigint, 'client cannot read working hours');
select pg_temp.logout();
select pg_temp.login_anon();
select pg_temp.throws($$select public.admin_set_work_hours('[]')$$, '%permission denied%', 'anon cannot set working hours');
select pg_temp.logout();

-- Validation
select pg_temp.login(current_setting('t.admin')::uuid);
select pg_temp.throws($$select public.admin_set_work_hours('[{"weekday":1,"from":"12:00","to":"09:00"}]')$$,
                      '%późniejsza%', 'end must be after start');
select pg_temp.throws($$select public.admin_set_work_hours('[{"weekday":1,"from":"09:00","to":"12:00"},{"weekday":1,"from":"11:00","to":"14:00"}]')$$,
                      '%nakładają%', 'overlapping ranges are rejected');
select pg_temp.throws($$select public.admin_set_work_hours('[{"weekday":8,"from":"09:00","to":"12:00"}]')$$,
                      '%późniejsza%', 'weekday must be 1–7');
select pg_temp.throws($$select public.admin_set_work_hours('[{"weekday":1,"from":"09:00","to":"09:30"}]', 60)$$,
                      '%krótszy%', 'range must fit one visit');
select pg_temp.throws($$select public.admin_set_work_hours('[{"weekday":"x"}]')$$, '%Nieprawidłowe%', 'garbage is rejected');

-- Every weekday 09:00–12:00 and 16:00–18:00 on Mondays, 60 min visits, 15 min break
select public.admin_set_work_hours(
  (select jsonb_agg(jsonb_build_object('weekday', d, 'from', '09:00', 'to', '12:00')) from generate_series(1, 7) d)
  || '[{"weekday":1,"from":"16:00","to":"18:00"}]'::jsonb, 60, 15);
select pg_temp.eq((select count(*) from public.work_hours), 8::bigint, 'schedule is stored');
select pg_temp.logout();

-- 09:00, 10:15 fit in 09–12 (11:30 + 60 min would end after 12:00); 16:00 fits on Mondays.
select set_config('t.day', ((now() at time zone 'Europe/Warsaw')::date + 2)::text, true);
select pg_temp.eq((select count(*) from public.slots
                    where (starts_at at time zone 'Europe/Warsaw')::date = current_setting('t.day')::date),
                  case when extract(isodow from current_setting('t.day')::date) = 1 then 3::bigint else 2::bigint end,
                  'slots are generated from the schedule with breaks');
select pg_temp.eq((select min((starts_at at time zone 'Europe/Warsaw')::time) from public.slots
                    where (starts_at at time zone 'Europe/Warsaw')::date = current_setting('t.day')::date),
                  time '09:00', 'first slot starts at the beginning of the working hours');
select pg_temp.ok((select bool_and(generated) from public.slots), 'generated slots are marked');
select pg_temp.ok((select max(starts_at) from public.slots) < now() + interval '30 days', 'slots stay within the horizon');
select pg_temp.ok((select min(starts_at) from public.slots) > now(), 'no slots in the past');

select pg_temp.login_anon();
select pg_temp.ok((select count(*) from public.get_free_slots()) > 40, 'clients see the generated slots');
select pg_temp.logout();

-- Booked slots survive schedule changes
select set_config('t.slot', (select id::text from public.slots
                              where (starts_at at time zone 'Europe/Warsaw')::date = current_setting('t.day')::date
                              order by starts_at limit 1), true);
select pg_temp.login(current_setting('t.anna')::uuid);
select set_config('t.appt', public.book_appointment('pierwsza-konsultacja', current_setting('t.slot')::uuid)::text, true);
select pg_temp.logout();

select pg_temp.login(current_setting('t.admin')::uuid);
select public.admin_set_work_hours('[{"weekday":2,"from":"10:00","to":"13:00"}]', 90, 0);
select pg_temp.logout();
select pg_temp.ok(exists (select 1 from public.slots where id = current_setting('t.slot')::uuid), 'booked slot is kept');
select pg_temp.eq((select count(*) from public.slots s
                    where s.generated and s.id <> current_setting('t.slot')::uuid
                      and extract(isodow from s.starts_at at time zone 'Europe/Warsaw') <> 2), 0::bigint,
                  'free slots outside the new schedule are removed');
select pg_temp.ok((select bool_and((starts_at at time zone 'Europe/Warsaw')::time in ('10:00', '11:30'))
                     from public.slots where id <> current_setting('t.slot')::uuid), 'new schedule uses 90-minute visits');

-- Hand-made slots are kept when the schedule changes
select pg_temp.login(current_setting('t.admin')::uuid);
select public.admin_add_slots(current_setting('t.day')::date + 1, '18:00', '19:00', 60, 0);
select public.admin_set_work_hours('[{"weekday":2,"from":"10:00","to":"13:00"}]', 90, 0);
select pg_temp.logout();
select pg_temp.eq((select count(*) from public.slots where not generated), 1::bigint, 'hand-made slot survives a sync');

-- Time off removes free slots and stops generating them
select set_config('t.tue', (select min((starts_at at time zone 'Europe/Warsaw')::date)::text from public.slots
                             where generated and id <> current_setting('t.slot')::uuid
                               and (starts_at at time zone 'Europe/Warsaw')::date > (now() at time zone 'Europe/Warsaw')::date), true);
select pg_temp.login(current_setting('t.admin')::uuid);
select pg_temp.throws(format($$select public.admin_add_time_off(%L, '10:00', null)$$, current_setting('t.tue')),
                      '%od–do%', 'time off needs both times or none');
select set_config('t.off', public.admin_add_time_off(current_setting('t.tue')::date, null, null, 'Urlop')::text, true);
select pg_temp.logout();
select pg_temp.eq((select count(*) from public.slots
                    where (starts_at at time zone 'Europe/Warsaw')::date = current_setting('t.tue')::date
                      and id <> current_setting('t.slot')::uuid), 0::bigint,
                  'day off has no slots');
select private.sync_slots();
select pg_temp.eq((select count(*) from public.slots
                    where (starts_at at time zone 'Europe/Warsaw')::date = current_setting('t.tue')::date
                      and id <> current_setting('t.slot')::uuid), 0::bigint,
                  'day off stays empty after a sync');
select pg_temp.login(current_setting('t.admin')::uuid);
select public.admin_delete_time_off(current_setting('t.off')::uuid);
select pg_temp.logout();
select pg_temp.eq((select count(*) from public.slots
                    where (starts_at at time zone 'Europe/Warsaw')::date = current_setting('t.tue')::date
                      and id <> current_setting('t.slot')::uuid), 2::bigint,
                  'removing time off brings the slots back');

-- Partial time off blocks only those hours
select pg_temp.login(current_setting('t.admin')::uuid);
select public.admin_add_time_off(current_setting('t.tue')::date, '11:00', '13:00');
select pg_temp.logout();
select pg_temp.eq((select count(*) from public.slots
                    where (starts_at at time zone 'Europe/Warsaw')::date = current_setting('t.tue')::date
                      and id <> current_setting('t.slot')::uuid), 0::bigint,
                  'blocked hours remove overlapping slots (10:00–11:30 and 11:30–13:00)');

-- Deleting a generated slot does not bring it back on the next sync
select set_config('t.gen', (select id::text from public.slots where generated and id <> current_setting('t.slot')::uuid
                             order by starts_at limit 1), true);
select set_config('t.gen_at', (select starts_at::text from public.slots where id = current_setting('t.gen')::uuid), true);
select pg_temp.login(current_setting('t.admin')::uuid);
select public.admin_delete_slot(current_setting('t.gen')::uuid);
select pg_temp.logout();
select private.sync_slots();
select pg_temp.ok(not exists (select 1 from public.slots where starts_at = current_setting('t.gen_at')::timestamptz),
                  'deleted generated slot stays deleted');
select pg_temp.ok(exists (select 1 from public.time_off where note = 'Usunięty termin'), 'deleting a slot records blocked hours');

-- Booked slot cannot be deleted; daily job exists
select pg_temp.login(current_setting('t.admin')::uuid);
select pg_temp.throws(format($$select public.admin_delete_slot(%L)$$, current_setting('t.slot')), '%zarezerwowany%',
                      'booked slot cannot be deleted');
select pg_temp.eq((public.admin_booking_settings() ->> 'horizon_days')::int, 28, 'admin reads booking settings');
select pg_temp.logout();
select pg_temp.eq((select count(*) from cron.job where jobname = 'sync-slots'), 1::bigint, 'daily slot sync is scheduled');

rollback;
