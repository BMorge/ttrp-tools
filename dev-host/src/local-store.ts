import { windowStateId, type StoredWindowState, type ToolStateStore, type WindowStateKey } from '@tools-sdk/storage';

const PREFIX = 'ttrp-dev-host:';

/** State store of the dev host: localStorage of the dev host origin, so saves survive reloads. */
export interface LocalStateStore extends ToolStateStore {
  read(key: WindowStateKey): StoredWindowState | null;
  remove(key: WindowStateKey): void;
}

export function createLocalStateStore(): LocalStateStore {
  const read = (key: WindowStateKey): StoredWindowState | null => {
    try {
      const raw = localStorage.getItem(PREFIX + windowStateId(key));
      return raw ? (JSON.parse(raw) as StoredWindowState) : null;
    } catch {
      return null;
    }
  };

  return {
    read,
    async loadWindowState(key) {
      return read(key);
    },
    async updateWindowState(key, update) {
      const next = update(read(key));
      localStorage.setItem(PREFIX + windowStateId(key), JSON.stringify(next));
      return next;
    },
    remove(key) {
      localStorage.removeItem(PREFIX + windowStateId(key));
    },
  };
}
