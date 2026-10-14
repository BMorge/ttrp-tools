import { TRAY } from './tray';
import { normalize, randomUnitQuaternion, scale, type Quat, type Vec3 } from './vector';

export interface DieLaunch {
  position: Vec3;
  rotation: Quat;
  velocity: Vec3;
  spin: Vec3;
}

const SPACING = 2.4;
const PER_LAYER = 9;
const SPEED = { min: 8, spread: 6 };
const SIDEWAYS = 6;
const SPIN = { min: 10, spread: 14 };

/** Random numbers for physics only: crypto keeps throws unpredictable, it does not prove fairness. */
export function cryptoRandom(): number {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return buffer[0] / 2 ** 32;
}

/** Re-thrown dice start higher, above the dice already lying in the tray. */
export const RETHROW_LIFT = 2.4;

/**
 * Starting conditions of a throw: dice start in a 3 × 3 grid (stacked in layers) near the left wall,
 * with random orientation, a moderate push to the right and a random spin. A gentle throw spreads dice
 * over the tray instead of piling them against the far wall, where they lean on each other.
 */
export function planThrow(count: number, random: () => number = cryptoRandom, lift = 0): DieLaunch[] {
  const jitter = (amount: number) => (random() - 0.5) * 2 * amount;

  return Array.from({ length: count }, (_, index) => {
    const layer = Math.floor(index / PER_LAYER);
    const slot = index % PER_LAYER;
    const column = slot % 3;
    const row = Math.floor(slot / 3);

    const position: Vec3 = [
      -TRAY.width / 2 + 2 + column * SPACING + jitter(0.25),
      2.6 + lift + layer * SPACING + jitter(0.25),
      (row - 1) * SPACING + jitter(0.25),
    ];
    const velocity: Vec3 = [SPEED.min + random() * SPEED.spread, -2 + random() * 3, jitter(SIDEWAYS)];
    const spinAxis = normalize([jitter(1), jitter(1), jitter(1)]);
    const spin = scale(spinAxis, SPIN.min + random() * SPIN.spread);

    return { position, rotation: randomUnitQuaternion(random), velocity, spin };
  });
}
