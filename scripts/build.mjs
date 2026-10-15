import path from 'node:path';

import { loadEnv } from 'vite';

import {
  TOOLS_ROOT,
  buildTools,
  discoverTools,
  formatBytes,
  parseArgs,
  resolveHostOrigins,
} from './lib.mjs';

/**
 * Production build of the tools: `npm run build [-- --out dist] [-- --only dice,my-tool]`.
 * The result is static: <out>/<id>/<version>/index.html plus hashed assets, served by a tools host.
 * Trusted shell origins: `--host-origins a,b`, else TTRP_TOOLS_HOST_ORIGINS, else the TtRP production site.
 */

const options = parseArgs();
const env = loadEnv('production', TOOLS_ROOT, ['NEXT_PUBLIC_', 'TTRP_']);
const hostOrigins = typeof options['host-origins'] === 'string'
  ? resolveHostOrigins('production', { TTRP_TOOLS_HOST_ORIGINS: options['host-origins'] })
  : resolveHostOrigins('production', env);
const only = typeof options.only === 'string' ? new Set(options.only.split(',')) : null;
const tools = discoverTools().filter((tool) => !only || only.has(tool.id));
const outDir = path.resolve(process.cwd(), typeof options.out === 'string' ? options.out : path.join(TOOLS_ROOT, 'dist'));

const built = await buildTools({ tools, outDir, hostOrigins });
for (const tool of built) {
  console.log(`tools: ${tool.id}@${tool.manifest.version} → ${path.relative(process.cwd(), tool.releaseDir)} (${formatBytes(tool.size)})`);
}
console.log(`tools: trusted shell origins — ${hostOrigins.join(', ')}`);
