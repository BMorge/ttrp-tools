import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'vite';

/**
 * Shared code of the tools repository scripts: tool discovery, trusted shell origins, response headers
 * of the tools host and the per-tool Vite build. Nothing here knows about a particular host deployment:
 * TtRP's own integration (catalog of connected tools, production build) lives outside this folder.
 */

export const TOOLS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SDK_DIR = path.join(TOOLS_ROOT, 'sdk');
export const DEV_HOST_DIR = path.join(TOOLS_ROOT, 'dev-host');
export const TEMPLATE_DIR = path.join(TOOLS_ROOT, 'template');
export const TOOLS_PORT = 5173;
export const DEV_HOST_PORT = 5180;

/** Folders of the repository that are not tools. */
export const RESERVED_NAMES = new Set(['sdk', 'dev-host', 'scripts', 'docs', 'legal', 'dist', 'node_modules']);

const DEFAULT_APP_URL = 'https://timetoroleplay.ru';
const DEFAULT_DEV_HOST_ORIGINS = ['http://localhost:3000', `http://localhost:${DEV_HOST_PORT}`];
export const TOOL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const VERSION_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Every folder with a tool.manifest.json; the folder name must equal the manifest id. */
export function discoverTools() {
  return fs.readdirSync(TOOLS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !RESERVED_NAMES.has(entry.name))
    .map((entry) => path.join(TOOLS_ROOT, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, 'tool.manifest.json')))
    .map((dir) => {
      const manifest = readJson(path.join(dir, 'tool.manifest.json'));
      const folder = path.basename(dir);
      if (manifest.id !== folder) {
        throw new Error(`${folder}/tool.manifest.json: id "${manifest.id}" must equal the folder name`);
      }
      if (!TOOL_ID_PATTERN.test(manifest.id)) {
        throw new Error(`${folder}/tool.manifest.json: invalid id "${manifest.id}"`);
      }
      if (!VERSION_PATTERN.test(manifest.version ?? '')) {
        throw new Error(`${folder}/tool.manifest.json: invalid version "${manifest.version}"`);
      }
      return { id: manifest.id, manifest, dir };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function directorySize(dir) {
  let total = 0;
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const itemPath = path.join(dir, item.name);
    total += item.isDirectory() ? directorySize(itemPath) : fs.statSync(itemPath).size;
  }
  return total;
}

export function formatBytes(bytes) {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(1)} KB`;
}

function toOrigin(rawUrl) {
  const normalized = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
  return new URL(normalized).origin;
}

/**
 * Shell origins a tool build accepts HOST_HELLO from and allows in `frame-ancestors`.
 * `TTRP_TOOLS_HOST_ORIGINS` (comma-separated) overrides the defaults: in development the TtRP dev shell
 * (http://localhost:3000) and the dev host of this repository; in production the TtRP site.
 */
export function resolveHostOrigins(mode, env) {
  const explicit = (env.TTRP_TOOLS_HOST_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (explicit.length > 0) {
    return explicit.map(toOrigin);
  }
  if (mode === 'development') {
    return DEFAULT_DEV_HOST_ORIGINS;
  }
  return [toOrigin(env.NEXT_PUBLIC_APP_URL || env.NEXT_PUBLIC_SITE_URL || DEFAULT_APP_URL)];
}

/** Headers of every tools host response; TtRP production nginx mirrors them. */
export function toolResponseHeaders({ hostOrigins, devServerOrigin = null }) {
  const connectSources = ["'self'"];
  if (devServerOrigin) {
    connectSources.push(devServerOrigin.replace(/^http/, 'ws'));
  }
  const contentSecurityPolicy = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self' blob:",
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    `connect-src ${connectSources.join(' ')}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${hostOrigins.join(' ')}`,
  ].join('; ');

  return {
    'Content-Security-Policy': contentSecurityPolicy,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=()',
  };
}

/**
 * Folders the dev servers may read: this repository and the folder holding its node_modules
 * (inside the TtRP monorepo dependencies live one level up, in front/node_modules).
 */
export function devServerAllowList() {
  const vitePackage = createRequire(import.meta.url).resolve('vite/package.json');
  const dependencyRoot = vitePackage.slice(0, vitePackage.lastIndexOf(`${path.sep}node_modules${path.sep}`));
  return [...new Set([TOOLS_ROOT, dependencyRoot])];
}

export function toolAliases() {
  return { '@tools-sdk': SDK_DIR };
}

/**
 * Inline (empty) PostCSS config: tools never pick up a config from the folders above — inside the TtRP
 * monorepo that would be the site's Tailwind — so a build is the same in both repositories.
 */
export const TOOLS_CSS_OPTIONS = { postcss: { plugins: [] } };

/** Builds each tool into <outDir>/<id>/<version>/ and copies its manifest next to the entrypoint. */
export async function buildTools({ tools, outDir, hostOrigins, clean = true }) {
  if (clean) {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  const built = [];
  for (const tool of tools) {
    const releaseDir = path.join(outDir, tool.id, tool.manifest.version);
    const entrypoint = tool.manifest.entrypoint.replace(/^\.\//, '');

    await build({
      configFile: false,
      root: tool.dir,
      base: './',
      mode: 'production',
      logLevel: 'warn',
      resolve: { alias: toolAliases() },
      css: TOOLS_CSS_OPTIONS,
      define: { __TTRP_HOST_ORIGINS__: JSON.stringify(hostOrigins) },
      build: {
        outDir: releaseDir,
        emptyOutDir: true,
        target: 'es2022',
        sourcemap: false,
        reportCompressedSize: false,
        // Rapier ships its WebAssembly inlined as base64 (≈4.9 MB raw, ≈1.8 MB gzip) in the engine chunk.
        chunkSizeWarningLimit: 6144,
        rollupOptions: { input: path.join(tool.dir, entrypoint) },
      },
    });

    if (!fs.existsSync(path.join(releaseDir, entrypoint))) {
      throw new Error(`${tool.id}: the build has no entrypoint ${entrypoint}`);
    }
    fs.copyFileSync(path.join(tool.dir, 'tool.manifest.json'), path.join(releaseDir, 'tool.manifest.json'));
    built.push({ ...tool, releaseDir, size: directorySize(releaseDir) });
  }
  return built;
}

/** `--name value` pairs and flags from process.argv. */
export function parseArgs(argv = process.argv.slice(2)) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith('--')) {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        options[arg.slice(2)] = next;
        index += 1;
      } else {
        options[arg.slice(2)] = true;
      }
    } else {
      options._.push(arg);
    }
  }
  return options;
}
