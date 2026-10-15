import type { StateSnapshot } from './protocol';
import type { StoredWindowState } from './storage';

/**
 * The snapshot a tool version may read: the current one, or after a rollback (current schema is newer
 * than the tool knows) the backup of the older schema. Null when nothing readable is stored.
 */
export function selectSnapshotForLoad(
  stored: StoredWindowState | null,
  maxSchemaVersion: number,
): StateSnapshot | null {
  if (!stored) {
    return null;
  }
  if (stored.current.schemaVersion <= maxSchemaVersion) {
    return stored.current;
  }
  if (stored.backup && stored.backup.schemaVersion <= maxSchemaVersion) {
    return stored.backup;
  }
  return null;
}

/**
 * - same schema: replace current, keep the backup;
 * - newer schema (upgrade): the previous snapshot becomes the backup;
 * - older schema (rollback): data written by the newer version is dropped — a rollback with a schema
 *   change is an emergency operation.
 */
export function applySnapshotSave(stored: StoredWindowState | null, next: StateSnapshot): StoredWindowState {
  if (!stored) {
    return { current: next, backup: null };
  }
  if (next.schemaVersion > stored.current.schemaVersion) {
    return { current: next, backup: stored.current };
  }
  if (next.schemaVersion < stored.current.schemaVersion) {
    return { current: next, backup: null };
  }
  return { current: next, backup: stored.backup };
}
