import { DIE_TYPES, type DieType } from '../dice/types';

import { createRandom, renderTake, vary, type Contact, type Take } from './synth';

/**
 * What the dice sound like. Every die type has its own voice — its material, how the tray answers it,
 * how it is mixed — so a handful of mixed dice sounds like a handful of different dice. The voices are
 * balanced in loudness by their layer gains (checked by synth.test.ts): none drowns or sticks out.
 */

/** How a die's own click is made; the pitch comes from the die (DIE_PITCH) times `pitchScale`. */
export interface ClickRecipe {
  pitchScale: number;
  resonances: readonly { ratio: number; q: number; gain: number }[];
  contact: Contact;
  duration: number;
}

/** One layer of a knock: its level and its low-pass cutoff, `base + span × strength` Hz. */
export interface Layer {
  gain: number;
  cutoff: readonly [base: number, span: number];
}

export interface SoundPreset {
  id: string;
  /** A short description of the voice, in Russian. */
  name: string;
  click: ClickRecipe;
  floor: Take;
  wall: Take;
  mix: {
    floor: { surface: Layer; click: Layer };
    wall: { surface: Layer; click: Layer };
    die: { first: Layer; second: Layer };
    /** Chance of the "tk-tok" double knock: an edge first, then the face. */
    flam: number;
    /** Stereo width: 1 puts dice at the walls at ±75 %. */
    width: number;
    /** Reverb send. */
    room: number;
  };
}

/** Main resonance of each die: smaller dice click higher, a D20 a bit lower and fuller. */
export const DIE_PITCH: Record<DieType, number> = {
  d4: 2900,
  d6: 2400,
  d8: 2600,
  d10: 2500,
  d12: 2250,
  d20: 2100,
};

/** Resin dice: a woody "clack" below the main resonance, a couple of quick overtones above. */
const RESIN: ClickRecipe = {
  pitchScale: 1,
  resonances: [
    { ratio: 0.45, q: 4, gain: 0.75 },
    { ratio: 1, q: 5, gain: 1 },
    { ratio: 1.55, q: 6, gain: 0.6 },
    { ratio: 2.2, q: 7, gain: 0.35 },
  ],
  contact: { duration: 0.00025, pulse: 0.8, noiseDecay: 0.00035, noise: 1, noiseBrightness: 0.55, tick: 0.1 },
  duration: 0.05,
};

/** Wooden dice: lower and fuller, a warm "klak" with body. */
const WOODEN_DICE: ClickRecipe = {
  pitchScale: 0.62,
  resonances: [
    { ratio: 0.5, q: 4, gain: 0.9 },
    { ratio: 1, q: 5.5, gain: 1 },
    { ratio: 1.7, q: 6.5, gain: 0.5 },
    { ratio: 2.6, q: 7, gain: 0.25 },
  ],
  contact: { duration: 0.00035, pulse: 0.9, noiseDecay: 0.0004, noise: 0.8, noiseBrightness: 0.45, tick: 0.08 },
  duration: 0.06,
};

/** A board under felt: a soft, warm "thup". */
const FELT_BOARD: Take = {
  duration: 0.1,
  resonances: [
    { frequency: 125, q: 3.2, gain: 1 },
    { frequency: 215, q: 3.6, gain: 0.9 },
    { frequency: 350, q: 4, gain: 0.7 },
    { frequency: 570, q: 4.5, gain: 0.45 },
    { frequency: 900, q: 5, gain: 0.25 },
  ],
  contact: { duration: 0.0016, pulse: 1.3, noiseDecay: 0.0012, noise: 0.5, noiseBrightness: 0.25, tick: 0.03 },
};

/** Thick felt: softer and lower, the contact itself is long. */
const THICK_FELT: Take = {
  duration: 0.12,
  resonances: [
    { frequency: 110, q: 2.8, gain: 1 },
    { frequency: 190, q: 3.2, gain: 0.85 },
    { frequency: 300, q: 3.6, gain: 0.6 },
    { frequency: 480, q: 4, gain: 0.35 },
  ],
  contact: { duration: 0.0024, pulse: 1.4, noiseDecay: 0.0016, noise: 0.35, noiseBrightness: 0.15, tick: 0.015 },
};

/** Felt over a heavier board, heard closer: more low body. */
const WARM_FELT: Take = {
  ...FELT_BOARD,
  resonances: FELT_BOARD.resonances.map((resonance, index) => ({
    ...resonance,
    frequency: resonance.frequency * 0.95,
    gain: resonance.gain * (index < 2 ? 1.2 : 1),
  })),
};

/** A bare wooden table top: a lively "tok". */
const WOOD_TABLE: Take = {
  duration: 0.1,
  resonances: [
    { frequency: 180, q: 4, gain: 0.9 },
    { frequency: 320, q: 5.5, gain: 1 },
    { frequency: 540, q: 6, gain: 0.8 },
    { frequency: 860, q: 6.5, gain: 0.6 },
    { frequency: 1300, q: 7, gain: 0.4 },
    { frequency: 1900, q: 7, gain: 0.25 },
  ],
  contact: { duration: 0.0006, pulse: 1, noiseDecay: 0.0007, noise: 0.8, noiseBrightness: 0.55, tick: 0.1 },
};

/** A leather mat on foam: deep and dull, almost no click. */
const LEATHER_MAT: Take = {
  duration: 0.12,
  resonances: [
    { frequency: 90, q: 2.2, gain: 1 },
    { frequency: 160, q: 3, gain: 0.8 },
    { frequency: 260, q: 3.4, gain: 0.5 },
    { frequency: 420, q: 3.8, gain: 0.3 },
  ],
  contact: { duration: 0.003, pulse: 1.5, noiseDecay: 0.002, noise: 0.25, noiseBrightness: 0.12, tick: 0.02 },
};

/** The wooden rim: a short, dry "tok". */
const WOOD_RIM: Take = {
  duration: 0.1,
  resonances: [
    { frequency: 230, q: 4.5, gain: 0.9 },
    { frequency: 410, q: 5, gain: 1 },
    { frequency: 680, q: 6, gain: 0.8 },
    { frequency: 1050, q: 6.5, gain: 0.55 },
    { frequency: 1600, q: 7, gain: 0.35 },
    { frequency: 2400, q: 7, gain: 0.2 },
  ],
  contact: { duration: 0.0005, pulse: 1, noiseDecay: 0.0006, noise: 0.8, noiseBrightness: 0.6, tick: 0.12 },
};

/** A rim wrapped in leather: the wood is there, muffled. */
const LEATHER_RIM: Take = {
  duration: 0.1,
  resonances: [
    { frequency: 200, q: 4, gain: 0.9 },
    { frequency: 360, q: 4.5, gain: 1 },
    { frequency: 600, q: 5, gain: 0.6 },
    { frequency: 950, q: 5.5, gain: 0.35 },
  ],
  contact: { duration: 0.0012, pulse: 1.2, noiseDecay: 0.001, noise: 0.5, noiseBrightness: 0.3, tick: 0.04 },
};

const layer = (gain: number, base: number, span: number): Layer => ({ gain, cutoff: [base, span] });

/** The mix every preset starts from: a felt tray with a wooden rim and resin dice. */
const BASE_MIX: SoundPreset['mix'] = {
  floor: { surface: layer(0.85, 900, 3000), click: layer(0.55, 2500, 5000) },
  wall: { surface: layer(0.85, 2500, 7000), click: layer(0.6, 3500, 8000) },
  die: { first: layer(0.75, 4000, 9000), second: layer(0.6, 3500, 8500) },
  flam: 0.45,
  width: 1,
  room: 0.06,
};

export const PRESETS = {
  resinOnFelt: {
    id: 'resin-on-felt',
    name: 'Смола на фетре',
    click: RESIN,
    floor: FELT_BOARD,
    wall: WOOD_RIM,
    mix: BASE_MIX,
  },
  softFelt: {
    id: 'soft-felt',
    name: 'Мягкий фетр',
    click: {
      ...RESIN,
      pitchScale: 0.9,
      resonances: RESIN.resonances.map((resonance) => ({ ...resonance, q: resonance.q * 0.9 })),
      contact: { ...RESIN.contact, duration: 0.0004, noiseBrightness: 0.4, tick: 0.06 },
    },
    floor: THICK_FELT,
    wall: WOOD_RIM,
    mix: {
      floor: { surface: layer(0.95, 700, 2000), click: layer(0.38, 1800, 3000) },
      wall: { surface: layer(0.75, 2000, 5000), click: layer(0.5, 2800, 5000) },
      die: { first: layer(0.65, 3000, 6000), second: layer(0.5, 2800, 5500) },
      flam: 0.35,
      width: 1,
      room: 0.04,
    },
  },
  woodTable: {
    id: 'wood-table',
    name: 'Деревянный стол',
    click: { ...RESIN, contact: { ...RESIN.contact, noiseBrightness: 0.6, tick: 0.12 } },
    floor: WOOD_TABLE,
    wall: WOOD_RIM,
    // Lively wood, softened a little with the felt tray's warmth.
    mix: {
      ...BASE_MIX,
      floor: { surface: layer(0.95, 1800, 4500), click: layer(0.72, 2800, 5500) },
      flam: 0.55,
      room: 0.07,
    },
  },
  leather: {
    id: 'leather',
    name: 'Кожаный лоток',
    click: {
      ...RESIN,
      pitchScale: 0.85,
      contact: { ...RESIN.contact, duration: 0.0005, noiseBrightness: 0.35, tick: 0.05 },
    },
    floor: LEATHER_MAT,
    wall: LEATHER_RIM,
    // Deep and soft, with enough of a click to be heard among other dice.
    mix: {
      floor: { surface: layer(1, 600, 1600), click: layer(0.42, 1800, 3200) },
      wall: { surface: layer(0.72, 1500, 4000), click: layer(0.41, 2200, 4200) },
      die: { first: layer(0.62, 2800, 5000), second: layer(0.5, 2500, 4500) },
      flam: 0.25,
      width: 1,
      room: 0.03,
    },
  },
  woodenDice: {
    id: 'wooden-dice',
    name: 'Деревянные кубики',
    click: WOODEN_DICE,
    floor: FELT_BOARD,
    wall: WOOD_RIM,
    mix: {
      ...BASE_MIX,
      floor: { surface: layer(0.8, 900, 3000), click: layer(0.65, 2200, 4500) },
      wall: { surface: layer(0.68, 2500, 7000), click: layer(0.56, 3000, 6000) },
      die: { first: layer(0.66, 3000, 6000), second: layer(0.53, 2800, 5500) },
    },
  },
  liveRoom: {
    id: 'live-room',
    name: 'Живая комната',
    click: { ...RESIN, contact: { ...RESIN.contact, noiseBrightness: 0.5 } },
    floor: WARM_FELT,
    wall: WOOD_RIM,
    // The big die, heard close: fuller, wider, with a little air.
    mix: {
      ...BASE_MIX,
      floor: { surface: layer(0.9, 900, 3000), click: layer(0.55, 2500, 5000) },
      width: 1.25,
      room: 0.1,
    },
  },
} satisfies Record<string, SoundPreset>;

/** Every die type has its own voice. */
export const PRESET_BY_DIE: Record<DieType, SoundPreset> = {
  d4: PRESETS.resinOnFelt,
  d6: PRESETS.softFelt,
  d8: PRESETS.woodTable,
  d10: PRESETS.leather,
  d12: PRESETS.woodenDice,
  d20: PRESETS.liveRoom,
};

export function presetFor(type: DieType): SoundPreset {
  return PRESET_BY_DIE[type];
}

/** One take of a die's own click, in its preset's material. */
export function renderDieClick(type: DieType, variant: number, sampleRate: number): Float32Array {
  const { click } = presetFor(type);
  const random = createRandom(1009 * (DIE_TYPES.indexOf(type) + 1) + 31 * variant);
  const pitch = DIE_PITCH[type] * click.pitchScale;
  const take = vary({
    duration: click.duration,
    resonances: click.resonances.map(({ ratio, q, gain }) => ({ frequency: pitch * ratio, q, gain })),
    contact: click.contact,
  }, random);
  return renderTake(sampleRate, take, random);
}

/** One take of the tray answering a die of this type: the floor under it or the rim. */
export function renderSurfaceKnock(type: DieType, surface: 'floor' | 'wall', variant: number, sampleRate: number): Float32Array {
  const preset = presetFor(type);
  const random = createRandom((surface === 'floor' ? 7001 : 7919) + 101 * DIE_TYPES.indexOf(type) + 31 * variant);
  return renderTake(sampleRate, vary(surface === 'floor' ? preset.floor : preset.wall, random), random);
}
