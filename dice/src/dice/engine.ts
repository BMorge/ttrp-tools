import { getDieModel } from './models';
import { DicePhysics, PHYSICS_STEP, initPhysics } from './physics';
import { isClearlyReadable, readDie } from './reading';
import { DiceScene } from './scene';
import { RETHROW_LIFT, cryptoRandom, planThrow } from './throw';

import { createDieVisual, disposeDieVisual, type DieVisual } from './visuals';

import type { DieType } from './types';

/**
 * - OK: every die shows a clear top face (or D4 vertex), values are counted;
 * - COCKED: a die is balanced on an edge or wedged so that two faces compete for the top;
 * - TIMEOUT: dice did not settle in time;
 * - ESCAPED: a die left the tray.
 * Only OK is a result: the rest is shown as "not counted", never replaced by a hidden random number.
 */
export type RollStatus = 'OK' | 'COCKED' | 'TIMEOUT' | 'ESCAPED';

export interface RolledDie {
  type: DieType;
  value: number;
}

export interface RollOutcome {
  status: RollStatus;
  dice: RolledDie[];
  /** Dice without a clear top face: the user may re-throw just these. */
  unreadable: number[];
}

export interface DiceEngineCallbacks {
  onContextLost: () => void;
}

/** Up to 0.25 s of simulation per frame: low frame rates slow the picture, not the dice. */
const MAX_FRAME_SECONDS = 0.25;
const MAX_STEPS_PER_FRAME = Math.ceil(MAX_FRAME_SECONDS / PHYSICS_STEP);
const REST_LINEAR_SPEED = 0.12;
const REST_ANGULAR_SPEED = 0.25;
const REST_STEPS_REQUIRED = Math.round(0.3 / PHYSICS_STEP);
const ROLL_TIMEOUT_SECONDS = 12;

interface ActiveRoll {
  types: DieType[];
  elapsed: number;
  restSteps: number;
  resolve: (outcome: RollOutcome) => void;
}

export class DiceEngine {
  private readonly physics = new DicePhysics();
  private readonly scene: DiceScene;
  private readonly visuals = new Map<DieType, DieVisual>();
  private readonly resizeObserver: ResizeObserver;
  private roll: ActiveRoll | null = null;
  /** Types of the dice lying in the tray, in the order of the physics bodies. */
  private tableTypes: DieType[] = [];
  private frame: number | null = null;
  private lastFrameTime = 0;
  private accumulator = 0;
  private paused = false;
  private disposed = false;

  static async create(container: HTMLElement, callbacks: DiceEngineCallbacks): Promise<DiceEngine> {
    await initPhysics();
    return new DiceEngine(container, callbacks);
  }

  private constructor(container: HTMLElement, callbacks: DiceEngineCallbacks) {
    this.scene = new DiceScene(container);
    this.scene.canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this.stopLoop();
      callbacks.onContextLost();
    });

    this.resizeObserver = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box && this.scene.resize(Math.round(box.width), Math.round(box.height)) && !this.roll) {
        this.scene.render();
      }
    });
    this.resizeObserver.observe(container);
    const box = container.getBoundingClientRect();
    if (this.scene.resize(Math.round(box.width), Math.round(box.height))) {
      this.scene.render();
    }
  }

  get rolling(): boolean {
    return this.roll !== null;
  }

  throwDice(types: DieType[]): Promise<RollOutcome> {
    const blocked = this.blockedReason();
    if (blocked) {
      return Promise.reject(new Error(blocked));
    }

    this.physics.clearDice();
    const launches = planThrow(types.length);
    types.forEach((type, index) => {
      this.physics.addDie(Float32Array.from(getDieModel(type).vertices.flat()), launches[index]);
    });
    this.scene.setDice(types.map((type) => this.visualFor(type)));
    this.tableTypes = types;
    return this.startRoll();
  }

  /** Re-throws only the given dice of the last throw, like picking up a cocked die at the table. */
  rethrowDice(indices: number[]): Promise<RollOutcome> {
    const blocked = this.blockedReason();
    if (blocked) {
      return Promise.reject(new Error(blocked));
    }
    const valid = indices.filter((index) => index >= 0 && index < this.tableTypes.length);
    if (valid.length === 0) {
      return Promise.reject(new Error('Nothing to re-throw'));
    }
    const launches = planThrow(valid.length, cryptoRandom, RETHROW_LIFT);
    valid.forEach((index, launch) => this.physics.relaunchDie(index, launches[launch]));
    return this.startRoll();
  }

  /** A hidden window freezes the simulation mid-roll and resumes it where it stopped. */
  setPaused(paused: boolean): void {
    if (this.paused === paused || this.disposed) {
      return;
    }
    this.paused = paused;
    if (paused) {
      this.stopLoop();
    } else if (this.roll) {
      this.requestFrame();
    } else {
      this.scene.render();
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.stopLoop();
    this.resizeObserver.disconnect();
    this.roll = null;
    this.physics.dispose();
    this.scene.dispose();
    for (const visual of this.visuals.values()) {
      disposeDieVisual(visual);
    }
    this.visuals.clear();
  }

  private blockedReason(): string | null {
    if (this.disposed) {
      return 'Dice engine is disposed';
    }
    return this.roll ? 'A roll is already in progress' : null;
  }

  private startRoll(): Promise<RollOutcome> {
    this.scene.updatePoses(this.physics.poses());
    return new Promise<RollOutcome>((resolve) => {
      this.roll = { types: this.tableTypes, elapsed: 0, restSteps: 0, resolve };
      this.accumulator = 0;
      this.requestFrame();
    });
  }

  private visualFor(type: DieType): DieVisual {
    let visual = this.visuals.get(type);
    if (!visual) {
      visual = createDieVisual(getDieModel(type), this.scene.maxAnisotropy);
      this.visuals.set(type, visual);
    }
    return visual;
  }

  private requestFrame(): void {
    if (this.frame !== null || this.paused || this.disposed) {
      return;
    }
    this.lastFrameTime = performance.now();
    this.frame = requestAnimationFrame(this.tick);
  }

  private stopLoop(): void {
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
  }

  private readonly tick = (time: number): void => {
    this.frame = null;
    if (this.paused || this.disposed) {
      return;
    }
    const delta = Math.min(Math.max(time - this.lastFrameTime, 0) / 1000, MAX_FRAME_SECONDS);
    this.lastFrameTime = time;

    if (this.roll) {
      this.accumulator += delta;
      let steps = 0;
      while (this.roll && this.accumulator >= PHYSICS_STEP && steps < MAX_STEPS_PER_FRAME) {
        this.physics.step();
        this.accumulator -= PHYSICS_STEP;
        steps += 1;
        this.advanceRoll();
      }
      this.scene.updatePoses(this.physics.poses());
    }
    this.scene.render();

    if (this.roll) {
      this.frame = requestAnimationFrame(this.tick);
    }
  };

  private advanceRoll(): void {
    const roll = this.roll;
    if (!roll) {
      return;
    }
    roll.elapsed += PHYSICS_STEP;

    const motion = this.physics.motion();
    if (motion.escaped) {
      this.finishRoll('ESCAPED');
      return;
    }
    const resting = motion.allSleeping
      || (motion.maxLinearSpeed < REST_LINEAR_SPEED && motion.maxAngularSpeed < REST_ANGULAR_SPEED);
    roll.restSteps = resting ? roll.restSteps + 1 : 0;

    if (roll.restSteps >= REST_STEPS_REQUIRED) {
      this.finishRoll(null);
    } else if (roll.elapsed >= ROLL_TIMEOUT_SECONDS) {
      this.finishRoll('TIMEOUT');
    }
  }

  private finishRoll(failure: RollStatus | null): void {
    const roll = this.roll;
    if (!roll) {
      return;
    }
    this.roll = null;

    const poses = this.physics.poses();
    const readings = roll.types.map((type, index) => readDie(getDieModel(type), poses[index].rotation));
    const unreadable = readings
      .map((reading, index) => (isClearlyReadable(reading) ? -1 : index))
      .filter((index) => index >= 0);
    roll.resolve({
      status: failure ?? (unreadable.length === 0 ? 'OK' : 'COCKED'),
      dice: roll.types.map((type, index) => ({ type, value: readings[index].value })),
      unreadable,
    });
  }
}
