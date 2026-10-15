import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { loadEnv } from 'vite';

import { TOOLS_PORT, TOOLS_ROOT, parseArgs, resolveHostOrigins, toolResponseHeaders } from './lib.mjs';

/**
 * Serves built tools the way a production tools host does: release paths only, the same security
 * headers, HTML revalidated, hashed assets immutable. `npm run serve [-- --dir dist]`.
 * Build for a local shell first, e.g. TTRP_TOOLS_HOST_ORIGINS=http://localhost:5180 npm run build.
 */

const options = parseArgs();
const root = path.resolve(process.cwd(), typeof options.dir === 'string' ? options.dir : path.join(TOOLS_ROOT, 'dist'));
const env = loadEnv('development', TOOLS_ROOT, ['NEXT_PUBLIC_', 'TTRP_']);
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

if (!fs.existsSync(root)) {
  console.error(`tools: ${root} is missing — build the tools first`);
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
  const file = path.normalize(path.join(root, pathname));
  if (
    !RELEASE_PATH.test(pathname)
    || !file.startsWith(root + path.sep)
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

server.listen(TOOLS_PORT, 'localhost', () => {
  console.log(`tools: built tools on http://localhost:${TOOLS_PORT} from ${path.relative(process.cwd(), root) || '.'}`);
  console.log(`tools: frame-ancestors — ${hostOrigins.join(', ')}`);
  for (const id of fs.readdirSync(root)) {
    const toolDir = path.join(root, id);
    if (!fs.statSync(toolDir).isDirectory()) {
      continue;
    }
    for (const version of fs.readdirSync(toolDir)) {
      console.log(`tools: ${id} → http://localhost:${TOOLS_PORT}/${id}/${version}/index.html`);
    }
  }
});
