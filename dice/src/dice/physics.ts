import RAPIER, { type ColliderDesc, type RigidBody, type World } from '@dimforge/rapier3d-compat';

import { TRAY } from './tray';

import type { DieLaunch } from './throw';
import type { Quat, Vec3 } from './vector';

export const PHYSICS_STEP = 1 / 120;
const GRAVITY = 50;
const WALL_THICKNESS = 1;

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

let rapierReady: Promise<void> | null = null;

/** Rapier's compat build carries its WebAssembly inline; it is compiled once per document. */
export function initPhysics(): Promise<void> {
  rapierReady ??= RAPIER.init();
  return rapierReady;
}

export class DicePhysics {
  private readonly world: World;
  private dice: RigidBody[] = [];

  constructor() {
    this.world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
    this.world.timestep = PHYSICS_STEP;
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
    this.world.createCollider(collider.setDensity(1.4).setFriction(0.45).setRestitution(0.35), body);
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
  }

  step(): void {
    this.world.step();
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
    this.world.free();
  }

  private createTray(): void {
    const tray = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const halfWidth = TRAY.width / 2;
    const halfDepth = TRAY.depth / 2;
    const halfHeight = TRAY.wallHeight / 2;
    const half = WALL_THICKNESS / 2;
    const add = (description: ColliderDesc) => {
      this.world.createCollider(description.setFriction(0.7).setRestitution(0.25), tray);
    };

    add(RAPIER.ColliderDesc.cuboid(halfWidth + WALL_THICKNESS, half, halfDepth + WALL_THICKNESS).setTranslation(0, -half, 0));
    add(RAPIER.ColliderDesc.cuboid(half, halfHeight, halfDepth + WALL_THICKNESS).setTranslation(-halfWidth - half, halfHeight, 0));
    add(RAPIER.ColliderDesc.cuboid(half, halfHeight, halfDepth + WALL_THICKNESS).setTranslation(halfWidth + half, halfHeight, 0));
    add(RAPIER.ColliderDesc.cuboid(halfWidth + WALL_THICKNESS, halfHeight, half).setTranslation(0, halfHeight, -halfDepth - half));
    add(RAPIER.ColliderDesc.cuboid(halfWidth + WALL_THICKNESS, halfHeight, half).setTranslation(0, halfHeight, halfDepth + half));
    add(RAPIER.ColliderDesc.cuboid(halfWidth + WALL_THICKNESS, half, halfDepth + WALL_THICKNESS).setTranslation(0, TRAY.wallHeight + half, 0));
  }
}
