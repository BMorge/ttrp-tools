import { describe, expect, it } from 'vitest';

import { createRandom } from './synth';
import { impactStrength, planImpact, planRattle, selectVoices, type SoundImpact } from './voices';

import type { DieType } from '../dice/types';

const impact = (overrides: Partial<SoundImpact> = {}): SoundImpact => ({
  type: 'd6',
  otherType: null,
  surface: 'floor',
  speed: 8,
  x: 0,
  z: 0,
  at: 0.004,
  ...overrides,
});

const random = () => 0.5;

describe('dice knocks to voices', () => {
  it('stays silent for resting contacts', () => {
    expect(impactStrength(0.42)).toBe(0);
    expect(planImpact(impact({ speed: 1.2 }), random)).toEqual([]);
  });

  it('plays harder knocks louder and brighter, up to a full-force landing', () => {
    const felt = [2, 5, 10, 17, 30].map((speed) => planImpact(impact({ speed }), random)[0]);

    for (let index = 1; index < felt.length; index += 1) {
      expect(felt[index].gain).toBeGreaterThanOrEqual(felt[index - 1].gain);
      expect(felt[index].cutoff).toBeGreaterThanOrEqual(felt[index - 1].cutoff);
    }
    expect(felt[3]).toEqual(felt[4]);
  });

  it('layers the takes by what the die hit', () => {
    const sources = (surface: SoundImpact['surface'], otherType: DieType | null = null) =>
      planImpact(impact({ surface, otherType }), random).map((voice) => voice.source);

    expect(sources('floor')).toEqual([{ kind: 'surface', surface: 'floor', type: 'd6' }, { kind: 'click', type: 'd6' }]);
    expect(sources('wall')).toEqual([{ kind: 'surface', surface: 'wall', type: 'd6' }, { kind: 'click', type: 'd6' }]);
    expect(sources('die', 'd20')).toEqual([{ kind: 'click', type: 'd6' }, { kind: 'click', type: 'd20' }]);
  });

  it('places a knock in the stereo field by its place in the tray and keeps its timing', () => {
    expect(planImpact(impact({ x: -9 }), random)[0].pan).toBeCloseTo(-0.75);
    expect(planImpact(impact({ x: 9 }), random)[0].pan).toBeCloseTo(0.75);
    expect(planImpact(impact({ at: 0.0125 }), random).every((voice) => voice.at === 0.0125)).toBe(true);
  });

  it('rattles more clicks for more dice and keeps the loudest voices when crowded', () => {
    const one = planRattle(['d6'], createRandom(1));
    const twenty = planRattle(Array.from({ length: 20 }, () => 'd20' as const), createRandom(1));

    expect(one.length).toBeLessThan(twenty.length);
    expect(planRattle([], random)).toEqual([]);

    const kept = selectVoices(twenty, 3);
    expect(kept).toHaveLength(3);
    expect(Math.min(...kept.map((voice) => voice.gain))).toBeGreaterThanOrEqual(
      Math.max(...twenty.filter((voice) => !kept.includes(voice)).map((voice) => voice.gain)),
    );
    expect(selectVoices(twenty, 0)).toEqual([]);
  });

});
