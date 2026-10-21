// Builds the tiny site that keeps the old GitHub Pages address working: every path redirects to SITE_URL.
// Usage: node scripts/legacy-redirect.mjs https://zdrowko-za-zdrowie.pages.dev _legacy
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [target, outDir = '_legacy'] = process.argv.slice(2);
if (!target || !/^https:\/\//.test(target)) throw new Error('Usage: legacy-redirect.mjs <https://new-site> [outDir]');
const site = target.replace(/\/+$/, '');

// The old site lived under /zdrowko_za_zdrowie/; keep the hash (e.g. #oferta) and drop the repo prefix.
const page = `<!doctype html>
<html lang="pl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Zdrówko za zdrowie – nowy adres</title>
  <meta name="robots" content="noindex">
  <link rel="canonical" href="${site}/">
  <meta http-equiv="refresh" content="0; url=${site}/">
  <script>
    var path = location.pathname.replace(/^\\/zdrowko_za_zdrowie/, '') || '/';
    location.replace(${JSON.stringify(site)} + path + location.search + location.hash);
  </script>
</head>
<body style="font-family:system-ui,sans-serif;padding:24px">
  <p>Strona przeniosła się pod nowy adres: <a href="${site}/">${site.replace('https://', '')}</a></p>
</body>
</html>
`;

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'index.html'), page);
await writeFile(join(outDir, '404.html'), page);
await writeFile(join(outDir, '.nojekyll'), '');
console.log(`Redirect site for ${site} written to ${outDir}/`);
