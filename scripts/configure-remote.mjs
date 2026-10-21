// Configures the hosted Supabase project after migrations (run by CD, idempotent).
// Uses the Supabase Management API, so only an access token is needed (no database password).
//
// Required env: SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF, SITE_URL, ADMIN_EMAILS (comma-separated)
// Optional env: EMAIL_FROM, EMAIL_REPLY_TO, RESEND_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
//               CLOUDFLARE_PROJECT (adds *.<project>.pages.dev preview URLs to the redirect allow-list)
import { readFile } from 'node:fs/promises';

const env = process.env;
for (const name of ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_PROJECT_REF', 'SITE_URL', 'ADMIN_EMAILS']) {
  if (!env[name]) throw new Error(`Missing env ${name}`);
}

const api = `https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}`;
const siteUrl = env.SITE_URL.replace(/\/+$/, '');
const adminEmails = env.ADMIN_EMAILS.split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);
const emailFrom = env.EMAIL_FROM || 'Zdrówko za zdrowie <onboarding@resend.dev>';
// Supabase Auth can send through Resend only from a verified domain (not the resend.dev sandbox).
const ownDomain = Boolean(env.RESEND_API_KEY) && !/@resend\.dev>?$/i.test(emailFrom);

async function call(method, path, body) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

const lit = (v) => (v == null || v === '' ? 'null' : `'${String(v).replaceAll("'", "''")}'`);
const sql = (query) => call('POST', '/database/query', { query });

// 1. Application settings (private.settings) and the Resend key (Vault).
await sql(
  `select private.configure(${lit(siteUrl)}, array[${adminEmails.map(lit).join(', ')}]::text[], ${lit(emailFrom)}, ${lit(env.EMAIL_REPLY_TO)})`,
);
if (env.RESEND_API_KEY) await sql(`select private.set_secret('resend_api_key', ${lit(env.RESEND_API_KEY)})`);
console.log(
  `✓ settings: site ${siteUrl}, admins ${adminEmails.length}, e-mails ${env.RESEND_API_KEY ? 'on' : 'off (no RESEND_API_KEY)'}`,
);

// 2. Auth: redirect allow-list, passwordless e-mail templates, Google, SMTP.
const template = await readFile(new URL('../supabase/templates/magic-link.html', import.meta.url), 'utf8');
const subject = 'Twój link do logowania – Zdrówko za zdrowie';
const allow = [`${siteUrl}/**`];
if (env.CLOUDFLARE_PROJECT) allow.push(`https://*.${env.CLOUDFLARE_PROJECT}.pages.dev/**`);

const auth = {
  site_url: siteUrl,
  uri_allow_list: allow.join(','),
  disable_signup: false,
  external_email_enabled: true,
  mailer_otp_length: 6,
  mailer_otp_exp: 3600,
};
if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
  Object.assign(auth, {
    external_google_enabled: true,
    external_google_client_id: env.GOOGLE_CLIENT_ID,
    external_google_secret: env.GOOGLE_CLIENT_SECRET,
  });
}
if (ownDomain) {
  const match = /^(.*?)\s*<([^>]+)>$/.exec(emailFrom);
  Object.assign(auth, {
    smtp_host: 'smtp.resend.com',
    smtp_port: '465',
    smtp_user: 'resend',
    smtp_pass: env.RESEND_API_KEY,
    smtp_admin_email: match ? match[2] : emailFrom,
    smtp_sender_name: match ? match[1] : 'Zdrówko za zdrowie',
    rate_limit_email_sent: 100,
    // Free tier allows custom templates only with own SMTP. The default template has the link but no code.
    mailer_subjects_magic_link: subject,
    mailer_templates_magic_link_content: template,
    mailer_subjects_confirmation: subject,
    mailer_templates_confirmation_content: template,
  });
}
await call('PATCH', '/config/auth', auth);
console.log(
  `✓ auth: redirects ${allow.join(' ')}, Google ${auth.external_google_enabled ? 'on' : 'off'}, SMTP ${ownDomain ? 'Resend' : 'Supabase default (team members only)'}`,
);
