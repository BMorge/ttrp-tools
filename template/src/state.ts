import { z } from 'zod';

import type { JsonValue, StateSnapshot } from '@tools-sdk/protocol';

/**
 * Saved state of one window. The version must equal `storageSchemaVersion` of the manifest;
 * bump both together with a migration in restoreState.
 */
export const STATE_SCHEMA_VERSION = 1;
export const MAX_NOTE_LENGTH = 10_000;

const stateSchema = z.object({
  note: z.string().max(MAX_NOTE_LENGTH),
}).strict();

export type ToolState = z.infer<typeof stateSchema>;

export function initialState(): ToolState {
  return { note: '' };
}

/**
 * Saved data is untrusted input: validate it and start clean (saying so) when it does not fit.
 * A migration looks like `if (snapshot.schemaVersion === 1) return migrateFromV1(snapshot.state)`.
 */
export function restoreState(snapshot: StateSnapshot | null): { state: ToolState; reset: boolean } {
  if (!snapshot) {
    return { state: initialState(), reset: false };
  }
  if (snapshot.schemaVersion !== STATE_SCHEMA_VERSION) {
    return { state: initialState(), reset: true };
  }
  const parsed = stateSchema.safeParse(snapshot.state);
  return parsed.success ? { state: parsed.data, reset: false } : { state: initialState(), reset: true };
}

export function toSnapshotState(state: ToolState): JsonValue {
  return { note: state.note };
}
