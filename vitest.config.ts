import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@tools-sdk': fileURLToPath(new URL('./sdk', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
  },
});
