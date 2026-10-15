import { presetFor, type Layer, type SoundPreset } from './presets';
import { VARIANTS } from './synth';

import type { ContactSurface } from '../dice/physics';
import type { DieType } from '../dice/types';

/**
 * From physics to sound: which takes to play for a knock, how loud, how bright and where in the stereo
 * field — by the preset of the die that knocked. Pure functions; the Web Audio graph lives in audio.ts.
 */

/** A knock of the dice, as the engine reports it. */
export interface SoundImpact {
  type: DieType;
  /** The other die of a die–die knock. */
  otherType: DieType | null;
  surface: ContactSurface;
  /** Velocity change from the contact, world units per second. */
  speed: number;
  /** Position in the tray: x across (−9…9, left to right on screen), z towards the viewer (−5.5…5.5). */
  x: number;
  z: number;
  /** Seconds since the start of the frame's batch. */
  at: number;
}

/** What the engine reports once per animation frame of a roll. */
export interface SoundBatch {
  impacts: SoundImpact[];
}

/** A die's own click, or the tray (floor or rim) as it answers a die of this type. */
export type VoiceSource = { kind: 'click'; type: DieType } | { kind: 'surface'; surface: 'floor' | 'wall'; type: DieType };

export interface Voice {
  source: VoiceSource;
  variant: number;
  gain: number;
  /** Low-pass cutoff, Hz: soft knocks are dull, hard knocks are bright. */
  cutoff: number;
  pan: number;
  playbackRate: number;
  at: number;
  /** Reverb send. */
  room: number;
}

/** Knocks below are resting contacts; above the hardest the sound does not grow (see the physics probe). */
const SOFTEST_SPEED = 1.2;
const HARDEST_SPEED = 17;
const MIN_GAIN = 0.012;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 0 for a resting contact, 1 for a full-force landing. */
export function impactStrength(speed: number): number {
  return clamp((speed - SOFTEST_SPEED) / (HARDEST_SPEED - SOFTEST_SPEED), 0, 1);
}

export function planImpact(impact: SoundImpact, random: () => number): Voice[] {
  const strength = impactStrength(impact.speed);
  if (strength <= 0) {
    return [];
  }
  const preset = presetFor(impact.type);
  // Perceived loudness grows slower than the force; dice nearer the viewer sound a little closer.
  const loudness = strength ** 0.65 * (1 + 0.1 * clamp(impact.z / 5.5, -1, 1));
  const voices: Voice[] = [];
  const add = (source: VoiceSource, layer: Layer, owner: SoundPreset, options: { panShift?: number; delay?: number } = {}) => {
    const gain = layer.gain * loudness;
    if (gain < MIN_GAIN) {
      return;
    }
    const pan = clamp(impact.x / 9, -1, 1) * 0.75 * owner.mix.width;
    voices.push({
      source,
      variant: Math.floor(random() * VARIANTS),
      gain,
      cutoff: layer.cutoff[0] + layer.cutoff[1] * strength,
      pan: clamp(pan + (options.panShift ?? 0), -1, 1),
      playbackRate: 0.96 + random() * 0.08,
      at: impact.at + (options.delay ?? 0),
      room: owner.mix.room,
    });
  };
  // A die rarely lands flat: an edge or a corner touches first, the face slaps a moment later — "tk-tok".
  const flam = (click: Layer) => {
    if (strength > 0.2 && random() < preset.mix.flam) {
      const echo: Layer = { gain: click.gain * 0.55, cutoff: [click.cutoff[0] * 0.8, click.cutoff[1] * 0.6] };
      add({ kind: 'click', type: impact.type }, echo, preset, { delay: 0.004 + random() * 0.007 });
    }
  };

  switch (impact.surface) {
    case 'floor':
      add({ kind: 'surface', surface: 'floor', type: impact.type }, preset.mix.floor.surface, preset);
      add({ kind: 'click', type: impact.type }, preset.mix.floor.click, preset);
      flam(preset.mix.floor.click);
      break;
    case 'wall':
      add({ kind: 'surface', surface: 'wall', type: impact.type }, preset.mix.wall.surface, preset);
      add({ kind: 'click', type: impact.type }, preset.mix.wall.click, preset);
      flam(preset.mix.wall.click);
      break;
    case 'die': {
      // Both dice click, each in its own material.
      const other = impact.otherType ?? impact.type;
      const otherPreset = presetFor(other);
      add({ kind: 'click', type: impact.type }, preset.mix.die.first, preset, { panShift: -0.04 });
      add({ kind: 'click', type: other }, otherPreset.mix.die.second, otherPreset, { panShift: 0.04 });
      break;
    }
  }
  return voices;
}

/**
 * Dice rattling in the hand as they are thrown: a muffled handful of clicks on the left, where the dice
 * start. More dice — more clicks.
 */
export function planRattle(types: readonly DieType[], random: () => number): Voice[] {
  if (types.length === 0) {
    return [];
  }
  const count = Math.min(14, 3 + Math.round(types.length * 1.1));
  return Array.from({ length: count }, () => {
    const type = types[Math.floor(random() * types.length)];
    const preset = presetFor(type);
    return {
      source: { kind: 'click' as const, type },
      variant: Math.floor(random() * VARIANTS),
      gain: (0.08 + random() * 0.14) * (preset.mix.die.first.gain / 0.75),
      cutoff: 2200 + random() * 1400,
      pan: -0.55 + (random() - 0.5) * 0.3,
      playbackRate: 0.94 + random() * 0.1,
      at: random() * 0.16,
      room: preset.mix.room,
    };
  });
}

/** When more voices are asked for than there is room for, the loudest win. */
export function selectVoices(voices: Voice[], available: number): Voice[] {
  if (available <= 0) {
    return [];
  }
  return voices.length <= available ? voices : [...voices].sort((a, b) => b.gain - a.gain).slice(0, available);
}
