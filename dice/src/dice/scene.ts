import * as THREE from 'three';

import { TRAY } from './tray';

import type { DiePose } from './physics';
import type { DieVisual } from './visuals';

const CAMERA_DIRECTION = new THREE.Vector3(0, 1, 0.42).normalize();
const CAMERA_TARGET = new THREE.Vector3(0, 0, 0.4);

/** Three.js view of the tray. Owns the renderer and the static tray; dice meshes share per-type visuals. */
export class DiceScene {
  readonly canvas: HTMLCanvasElement;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(36, 1, 0.1, 200);
  private readonly diceMeshes: THREE.Mesh[] = [];
  private readonly trayResources: Array<{ dispose(): void }> = [];

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'stage__surface';
    container.appendChild(this.canvas);

    this.scene.background = new THREE.Color('#171a21');
    this.addLights();
    this.addTray();
  }

  get maxAnisotropy(): number {
    return this.renderer.capabilities.getMaxAnisotropy();
  }

  setDice(visuals: DieVisual[]): void {
    this.clearDice();
    for (const visual of visuals) {
      const mesh = new THREE.Mesh(visual.geometry, visual.material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
      this.diceMeshes.push(mesh);
    }
  }

  clearDice(): void {
    for (const mesh of this.diceMeshes) {
      this.scene.remove(mesh);
    }
    this.diceMeshes.length = 0;
  }

  updatePoses(poses: DiePose[]): void {
    poses.forEach((pose, index) => {
      const mesh = this.diceMeshes[index];
      if (!mesh) {
        return;
      }
      mesh.position.set(pose.position[0], pose.position[1], pose.position[2]);
      mesh.quaternion.set(pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w);
    });
  }

  /** Returns false for a zero-sized container (hidden window): the view keeps its last size. */
  resize(width: number, height: number): boolean {
    if (width < 2 || height < 2) {
      return false;
    }
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.fitCamera();
    return true;
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.clearDice();
    for (const resource of this.trayResources) {
      resource.dispose();
    }
    this.renderer.dispose();
    this.canvas.remove();
  }

  private fitCamera(): void {
    const verticalHalf = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const horizontalHalf = Math.atan(Math.tan(verticalHalf) * this.camera.aspect);
    const margin = 1.1;
    const distance = Math.max(
      ((TRAY.depth / 2) * margin) / Math.tan(verticalHalf),
      ((TRAY.width / 2) * margin) / Math.tan(horizontalHalf),
    ) + 2;
    this.camera.position.copy(CAMERA_TARGET).addScaledVector(CAMERA_DIRECTION, distance);
    this.camera.lookAt(CAMERA_TARGET);
    this.camera.updateProjectionMatrix();
  }

  private addLights(): void {
    this.scene.add(new THREE.HemisphereLight('#ffffff', '#3a3f4b', 1.1));
    const key = new THREE.DirectionalLight('#ffffff', 2.2);
    key.position.set(-6, 16, 9);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.bias = -0.0005;
    const shadowCamera = key.shadow.camera;
    shadowCamera.left = -13;
    shadowCamera.right = 13;
    shadowCamera.top = 10;
    shadowCamera.bottom = -10;
    shadowCamera.near = 1;
    shadowCamera.far = 40;
    this.scene.add(key);
  }

  private addTray(): void {
    const own = <T extends { dispose(): void }>(resource: T): T => {
      this.trayResources.push(resource);
      return resource;
    };

    const table = new THREE.Mesh(
      own(new THREE.PlaneGeometry(TRAY.width + 30, TRAY.depth + 30)),
      own(new THREE.MeshStandardMaterial({ color: '#101317', roughness: 1 })),
    );
    table.rotation.x = -Math.PI / 2;
    table.position.y = -0.02;
    this.scene.add(table);

    const felt = new THREE.Mesh(
      own(new THREE.PlaneGeometry(TRAY.width, TRAY.depth)),
      own(new THREE.MeshStandardMaterial({ color: '#235347', roughness: 0.95 })),
    );
    felt.rotation.x = -Math.PI / 2;
    felt.receiveShadow = true;
    this.scene.add(felt);

    const rimHeight = 0.7;
    const rimThickness = 0.5;
    const rimMaterial = own(new THREE.MeshStandardMaterial({ color: '#6b4630', roughness: 0.7 }));
    const longRim = own(new THREE.BoxGeometry(TRAY.width + rimThickness * 2, rimHeight, rimThickness));
    const shortRim = own(new THREE.BoxGeometry(rimThickness, rimHeight, TRAY.depth));
    const rims: Array<[THREE.BufferGeometry, number, number]> = [
      [longRim, 0, -(TRAY.depth + rimThickness) / 2],
      [longRim, 0, (TRAY.depth + rimThickness) / 2],
      [shortRim, -(TRAY.width + rimThickness) / 2, 0],
      [shortRim, (TRAY.width + rimThickness) / 2, 0],
    ];
    for (const [geometry, x, z] of rims) {
      const rim = new THREE.Mesh(geometry, rimMaterial);
      rim.position.set(x, rimHeight / 2, z);
      rim.castShadow = true;
      rim.receiveShadow = true;
      this.scene.add(rim);
    }
  }
}
