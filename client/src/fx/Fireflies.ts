import * as THREE from "three";
import { FIREFLY_COUNT } from "../config";
import { HL_CHARTREUSE } from "../palette";

// Stage 4d.3 ambient dressing (feedback round: 8 -> 6, glow halved, blink +
// wander/hover): 6 glow fireflies as ONE InstancedMesh (1 draw call) of
// camera-facing glow quads in warm chartreuse (highlight family — fireflies
// are a must-highlight ambient, pink stays banned).
// Draw-call accounting for the whole stage (documented here so the budget
// stays reviewable): fireflies +1, nebulae +3 (NEBULA_COUNT sprites in
// SceneManager.buildSky), glass walls +0 (same material, transparency only).
// Total added draw calls = 4 (within the A6 budget of <= 4). Light count
// unchanged (no new lights), textures are one shared 64px procedural canvas
// (no asset files, far below the 256px cap).

// Quad size (m): small glow dots readable on a phone, never cover fighters.
export const FIREFLY_QUAD_SIZE = 0.35;
// Base glow opacity: 4d.3 feedback dimmed the default glow -50% (was 0.9).
export const FIREFLY_OPACITY = 0.45;
// Vertical bob amplitude (m) and per-instance speed band (rad/s): slow drift.
export const FIREFLY_BOB_AMPLITUDE = 0.25;
export const FIREFLY_SPEED_MIN = 0.5;
export const FIREFLY_SPEED_MAX = 1.0;
// Blink pulse growth: one shared material has no per-instance opacity, so
// the blink rides on SIZE (an additive glow quad reads brighter when bigger).
// Peak scale factor is 1 + FIREFLY_BLINK_GROW during the pulse envelope.
export const FIREFLY_BLINK_GROW = 1.2;
// Blink-capable subset: indices 0/2/4 only (~half, staggered 8/10/12s
// periods) — never all at once (first-active-wins cap in update()).
export const FIREFLY_BLINK: readonly boolean[] = [true, false, true, false, true, false];
// Behavior classes: true = WANDER (slow large-radius drift across the room),
// false = HOVER (small-radius drift near the home area). Both classes ship
// (pinned by test); per-index speeds/phases add slight chaos for ambience.
export const FIREFLY_WANDER: readonly boolean[] = [true, true, false, false, true, false];
// Wander radii (m): large enough to read as travel, small enough to stay far
// inside the arena (|base| <= 7.6 + 2.2 wander < ARENA_HALF_SIZE 16.8).
export const FIREFLY_WANDER_RX = 2.2;
export const FIREFLY_WANDER_RZ = 1.8;
export const FIREFLY_HOVER_R = 0.4;

// Base positions in groups of 2 / 3 / 1 (6 total — feedback round cut the old
// north-east pair), spread over the arena and above head height (y 2.5-3.2;
// the capsule top is ~2.1) so the drift never collides with gameplay reads.
// XZ footprints avoid obstacle centers but that is cosmetic only — fireflies
// have no collision. Exported: tests measure wander/hover displacement from
// these homes (zero runtime cost, no new API on the hot path).
export const FIREFLY_BASES: ReadonlyArray<readonly [number, number, number]> = [
  [6.0, 2.6, 6.0],
  [6.9, 2.9, 5.4],
  [-7.0, 3.0, -4.0],
  [-6.1, 2.7, -4.6],
  [-7.6, 3.2, -3.1],
  [0.5, 3.1, -8.5],
];

// Per-index blink timing (s): staggered periods 8/10/12 with short pulses
// 0.6/0.4/0.8 (~one blink per ~10s per firefly, never synchronized).
// Non-blink indices carry zeros (unused).
const FIREFLY_PERIODS: readonly number[] = [8, 0, 10, 0, 12, 0];
const FIREFLY_PULSES: readonly number[] = [0.6, 0, 0.4, 0, 0.8, 0];
const FIREFLY_BLINK_PHASES: readonly number[] = [0, 0, 2.1, 0, 4.2, 0];

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

// Ambient firefly swarm: billboarded glow quads with per-instance slow drift
// (wander XOR hover), vertical bob, and a capped blink pulse. Zero per-frame
// allocations (preallocated arrays + scratch matrix/vector, scalar math
// only). Deterministic: every parameter derives from the index (no RNG
// anywhere, including the hot path). frustumCulled off: instances span the
// arena while the base quad geometry sits at the origin, so default culling
// would pop the whole swarm.
export class Fireflies {
  private readonly scene: THREE.Scene;
  private readonly mesh: THREE.InstancedMesh;
  private readonly texture: THREE.Texture;
  private readonly baseX = new Float32Array(FIREFLY_COUNT);
  private readonly baseY = new Float32Array(FIREFLY_COUNT);
  private readonly baseZ = new Float32Array(FIREFLY_COUNT);
  private readonly driftW1 = new Float32Array(FIREFLY_COUNT);
  private readonly driftW2 = new Float32Array(FIREFLY_COUNT);
  private readonly driftW3 = new Float32Array(FIREFLY_COUNT);
  private readonly driftP1 = new Float32Array(FIREFLY_COUNT);
  private readonly driftP2 = new Float32Array(FIREFLY_COUNT);
  private readonly envelopes = new Float32Array(FIREFLY_COUNT);
  private time = 0;
  // Scratch state for update() (no per-frame alloc).
  private readonly scratchMatrix = new THREE.Matrix4();
  private readonly scratchPosition = new THREE.Vector3();
  private readonly scratchScale = new THREE.Vector3();

  public constructor(scene: THREE.Scene) {
    this.scene = scene;
    for (let i = 0; i < FIREFLY_COUNT; i += 1) {
      const base = FIREFLY_BASES[i % FIREFLY_BASES.length] ?? [0, 2.8, 0];
      this.baseX[i] = base[0];
      this.baseY[i] = base[1];
      this.baseZ[i] = base[2];
      // Deterministic per-instance drift speeds/phases (slight chaos for
      // ambience, identical every run so screenshots and tests stay stable).
      // Wanderers drift slower (larger paths, same unhurried feel).
      const wander = FIREFLY_WANDER[i % FIREFLY_WANDER.length] === true;
      const speedScale = wander ? 0.35 : 1;
      this.driftW1[i] =
        (FIREFLY_SPEED_MIN + ((FIREFLY_SPEED_MAX - FIREFLY_SPEED_MIN) * (i % 4)) / 3) * speedScale;
      this.driftW2[i] =
        (FIREFLY_SPEED_MIN + ((FIREFLY_SPEED_MAX - FIREFLY_SPEED_MIN) * ((i + 1) % 4)) / 3) *
        speedScale;
      this.driftW3[i] =
        FIREFLY_SPEED_MIN + ((FIREFLY_SPEED_MAX - FIREFLY_SPEED_MIN) * ((i + 2) % 4)) / 3;
      this.driftP1[i] = (i / FIREFLY_COUNT) * Math.PI * 2;
      this.driftP2[i] = ((i + 2) / FIREFLY_COUNT) * Math.PI * 2;
      this.envelopes[i] = 0;
    }
    this.texture = makeFireflyTexture();
    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.MeshBasicMaterial({
      map: this.texture,
      color: HL_CHARTREUSE,
      transparent: true,
      opacity: FIREFLY_OPACITY,
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

  // Per-frame drift: wander/hover XZ + sine Y bob, billboarded with the live
  // camera quaternion, plus at most ONE blink pulse (first-active-wins across
  // the staggered subset, so the swarm never flashes all at once). Scalar
  // math + reused scratch objects only — no allocations, no lights.
  public update(deltaSeconds: number, camera: THREE.Camera): void {
    if (!(deltaSeconds > 0)) {
      return;
    }
    this.time += deltaSeconds;
    // Pass 1: blink envelopes + the concurrency cap (lowest index wins).
    let winner = -1;
    for (let i = 0; i < FIREFLY_COUNT; i += 1) {
      let envelope = 0;
      if (FIREFLY_BLINK[i % FIREFLY_BLINK.length] === true && winner < 0) {
        const period = FIREFLY_PERIODS[i % FIREFLY_PERIODS.length] ?? 0;
        const pulse = FIREFLY_PULSES[i % FIREFLY_PULSES.length] ?? 0;
        if (period > 0 && pulse > 0) {
          const phase = FIREFLY_BLINK_PHASES[i % FIREFLY_BLINK_PHASES.length] ?? 0;
          const cycle = (this.time + phase) % period;
          if (cycle < pulse) {
            // Smooth dim-to-bright bump (sin^2: 0 at both ends, 1 mid-pulse).
            const sine = Math.sin((Math.PI * cycle) / pulse);
            envelope = sine * sine;
            winner = i;
          }
        }
      }
      this.envelopes[i] = envelope;
    }
    // Pass 2: compose billboarded matrices.
    const quaternion = camera.quaternion;
    for (let i = 0; i < FIREFLY_COUNT; i += 1) {
      const wander = FIREFLY_WANDER[i % FIREFLY_WANDER.length] === true;
      const radiusX = wander ? FIREFLY_WANDER_RX : FIREFLY_HOVER_R;
      const radiusZ = wander ? FIREFLY_WANDER_RZ : FIREFLY_HOVER_R;
      const x = this.baseX[i] + radiusX * Math.sin(this.time * this.driftW1[i] + this.driftP1[i]);
      const z = this.baseZ[i] + radiusZ * Math.sin(this.time * this.driftW2[i] + this.driftP2[i]);
      const y =
        this.baseY[i] +
        Math.sin(this.time * this.driftW3[i] + this.driftP1[i]) * FIREFLY_BOB_AMPLITUDE;
      const size = FIREFLY_QUAD_SIZE * (1 + FIREFLY_BLINK_GROW * this.envelopes[i]);
      this.scratchPosition.set(x, y, z);
      this.scratchScale.set(size, size, size);
      this.scratchMatrix.compose(this.scratchPosition, quaternion, this.scratchScale);
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
