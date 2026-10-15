import type { ToolManifest } from '@tools-sdk/protocol';

declare global {
  /** Manifests of every tool in the repository; injected by scripts/dev.mjs. */
  const __DEV_HOST_TOOLS__: ToolManifest[];
  /** Origin of the local tools host (http://localhost:5173). */
  const __DEV_HOST_TOOLS_ORIGIN__: string;
}

export {};
