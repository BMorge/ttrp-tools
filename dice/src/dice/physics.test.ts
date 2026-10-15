import { beforeAll, describe, expect, it } from 'vitest';

import { getDieModel } from './models';
import { DicePhysics, PHYSICS_STEP, initPhysics, type DieImpact } from './physics';
import { isClearlyReadable, readDie } from './reading';
import { RETHROW_LIFT, planThrow } from './throw';
import { DIE_SIDES, DIE_TYPES, type DieType } from './types';

/** Deterministic PRNG for reproducible throws (mulberry32). */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** Same settle rule as the engine: 0.3 s below the rest speeds, or all bodies asleep. */
function settle(physics: DicePhysics): { elapsed: number; escaped: boolean } {
  let restSteps = 0;
  let elapsed = 0;
  let escaped = false;
  while (elapsed < 12 && restSteps < Math.round(0.3 / PHYSICS_STEP)) {
    physics.step();
    elapsed += PHYSICS_STEP;
    const motion = physics.motion();
    escaped ||= motion.escaped;
    const resting = motion.allSleeping || (motion.maxLinearSpeed < 0.12 && motion.maxAngularSpeed < 0.25);
    restSteps = resting ? restSteps + 1 : 0;
  }
  return { elapsed, escaped };
}

function readAll(physics: DicePhysics, types: DieType[]) {
  const poses = physics.poses();
  return types.map((type, index) => readDie(getDieModel(type), poses[index].rotation));
}

function simulate(types: DieType[], seed: number) {
  const physics = new DicePhysics();
  const launches = planThrow(types.length, seededRandom(seed));
  types.forEach((type, index) => {
    physics.addDie(Float32Array.from(getDieModel(type).vertices.flat()), launches[index]);
  });
  const { elapsed, escaped } = settle(physics);
  const readings = readAll(physics, types);
  return { physics, elapsed, escaped, readings };
}

describe('dice physics', () => {
  beforeAll(async () => {
    await initPhysics();
  });

  it('settles every die type inside the tray within the timeout', () => {
    for (const [index, type] of DIE_TYPES.entries()) {
      const result = simulate([type, type, type], 1000 + index);
      result.physics.dispose();

      expect(result.escaped).toBe(false);
      expect(result.elapsed).toBeLessThan(12);
      result.readings.forEach((reading) => {
        expect(reading.value).toBeGreaterThanOrEqual(1);
        expect(reading.value).toBeLessThanOrEqual(DIE_SIDES[type]);
      });
    }
  });

  it('gives a clear top face for almost every die over a series of mixed throws', () => {
    let dice = 0;
    let readable = 0;
    let slowest = 0;
    for (let seed = 1; seed <= 40; seed += 1) {
      const result = simulate(['d4', 'd6', 'd8', 'd10', 'd12', 'd20'], seed);
      result.physics.dispose();
      expect(result.escaped).toBe(false);
      slowest = Math.max(slowest, result.elapsed);
      dice += result.readings.length;
      readable += result.readings.filter(isClearlyReadable).length;
    }

    expect(slowest).toBeLessThan(6);
    expect(readable / dice).toBeGreaterThan(0.97);
  });

  it('reports knocks while the dice move and falls silent when they rest', () => {
    const types: DieType[] = ['d4', 'd6', 'd8', 'd10', 'd12', 'd20'];
    const physics = new DicePhysics();
    const launches = planThrow(types.length, seededRandom(77));
    types.forEach((type, index) => {
      physics.addDie(Float32Array.from(getDieModel(type).vertices.flat()), launches[index]);
    });

    const impacts: DieImpact[] = [];
    for (let step = 1; step <= Math.round(1.5 / PHYSICS_STEP); step += 1) {
      physics.step();
      if (step % 2 === 0) {
        const batch = physics.takeContacts();
        impacts.push(...batch.impacts);
        batch.impacts.forEach((impact) => expect(impact.at).toBeLessThan(2 * PHYSICS_STEP));
      }
    }

    expect(impacts.length).toBeGreaterThan(10);
    expect(impacts.some((impact) => impact.surface === 'floor')).toBe(true);
    expect(Math.max(...impacts.map((impact) => impact.speed))).toBeGreaterThan(8);

    expect(settle(physics).escaped).toBe(false);
    physics.takeContacts();
    for (let step = 0; step < 60; step += 1) {
      physics.step();
    }
    const resting = physics.takeContacts();
    physics.dispose();

    expect(resting.impacts).toEqual([]);
  });

  it('hears dice knocking each other in a big throw', () => {
    const types = Array.from({ length: 20 }, (_, index) => DIE_TYPES[index % DIE_TYPES.length]);
    const physics = new DicePhysics();
    const launches = planThrow(types.length, seededRandom(78));
    types.forEach((type, index) => {
      physics.addDie(Float32Array.from(getDieModel(type).vertices.flat()), launches[index]);
    });
    for (let step = 0; step < Math.round(1 / PHYSICS_STEP); step += 1) {
      physics.step();
    }
    const { impacts } = physics.takeContacts();
    physics.dispose();

    const knocks = impacts.filter((impact) => impact.surface === 'die');
    expect(knocks.length).toBeGreaterThan(3);
    knocks.forEach((knock) => {
      expect(knock.otherDie).not.toBeNull();
      expect(knock.otherDie).not.toBe(knock.die);
    });
  });

  it('re-throws only the unclear dice of a full 20-dice throw until all are readable', () => {
    const types = Array.from({ length: 20 }, (_, index) => DIE_TYPES[index % DIE_TYPES.length]);
    let worstAttempts = 0;
    for (let seed = 1; seed <= 10; seed += 1) {
      const { physics, escaped } = simulate(types, 500 + seed);
      expect(escaped).toBe(false);
      const random = seededRandom(900 + seed);

      let attempts = 0;
      let unreadable = readAll(physics, types).flatMap((reading, index) => (isClearlyReadable(reading) ? [] : [index]));
      while (unreadable.length > 0 && attempts < 5) {
        const before = physics.poses();
        const launches = planThrow(unreadable.length, random, RETHROW_LIFT);
        unreadable.forEach((index, launch) => physics.relaunchDie(index, launches[launch]));
        expect(settle(physics).escaped).toBe(false);
        attempts += 1;
        unreadable = readAll(physics, types).flatMap((reading, index) => (isClearlyReadable(reading) ? [] : [index]));
        expect(physics.poses()).toHaveLength(before.length);
      }
      physics.dispose();
      expect(unreadable).toEqual([]);
      worstAttempts = Math.max(worstAttempts, attempts);
    }
    expect(worstAttempts).toBeLessThanOrEqual(3);
  });
});
