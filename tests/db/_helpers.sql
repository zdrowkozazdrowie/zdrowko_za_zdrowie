-- Tiny assertion helpers for SQL tests (each test file runs in a transaction that is rolled back).
\set ON_ERROR_STOP 1
set client_min_messages = notice;

create or replace function pg_temp.ok(p_cond boolean, p_msg text) returns void
language plpgsql as $$
begin
  if p_cond is not true then
    raise exception 'not ok - %', p_msg;
  end if;
  raise notice 'ok - %', p_msg;
end;
$$;

create or replace function pg_temp.eq(p_got anyelement, p_want anyelement, p_msg text) returns void
language plpgsql as $$
begin
  if p_got is distinct from p_want then
    raise exception 'not ok - % (got: %, want: %)', p_msg, p_got, p_want;
  end if;
  raise notice 'ok - %', p_msg;
end;
$$;

create or replace function pg_temp.throws(p_sql text, p_like text, p_msg text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm ilike p_like then
      raise notice 'ok - %', p_msg;
      return;
    end if;
    raise exception 'not ok - % (unexpected error: %)', p_msg, sqlerrm;
  end;
  raise exception 'not ok - % (no error raised)', p_msg;
end;
$$;

-- Simulates PostgREST requests: role + JWT claims for the current transaction.
create or replace function pg_temp.login(p_uid uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
end;
$$;

create or replace function pg_temp.login_anon() returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  execute 'set local role anon';
end;
$$;

create or replace function pg_temp.logout() returns void
language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end;
$$;

create or replace function pg_temp.mk_user(p_email text, p_name text default null, p_confirmed boolean default true)
returns uuid
language sql as $$
  insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
  values (gen_random_uuid(), p_email, case when p_confirmed then now() end,
          case when p_name is null then '{}'::jsonb else jsonb_build_object('full_name', p_name) end)
  returning id
$$;
