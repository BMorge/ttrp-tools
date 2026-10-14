import { normalize, rotate, type Quat, type Vec3 } from './vector';

import type { DieModel } from './models';

/**
 * A result counts only when the deciding face (or D4 vertex) is clearly the top one: its angle from
 * vertical must beat the runner-up by this margin. A die balanced on an edge has two candidates at the
 * same angle and is not counted; a die leaning on another die with an obvious top face is.
 */
export const MIN_READING_MARGIN = (16 * Math.PI) / 180;

export interface DieReading {
  value: number;
  /** Angle between the deciding feature and vertical, radians. 0 means lying perfectly flat. */
  tilt: number;
  /** How much closer to vertical the deciding feature is than the runner-up, radians. */
  margin: number;
}

function pickTop(directions: readonly Vec3[], rotation: Quat): { index: number; tilt: number; margin: number } {
  let best = { index: 0, height: -Infinity };
  let runnerUpHeight = -Infinity;
  directions.forEach((direction, index) => {
    const height = rotate(rotation, direction)[1];
    if (height > best.height) {
      runnerUpHeight = best.height;
      best = { index, height };
    } else if (height > runnerUpHeight) {
      runnerUpHeight = height;
    }
  });
  const angle = (height: number) => Math.acos(Math.min(1, Math.max(-1, height)));
  const tilt = angle(best.height);
  return { index: best.index, tilt, margin: angle(runnerUpHeight) - tilt };
}

export function readDie(model: DieModel, rotation: Quat): DieReading {
  if (model.reading === 'TOP_VERTEX') {
    const top = pickTop(model.vertices.map(normalize), rotation);
    return { value: model.vertexValues[top.index], tilt: top.tilt, margin: top.margin };
  }
  const top = pickTop(model.faceNormals, rotation);
  return { value: model.faceValues[top.index], tilt: top.tilt, margin: top.margin };
}

export function isClearlyReadable(reading: DieReading): boolean {
  return reading.margin >= MIN_READING_MARGIN;
}
