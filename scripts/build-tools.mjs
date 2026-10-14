import fs from 'node:fs';
import path from 'node:path';

import { build, loadEnv } from 'vite';

import {
  FRONT_DIR,
  TOOLS_DIST_DIR,
  directorySize,
  formatBytes,
  readToolDefinitions,
  resolveHostOrigins,
  toolAliases,
} from './tools-config.mjs';

/**
 * Builds every enabled tool into front/tools-dist/<id>/<version>/.
 * The directory lives outside public/: Next does not serve it and the service worker never precaches it.
 * Production serves it from the tools host (infra/prod/nginx/sites-available/tools.timetoroleplay.ru).
 */

const env = loadEnv('production', FRONT_DIR, ['NEXT_PUBLIC_', 'TTRP_']);
const hostOrigins = resolveHostOrigins('production', env);

fs.rmSync(TOOLS_DIST_DIR, { recursive: true, force: true });

for (const { entry, manifest, toolDir } of readToolDefinitions()) {
  if (entry.enabled !== true) {
    console.log(`tools: ${manifest.id} is disabled, skipped`);
    continue;
  }

  const outDir = path.join(TOOLS_DIST_DIR, manifest.id, manifest.version);
  const entrypoint = manifest.entrypoint.replace(/^\.\//, '');

  await build({
    configFile: false,
    root: toolDir,
    base: './',
    mode: 'production',
    logLevel: 'warn',
    resolve: { alias: toolAliases() },
    define: { __TTRP_HOST_ORIGINS__: JSON.stringify(hostOrigins) },
    build: {
      outDir,
      emptyOutDir: true,
      target: 'es2022',
      sourcemap: false,
      reportCompressedSize: false,
      // Rapier ships its WebAssembly inlined as base64 (≈4.9 MB raw, ≈1.8 MB gzip) in the engine chunk.
      chunkSizeWarningLimit: 6144,
      rollupOptions: { input: path.join(toolDir, entrypoint) },
    },
  });

  if (!fs.existsSync(path.join(outDir, entrypoint))) {
    throw new Error(`tools: ${manifest.id} build has no entrypoint ${entrypoint}`);
  }
  fs.copyFileSync(path.join(toolDir, 'tool.manifest.json'), path.join(outDir, 'tool.manifest.json'));

  console.log(
    `tools: ${manifest.id}@${manifest.version} → ${path.relative(FRONT_DIR, outDir)} (${formatBytes(directorySize(outDir))})`,
  );
}

console.log(`tools: trusted shell origins — ${hostOrigins.join(', ')}`);
