import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { loadEnv } from 'vite';

import {
  DEV_TOOLS_PORT,
  FRONT_DIR,
  TOOLS_DIST_DIR,
  resolveHostOrigins,
  toolResponseHeaders,
} from './tools-config.mjs';

/**
 * Serves the built tools (front/tools-dist) the way production nginx does: release paths only,
 * the same security headers, HTML revalidated, hashed assets immutable. Lets you check the built
 * bundle locally; build it for the local shell first:
 *   TTRP_TOOLS_HOST_ORIGINS=http://localhost:3000 npm run build:tools
 */

const env = loadEnv('development', FRONT_DIR, ['NEXT_PUBLIC_', 'TTRP_']);
const hostOrigins = resolveHostOrigins('development', env);
const securityHeaders = toolResponseHeaders({ hostOrigins });
const RELEASE_PATH = /^\/[a-z0-9-]+\/\d+\.\d+\.\d+\//;
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

if (!fs.existsSync(TOOLS_DIST_DIR)) {
  console.error('tools: front/tools-dist is missing — run `npm run build:tools` first');
  process.exit(1);
}

const server = http.createServer((request, response) => {
  const reply = (status, text) => {
    response.writeHead(status, { ...securityHeaders, 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(text);
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    reply(405, 'Method not allowed');
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
  } catch {
    reply(400, 'Bad request');
    return;
  }
  const file = path.normalize(path.join(TOOLS_DIST_DIR, pathname));
  if (
    !RELEASE_PATH.test(pathname)
    || !file.startsWith(TOOLS_DIST_DIR + path.sep)
    || !fs.existsSync(file)
    || !fs.statSync(file).isFile()
  ) {
    reply(404, 'Not found');
    return;
  }

  const extension = path.extname(file);
  response.writeHead(200, {
    ...securityHeaders,
    'Content-Type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
    'Content-Length': fs.statSync(file).size,
    'Cache-Control': extension === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  fs.createReadStream(file).pipe(response);
});

server.listen(DEV_TOOLS_PORT, 'localhost', () => {
  console.log(`tools: built tools on http://localhost:${DEV_TOOLS_PORT} (from front/tools-dist)`);
  console.log(`tools: trusted shell origins — ${hostOrigins.join(', ')}`);
  for (const id of fs.readdirSync(TOOLS_DIST_DIR)) {
    for (const version of fs.readdirSync(path.join(TOOLS_DIST_DIR, id))) {
      console.log(`tools: ${id} → http://localhost:${DEV_TOOLS_PORT}/${id}/${version}/index.html`);
    }
  }
});
