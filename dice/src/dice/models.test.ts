import { describe, expect, it } from 'vitest';

import { getDieModel } from './models';
import { MIN_READING_MARGIN, isClearlyReadable, readDie } from './reading';
import { DIE_SIDES, DIE_TYPES } from './types';
import {
  UP,
  centroid,
  dot,
  normalize,
  quatFromAxisAngle,
  quatFromUnitVectors,
  rotate,
  sub,
  type Quat,
} from './vector';

function multiply(a: Quat, b: Quat): Quat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

describe('die models', () => {
  it.each(DIE_TYPES)('%s has planar outward faces', (type) => {
    const model = getDieModel(type);

    expect(model.faces).toHaveLength(DIE_SIDES[type]);
    model.faces.forEach((face, index) => {
      const normal = model.faceNormals[index];
      const points = face.map((vertex) => model.vertices[vertex]);
      const offset = dot(normal, points[0]);
      points.forEach((point) => expect(dot(normal, point)).toBeCloseTo(offset, 6));
      expect(dot(normal, centroid(points))).toBeGreaterThan(0);
      model.vertices.forEach((vertex) => expect(dot(normal, vertex)).toBeLessThanOrEqual(offset + 1e-6));
    });
  });

  it.each(['d6', 'd8', 'd12', 'd20'] as const)('%s numbers faces 1..N with opposite faces adding to N + 1', (type) => {
    const model = getDieModel(type);
    const sides = DIE_SIDES[type];

    expect([...model.faceValues].sort((a, b) => a - b)).toEqual(Array.from({ length: sides }, (_, i) => i + 1));
    model.faceNormals.forEach((normal, index) => {
      const opposite = model.faceNormals.findIndex((other) => dot(other, normal) < -0.999);
      expect(model.faceValues[index] + model.faceValues[opposite]).toBe(sides + 1);
      expect(model.faceLabels[index]).toBe(String(model.faceValues[index]));
    });
  });

  it('d10 prints 0..9, counts 0 as 10 and keeps odd numbers around the top apex', () => {
    const model = getDieModel('d10');

    expect([...model.faceLabels].sort()).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
    expect([...model.faceValues].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    model.faceNormals.forEach((normal, index) => {
      const label = Number(model.faceLabels[index]);
      expect(label % 2 === 1).toBe(normal[1] > 0);
      const opposite = model.faceNormals.findIndex((other) => dot(other, normal) < -0.999);
      expect(label + Number(model.faceLabels[opposite])).toBe(9);
    });
  });

  it('d4 reads the number at the top vertex', () => {
    const model = getDieModel('d4');

    expect(model.reading).toBe('TOP_VERTEX');
    expect([...model.vertexValues].sort()).toEqual([1, 2, 3, 4]);
  });
});

describe('readDie', () => {
  it.each(DIE_TYPES.filter((type) => type !== 'd4'))('%s reads the face turned up', (type) => {
    const model = getDieModel(type);

    model.faceNormals.forEach((normal, index) => {
      const spin = quatFromAxisAngle(UP, 0.7 * index);
      const rotation = multiply(spin, quatFromUnitVectors(normal, UP));
      const reading = readDie(model, rotation);

      expect(reading.value).toBe(model.faceValues[index]);
      expect(reading.tilt).toBeCloseTo(0, 6);
      expect(isClearlyReadable(reading)).toBe(true);
    });
  });

  it('d4 lying on a face shows the opposite vertex on top', () => {
    const model = getDieModel('d4');

    model.vertices.forEach((vertex, vertexIndex) => {
      const restingFace = model.faces.findIndex((face) => !face.includes(vertexIndex));
      const rotation = quatFromUnitVectors(model.faceNormals[restingFace], [0, -1, 0]);
      const reading = readDie(model, rotation);

      expect(reading.value).toBe(model.vertexValues[vertexIndex]);
      expect(reading.tilt).toBeCloseTo(0, 6);
      expect(isClearlyReadable(reading)).toBe(true);
      expect(rotate(rotation, normalize(vertex))[1]).toBeCloseTo(1, 6);
    });
  });

  it('flags a die balanced on an edge', () => {
    const model = getDieModel('d6');
    const flat = quatFromUnitVectors(model.faceNormals[0], UP);
    const edgeAxis = normalize(sub(model.vertices[model.faces[0][1]], model.vertices[model.faces[0][0]]));
    const balanced = multiply(quatFromAxisAngle(rotate(flat, edgeAxis), Math.PI / 4), flat);
    const reading = readDie(model, balanced);

    expect(reading.tilt).toBeCloseTo(Math.PI / 4, 6);
    expect(reading.margin).toBeCloseTo(0, 6);
    expect(isClearlyReadable(reading)).toBe(false);
  });

  it('still reads a die leaning on a neighbour when its top face is obvious', () => {
    const model = getDieModel('d20');
    const flat = quatFromUnitVectors(model.faceNormals[3], UP);
    const leaning = multiply(quatFromAxisAngle([1, 0, 0], (10 * Math.PI) / 180), flat);
    const reading = readDie(model, leaning);

    expect(reading.value).toBe(model.faceValues[3]);
    expect(reading.margin).toBeGreaterThanOrEqual(MIN_READING_MARGIN);
    expect(isClearlyReadable(reading)).toBe(true);
  });
});
