// Dev server: rebuilds on change and serves dist/ on http://127.0.0.1:4173 (the default site_url).
import { watch } from 'node:fs';
import { join } from 'node:path';
import * as esbuild from 'esbuild';
import { config, copyStatic, esbuildOptions, out, pageEntries, src } from './build.mjs';

const cfg = config();
const ctx = await esbuild.context(esbuildOptions(cfg, await pageEntries(), { dev: true }));
await copyStatic('dev');
await ctx.watch();

let timer;
for (const dir of [src, join(src, '..', 'public')]) {
  watch(dir, { recursive: true }, (_event, file) => {
    if (file?.startsWith('ts')) return; // handled by esbuild
    clearTimeout(timer);
    timer = setTimeout(() => copyStatic('dev').catch(console.error), 50);
  });
}

const { hosts, port } = await ctx.serve({ servedir: out, host: '127.0.0.1', port: 4173 });
console.log(`Dev server: http://${hosts[0]}:${port}  (backend: ${cfg.supabaseUrl})`);
