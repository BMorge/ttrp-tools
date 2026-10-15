import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { IMPLEMENTED_CAPABILITIES, SUPPORTED_BRIDGE_VERSIONS, toolManifestSchema, type ToolManifest } from '@tools-sdk/protocol';

import { discoverTools } from './lib.mjs';

/** What `npm test` checks in every tool folder: the same rules the host applies when it loads a tool. */
const tools: { id: string; manifest: ToolManifest; dir: string }[] = discoverTools();

describe.each(tools)('tool $id', ({ manifest, dir }) => {
  it('has a valid manifest', () => {
    const parsed = toolManifestSchema.safeParse(manifest);

    expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
  });

  it('targets a supported bridge and requests only implemented capabilities', () => {
    expect(SUPPORTED_BRIDGE_VERSIONS).toContain(manifest.bridgeVersion);
    expect(manifest.requestedCapabilities.filter((capability) => !IMPLEMENTED_CAPABILITIES.includes(capability))).toEqual([]);
  });

  it('opens at least at its minimum size', () => {
    expect(manifest.window.width).toBeGreaterThanOrEqual(manifest.window.minWidth);
    expect(manifest.window.height).toBeGreaterThanOrEqual(manifest.window.minHeight);
  });

  it('has its entrypoint', () => {
    expect(fs.existsSync(path.join(dir, manifest.entrypoint))).toBe(true);
  });
});
