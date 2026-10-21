\ir _helpers.sql
begin;

select private.configure('https://zdrowko.test/', array['admin@example.com'], 'Zdrówko <wizyty@zdrowko.test>', 'kontakt@zdrowko.test');
select pg_temp.eq((select site_url from private.settings), 'https://zdrowko.test', 'trailing slash is removed from site URL');

select private.set_secret('resend_api_key', 're_test_1');
select private.set_secret('resend_api_key', 're_test_2');
select pg_temp.eq(private.get_secret('resend_api_key'), 're_test_2', 'secret is upserted in Vault');

-- Send through pg_net
select set_config('t.mail', private.enqueue_email('anna@example.com', 'Temat', '<p>Treść</p>', 'test')::text, true);
select pg_temp.eq((select status from private.email_outbox where id = current_setting('t.mail')::bigint), 'sending',
                  'e-mail is handed to pg_net');
select set_config('t.req', (select request_id::text from private.email_outbox where id = current_setting('t.mail')::bigint), true);
select pg_temp.eq((select url from net.http_request_queue where id = current_setting('t.req')::bigint), 'https://api.resend.com/emails',
                  'request goes to Resend');
select pg_temp.eq((select headers ->> 'Authorization' from net.http_request_queue where id = current_setting('t.req')::bigint),
                  'Bearer re_test_2', 'request uses the API key from Vault');
select pg_temp.eq((select convert_from(body, 'utf8')::jsonb -> 'to' ->> 0 from net.http_request_queue where id = current_setting('t.req')::bigint),
                  'anna@example.com', 'recipient is set');
select pg_temp.eq((select convert_from(body, 'utf8')::jsonb ->> 'reply_to' from net.http_request_queue where id = current_setting('t.req')::bigint),
                  'kontakt@zdrowko.test', 'reply-to is set');

-- Failure -> retry
insert into net._http_response (id, status_code, content) values (current_setting('t.req')::bigint, 500, 'boom');
update private.email_outbox set last_attempt_at = now() - interval '10 minutes' where id = current_setting('t.mail')::bigint;
select private.process_email_queue();
select pg_temp.eq((select status from private.email_outbox where id = current_setting('t.mail')::bigint), 'sending',
                  'failed e-mail is retried');
select pg_temp.eq((select attempts from private.email_outbox where id = current_setting('t.mail')::bigint), 2,
                  'retry increments attempts');
select pg_temp.ok((select last_error like 'HTTP 500%' from private.email_outbox where id = current_setting('t.mail')::bigint),
                  'error is recorded');

-- Success
insert into net._http_response (id, status_code, content)
select request_id, 200, '{"id":"x"}' from private.email_outbox where id = current_setting('t.mail')::bigint;
select private.process_email_queue();
select pg_temp.eq((select status from private.email_outbox where id = current_setting('t.mail')::bigint), 'sent',
                  'successful response marks the e-mail as sent');

-- Gives up after 5 attempts
select set_config('t.mail2', private.enqueue_email('ola@example.com', 'X', 'Y', 'test')::text, true);
update private.email_outbox set attempts = 5 where id = current_setting('t.mail2')::bigint;
insert into net._http_response (id, status_code, content)
select request_id, 422, 'invalid' from private.email_outbox where id = current_setting('t.mail2')::bigint;
select private.process_email_queue();
select pg_temp.eq((select status from private.email_outbox where id = current_setting('t.mail2')::bigint), 'failed',
                  'e-mail is marked failed after 5 attempts');

select pg_temp.ok(private.enqueue_email('', 'X', 'Y', 'test') is null, 'empty recipient is ignored');
select pg_temp.ok(exists (select 1 from cron.job where jobname = 'process-email-queue'), 'queue worker is scheduled');

-- Private schema is not reachable from the API roles
select pg_temp.login_anon();
select pg_temp.throws($$select private.process_email_queue()$$, '%permission denied%', 'anon cannot call private functions');
select pg_temp.logout();

rollback;
