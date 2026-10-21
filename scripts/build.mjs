// Static build: TypeScript pages -> dist/js (esbuild), HTML/CSS/assets copied to dist/,
// Cloudflare Pages _headers (CSP) generated from the Supabase URL.
//
// Env: SUPABASE_URL, SUPABASE_ANON_KEY (public "anon"/publishable key; access is enforced by RLS).
// Without them the build targets a local Supabase started with `supabase start`.
import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const out = join(root, 'dist');

// Default key of every local `supabase start` instance (public, documented by Supabase).
const LOCAL_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

export function config(env = process.env) {
  const supabaseUrl = (env.SUPABASE_URL || 'http://127.0.0.1:54321').replace(/\/+$/, '');
  const anonKey = env.SUPABASE_ANON_KEY || LOCAL_ANON_KEY;
  if (env.CI && (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) && env.ALLOW_LOCAL_BACKEND !== '1') {
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set for CI builds (or ALLOW_LOCAL_BACKEND=1).');
  }
  return { supabaseUrl, anonKey };
}

async function pageEntries() {
  const dir = join(src, 'ts', 'pages');
  return (await readdir(dir)).filter((f) => f.endsWith('.ts')).map((f) => join(dir, f));
}

export function esbuildOptions(cfg, entryPoints, { dev = false } = {}) {
  return {
    entryPoints,
    outdir: join(out, 'js'),
    bundle: true,
    format: 'esm',
    splitting: true,
    target: 'es2022',
    minify: !dev,
    sourcemap: dev ? 'inline' : 'linked',
    chunkNames: 'chunks/[name]-[hash]',
    define: {
      __SUPABASE_URL__: JSON.stringify(cfg.supabaseUrl),
      __SUPABASE_ANON_KEY__: JSON.stringify(cfg.anonKey),
    },
    logLevel: 'warning',
  };
}

function headers(cfg) {
  const api = new URL(cfg.supabaseUrl);
  const ws = `${api.protocol === 'https:' ? 'wss' : 'ws'}://${api.host}`;
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    // Inline style attributes are used for small dynamic sizes (progress bar, plate icons).
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    `img-src 'self' data: blob: ${api.origin}`,
    `connect-src 'self' ${api.origin} ${ws}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
  return `/*
  Content-Security-Policy: ${csp}
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
  Cross-Origin-Opener-Policy: same-origin-allow-popups

/js/*
  Cache-Control: public, max-age=31536000, immutable

/styles/*
  Cache-Control: public, max-age=31536000, immutable

/*.html
  Cache-Control: no-cache

/admin.html
  X-Robots-Tag: noindex
`;
}

export async function copyStatic(buildId) {
  await mkdir(out, { recursive: true });
  await cp(join(root, 'public'), out, { recursive: true });
  await cp(join(src, 'styles'), join(out, 'styles'), { recursive: true });
  for (const file of await readdir(src)) {
    if (!file.endsWith('.html')) continue;
    const html = await readFile(join(src, file), 'utf8');
    await writeFile(join(out, file), html.replaceAll('__BUILD__', buildId));
  }
}

async function buildId() {
  const hash = createHash('sha256');
  for (const dir of ['src', 'public']) {
    const files = await readdir(join(root, dir), { recursive: true, withFileTypes: true });
    for (const f of files.filter((x) => x.isFile()).sort((a, b) => a.name.localeCompare(b.name))) {
      hash.update(await readFile(join(f.parentPath, f.name)));
    }
  }
  return hash.digest('hex').slice(0, 10);
}

export async function build() {
  const cfg = config();
  await rm(out, { recursive: true, force: true });
  await esbuild.build(esbuildOptions(cfg, await pageEntries()));
  await copyStatic(await buildId());
  await writeFile(join(out, '_headers'), headers(cfg));
  console.log(`Built dist/ for ${cfg.supabaseUrl}`);
}

export { pageEntries, out, src, headers };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await build();
}
