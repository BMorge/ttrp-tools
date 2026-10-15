import { describe, expect, it } from 'vitest';

import manifest from '../tool.manifest.json';

import { MAX_NOTE_LENGTH, STATE_SCHEMA_VERSION, initialState, restoreState, toSnapshotState } from './state';

const snapshot = (state: unknown, schemaVersion = STATE_SCHEMA_VERSION) => ({
  state: state as never,
  schemaVersion,
  updatedAt: '2026-10-14T12:00:00.000Z',
});

describe('template state', () => {
  it('uses the schema version declared in the manifest', () => {
    expect(STATE_SCHEMA_VERSION).toBe(manifest.storageSchemaVersion);
  });

  it('starts empty when nothing is saved', () => {
    expect(restoreState(null)).toEqual({ state: initialState(), reset: false });
  });

  it('round-trips through a snapshot', () => {
    const state = { note: 'Мастер ходит первым' };

    expect(restoreState(snapshot(toSnapshotState(state)))).toEqual({ state, reset: false });
  });

  it('resets a corrupted, oversized or unknown save instead of failing', () => {
    expect(restoreState(snapshot({ note: 42 }))).toEqual({ state: initialState(), reset: true });
    expect(restoreState(snapshot({ note: 'x'.repeat(MAX_NOTE_LENGTH + 1) }))).toEqual({ state: initialState(), reset: true });
    expect(restoreState(snapshot({ note: 'ok' }, STATE_SCHEMA_VERSION + 1))).toEqual({ state: initialState(), reset: true });
  });
});
