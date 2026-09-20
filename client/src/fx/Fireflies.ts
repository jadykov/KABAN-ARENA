import * as THREE from "three";
import { FIREFLY_COUNT } from "../config";
import { HL_CHARTREUSE } from "../palette";

// Stage 4d.3 ambient dressing: 8 glow fireflies as ONE InstancedMesh
// (1 draw call) of camera-facing glow quads in warm chartreuse (highlight
// family — fireflies are a must-highlight ambient, pink stays banned).
// Draw-call accounting for the whole stage (documented here so the budget
// stays reviewable): fireflies +1, nebulae +3 (NEBULA_COUNT sprites in
// SceneManager.buildSky), glass walls +0 (same material, transparency only).
// Total added draw calls = 4 (within the A6 budget of <= 4). Light count
// unchanged (no new lights), textures are one shared 64px procedural canvas
// (no asset files, far below the 256px cap).

// Quad size (m): small glow dots readable on a phone, never cover fighters.
export const FIREFLY_QUAD_SIZE = 0.35;
// Vertical bob amplitude (m) and per-instance speed band (rad/s): slow drift.
export const FIREFLY_BOB_AMPLITUDE = 0.25;
export const FIREFLY_SPEED_MIN = 0.5;
export const FIREFLY_SPEED_MAX = 1.0;

// Base positions in groups of 2 / 3 / 1 / 2 (8 total), spread over the arena
// and above head height (y 2.5-3.2; the capsule top is ~2.1) so the drift
// never collides with gameplay reads. XZ footprints avoid obstacle centers
// but that is cosmetic only — fireflies have no collision.
const FIREFLY_BASES: ReadonlyArray<readonly [number, number, number]> = [
  [6.0, 2.6, 6.0],
  [6.9, 2.9, 5.4],
  [-7.0, 3.0, -4.0],
  [-6.1, 2.7, -4.6],
  [-7.6, 3.2, -3.1],
  [0.5, 3.1, -8.5],
  [-2.0, 2.5, 9.0],
  [-1.1, 2.8, 9.6],
];

function makeFireflyTexture(): THREE.Texture {
  if (typeof document === "undefined") {
    // Headless unit tests (vitest node env) have no DOM canvas: fall back
    // to a 1x1 white texture so construction stays testable.
    const pixel = new Uint8Array([255, 255, 255, 255]);
    const fallback = new THREE.DataTexture(pixel, 1, 1);
    fallback.needsUpdate = true;
    return fallback;
  }
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (context !== null) {
    const gradient = context.createRadialGradient(32, 32, 2, 32, 32, 30);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.4, "rgba(255,255,255,0.5)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 64, 64);
  }
  return new THREE.CanvasTexture(canvas);
}

// Ambient firefly swarm: billboarded glow quads with per-instance slow
// scalar bob. Zero per-frame allocations (scratch matrix/vector reused,
// scalar phase math only). frustumCulled off: instances span the arena while
// the base quad geometry sits at the origin, so default culling would pop
// the whole swarm.
export class Fireflies {
  private readonly scene: THREE.Scene;
  private readonly mesh: THREE.InstancedMesh;
  private readonly texture: THREE.Texture;
  private readonly baseX = new Float32Array(FIREFLY_COUNT);
  private readonly baseY = new Float32Array(FIREFLY_COUNT);
  private readonly baseZ = new Float32Array(FIREFLY_COUNT);
  private readonly phases = new Float32Array(FIREFLY_COUNT);
  private readonly speeds = new Float32Array(FIREFLY_COUNT);
  private time = 0;
  // Scratch state for update() (no per-frame alloc).
  private readonly scratchMatrix = new THREE.Matrix4();
  private readonly scratchPosition = new THREE.Vector3();
  private readonly scratchScale = new THREE.Vector3(
    FIREFLY_QUAD_SIZE,
    FIREFLY_QUAD_SIZE,
    FIREFLY_QUAD_SIZE,
  );

  public constructor(scene: THREE.Scene) {
    this.scene = scene;
    for (let i = 0; i < FIREFLY_COUNT; i += 1) {
      const base = FIREFLY_BASES[i % FIREFLY_BASES.length] ?? [0, 2.8, 0];
      this.baseX[i] = base[0];
      this.baseY[i] = base[1];
      this.baseZ[i] = base[2];
      // Deterministic per-instance drift (no RNG — identical every run, so
      // screenshots and tests stay stable).
      this.phases[i] = (i / FIREFLY_COUNT) * Math.PI * 2;
      this.speeds[i] =
        FIREFLY_SPEED_MIN +
        ((FIREFLY_SPEED_MAX - FIREFLY_SPEED_MIN) * (i % 4)) / 3;
    }
    this.texture = makeFireflyTexture();
    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.MeshBasicMaterial({
      map: this.texture,
      color: HL_CHARTREUSE,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    this.mesh = new THREE.InstancedMesh(geometry, material, FIREFLY_COUNT);
    this.mesh.name = "fireflies";
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(this.mesh);
  }

  public get object(): THREE.InstancedMesh {
    return this.mesh;
  }

  // Per-frame drift: bob each instance's Y by a slow sine and billboard the
  // quad with the live camera quaternion. Scalar math + reused scratch
  // objects only — no allocations, no lights, 1 draw call.
  public update(deltaSeconds: number, camera: THREE.Camera): void {
    if (!(deltaSeconds > 0)) {
      return;
    }
    this.time += deltaSeconds;
    const quaternion = camera.quaternion;
    for (let i = 0; i < FIREFLY_COUNT; i += 1) {
      const y =
        this.baseY[i] +
        Math.sin(this.time * this.speeds[i] + this.phases[i]) *
          FIREFLY_BOB_AMPLITUDE;
      this.scratchPosition.set(this.baseX[i], y, this.baseZ[i]);
      this.scratchMatrix.compose(
        this.scratchPosition,
        quaternion,
        this.scratchScale,
      );
      this.mesh.setMatrixAt(i, this.scratchMatrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  public dispose(): void {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.texture.dispose();
  }
}
