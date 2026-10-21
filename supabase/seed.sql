-- Local development only (`supabase start` / `supabase db reset`). Production is configured by CD.
-- Kept free of rows in tested tables, because tests/db count rows.
-- Sign in locally as admin@zdrowko.local (e-mails land in Mailpit: http://127.0.0.1:54324).
select private.configure(
  'http://127.0.0.1:4173',
  array['admin@zdrowko.local'],
  'Zdrówko za zdrowie <onboarding@resend.dev>'
);
