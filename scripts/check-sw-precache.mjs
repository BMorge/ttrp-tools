import fs from 'node:fs';
import path from 'node:path';

import { FRONT_DIR } from './tools-config.mjs';

/**
 * Embedded tools load only on demand from the tools host. If their files ever end up in public/,
 * Serwist precaches them (globPublicPatterns defaults to every public file, with no size limit)
 * and every visitor downloads them on service worker install. Fail the build instead.
 */

const swFile = path.join(FRONT_DIR, 'public', 'sw.js');
if (!fs.existsSync(swFile)) {
  console.log('check:sw-precache: public/sw.js not found, skipped');
  process.exit(0);
}

const content = fs.readFileSync(swFile, 'utf8');
const markers = ['tools-dist', 'tool.manifest.json'].filter((marker) => content.includes(marker));
if (markers.length > 0) {
  console.error(
    `check:sw-precache: public/sw.js references embedded tools (${markers.join(', ')}); `
    + 'tools must load only from the tools host',
  );
  process.exit(1);
}
console.log('check:sw-precache: ok');
