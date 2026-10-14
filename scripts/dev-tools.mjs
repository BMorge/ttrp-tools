import path from 'node:path';

import { createServer, loadEnv } from 'vite';

import {
  DEV_TOOLS_PORT,
  FRONT_DIR,
  TOOLS_DIR,
  readToolDefinitions,
  resolveHostOrigins,
  toolAliases,
  toolResponseHeaders,
} from './tools-config.mjs';

/**
 * Local tools host: one Vite dev server on its own origin (http://localhost:5173), the same
 * /<id>/<version>/ paths and response headers as production, plus HMR.
 * The shell (`npm run dev`, http://localhost:3000) embeds tools from here.
 */

const env = loadEnv('development', FRONT_DIR, ['NEXT_PUBLIC_', 'TTRP_']);
const hostOrigins = resolveHostOrigins('development', env);
const devServerOrigin = `http://localhost:${DEV_TOOLS_PORT}`;
const releaseVersions = new Map(
  readToolDefinitions()
    .filter(({ entry }) => entry.enabled === true)
    .map(({ manifest }) => [manifest.id, manifest.version]),
);

/** Maps the production layout /<id>/<version>/... onto the source folders front/tools/<id>/... */
function releasePathsPlugin() {
  return {
    name: 'ttrp-tools-release-paths',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const match = /^\/([a-z0-9-]+)\/(\d+\.\d+\.\d+)(\/.*)?$/.exec(request.url ?? '');
        if (match) {
          const [, id, version, rest = '/'] = match;
          if (releaseVersions.get(id) !== version) {
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

const server = await createServer({
  configFile: false,
  root: TOOLS_DIR,
  base: '/',
  mode: 'development',
  appType: 'mpa',
  cacheDir: path.join(FRONT_DIR, 'node_modules/.vite-tools'),
  resolve: { alias: toolAliases() },
  define: { __TTRP_HOST_ORIGINS__: JSON.stringify(hostOrigins) },
  plugins: [releasePathsPlugin()],
  server: {
    host: 'localhost',
    port: DEV_TOOLS_PORT,
    strictPort: true,
    headers: toolResponseHeaders({ hostOrigins, devServerOrigin }),
    fs: { allow: [FRONT_DIR] },
  },
});

await server.listen();
server.printUrls();
console.log(`tools: trusted shell origins — ${hostOrigins.join(', ')}`);
for (const [id, version] of releaseVersions) {
  console.log(`tools: ${id} → ${devServerOrigin}/${id}/${version}/index.html`);
}
