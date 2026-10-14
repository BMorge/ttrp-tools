import * as THREE from 'three';

import { add, centroid, cross, dot, normalize, scale, sub, type Vec3 } from './vector';

import type { DieModel } from './models';
import type { DieType } from './types';

export interface DiePalette {
  body: string;
  ink: string;
  edge: string;
}

export const DIE_PALETTES: Record<DieType, DiePalette> = {
  d4: { body: '#e4572e', ink: '#ffffff', edge: 'rgba(0, 0, 0, 0.22)' },
  d6: { body: '#f4f1ea', ink: '#1f2933', edge: 'rgba(0, 0, 0, 0.16)' },
  d8: { body: '#2e8b57', ink: '#ffffff', edge: 'rgba(0, 0, 0, 0.22)' },
  d10: { body: '#2f6fb2', ink: '#ffffff', edge: 'rgba(0, 0, 0, 0.22)' },
  d12: { body: '#7b4fb8', ink: '#ffffff', edge: 'rgba(0, 0, 0, 0.22)' },
  d20: { body: '#ff6b35', ink: '#ffffff', edge: 'rgba(0, 0, 0, 0.22)' },
};

export interface DieVisual {
  geometry: THREE.BufferGeometry;
  material: THREE.MeshStandardMaterial;
}

const ATLAS_SIZE = 1024;
const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/** Where a face lands in the texture atlas: the projected polygon in canvas pixels. */
interface FaceLayout {
  points: Array<[number, number]>;
  center: [number, number];
  inradius: number;
}

function midpoint(a: Vec3, b: Vec3): Vec3 {
  return scale(add(a, b), 0.5);
}

/** Distance from the 2D origin to the line through p and q. */
function distanceToEdge(p: [number, number], q: [number, number]): number {
  const cross2d = p[0] * q[1] - p[1] * q[0];
  return Math.abs(cross2d) / Math.hypot(q[0] - p[0], q[1] - p[1]);
}

/**
 * Projects every face onto its own plane and places it in a cell of the atlas. The face's
 * "up" points to its first vertex (to an edge for a D6), so numbers have a stable orientation.
 */
function layoutFaces(model: DieModel): FaceLayout[] {
  const count = model.faces.length;
  const columns = Math.ceil(Math.sqrt(count));
  const cell = ATLAS_SIZE / Math.max(columns, Math.ceil(count / columns));

  return model.faces.map((face, index) => {
    const points3d = face.map((vertex) => model.vertices[vertex]);
    const center = centroid(points3d);
    const normal = model.faceNormals[index];
    const upTarget = model.type === 'd6' ? midpoint(points3d[0], points3d[1]) : points3d[0];
    const upRaw = sub(upTarget, center);
    const up = normalize(sub(upRaw, scale(normal, dot(upRaw, normal))));
    const right = cross(up, normal);

    const local = points3d.map((point): [number, number] => {
      const offset = sub(point, center);
      return [dot(offset, right), dot(offset, up)];
    });
    const extent = Math.max(...local.map(([x, y]) => Math.max(Math.abs(x), Math.abs(y))));
    const pixelsPerUnit = (cell * 0.46) / extent;
    const inradius = Math.min(...local.map((point, i) => distanceToEdge(point, local[(i + 1) % local.length])));

    const cellX = ((index % columns) + 0.5) * cell;
    const cellY = (Math.floor(index / columns) + 0.5) * cell;
    return {
      points: local.map(([x, y]): [number, number] => [cellX + x * pixelsPerUnit, cellY - y * pixelsPerUnit]),
      center: [cellX, cellY],
      inradius: inradius * pixelsPerUnit,
    };
  });
}

function createGeometry(model: DieModel, layouts: FaceLayout[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];

  model.faces.forEach((face, faceIndex) => {
    const normal = model.faceNormals[faceIndex];
    const { points } = layouts[faceIndex];
    const pushCorner = (corner: number) => {
      const vertex = model.vertices[face[corner]];
      positions.push(vertex[0], vertex[1], vertex[2]);
      normals.push(normal[0], normal[1], normal[2]);
      uvs.push(points[corner][0] / ATLAS_SIZE, 1 - points[corner][1] / ATLAS_SIZE);
    };
    for (let corner = 1; corner < face.length - 1; corner += 1) {
      pushCorner(0);
      pushCorner(corner);
      pushCorner(corner + 1);
    }
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeBoundingSphere();
  return geometry;
}

function drawLabel(
  context: CanvasRenderingContext2D,
  text: string,
  position: [number, number],
  angle: number,
  size: number,
  underline: boolean,
): void {
  context.save();
  context.translate(position[0], position[1]);
  context.rotate(angle);
  context.font = `700 ${Math.round(size)}px ${FONT_FAMILY}`;
  context.fillText(text, 0, 0);
  if (underline) {
    const width = context.measureText(text).width;
    context.fillRect(-width / 2, size * 0.42, width, Math.max(2, size * 0.08));
  }
  context.restore();
}

function createTexture(model: DieModel, layouts: FaceLayout[], palette: DiePalette, anisotropy: number): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_SIZE;
  canvas.height = ATLAS_SIZE;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Canvas 2D is not available');
  }

  context.fillStyle = palette.body;
  context.fillRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);
  const hasSixAndNine = model.faceLabels.includes('6') && model.faceLabels.includes('9');

  layouts.forEach((layout, faceIndex) => {
    context.beginPath();
    layout.points.forEach(([x, y], corner) => (corner === 0 ? context.moveTo(x, y) : context.lineTo(x, y)));
    context.closePath();
    context.strokeStyle = palette.edge;
    context.lineWidth = Math.max(3, layout.inradius * 0.05);
    context.stroke();

    context.fillStyle = palette.ink;
    context.textAlign = 'center';
    context.textBaseline = 'middle';

    if (model.reading === 'TOP_VERTEX') {
      // Classic D4: each corner shows its vertex number, upright when that vertex points up.
      layout.points.forEach(([x, y], corner) => {
        const dx = x - layout.center[0];
        const dy = y - layout.center[1];
        const value = model.vertexValues[model.faces[faceIndex][corner]];
        drawLabel(
          context,
          String(value),
          [layout.center[0] + dx * 0.55, layout.center[1] + dy * 0.55],
          Math.atan2(dx, -dy),
          layout.inradius * 0.62,
          false,
        );
      });
      return;
    }

    const label = model.faceLabels[faceIndex];
    drawLabel(
      context,
      label,
      layout.center,
      0,
      layout.inradius * (label.length > 1 ? 1.05 : 1.35),
      hasSixAndNine && (label === '6' || label === '9'),
    );
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = anisotropy;
  return texture;
}

export function createDieVisual(model: DieModel, anisotropy: number): DieVisual {
  const layouts = layoutFaces(model);
  const material = new THREE.MeshStandardMaterial({
    map: createTexture(model, layouts, DIE_PALETTES[model.type], anisotropy),
    roughness: 0.42,
    metalness: 0,
  });
  return { geometry: createGeometry(model, layouts), material };
}

export function disposeDieVisual(visual: DieVisual): void {
  visual.geometry.dispose();
  visual.material.map?.dispose();
  visual.material.dispose();
}
