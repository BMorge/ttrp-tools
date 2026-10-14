import { centroid, cross, dot, length, normalize, scale, sub, type Vec3 } from './vector';

/** Convex dice shapes: vertices around the origin and faces as vertex indices, counter-clockwise from outside. */
export interface Polyhedron {
  vertices: Vec3[];
  faces: number[][];
}

const PHI = (1 + Math.sqrt(5)) / 2;
const EPSILON = 1e-6;

/** Every sign combination of the non-zero components. */
function signedVariants(base: Vec3): Vec3[] {
  let variants: Vec3[] = [[0, 0, 0]];
  for (let axis = 0; axis < 3; axis += 1) {
    const value = base[axis];
    const signs = value === 0 ? [0] : [value, -value];
    variants = variants.flatMap((variant) => signs.map((component) => {
      const next: [number, number, number] = [variant[0], variant[1], variant[2]];
      next[axis] = component;
      return next;
    }));
  }
  return variants;
}

function orderAroundNormal(indices: number[], vertices: readonly Vec3[], normal: Vec3): number[] {
  const center = centroid(indices.map((index) => vertices[index]));
  const reference = normalize(sub(vertices[indices[0]], center));
  const side = cross(normal, reference);
  const angleOf = (index: number) => {
    const offset = sub(vertices[index], center);
    const angle = Math.atan2(dot(offset, side), dot(offset, reference));
    return angle < 0 ? angle + 2 * Math.PI : angle;
  };
  return [...indices].sort((a, b) => angleOf(a) - angleOf(b));
}

/**
 * Faces of the convex hull of points around the origin: every plane through three vertices that keeps
 * all other vertices behind it. Fine for the at most 20 vertices a die has.
 */
export function convexFaces(vertices: readonly Vec3[]): number[][] {
  const planes: Array<{ normal: Vec3; offset: number; members: number[] }> = [];
  const count = vertices.length;

  for (let i = 0; i < count; i += 1) {
    for (let j = i + 1; j < count; j += 1) {
      for (let k = j + 1; k < count; k += 1) {
        const rawNormal = cross(sub(vertices[j], vertices[i]), sub(vertices[k], vertices[i]));
        if (length(rawNormal) < EPSILON) {
          continue;
        }
        let normal = normalize(rawNormal);
        let offset = dot(normal, vertices[i]);
        if (offset < 0) {
          normal = scale(normal, -1);
          offset = -offset;
        }
        if (vertices.some((vertex) => dot(normal, vertex) > offset + EPSILON)) {
          continue;
        }
        if (planes.some((plane) => dot(plane.normal, normal) > 1 - EPSILON && Math.abs(plane.offset - offset) < EPSILON)) {
          continue;
        }
        const members = vertices
          .map((vertex, index) => (Math.abs(dot(normal, vertex) - offset) < EPSILON ? index : -1))
          .filter((index) => index >= 0);
        planes.push({ normal, offset, members });
      }
    }
  }

  return planes.map((plane) => orderAroundNormal(plane.members, vertices, plane.normal));
}

/**
 * Pentagonal trapezohedron (D10). Kite faces are planar only for one apex height:
 * apex = ring · (1 + cos 36°) / (1 − cos 36°) for rings at ±ring with radius 1.
 */
function trapezohedronVertices(): Vec3[] {
  const ringHeight = 0.105;
  const cos36 = Math.cos(Math.PI / 5);
  const apexHeight = (ringHeight * (1 + cos36)) / (1 - cos36);
  const vertices: Vec3[] = [[0, apexHeight, 0], [0, -apexHeight, 0]];
  for (let k = 0; k < 5; k += 1) {
    const angle = (2 * Math.PI * k) / 5;
    vertices.push([Math.cos(angle), ringHeight, Math.sin(angle)]);
  }
  for (let k = 0; k < 5; k += 1) {
    const angle = (2 * Math.PI * k) / 5 + Math.PI / 5;
    vertices.push([Math.cos(angle), -ringHeight, Math.sin(angle)]);
  }
  return vertices;
}

function verticesForSides(sides: number): Vec3[] {
  switch (sides) {
    case 4:
      return [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]];
    case 6:
      return signedVariants([1, 1, 1]);
    case 8:
      return [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    case 10:
      return trapezohedronVertices();
    case 12:
      return [
        ...signedVariants([1, 1, 1]),
        ...signedVariants([0, 1 / PHI, PHI]),
        ...signedVariants([1 / PHI, PHI, 0]),
        ...signedVariants([PHI, 0, 1 / PHI]),
      ];
    case 20:
      return [
        ...signedVariants([0, 1, PHI]),
        ...signedVariants([1, PHI, 0]),
        ...signedVariants([PHI, 0, 1]),
      ];
    default:
      throw new Error(`Unsupported die with ${sides} sides`);
  }
}

/** The die shape with circumradius 1. */
export function createPolyhedron(sides: number): Polyhedron {
  const raw = verticesForSides(sides);
  const radius = Math.max(...raw.map(length));
  const vertices = raw.map((vertex) => scale(vertex, 1 / radius));
  const faces = convexFaces(vertices);
  if (faces.length !== sides) {
    throw new Error(`Die with ${sides} sides produced ${faces.length} faces`);
  }
  return { vertices, faces };
}
