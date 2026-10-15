import type { StateSnapshot } from './protocol';

/**
 * Where a host keeps the state of tool windows. TtRP stores it in IndexedDB of its own origin,
 * the dev host in localStorage, tests in memory. Tools never touch this directly: they use
 * `state.load` / `state.save` through the bridge.
 */

export interface WindowStateKey {
  userId: string;
  appId: string;
  windowId: string;
}

/** `backup` keeps the last snapshot of the previous schema version (see snapshots.ts). */
export interface StoredWindowState {
  current: StateSnapshot;
  backup: StateSnapshot | null;
}

export interface ToolStateStore {
  loadWindowState(key: WindowStateKey): Promise<StoredWindowState | null>;
  /** Read-modify-write as one step; `update` must be synchronous. */
  updateWindowState(
    key: WindowStateKey,
    update: (stored: StoredWindowState | null) => StoredWindowState,
  ): Promise<StoredWindowState>;
}

export function windowStateId(key: WindowStateKey): string {
  return `${key.userId}|${key.appId}|${key.windowId}`;
}

/** Store without persistence: tests, previews, hosts that keep nothing between page loads. */
export function createMemoryStateStore(): ToolStateStore & { clear(): void } {
  const states = new Map<string, StoredWindowState>();
  return {
    async loadWindowState(key) {
      return states.get(windowStateId(key)) ?? null;
    },
    async updateWindowState(key, update) {
      const next = update(states.get(windowStateId(key)) ?? null);
      states.set(windowStateId(key), next);
      return next;
    },
    clear() {
      states.clear();
    },
  };
}
