import path from 'node:path';

import { createServer, loadEnv } from 'vite';

import {
  DEV_HOST_DIR,
  DEV_HOST_PORT,
  TOOLS_CSS_OPTIONS,
  TOOLS_PORT,
  TOOLS_ROOT,
  devServerAllowList,
  discoverTools,
  parseArgs,
  resolveHostOrigins,
  toolAliases,
  toolResponseHeaders,
} from './lib.mjs';

/**
 * Development: two origins, like production.
 * - Tools host on http://localhost:5173: every tool at /<id>/<version>/ with HMR and production headers.
 * - Dev host on http://localhost:5180: a stand-in for the TtRP shell that embeds a tool and drives
 *   the bridge (visibility, close, revoke, state). The TtRP dev shell (http://localhost:3000) can embed
 *   the same tools host.
 * `--host-only` starts just the dev host, to check built tools served by `npm run serve`.
 */

const options = parseArgs();
const hostOnly = options['host-only'] === true;

const env = loadEnv('development', TOOLS_ROOT, ['NEXT_PUBLIC_', 'TTRP_']);
const hostOrigins = resolveHostOrigins('development', env);
const toolsOrigin = `http://localhost:${TOOLS_PORT}`;
const tools = discoverTools();
const versions = new Map(tools.map((tool) => [tool.id, tool.manifest.version]));

/** Maps the production layout /<id>/<version>/... onto the source folders <id>/... */
function releasePathsPlugin() {
  return {
    name: 'ttrp-tools-release-paths',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const match = /^\/([a-z0-9-]+)\/(\d+\.\d+\.\d+)(\/.*)?$/.exec(request.url ?? '');
        if (match) {
          const [, id, version, rest = '/'] = match;
          if (versions.get(id) !== version) {
            response.statusCode = 404;
            response.end('Not found');
            return;
          }
          request.url = `/${id}${rest}`;
        }
        next();
      });
    },
  };
}

const toolsServer = hostOnly ? null : await createServer({
  configFile: false,
  root: TOOLS_ROOT,
  base: '/',
  mode: 'development',
  appType: 'mpa',
  cacheDir: path.join(TOOLS_ROOT, 'node_modules/.vite-tools'),
  resolve: { alias: toolAliases() },
  css: TOOLS_CSS_OPTIONS,
  define: { __TTRP_HOST_ORIGINS__: JSON.stringify(hostOrigins) },
  plugins: [releasePathsPlugin()],
  server: {
    host: 'localhost',
    port: TOOLS_PORT,
    strictPort: true,
    headers: toolResponseHeaders({ hostOrigins, devServerOrigin: toolsOrigin }),
    fs: { allow: devServerAllowList() },
  },
});

const devHostServer = await createServer({
  configFile: false,
  root: DEV_HOST_DIR,
  base: '/',
  mode: 'development',
  cacheDir: path.join(TOOLS_ROOT, 'node_modules/.vite-dev-host'),
  resolve: { alias: toolAliases() },
  css: TOOLS_CSS_OPTIONS,
  define: {
    __DEV_HOST_TOOLS__: JSON.stringify(tools.map((tool) => tool.manifest)),
    __DEV_HOST_TOOLS_ORIGIN__: JSON.stringify(toolsOrigin),
  },
  server: {
    host: 'localhost',
    port: DEV_HOST_PORT,
    strictPort: true,
    fs: { allow: devServerAllowList() },
  },
});

await toolsServer?.listen();
await devHostServer.listen();

console.log(`tools: dev host  → http://localhost:${DEV_HOST_PORT}`);
if (toolsServer) {
  console.log(`tools: tools host → ${toolsOrigin} (trusted shells: ${hostOrigins.join(', ')})`);
} else {
  console.log(`tools: --host-only — the dev host embeds whatever serves ${toolsOrigin} (npm run serve)`);
}
for (const tool of tools) {
  console.log(`tools: ${tool.id} → ${toolsOrigin}/${tool.id}/${tool.manifest.version}/index.html`);
}
