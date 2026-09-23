import * as THREE from "three";
import { FIREFLY_COUNT } from "../config";
import { ACCENT_SPARK, HL_CHARTREUSE, NEUTRAL_WHITE } from "../palette";

// Visual-round ambient dressing (was Stage 4d.3: 8 -> 6 glow fireflies,
// glow halved, blink + wander/hover): 6 star-like twinkles as ONE
// InstancedMesh (1 draw call) of camera-facing 4-point star sparkle quads.
// The swarm reads "starry" rather than "all green": the 3 twinkling indices
// keep the chartreuse highlight (fireflies are a must-highlight ambient,
// pink stays banned) while the other 3 are pale starlight (pale violet +
// white) via per-instance color — still one mesh, no new draw calls.
// Draw-call accounting for the whole stage (documented here so the budget
// stays reviewable): fireflies +1, nebulae +3 (NEBULA_COUNT sprites in
// SceneManager.buildSky), glass walls +0 (same material, transparency only).
// Total added draw calls = 4 (within the A6 budget of <= 4). Light count
// unchanged (no new lights), textures are one shared 64px procedural canvas
// (no asset files, far below the 256px cap).

// Quad size (m): tiny star sparkles readable on a phone, never cover
// fighters (visual round: 0.35 -> 0.24 so they read as distant stars).
export const FIREFLY_QUAD_SIZE = 0.24;
// Base glow opacity: 4d.3 feedback dimmed the default glow -50% (was 0.9).
export const FIREFLY_OPACITY = 0.45;
// Shared sparkle texture size (px): one 64px procedural canvas, well under
// the 256px cap, no asset files.
export const FIREFLY_TEXTURE_SIZE = 64;
// Vertical bob amplitude (m) and per-instance speed band (rad/s): slow drift.
export const FIREFLY_BOB_AMPLITUDE = 0.25;
export const FIREFLY_SPEED_MIN = 0.5;
export const FIREFLY_SPEED_MAX = 1.0;
// Twinkle pulse growth: one shared material has no per-instance opacity, so
// the twinkle rides on SIZE (an additive star quad reads brighter when
// bigger). Peak scale factor is 1 + FIREFLY_TWINKLE_GROW during the pulse
// envelope. (Historic name FIREFLY_BLINK_* is kept as an alias — SceneManager
// tests and older readers use it; new code should say twinkle.)
export const FIREFLY_TWINKLE_GROW = 1.2;
export const FIREFLY_BLINK_GROW = FIREFLY_TWINKLE_GROW;
// Twinkle-capable subset: indices 0/2/4 only (~half, staggered 8/10/12s
// periods) — never all at once (first-active-wins cap in update()).
export const FIREFLY_TWINKLE: readonly boolean[] = [true, false, true, false, true, false];
export const FIREFLY_BLINK: readonly boolean[] = FIREFLY_TWINKLE;
// Per-instance star colors (visual round): the 3 twinkling indices read
// chartreuse (must-highlight ambient), the other 3 read starlight — 2 pale
// violet + 1 pure white — so the swarm sparkles instead of glowing green.
// Applied via instanceColor on the single InstancedMesh (white base material
// color, no new draw calls, no new lights).
export const FIREFLY_COLORS: readonly number[] = [
  HL_CHARTREUSE,
  ACCENT_SPARK,
  HL_CHARTREUSE,
  ACCENT_SPARK,
  HL_CHARTREUSE,
  NEUTRAL_WHITE,
];
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

// Per-index twinkle timing (s): staggered periods 8/10/12 with short pulses
// 0.6/0.4/0.8 (~one twinkle per ~10s per star, never synchronized).
// Non-twinkle indices carry zeros (unused).
const FIREFLY_PERIODS: readonly number[] = [8, 0, 10, 0, 12, 0];
const FIREFLY_PULSES: readonly number[] = [0.6, 0, 0.4, 0, 0.8, 0];
const FIREFLY_TWINKLE_PHASES: readonly number[] = [0, 0, 2.1, 0, 4.2, 0];

// 4-point star falloff (visual round): u/v span [-1, 1] across the quad.
// A soft round core plus thin horizontal/vertical arms (cross-shaped
// falloff): the center is brightest, the arms mid-bright, the diagonals dim.
// Pure scalar math shared by the canvas path and the headless fallback, and
// exported so tests pin the star shape without sampling canvas pixels.
export function fireflyStarAlpha(u: number, v: number): number {
  const d = Math.hypot(u, v);
  const coreBase = 1 - d * 1.2;
  const core = coreBase > 0 ? coreBase * coreBase : 0;
  const armXLong = 1 - Math.abs(u) * 1.2;
  const armXThin = 1 - Math.abs(v) * 4;
  const armX = armXLong > 0 && armXThin > 0 ? armXLong * armXThin : 0;
  const armYLong = 1 - Math.abs(v) * 1.2;
  const armYThin = 1 - Math.abs(u) * 4;
  const armY = armYLong > 0 && armYThin > 0 ? armYLong * armYThin : 0;
  const arms = armX > armY ? armX : armY;
  const alpha = core + 0.7 * arms;
  return alpha > 1 ? 1 : alpha;
}

// Paint a white RGBA star (RGB 255, alpha from fireflyStarAlpha) into data
// for a square texture of the given size. Shared by both texture paths so
// the browser canvas and the headless fallback carry the same cross.
function paintStarTexture(data: Uint8Array | Uint8ClampedArray, size: number): void {
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = (x + 0.5) / size * 2 - 1;
      const v = (y + 0.5) / size * 2 - 1;
      const alpha = fireflyStarAlpha(u, v);
      const i = (y * size + x) * 4;
      data[i] = 0xff;
      data[i + 1] = 0xff;
      data[i + 2] = 0xff;
      data[i + 3] = Math.round(alpha * 255);
    }
  }
}

function makeFireflyTexture(): THREE.Texture {
  if (typeof document === "undefined") {
    // Headless unit tests (vitest node env) have no DOM canvas: fall back
    // to a 16x16 DataTexture carrying the same 4-point star so the cross
    // shape stays testable via texels.
    const size = 16;
    const data = new Uint8Array(size * size * 4);
    paintStarTexture(data, size);
    const fallback = new THREE.DataTexture(data, size, size);
    fallback.colorSpace = THREE.SRGBColorSpace;
    fallback.needsUpdate = true;
    return fallback;
  }
  const canvas = document.createElement("canvas");
  canvas.width = FIREFLY_TEXTURE_SIZE;
  canvas.height = FIREFLY_TEXTURE_SIZE;
  const context = canvas.getContext("2d");
  if (context !== null) {
    const image = context.createImageData(FIREFLY_TEXTURE_SIZE, FIREFLY_TEXTURE_SIZE);
    paintStarTexture(image.data, FIREFLY_TEXTURE_SIZE);
    context.putImageData(image, 0, 0);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

// Ambient star swarm: billboarded 4-point sparkle quads with per-instance
// slow drift (wander XOR hover), vertical bob, per-instance star colors, and
// a capped twinkle pulse. Zero per-frame allocations (preallocated arrays +
// scratch matrix/vector/color, scalar math only). Deterministic: every
// parameter derives from the index (no RNG anywhere, including the hot
// path). frustumCulled off: instances span the arena while the base quad
// geometry sits at the origin, so default culling would pop the whole swarm.
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
  private readonly scratchColor = new THREE.Color();

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
    // White base color: the star tint comes from per-instance colors below
    // (chartreuse twinklers + pale starlight), multiplied with the white
    // star texture. Still one mesh, no new draw calls, no new lights.
    const material = new THREE.MeshBasicMaterial({
      map: this.texture,
      color: NEUTRAL_WHITE,
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
    for (let i = 0; i < FIREFLY_COUNT; i += 1) {
      const tint = FIREFLY_COLORS[i % FIREFLY_COLORS.length] ?? NEUTRAL_WHITE;
      this.scratchColor.set(tint);
      this.mesh.setColorAt(i, this.scratchColor);
    }
    if (this.mesh.instanceColor !== null) {
      this.mesh.instanceColor.needsUpdate = true;
    }
    this.scene.add(this.mesh);
  }

  public get object(): THREE.InstancedMesh {
    return this.mesh;
  }

  // Per-frame drift: wander/hover XZ + sine Y bob, billboarded with the live
  // camera quaternion, plus at most ONE twinkle pulse (first-active-wins
  // across the staggered subset, so the swarm never flashes all at once).
  // Scalar math + reused scratch objects only — no allocations, no lights.
  public update(deltaSeconds: number, camera: THREE.Camera): void {
    if (!(deltaSeconds > 0)) {
      return;
    }
    this.time += deltaSeconds;
    // Pass 1: twinkle envelopes + the concurrency cap (lowest index wins).
    let winner = -1;
    for (let i = 0; i < FIREFLY_COUNT; i += 1) {
      let envelope = 0;
      if (FIREFLY_TWINKLE[i % FIREFLY_TWINKLE.length] === true && winner < 0) {
        const period = FIREFLY_PERIODS[i % FIREFLY_PERIODS.length] ?? 0;
        const pulse = FIREFLY_PULSES[i % FIREFLY_PULSES.length] ?? 0;
        if (period > 0 && pulse > 0) {
          const phase = FIREFLY_TWINKLE_PHASES[i % FIREFLY_TWINKLE_PHASES.length] ?? 0;
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
      const size = FIREFLY_QUAD_SIZE * (1 + FIREFLY_TWINKLE_GROW * this.envelopes[i]);
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
    // Releases the instanceMatrix/instanceColor buffers (per-instance star
    // colors included); geometry/material/texture release below.
    this.mesh.dispose();
    this.texture.dispose();
  }
}
