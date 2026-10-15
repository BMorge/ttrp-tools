import RAPIER, { type ColliderDesc, type EventQueue, type RigidBody, type World } from '@dimforge/rapier3d-compat';

import { TRAY } from './tray';

import type { DieLaunch } from './throw';
import type { Quat, Vec3 } from './vector';

export const PHYSICS_STEP = 1 / 120;
const GRAVITY = 50;
const WALL_THICKNESS = 1;
/** Velocity change from one contact (world units per second) that is heard as a knock; resting gives ≈ 0.4. */
export const IMPACT_MIN_SPEED = 1.2;
/** One knock per pair of bodies within this time: an impact is resolved over a few steps; quick chatter stays. */
const IMPACT_COOLDOWN_STEPS = Math.round(0.03 / PHYSICS_STEP);

export interface DiePose {
  position: Vec3;
  rotation: Quat;
}

export interface DiceMotion {
  maxLinearSpeed: number;
  maxAngularSpeed: number;
  allSleeping: boolean;
  escaped: boolean;
}

export type ContactSurface = 'floor' | 'wall' | 'die';

/** A knock worth hearing: the velocity change one contact gave a die. */
export interface DieImpact {
  /** Index of the die in the throw. */
  die: number;
  surface: ContactSurface;
  /** The other die of a die–die knock. */
  otherDie: number | null;
  /** Change of the relative velocity, world units per second. */
  speed: number;
  position: Vec3;
  /** Seconds since the first step of the batch. */
  at: number;
}

/** What the dice did since the previous batch, for the sound: their knocks. */
export interface ContactBatch {
  impacts: DieImpact[];
  steps: number;
}

type ColliderRole = number | 'floor' | 'wall';

let rapierReady: Promise<void> | null = null;

/** Rapier's compat build carries its WebAssembly inline; it is compiled once per document. */
export function initPhysics(): Promise<void> {
  rapierReady ??= RAPIER.init();
  return rapierReady;
}

export class DicePhysics {
  private readonly world: World;
  private readonly events: EventQueue;
  /** Collider handle → index of the die or part of the tray. */
  private readonly roles = new Map<number, ColliderRole>();
  /** Last step that produced a knock, per pair of colliders. */
  private readonly lastImpactStep = new Map<string, number>();
  /** Knocks of the current batch per pair: a stronger step of the same impact raises it. */
  private readonly pendingImpacts = new Map<string, DieImpact>();
  private dice: RigidBody[] = [];
  private stepCount = 0;
  private batchStart = 0;
  private impacts: DieImpact[] = [];

  constructor() {
    this.world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
    this.world.timestep = PHYSICS_STEP;
    this.events = new RAPIER.EventQueue(true);
    this.createTray();
  }

  addDie(hull: Float32Array, launch: DieLaunch): void {
    const [x, y, z] = launch.position;
    const [vx, vy, vz] = launch.velocity;
    const [sx, sy, sz] = launch.spin;
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(x, y, z)
        .setRotation(launch.rotation)
        .setLinvel(vx, vy, vz)
        .setAngvel({ x: sx, y: sy, z: sz })
        .setLinearDamping(0.1)
        .setAngularDamping(0.2)
        .setCcdEnabled(true),
    );
    const collider = RAPIER.ColliderDesc.convexHull(hull);
    if (!collider) {
      throw new Error('Die hull is degenerate');
    }
    const created = this.world.createCollider(
      collider
        .setDensity(1.4)
        .setFriction(0.45)
        .setRestitution(0.35)
        // Every contact of a die reports its force: the knocks are heard from these.
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(0),
      body,
    );
    this.roles.set(created.handle, this.dice.length);
    this.dice.push(body);
  }

  /** Picks a die up and throws it again; the other dice stay where they are. */
  relaunchDie(index: number, launch: DieLaunch): void {
    const body = this.dice[index];
    if (!body) {
      return;
    }
    const [x, y, z] = launch.position;
    const [vx, vy, vz] = launch.velocity;
    const [sx, sy, sz] = launch.spin;
    body.setTranslation({ x, y, z }, true);
    body.setRotation(launch.rotation, true);
    body.setLinvel({ x: vx, y: vy, z: vz }, true);
    body.setAngvel({ x: sx, y: sy, z: sz }, true);
  }

  clearDice(): void {
    for (const body of this.dice) {
      this.world.removeRigidBody(body);
    }
    this.dice = [];
    for (const [handle, role] of this.roles) {
      if (typeof role === 'number') {
        this.roles.delete(handle);
      }
    }
    this.lastImpactStep.clear();
    this.takeContacts();
  }

  step(): void {
    this.world.step(this.events);
    this.stepCount += 1;
    this.events.drainContactForceEvents((event) => {
      this.recordContact(event.collider1(), event.collider2(), event.totalForceMagnitude());
    });
  }

  /** Knocks since the previous call; starts a new batch. */
  takeContacts(): ContactBatch {
    const batch: ContactBatch = { impacts: this.impacts, steps: this.stepCount - this.batchStart };
    this.batchStart = this.stepCount;
    this.impacts = [];
    this.pendingImpacts.clear();
    return batch;
  }

  poses(): DiePose[] {
    return this.dice.map((body) => {
      const position = body.translation();
      const rotation = body.rotation();
      return {
        position: [position.x, position.y, position.z],
        rotation: { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
      };
    });
  }

  motion(): DiceMotion {
    let maxLinearSpeed = 0;
    let maxAngularSpeed = 0;
    let allSleeping = true;
    let escaped = false;
    const limitX = TRAY.width / 2 + 1.5;
    const limitZ = TRAY.depth / 2 + 1.5;

    for (const body of this.dice) {
      const position = body.translation();
      if (Math.abs(position.x) > limitX || Math.abs(position.z) > limitZ || position.y < -1.5) {
        escaped = true;
      }
      if (body.isSleeping()) {
        continue;
      }
      allSleeping = false;
      const linear = body.linvel();
      const angular = body.angvel();
      maxLinearSpeed = Math.max(maxLinearSpeed, Math.hypot(linear.x, linear.y, linear.z));
      maxAngularSpeed = Math.max(maxAngularSpeed, Math.hypot(angular.x, angular.y, angular.z));
    }
    return { maxLinearSpeed, maxAngularSpeed, allSleeping, escaped };
  }

  dispose(): void {
    this.dice = [];
    this.roles.clear();
    this.events.free();
    this.world.free();
  }

  private recordContact(handle1: number, handle2: number, force: number): void {
    const role1 = this.roles.get(handle1) ?? 'wall';
    const role2 = this.roles.get(handle2) ?? 'wall';
    const firstIsDie = typeof role1 === 'number';
    const dieIndex = firstIsDie ? role1 : role2;
    if (typeof dieIndex !== 'number') {
      return;
    }
    const other = firstIsDie ? role2 : role1;
    const body = this.dice[dieIndex];
    const otherBody = typeof other === 'number' ? this.dice[other] : null;
    if (!body || (typeof other === 'number' && !otherBody)) {
      return;
    }

    const impulse = force * PHYSICS_STEP;
    const speed = impulse * (1 / body.mass() + (otherBody ? 1 / otherBody.mass() : 0));
    if (speed < IMPACT_MIN_SPEED) {
      return;
    }
    const position = body.translation();

    const key = handle1 < handle2 ? `${handle1}:${handle2}` : `${handle2}:${handle1}`;
    const pending = this.pendingImpacts.get(key);
    if (pending) {
      pending.speed = Math.max(pending.speed, speed);
      return;
    }
    const last = this.lastImpactStep.get(key);
    if (last !== undefined && this.stepCount - last < IMPACT_COOLDOWN_STEPS) {
      return;
    }
    this.lastImpactStep.set(key, this.stepCount);

    let point: Vec3 = [position.x, position.y, position.z];
    if (otherBody) {
      const second = otherBody.translation();
      point = [(position.x + second.x) / 2, (position.y + second.y) / 2, (position.z + second.z) / 2];
    }
    const impact: DieImpact = {
      die: dieIndex,
      surface: typeof other === 'number' ? 'die' : other,
      otherDie: typeof other === 'number' ? other : null,
      speed,
      position: point,
      at: (this.stepCount - 1 - this.batchStart) * PHYSICS_STEP,
    };
    this.pendingImpacts.set(key, impact);
    this.impacts.push(impact);
  }

  private createTray(): void {
    const tray = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const halfWidth = TRAY.width / 2;
    const halfDepth = TRAY.depth / 2;
    const halfHeight = TRAY.wallHeight / 2;
    const half = WALL_THICKNESS / 2;
    const add = (description: ColliderDesc, role: 'floor' | 'wall' = 'wall') => {
      const collider = this.world.createCollider(description.setFriction(0.7).setRestitution(0.25), tray);
      this.roles.set(collider.handle, role);
    };

    add(RAPIER.ColliderDesc.cuboid(halfWidth + WALL_THICKNESS, half, halfDepth + WALL_THICKNESS).setTranslation(0, -half, 0), 'floor');
    add(RAPIER.ColliderDesc.cuboid(half, halfHeight, halfDepth + WALL_THICKNESS).setTranslation(-halfWidth - half, halfHeight, 0));
    add(RAPIER.ColliderDesc.cuboid(half, halfHeight, halfDepth + WALL_THICKNESS).setTranslation(halfWidth + half, halfHeight, 0));
    add(RAPIER.ColliderDesc.cuboid(halfWidth + WALL_THICKNESS, halfHeight, half).setTranslation(0, halfHeight, -halfDepth - half));
    add(RAPIER.ColliderDesc.cuboid(halfWidth + WALL_THICKNESS, halfHeight, half).setTranslation(0, halfHeight, halfDepth + half));
    add(RAPIER.ColliderDesc.cuboid(halfWidth + WALL_THICKNESS, half, halfDepth + WALL_THICKNESS).setTranslation(0, TRAY.wallHeight + half, 0));
  }
}
