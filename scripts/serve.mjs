// Minimal static server for dist/ (used by E2E tests and `npm run preview`).
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const port = Number(process.env.PORT || 4173);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
};

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(root, path.endsWith('/') ? `${path}index.html` : path);
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`Serving dist/ on http://127.0.0.1:${port}`));
