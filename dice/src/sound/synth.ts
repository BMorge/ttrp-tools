/**
 * Procedural sounds of the dice tray: a short contact (a pulse plus a burst of noise) excites a few
 * strongly damped resonances, the way resin and wood answer a knock. Damped means dry: a die clicks
 * and is silent in a few milliseconds instead of ringing like glass. Nothing is recorded — no
 * licences, nothing to download — and every take is deterministic for its seed, so tests check
 * the shape of the sound.
 */

export interface Resonance {
  frequency: number;
  /** Quality factor: rings for Q / (π f) seconds. Wood and resin stay low; glass would be in the hundreds. */
  q: number;
  gain: number;
}

export interface Contact {
  /** Half-sine pulse of the contact, seconds: soft contacts last longer and sound duller. */
  duration: number;
  pulse: number;
  /** Burst of contact noise: its decay, level and colour (0 dark … 1 bright). */
  noiseDecay: number;
  noise: number;
  noiseBrightness: number;
  /** The contact itself heard directly: the dry "tick" on top. */
  tick: number;
}

/** A recipe of one knock: what rings and how it is struck. */
export interface Take {
  resonances: readonly Resonance[];
  contact: Contact;
  duration: number;
}

/** Recorded-like variety: every sound has a few takes, a knock picks one at random. */
export const VARIANTS = 6;
const PEAK = 0.9;

/** mulberry32: small and fast, enough for sound variation. */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

function between(random: () => number, min: number, max: number): number {
  return min + (max - min) * random();
}

function normalize(samples: Float32Array, peak: number): void {
  let max = 0;
  for (const sample of samples) {
    max = Math.max(max, Math.abs(sample));
  }
  if (max > 0) {
    const gain = peak / max;
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] *= gain;
    }
  }
}

/** Short fade-in against digital clicks, fade-out so a cut tail never pops. */
function fade(samples: Float32Array, sampleRate: number): void {
  const fadeIn = Math.min(samples.length, Math.max(1, Math.round(sampleRate * 0.0001)));
  for (let index = 0; index < fadeIn; index += 1) {
    samples[index] *= index / fadeIn;
  }
  const fadeOut = Math.min(samples.length, Math.round(sampleRate * 0.006));
  for (let index = 0; index < fadeOut; index += 1) {
    samples[samples.length - 1 - index] *= index / fadeOut;
  }
}

/** The force of the contact: a smooth pulse for the body of the knock, a noise burst for its grain. */
function renderContact(sampleRate: number, length: number, contact: Contact, random: () => number): Float32Array {
  const drive = new Float32Array(length);
  const pulseLength = Math.max(2, Math.round(sampleRate * contact.duration));
  for (let index = 0; index < Math.min(pulseLength, length); index += 1) {
    drive[index] += contact.pulse * Math.sin((Math.PI * index) / pulseLength);
  }
  const attack = Math.max(1, Math.round(sampleRate * 0.00008));
  const damping = Math.exp(-1 / (contact.noiseDecay * sampleRate));
  let envelope = 1;
  let colored = 0;
  for (let index = 0; index < length && envelope > 1e-5; index += 1) {
    colored += contact.noiseBrightness * ((random() * 2 - 1) - colored);
    drive[index] += contact.noise * colored * envelope * Math.min(1, index / attack);
    if (index >= attack) {
      envelope *= damping;
    }
  }
  return drive;
}

/** A damped resonance driven by the contact (band-pass biquad, 0 dB at the peak). */
function addResonance(output: Float32Array, drive: Float32Array, sampleRate: number, resonance: Resonance): void {
  if (resonance.frequency >= sampleRate / 2 - 500) {
    return;
  }
  const omega = (2 * Math.PI * resonance.frequency) / sampleRate;
  const alpha = Math.sin(omega) / (2 * resonance.q);
  const a0 = 1 + alpha;
  const b0 = alpha / a0;
  const b2 = -alpha / a0;
  const a1 = (-2 * Math.cos(omega)) / a0;
  const a2 = (1 - alpha) / a0;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let index = 0; index < drive.length; index += 1) {
    const x = drive[index];
    const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    output[index] += resonance.gain * y;
  }
}

export function renderTake(sampleRate: number, take: Take, random: () => number): Float32Array {
  const length = Math.round(sampleRate * take.duration);
  const drive = renderContact(sampleRate, length, take.contact, random);
  const samples = new Float32Array(length);
  for (const resonance of take.resonances) {
    addResonance(samples, drive, sampleRate, resonance);
  }
  // The contact heard directly, high-passed: the dry click a microphone close to the dice catches.
  let previous = 0;
  for (let index = 0; index < length; index += 1) {
    samples[index] += take.contact.tick * (drive[index] - previous);
    previous = drive[index];
  }
  fade(samples, sampleRate);
  normalize(samples, PEAK);
  return samples;
}

/** Every take differs a little, like real knocks: resonances, damping, contact length. */
export function vary(take: Take, random: () => number): Take {
  return {
    duration: take.duration,
    resonances: take.resonances.map((resonance) => ({
      frequency: resonance.frequency * between(random, 0.94, 1.06),
      q: resonance.q * between(random, 0.85, 1.15),
      gain: resonance.gain * between(random, 0.75, 1.25),
    })),
    contact: {
      ...take.contact,
      duration: take.contact.duration * between(random, 0.8, 1.25),
      noiseDecay: take.contact.noiseDecay * between(random, 0.8, 1.25),
    },
  };
}

/**
 * A little air around the tray: a smooth, dark, quickly decaying tail. No discrete early reflections —
 * at a few milliseconds they comb-filter the knocks into a hollow "can" sound. Stereo.
 */
export function renderRoomImpulse(sampleRate: number): [Float32Array, Float32Array] {
  const length = Math.round(sampleRate * 0.3);
  const channel = (seed: number): Float32Array => {
    const random = createRandom(seed);
    const samples = new Float32Array(length);
    const start = Math.round(sampleRate * 0.001);
    let low = 0;
    for (let index = start; index < length; index += 1) {
      const time = (index - start) / sampleRate;
      low += 0.25 * ((random() * 2 - 1) - low);
      samples[index] = low * Math.exp(-time / 0.04);
    }
    fade(samples, sampleRate);
    return samples;
  };
  return [channel(5101), channel(6203)];
}
