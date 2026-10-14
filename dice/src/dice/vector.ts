/** Minimal vector math for dice geometry and result reading; kept free of three.js so it stays testable. */

export type Vec3 = readonly [number, number, number];

export interface Quat {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

export const UP: Vec3 = [0, 1, 0];

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(v: Vec3, factor: number): Vec3 {
  return [v[0] * factor, v[1] * factor, v[2] * factor];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function length(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

export function normalize(v: Vec3): Vec3 {
  const size = length(v);
  return size === 0 ? [0, 0, 0] : scale(v, 1 / size);
}

export function centroid(points: readonly Vec3[]): Vec3 {
  const sum = points.reduce<Vec3>((total, point) => add(total, point), [0, 0, 0]);
  return scale(sum, 1 / points.length);
}

/** Rotates `v` by the unit quaternion `q` (q · v · q⁻¹). */
export function rotate(q: Quat, v: Vec3): Vec3 {
  const tx = 2 * (q.y * v[2] - q.z * v[1]);
  const ty = 2 * (q.z * v[0] - q.x * v[2]);
  const tz = 2 * (q.x * v[1] - q.y * v[0]);
  return [
    v[0] + q.w * tx + (q.y * tz - q.z * ty),
    v[1] + q.w * ty + (q.z * tx - q.x * tz),
    v[2] + q.w * tz + (q.x * ty - q.y * tx),
  ];
}

/** Shortest rotation that turns the unit vector `from` into the unit vector `to`. */
export function quatFromUnitVectors(from: Vec3, to: Vec3): Quat {
  let w = dot(from, to) + 1;
  let axis: Vec3;
  if (w < 1e-8) {
    w = 0;
    axis = Math.abs(from[0]) > Math.abs(from[2]) ? [-from[1], from[0], 0] : [0, -from[2], from[1]];
  } else {
    axis = cross(from, to);
  }
  const size = Math.hypot(axis[0], axis[1], axis[2], w);
  return { x: axis[0] / size, y: axis[1] / size, z: axis[2] / size, w: w / size };
}

export function quatFromAxisAngle(axis: Vec3, angle: number): Quat {
  const unit = normalize(axis);
  const half = Math.sin(angle / 2);
  return { x: unit[0] * half, y: unit[1] * half, z: unit[2] * half, w: Math.cos(angle / 2) };
}

/** Uniformly distributed random orientation (Shoemake). */
export function randomUnitQuaternion(random: () => number): Quat {
  const u1 = random();
  const u2 = random() * 2 * Math.PI;
  const u3 = random() * 2 * Math.PI;
  const a = Math.sqrt(1 - u1);
  const b = Math.sqrt(u1);
  return { x: a * Math.sin(u2), y: a * Math.cos(u2), z: b * Math.sin(u3), w: b * Math.cos(u3) };
}
