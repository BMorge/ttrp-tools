import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Shared settings of the embedded tools build: catalog, manifests, trusted shell origins and
 * the response headers of the tools host. Used by next.config.mjs and the tools build/dev scripts.
 */

export const FRONT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const TOOLS_DIR = path.join(FRONT_DIR, 'tools');
export const SDK_DIR = path.join(TOOLS_DIR, 'sdk');
export const TOOLS_DIST_DIR = path.join(FRONT_DIR, 'tools-dist');
export const DEV_TOOLS_PORT = 5173;

const DEFAULT_APP_URL = 'https://timetoroleplay.ru';
const DEFAULT_DEV_HOST_ORIGINS = ['http://localhost:3000'];
const TOOL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const VERSION_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Catalog entries joined with their manifests. The build checks only what it relies on;
 * the shell validates the full schema at runtime and in unit tests.
 */
export function readToolDefinitions() {
  const catalog = readJson(path.join(TOOLS_DIR, 'catalog.json'));
  if (!Array.isArray(catalog.tools)) {
    throw new Error('front/tools/catalog.json: "tools" must be an array');
  }

  const seen = new Set();
  return catalog.tools.map((entry) => {
    if (!TOOL_ID_PATTERN.test(entry.id ?? '')) {
      throw new Error(`front/tools/catalog.json: invalid tool id "${entry.id}"`);
    }
    if (seen.has(entry.id)) {
      throw new Error(`front/tools/catalog.json: duplicate tool id "${entry.id}"`);
    }
    seen.add(entry.id);

    const toolDir = path.join(TOOLS_DIR, entry.id);
    const manifest = readJson(path.join(toolDir, 'tool.manifest.json'));
    if (manifest.id !== entry.id) {
      throw new Error(`front/tools/${entry.id}/tool.manifest.json: id "${manifest.id}" must equal the folder name`);
    }
    if (!VERSION_PATTERN.test(manifest.version ?? '')) {
      throw new Error(`front/tools/${entry.id}/tool.manifest.json: invalid version "${manifest.version}"`);
    }
    return { entry, manifest, toolDir };
  });
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

/** Catalog the shell receives at build time; sizes are known once `build:tools` has run. */
export function readShellCatalog() {
  return {
    tools: readToolDefinitions().map(({ entry, manifest }) => {
      const releaseDir = path.join(TOOLS_DIST_DIR, manifest.id, manifest.version);
      return {
        manifest,
        enabled: entry.enabled === true,
        allowedCapabilities: entry.allowedCapabilities ?? [],
        limits: entry.limits,
        downloadSizeBytes: fs.existsSync(releaseDir) ? directorySize(releaseDir) : null,
      };
    }),
  };
}

function toOrigin(rawUrl) {
  const normalized = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
  return new URL(normalized).origin;
}

/**
 * Shell origins a tool build accepts HOST_HELLO from and allows in `frame-ancestors`.
 * `TTRP_TOOLS_HOST_ORIGINS` (comma-separated) overrides the defaults.
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

/** Headers of every tools host response; production nginx (infra/prod/nginx) mirrors them. */
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

export function toolAliases() {
  return { '@tools-sdk': SDK_DIR };
}
