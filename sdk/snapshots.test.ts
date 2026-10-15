import { describe, expect, it } from 'vitest';

import { applySnapshotSave, selectSnapshotForLoad } from './snapshots';

import type { StateSnapshot } from './protocol';

const snapshot = (schemaVersion: number, label: string): StateSnapshot => ({
  state: { label },
  schemaVersion,
  updatedAt: '2026-10-14T12:00:00.000Z',
});

describe('state snapshots', () => {
  it('keeps the previous schema as a backup on upgrade and serves it after a rollback', () => {
    const v1 = applySnapshotSave(null, snapshot(1, 'old'));
    const v2 = applySnapshotSave(v1, snapshot(2, 'new'));

    expect(v2).toEqual({ current: snapshot(2, 'new'), backup: snapshot(1, 'old') });
    expect(selectSnapshotForLoad(v2, 2)).toEqual(snapshot(2, 'new'));
    expect(selectSnapshotForLoad(v2, 1)).toEqual(snapshot(1, 'old'));
    expect(selectSnapshotForLoad(v2, 0)).toBeNull();
  });

  it('drops data of the newer schema when an older version saves after a rollback', () => {
    const upgraded = { current: snapshot(2, 'new'), backup: snapshot(1, 'old') };

    expect(applySnapshotSave(upgraded, snapshot(1, 'after rollback'))).toEqual({
      current: snapshot(1, 'after rollback'),
      backup: null,
    });
    expect(applySnapshotSave(upgraded, snapshot(2, 'same schema'))).toEqual({
      current: snapshot(2, 'same schema'),
      backup: snapshot(1, 'old'),
    });
  });
});
