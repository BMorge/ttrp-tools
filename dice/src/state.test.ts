import { describe, expect, it } from 'vitest';

import manifest from '../tool.manifest.json';

import {
  DEFAULT_SOUND,
  DICE_STATE_SCHEMA_VERSION,
  MAX_HISTORY,
  initialDiceState,
  restoreDiceState,
  toSnapshotState,
  withRoll,
  withSound,
  type RollRecord,
} from './state';

const record = (index: number): RollRecord => ({
  id: `roll-${index}`,
  at: '2026-10-14T12:00:00.000Z',
  dice: [{ type: 'd20', value: 14 }],
  modifier: 2,
  total: 16,
});

describe('dice state', () => {
  it('uses the schema version declared in the manifest', () => {
    expect(DICE_STATE_SCHEMA_VERSION).toBe(manifest.storageSchemaVersion);
  });

  it('starts with one D20 when nothing is saved', () => {
    expect(restoreDiceState(null)).toEqual({ state: initialDiceState(), reset: false });
    expect(initialDiceState().selection.counts.d20).toBe(1);
  });

  it('round-trips through a snapshot', () => {
    const state = withSound(withRoll(initialDiceState(), record(1)), { enabled: false, volume: 0.35 });
    const snapshot = {
      state: toSnapshotState(state),
      schemaVersion: DICE_STATE_SCHEMA_VERSION,
      updatedAt: '2026-10-14T12:00:01.000Z',
    };

    expect(restoreDiceState(snapshot)).toEqual({ state, reset: false });
  });

  it('resets a corrupted or unknown save instead of failing', () => {
    const corrupted = { state: { history: 'nope' }, schemaVersion: 1, updatedAt: '2026-10-14T12:00:00.000Z' };
    const future = { state: toSnapshotState(initialDiceState()), schemaVersion: 3, updatedAt: '2026-10-14T12:00:00.000Z' };

    expect(restoreDiceState(corrupted)).toEqual({ state: initialDiceState(), reset: true });
    expect(restoreDiceState(future)).toEqual({ state: initialDiceState(), reset: true });
  });

  it('migrates a save from before the sound: dice and history stay, the sound gets the defaults', () => {
    const { selection, history } = withRoll(initialDiceState(), record(1));
    const saved = { state: toSnapshotState({ selection, history } as never), schemaVersion: 1, updatedAt: '2026-10-14T12:00:00.000Z' };

    expect(restoreDiceState(saved)).toEqual({ state: { selection, history, sound: DEFAULT_SOUND }, reset: false });
  });

  it('keeps the volume within 0…1', () => {
    expect(withSound(initialDiceState(), { enabled: true, volume: 3 }).sound.volume).toBe(1);
    expect(withSound(initialDiceState(), { enabled: true, volume: -1 }).sound.volume).toBe(0);
  });

  it('keeps only the latest rolls', () => {
    let state = initialDiceState();
    for (let index = 0; index < MAX_HISTORY + 5; index += 1) {
      state = withRoll(state, record(index));
    }

    expect(state.history).toHaveLength(MAX_HISTORY);
    expect(state.history[0].id).toBe(`roll-${MAX_HISTORY + 4}`);
  });
});
