import { createPolyhedron } from './polyhedra';
import { DIE_SIDES, type DieType } from './types';
import { cross, dot, normalize, scale, sub, type Vec3 } from './vector';

/**
 * How a die is read: by the face looking up, or (classic D4) by the number at the top vertex.
 */
export type ReadingRule = 'TOP_FACE' | 'TOP_VERTEX';

export interface DieModel {
  readonly type: DieType;
  /** World units, centred on the body's centre of mass. */
  readonly vertices: readonly Vec3[];
  readonly faces: readonly (readonly number[])[];
  readonly faceNormals: readonly Vec3[];
  /** What is printed on each face (empty for TOP_VERTEX dice). */
  readonly faceLabels: readonly string[];
  /** Result when the face looks up (D10 prints 0 and counts it as 10). */
  readonly faceValues: readonly number[];
  /** Result when the vertex points up (TOP_VERTEX dice only). */
  readonly vertexValues: readonly number[];
  readonly reading: ReadingRule;
}

/** Circumradius in world units; the tray is 18 × 11 (see tray.ts). */
const DIE_RADIUS: Record<DieType, number> = {
  d4: 1.2,
  d6: 1,
  d8: 1.05,
  d10: 1.05,
  d12: 1.1,
  d20: 1.12,
};

function faceNormal(vertices: readonly Vec3[], face: readonly number[]): Vec3 {
  return normalize(cross(sub(vertices[face[1]], vertices[face[0]]), sub(vertices[face[2]], vertices[face[0]])));
}

function oppositeFace(normals: readonly Vec3[], index: number): number {
  const opposite = normals.findIndex((normal) => dot(normal, normals[index]) < -1 + 1e-6);
  if (opposite < 0) {
    throw new Error('Die face has no opposite face');
  }
  return opposite;
}

/** Classic numbering: opposite faces add up to sides + 1. */
function pairedFaceValues(normals: readonly Vec3[], sides: number): number[] {
  const values = new Array<number>(normals.length).fill(0);
  let next = 1;
  normals.forEach((_, index) => {
    if (values[index] !== 0) {
      return;
    }
    const opposite = oppositeFace(normals, index);
    values[index] = next;
    values[opposite] = sides + 1 - next;
    next += 1;
  });
  return values;
}

/** D10: odd numbers around the top apex, even ones around the bottom, opposite faces add up to 9. */
function d10FaceLabels(normals: readonly Vec3[]): number[] {
  const labels = new Array<number>(normals.length).fill(-1);
  const topFaces = normals
    .map((normal, index) => ({ index, normal }))
    .filter(({ normal }) => normal[1] > 0)
    .sort((a, b) => Math.atan2(a.normal[2], a.normal[0]) - Math.atan2(b.normal[2], b.normal[0]));
  topFaces.forEach(({ index }, position) => {
    labels[index] = 2 * position + 1;
    labels[oppositeFace(normals, index)] = 8 - 2 * position;
  });
  return labels;
}

export function createDieModel(type: DieType): DieModel {
  const sides = DIE_SIDES[type];
  const polyhedron = createPolyhedron(sides);
  const vertices = polyhedron.vertices.map((vertex) => scale(vertex, DIE_RADIUS[type]));
  const faces = polyhedron.faces;
  const faceNormals = faces.map((face) => faceNormal(vertices, face));

  if (type === 'd4') {
    return {
      type,
      vertices,
      faces,
      faceNormals,
      faceLabels: faces.map(() => ''),
      faceValues: faces.map(() => 0),
      vertexValues: vertices.map((_, index) => index + 1),
      reading: 'TOP_VERTEX',
    };
  }

  if (type === 'd10') {
    const labels = d10FaceLabels(faceNormals);
    return {
      type,
      vertices,
      faces,
      faceNormals,
      faceLabels: labels.map(String),
      faceValues: labels.map((label) => (label === 0 ? 10 : label)),
      vertexValues: [],
      reading: 'TOP_FACE',
    };
  }

  const values = pairedFaceValues(faceNormals, sides);
  return {
    type,
    vertices,
    faces,
    faceNormals,
    faceLabels: values.map(String),
    faceValues: values,
    vertexValues: [],
    reading: 'TOP_FACE',
  };
}

const models = new Map<DieType, DieModel>();

export function getDieModel(type: DieType): DieModel {
  let model = models.get(type);
  if (!model) {
    model = createDieModel(type);
    models.set(type, model);
  }
  return model;
}
