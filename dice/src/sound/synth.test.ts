import { describe, expect, it } from 'vitest';

import { DIE_TYPES, type DieType } from '../dice/types';

import { PRESET_BY_DIE, renderDieClick, renderSurfaceKnock, type Layer } from './presets';
import { VARIANTS, createRandom, renderRoomImpulse } from './synth';

const RATE = 48_000;

function rms(samples: Float32Array, from = 0, to = samples.length): number {
  let energy = 0;
  for (let index = from; index < to; index += 1) {
    energy += samples[index] * samples[index];
  }
  return Math.sqrt(energy / Math.max(1, to - from));
}

/** toEqual walks typed arrays slowly; a plain loop is enough here. */
function same(a: Float32Array, b: Float32Array): boolean {
  return a.length === b.length && a.every((sample, index) => sample === b[index]);
}

function peak(samples: Float32Array): number {
  return samples.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
}

/** Sign changes per second: a rough measure of how high a sound is. */
function crossingRate(samples: Float32Array): number {
  let crossings = 0;
  for (let index = 1; index < samples.length; index += 1) {
    if ((samples[index - 1] < 0 && samples[index] > 0) || (samples[index - 1] > 0 && samples[index] < 0)) {
      crossings += 1;
    }
  }
  return (crossings * RATE) / samples.length;
}

/** First-order filter: a low-pass, or a high-pass as the input minus its low-pass. */
function onePole(samples: Float32Array, cutoff: number, highpass: boolean): Float32Array {
  const output = new Float32Array(samples.length);
  const decay = Math.exp((-2 * Math.PI * cutoff) / RATE);
  let low = 0;
  for (let index = 0; index < samples.length; index += 1) {
    low = (1 - decay) * samples[index] + decay * low;
    output[index] = highpass ? samples[index] - low : low;
  }
  return output;
}

/**
 * How loud a medium knock of this die is, dB: its layers mixed as in voices.ts, heard through a crude ear
 * (high-pass 400 Hz, low-pass 10 kHz — roughly A-weighting at a quiet level) over the first 60 ms.
 */
function knockLoudness(type: DieType, kind: 'floor' | 'wall' | 'die'): number {
  const strength = 0.5;
  const preset = PRESET_BY_DIE[type];
  let sum = 0;
  for (let variant = 0; variant < VARIANTS; variant += 1) {
    const click = renderDieClick(type, variant, RATE);
    const layers: Array<[Float32Array, Layer]> = kind === 'die'
      ? [[click, preset.mix.die.first], [renderDieClick(type, (variant + 1) % VARIANTS, RATE), preset.mix.die.second]]
      : [[renderSurfaceKnock(type, kind, variant, RATE), preset.mix[kind].surface], [click, preset.mix[kind].click]];
    const mix = new Float32Array(Math.max(...layers.map(([take]) => take.length)));
    for (const [take, layer] of layers) {
      const filtered = onePole(take, layer.cutoff[0] + layer.cutoff[1] * strength, false);
      filtered.forEach((sample, index) => {
        mix[index] += sample * layer.gain * strength ** 0.65;
      });
    }
    const heard = onePole(onePole(mix, 400, true), 10_000, false);
    const window = Math.min(heard.length, Math.round(RATE * 0.06));
    sum += 20 * Math.log10(rms(heard, 0, window));
  }
  return sum / VARIANTS;
}

function averageRate(render: (variant: number) => Float32Array): number {
  let sum = 0;
  for (let variant = 0; variant < VARIANTS; variant += 1) {
    sum += crossingRate(render(variant));
  }
  return sum / VARIANTS;
}

describe('dice tray synthesis', () => {
  it('renders every take finite, normalized and the same for the same seed', () => {
    for (const type of DIE_TYPES) {
      for (let variant = 0; variant < VARIANTS; variant += 1) {
        const take = renderDieClick(type, variant, RATE);

        expect(same(take, renderDieClick(type, variant, RATE))).toBe(true);
        expect(take.every(Number.isFinite)).toBe(true);
        expect(peak(take)).toBeCloseTo(0.9, 3);
      }
    }
    expect(same(renderDieClick('d6', 0, RATE), renderDieClick('d6', 1, RATE))).toBe(false);
    expect(peak(renderSurfaceKnock('d6', 'floor', 0, RATE))).toBeCloseTo(0.9, 3);
  });

  it('lets every knock die away instead of ringing on', () => {
    for (const take of [renderDieClick('d20', 2, RATE), renderSurfaceKnock('d4', 'floor', 1, RATE), renderSurfaceKnock('d4', 'wall', 3, RATE)]) {
      const tenth = Math.floor(take.length / 10);

      expect(rms(take, take.length - tenth)).toBeLessThan(rms(take, 0, tenth) * 0.02);
    }
  });

  it('keeps the knocks dry: no glassy ringing, no hollow boom', () => {
    // Time from the loudest millisecond until the sound stays 40 dB below it.
    const ringTime = (take: Float32Array) => {
      const window = RATE / 1000;
      const levels = Array.from({ length: Math.floor(take.length / window) }, (_, index) => rms(take, index * window, (index + 1) * window));
      const loudest = levels.indexOf(Math.max(...levels));
      let last = loudest;
      levels.forEach((level, index) => {
        if (level > levels[loudest] * 0.01) {
          last = index;
        }
      });
      return (last - loudest) / 1000;
    };

    // Every preset in comparison: they differ in material, none may ring.
    for (let variant = 0; variant < VARIANTS; variant += 1) {
      for (const type of DIE_TYPES) {
        expect(ringTime(renderDieClick(type, variant, RATE))).toBeLessThan(0.012);
        expect(ringTime(renderSurfaceKnock(type, 'wall', variant, RATE))).toBeLessThan(0.045);
        expect(ringTime(renderSurfaceKnock(type, 'floor', variant, RATE))).toBeLessThan(0.055);
      }
    }
  });

  it('gives every die type its own voice', () => {
    expect(new Set(DIE_TYPES.map((type) => PRESET_BY_DIE[type].id)).size).toBe(DIE_TYPES.length);
  });

  it('keeps the voices balanced: in a mixed handful no die drowns or sticks out', () => {
    for (const kind of ['floor', 'wall', 'die'] as const) {
      const levels = DIE_TYPES.map((type) => knockLoudness(type, kind));
      const median = [...levels].sort((a, b) => a - b)[Math.floor(levels.length / 2)];

      levels.forEach((level) => expect(Math.abs(level - median)).toBeLessThan(2));
    }
  });

  it('rings smaller dice higher and keeps the felt darker than the wooden rim', () => {
    const d4 = averageRate((variant) => renderDieClick('d4', variant, RATE));
    const d20 = averageRate((variant) => renderDieClick('d20', variant, RATE));
    const felt = averageRate((variant) => renderSurfaceKnock('d4', 'floor', variant, RATE));
    const wood = averageRate((variant) => renderSurfaceKnock('d4', 'wall', variant, RATE));

    expect(d4).toBeGreaterThan(d20);
    expect(felt).toBeLessThan(wood);
    expect(wood).toBeLessThan(d20);
  });

  it('gives the tray a short stereo room that fades out', () => {
    const [left, right] = renderRoomImpulse(RATE);
    const early = Math.round(RATE * 0.05);

    expect(left).toHaveLength(right.length);
    expect(same(left, right)).toBe(false);
    expect(rms(left, left.length - early)).toBeLessThan(rms(left, 0, early) * 0.05);
  });

  it('draws the same numbers for the same seed', () => {
    const first = createRandom(42);
    const second = createRandom(42);

    expect(Array.from({ length: 5 }, first)).toEqual(Array.from({ length: 5 }, second));
  });
});
