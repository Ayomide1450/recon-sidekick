// Minimal static server for the preview harness. ES modules are blocked on file://,
// so the dashboard has to be served over HTTP to be viewed or screenshotted.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || 8731);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

createServer(async (request, response) => {
  try {
    const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    // Confine every read to the project root.
    const resolved = join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, ''));
    if (!resolved.startsWith(ROOT)) {
      response.writeHead(403).end('forbidden');
      return;
    }
    const body = await readFile(resolved);
    response.writeHead(200, { 'content-type': TYPES[extname(resolved)] || 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404).end('not found');
  }
}).listen(PORT, () => {
  console.log(`preview: http://localhost:${PORT}/tools/preview.html`);
});
