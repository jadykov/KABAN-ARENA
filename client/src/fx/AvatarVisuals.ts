// Stage 4d.1 avatar visuals (shared by the local avatar in SceneManager and
// remote bodies in RemoteAvatars): the fighter holds a round ball/core in its
// RIGHT hand (local −X; the body faces +Z) and wears a Mii-inspired face
// decal (minimal dark strokes, one of 7 variants picked per player).
// Cheap by construction: shared module-level geometries, ≤7 cached face
// textures/materials total, one per-avatar ball material (charge glow stays
// independent per fighter), no lights, no shadows, no per-frame allocations
// (scalar math only) and no per-frame texture work.

import * as THREE from "three";
import {
  AVATAR_CHARGE_OPACITY,
  HANDBALL_OFFSET_X,
  HANDBALL_OFFSET_Y,
  HANDBALL_OFFSET_Z,
  HANDBALL_RADIUS,
  HANDBALL_THROW_FLICK_S,
  RELOAD_MS,
} from "../config";

export interface HandBallHandle {
  readonly group: THREE.Group;
  setCharge01(value: number): void;
  // Stage 4d.2 charge translucency (local avatar only, driven by
  // SceneManager): fades the held core to AVATAR_CHARGE_OPACITY from charge
  // start until the actual shot/cancel. Transparent flips once and stays
  // flagged (no per-frame state churn); emissive charge glow is independent
  // and keeps working while translucent.
  setTranslucent(active: boolean): void;
  getBallOpacity(): number;
  // Throw flick on release: quick forward snap (~0.15s), then the ball hides
  // for the reload window and pops back at the end (reload return).
  playThrow(): void;
  update(deltaSeconds: number): void;
  reset(): void;
  dispose(): void;
}

export interface AvatarVisualsHandle {
  readonly ball: HandBallHandle;
  readonly face: THREE.Group;
  // Re-assign the face variant once the player's session id is known (local
  // avatar builds before join; remotes pass it at createEntry time).
  setFaceSource(sessionId: string): void;
  setTranslucent(active: boolean): void;
  getBallOpacity(): number;
  update(deltaSeconds: number): void;
  reset(): void;
  dispose(): void;
}

// South Park-style hop state (one per avatar, mutated in place — never
// reallocated per frame). phase = bounce cycle radians, amount = eased
// 0..1 motion intensity driving lift + squash/stretch + rock + waddle.
export interface HopState {
  phase: number;
  amount: number;
  // Per-hop chaos (South Park waddle): lean/roll refreshed from a tiny
  // deterministic PRNG every hop, so each bounce wobbles a different way
  // yet stays stable per player (seeded by session id, not Math.random).
  rng: number;
  lastHop: number;
  lean: number;
  drift: number;
  yawWob: number;
}

export function createHopState(seed = ""): HopState {
  return { phase: 0, amount: 0, rng: hashSeed(seed), lastHop: -1, lean: 0, drift: 0, yawWob: 0 };
}

export function seedHopState(state: HopState, seed: string): void {
  state.rng = hashSeed(seed);
  state.lastHop = -1;
  state.lean = 0;
  state.drift = 0;
  state.yawWob = 0;
}

function hashSeed(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return hash === 0 ? 0x9e3779b9 : hash;
}

// Mulberry32 step (scalar, no allocations): uniform [0, 1).
function nextUnit(state: HopState): number {
  state.rng = (state.rng + 0x6d2b79f5) >>> 0;
  let t = state.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// Shared ball geometry (one sphere for every avatar, module lifetime). Ball
// materials are cloned per avatar (like the old cannon) so the charge
// emissive stays independent per fighter; each handle disposes its own
// material. Face decal geometry + one material per variant are cached
// module-wide (≤7 textures total, shared by every avatar on that variant).
let sharedBallGeo: THREE.SphereGeometry | null = null;
let sharedDecalGeo: THREE.CylinderGeometry | null = null;
const faceMaterials: THREE.MeshBasicMaterial[] = [];

// Mii-inspired schematic faces (owner reference /tmp/hercules/litsa.jpeg —
// file on disk is litsa.jpg): 0 big dots + smile, 1 big happy ∪∪ + smile,
// 2 big >< + frown, 3 big slashes + firm line, 4 round glasses + dots + line,
// 5 dots + open O mouth, 6 dots + wavy mouth. Each = 2-4 BIG elements drawn
// large at 128×128 with thick strokes — expression readable at a glance from
// gameplay distance. Single dark color, no noses, no eyebrows, no hair.
export const FACE_VARIANT_COUNT = 7;
export const FACE_CANVAS_SIZE = 128;
export const FACE_STROKE = "#1a1a1a";
// Curved decal patch hugging the 0.5m capsule front (+Z): radius sits 8mm
// proud so it reads painted-on (no z-fight, no floating), arc ~97° wide,
// upper-front band centered at face height. Rotates with the body (child of
// the avatar). Big on purpose (~3.3x the original area, roughly a third of
// the body): the expression must read schematically at 5-8m gameplay
// distance. Top edge kisses the hemisphere seam so the patch stays on the
// straight cylinder wall (all vertices r=0.508 — protrusion invariant holds).
export const FACE_DECAL_RADIUS = 0.508;
export const FACE_DECAL_HEIGHT = 0.8;
export const FACE_DECAL_ARC = 1.7;
export const FACE_DECAL_Y = 0.1;

// Deterministic variant per player: same hashing spirit as
// paletteForSession (hash*31, mod count) so a session id always maps to the
// same face (stable identity). Empty id → variant 0 (pre-join default).
export function faceVariantForSession(sessionId: string): number {
  let hash = 0;
  for (let i = 0; i < sessionId.length; i += 1) {
    hash = (hash * 31 + sessionId.charCodeAt(i)) >>> 0;
  }
  return hash % FACE_VARIANT_COUNT;
}

function ballMaterialFor(color: number): THREE.MeshStandardMaterial {
  const key = Number.isFinite(color) ? Math.floor(color) : 0xff9f43;
  return new THREE.MeshStandardMaterial({
    color: key,
    emissive: 0xff8800,
    emissiveIntensity: 0,
    roughness: 0.45,
    metalness: 0.1,
  });
}

function ballGeo(): THREE.SphereGeometry {
  if (sharedBallGeo === null) {
    sharedBallGeo = new THREE.SphereGeometry(HANDBALL_RADIUS, 10, 8);
  }
  return sharedBallGeo;
}

function faceDecalGeo(): THREE.CylinderGeometry {
  if (sharedDecalGeo === null) {
    // Open curved patch centered on +Z (theta 0 = +Z in three.js cylinders).
    sharedDecalGeo = new THREE.CylinderGeometry(
      FACE_DECAL_RADIUS,
      FACE_DECAL_RADIUS,
      FACE_DECAL_HEIGHT,
      12,
      1,
      true,
      -FACE_DECAL_ARC / 2,
      FACE_DECAL_ARC / 2,
    );
  }
  return sharedDecalGeo;
}

function arcPath(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, Math.PI * 0.15, Math.PI * 0.85);
  ctx.stroke();
}

// One variant's strokes on a 128×128 transparent canvas: 2-4 BIG elements
// with thick round-cap strokes, no gradients, no detail. Canvas top = patch
// top (flipY). All ink sits at canvas y ≤ 80 so even the mouth lands on the
// shirt region of the two-tone body (patch bottom dips below the clothing
// boundary). Elements fill most of the canvas — readable at a glance from
// 5-8m: two big eyes + one big mouth, nothing else.
function drawFaceVariant(ctx: CanvasRenderingContext2D, variant: number): void {
  ctx.clearRect(0, 0, FACE_CANVAS_SIZE, FACE_CANVAS_SIZE);
  ctx.strokeStyle = FACE_STROKE;
  ctx.fillStyle = FACE_STROKE;
  ctx.lineWidth = 11;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (variant === 1) {
    // Big happy ∪∪ arcs + smile.
    arcPath(ctx, 44, 36, 17);
    arcPath(ctx, 84, 36, 17);
    arcPath(ctx, 64, 66, 12);
    return;
  }
  if (variant === 2) {
    // Big >< + frown.
    ctx.beginPath();
    ctx.moveTo(31, 27);
    ctx.lineTo(57, 53);
    ctx.moveTo(31, 53);
    ctx.lineTo(57, 27);
    ctx.moveTo(71, 27);
    ctx.lineTo(97, 53);
    ctx.moveTo(71, 53);
    ctx.lineTo(97, 27);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(64, 76, 12, Math.PI * 1.15, Math.PI * 1.85);
    ctx.stroke();
    return;
  }
  if (variant === 3) {
    // Big straight slashes + firm line mouth.
    ctx.beginPath();
    ctx.moveTo(32, 32);
    ctx.lineTo(56, 42);
    ctx.moveTo(96, 32);
    ctx.lineTo(72, 42);
    ctx.moveTo(48, 72);
    ctx.lineTo(80, 72);
    ctx.stroke();
    return;
  }
  if (variant === 4) {
    // Round glasses (thick simple frames) + dots + line mouth.
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.arc(44, 40, 18, 0, Math.PI * 2);
    ctx.arc(84, 40, 18, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(60, 36);
    ctx.lineTo(68, 36);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(44, 40, 7, 0, Math.PI * 2);
    ctx.arc(84, 40, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.moveTo(50, 74);
    ctx.lineTo(78, 74);
    ctx.stroke();
    return;
  }
  if (variant === 5) {
    // Big dots + open O mouth.
    ctx.beginPath();
    ctx.arc(44, 40, 11, 0, Math.PI * 2);
    ctx.arc(84, 40, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.arc(64, 68, 10, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }
  if (variant === 6) {
    // Big dots + wavy (~) mouth.
    ctx.beginPath();
    ctx.arc(44, 40, 11, 0, Math.PI * 2);
    ctx.arc(84, 40, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.moveTo(44, 70);
    ctx.quadraticCurveTo(54, 62, 64, 70);
    ctx.quadraticCurveTo(74, 78, 84, 70);
    ctx.stroke();
    return;
  }
  // Variant 0 (also the pre-join default): big dot eyes + smile arc.
  ctx.beginPath();
  ctx.arc(44, 40, 11, 0, Math.PI * 2);
  ctx.arc(84, 40, 11, 0, Math.PI * 2);
  ctx.fill();
  arcPath(ctx, 64, 66, 13);
}

function makeFaceTexture(variant: number): THREE.Texture {
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = FACE_CANVAS_SIZE;
    canvas.height = FACE_CANVAS_SIZE;
    const ctx = canvas.getContext("2d");
    if (ctx !== null) {
      drawFaceVariant(ctx, variant);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.needsUpdate = true;
      return texture;
    }
  }
  // Headless fallback (vitest node env has no DOM canvas): tiny
  // variant-distinct pixel pattern so selection/caching stays testable.
  const size = 8;
  const data = new Uint8Array(size * size * 4);
  const eyeX = 2 + (variant % 3);
  const mouthX = 2 + ((variant + 1) % 4);
  const setPixel = (x: number, y: number): void => {
    const i = (y * size + x) * 4;
    data[i] = 0x1a;
    data[i + 1] = 0x1a;
    data[i + 2] = 0x1a;
    data[i + 3] = 0xff;
  };
  setPixel(eyeX, 2);
  setPixel(size - 1 - eyeX, 2);
  setPixel(mouthX, 5);
  const texture = new THREE.DataTexture(data, size, size);
  texture.needsUpdate = true;
  return texture;
}

function faceMaterialFor(variant: number): THREE.MeshBasicMaterial {
  const normalized = ((variant % FACE_VARIANT_COUNT) + FACE_VARIANT_COUNT) % FACE_VARIANT_COUNT;
  const cached = faceMaterials[normalized];
  if (cached !== undefined) {
    return cached;
  }
  const created = new THREE.MeshBasicMaterial({
    map: makeFaceTexture(normalized),
    transparent: true,
    depthWrite: false,
  });
  // Set once at creation (transparent + map gotcha from AGENTS.md pitfalls).
  created.needsUpdate = true;
  faceMaterials[normalized] = created;
  return created;
}

function createFaceDecal(sessionId: string): THREE.Mesh {
  const decal = new THREE.Mesh(faceDecalGeo(), faceMaterialFor(faceVariantForSession(sessionId)));
  decal.position.set(0, FACE_DECAL_Y, 0);
  decal.castShadow = false;
  // Drawn after other transparents (e.g. shield bubble) so the face stays
  // readable through them.
  decal.renderOrder = 1;
  return decal;
}

// One decal per avatar: a curved patch with the session's variant texture,
// hugging the capsule front (+Z, the move/facing direction). The 8mm-proud
// radius replaces the old per-part protrusion problem entirely — nothing to
// bury, nothing z-fighting. sessionId defaults to "" (variant 0) for the
// pre-join local avatar; call setFaceSource once the id is known.
// (Prior rounds briefly had tiny 3D accents here; dropped for clarity — the
// big bold strokes read better and keep every avatar at minimum draw calls.)
export function attachFace(parent: THREE.Object3D, sessionId = ""): THREE.Group {
  const face = new THREE.Group();
  face.add(createFaceDecal(sessionId));
  parent.add(face);
  return face;
}

// Two-tone clothing (owner: "just paint top/bottom in varied clothing
// colors"): shirt on top, pants below, baked as per-vertex colors so each
// avatar stays ONE draw call and the emissive hit-flash path is untouched
// (emissive is independent of diffuse — HitFlash reads identically over
// vertex-colored surfaces). Build-time only, never per-frame.
// Pants rule: hash the session id with a +7 seed stride (decorrelated from
// the face/palette hash*31) mod a small dark pants palette — stable per
// player, varied across the room. Shirt is always the identity color
// (LOCAL_AVATAR_COLOR / paletteForSession), matching the hand ball.
export const PANTS_PALETTE = [0x2b3a4a, 0x5b3a29, 0x3a3a3a, 0x1f4d2e, 0x4a2440, 0x274060] as const;
export const CLOTHING_BOUNDARY_Y = 0;
export const CLOTHING_BLEND = 0.05;

export function pantsColorForSession(sessionId: string): number {
  let hash = 7;
  for (let i = 0; i < sessionId.length; i += 1) {
    hash = (hash * 31 + sessionId.charCodeAt(i)) >>> 0;
  }
  return PANTS_PALETTE[hash % PANTS_PALETTE.length] ?? PANTS_PALETTE[0] ?? 0x2b3a4a;
}

export function applyClothing(body: THREE.Mesh, shirtColor: number, pantsColor: number): void {
  const geometry = body.geometry;
  const positions = geometry.getAttribute("position");
  const count = positions.count;
  const existing = geometry.getAttribute("color");
  let colors: THREE.BufferAttribute;
  if (existing instanceof THREE.BufferAttribute && existing.count === count && existing.itemSize === 3) {
    // Re-apply (e.g. local avatar locking in its session pants on welcome)
    // overwrites the same attribute — no growth, no realloc.
    colors = existing;
  } else {
    colors = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
    geometry.setAttribute("color", colors);
  }
  // Build-time temps only (never called per-frame).
  const shirt = new THREE.Color(shirtColor);
  const pants = new THREE.Color(pantsColor);
  const mixed = new THREE.Color();
  for (let i = 0; i < count; i += 1) {
    const t = THREE.MathUtils.clamp(
      (positions.getY(i) - (CLOTHING_BOUNDARY_Y - CLOTHING_BLEND)) / (CLOTHING_BLEND * 2),
      0,
      1,
    );
    const s = t * t * (3 - 2 * t);
    mixed.copy(pants).lerp(shirt, s);
    colors.setXYZ(i, mixed.r, mixed.g, mixed.b);
  }
  colors.needsUpdate = true;
  const material = body.material as THREE.MeshStandardMaterial;
  material.color.setHex(0xffffff);
  if (!material.vertexColors) {
    material.vertexColors = true;
    material.needsUpdate = true;
  }
}

// South Park-style hop tuning: eased intensity, SLOW waddle cadence (owner:
// "way too fast" at 6-12Hz — now 2.5-4 hops/s), lift height, exaggerated
// squash at contact / stretch mid-hop, subtle fore-aft rock plus per-hop
// chaotic lean/drift/yaw (small: lively wobble, not drunkenness). All scalar.
const HOP_UP_RATE = 9;
const HOP_DOWN_RATE = 11;
const HOP_MIN_HZ = 2.5;
const HOP_MAX_HZ = 4;
const HOP_LIFT = 0.13;
const HOP_SQUASH = 0.15;
const HOP_STRETCH = 0.1;
const HOP_ROCK = 0.07;
const HOP_LEAN = 0.1;
const HOP_DRIFT = 0.03;
const HOP_YAW = 0.06;

export function resetHopState(state: HopState): void {
  state.phase = 0;
  state.amount = 0;
  state.lastHop = -1;
  state.lean = 0;
  state.drift = 0;
  state.yawWob = 0;
}

export function resetHopVisual(rig: THREE.Object3D, baseY: number): void {
  rig.position.set(0, baseY, 0);
  rig.scale.set(1, 1, 1);
  rig.rotation.set(0, 0, 0);
}

// Per-frame hop writer (no allocations — pure transform writes on the rig).
// speed01: 0 = stand still (eases back to exact identity), 1 = full tilt.
// The rig must be a CHILD of the physics-tracked object so the follow camera
// keeps following the true body position while only the visual hops.
export function updateHopVisual(
  rig: THREE.Object3D,
  baseY: number,
  speed01: number,
  state: HopState,
  deltaSeconds: number,
): void {
  if (!(deltaSeconds > 0)) {
    return;
  }
  const target = Number.isFinite(speed01) ? Math.min(1, Math.max(0, speed01)) : 0;
  const rate = target > state.amount ? HOP_UP_RATE : HOP_DOWN_RATE;
  state.amount += THREE.MathUtils.clamp(target - state.amount, -rate * deltaSeconds, rate * deltaSeconds);
  if (target === 0 && state.amount < 0.001) {
    // Fully settled: snap to exact identity (no residual offsets for
    // respawn/death/spectate paths to inherit).
    state.amount = 0;
    state.phase = 0;
    state.lastHop = -1;
    state.lean = 0;
    state.drift = 0;
    state.yawWob = 0;
    resetHopVisual(rig, baseY);
    return;
  }
  if (state.amount <= 0) {
    return;
  }
  // Phase advances at π radians per hop (one |sin| bounce per π), so the
  // visible bounce rate equals HOP_MIN..MAX_HZ (2.5-4 hops/s at full tilt).
  state.phase += deltaSeconds * (HOP_MIN_HZ + (HOP_MAX_HZ - HOP_MIN_HZ) * state.amount) * Math.PI;
  // Hop boundary (|sin| period is π): each new bounce draws a fresh lean /
  // drift / yaw wobble so consecutive hops waddle chaotically.
  const hopIndex = Math.floor(state.phase / Math.PI);
  if (hopIndex !== state.lastHop) {
    state.lastHop = hopIndex;
    state.lean = (nextUnit(state) * 2 - 1) * HOP_LEAN;
    state.drift = (nextUnit(state) * 2 - 1) * HOP_DRIFT;
    state.yawWob = (nextUnit(state) * 2 - 1) * HOP_YAW;
  }
  const hop = Math.abs(Math.sin(state.phase));
  const squash = 1 - hop;
  rig.position.y = baseY + hop * HOP_LIFT * state.amount;
  rig.position.x = state.drift * state.amount;
  const wide = (squash * HOP_SQUASH - hop * HOP_STRETCH * 0.5) * state.amount;
  const tall = (hop * HOP_STRETCH - squash * HOP_SQUASH) * state.amount;
  rig.scale.set(1 + wide, 1 + tall, 1 + wide);
  rig.rotation.x = -HOP_ROCK * state.amount * Math.sin(state.phase);
  rig.rotation.z = state.lean * state.amount;
  rig.rotation.y = state.yawWob * state.amount;
}

// Round held ball at the RIGHT side (local −X; the body faces +Z), chest
// height (mirrors the old cannon attach offset magnitude), tinted in the
// owner's fighter color. Animations: slow idle bob, charge swell (scale up
// to ~1.6x with charge01 + slight pulse), quick forward flick on release,
// then hidden for the reload window with a pop-back return at the end.
// (muzzleForShot is unaffected by the side: it offsets along the aim *dir*,
// never sideways — verified, no side term in protocol.ts.)
export function attachHandBall(parent: THREE.Object3D, color: number): HandBallHandle {
  const group = new THREE.Group();
  group.position.set(HANDBALL_OFFSET_X, HANDBALL_OFFSET_Y, HANDBALL_OFFSET_Z);

  const material = ballMaterialFor(color);
  const ball = new THREE.Mesh(ballGeo(), material);
  ball.castShadow = false;
  group.add(ball);
  parent.add(group);

  let charge01 = 0;
  let glowTime = 0;
  let bobTime = Math.random() * Math.PI * 2;
  let flickT = -1;
  let reloadT = -1;
  let reappearT = -1;
  const reloadDurationS = RELOAD_MS / 1000;

  const handle: HandBallHandle = {
    group,
    setCharge01(value: number): void {
      charge01 = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
    },
    setTranslucent(active: boolean): void {
      material.transparent = true;
      material.opacity = active === true ? AVATAR_CHARGE_OPACITY : 1;
    },
    getBallOpacity(): number {
      return material.opacity;
    },
    playThrow(): void {
      // Flick and reload clocks start together at release so the ball pops
      // back exactly when the 2.5s FSM reload ends — a new charge never meets
      // a still-hidden ball.
      flickT = 0;
      reloadT = 0;
      reappearT = -1;
      group.visible = true;
    },
    update(deltaSeconds: number): void {
      if (!(deltaSeconds > 0)) {
        return;
      }
      glowTime += deltaSeconds;
      bobTime += deltaSeconds;
      // Charge glow on the held core (emissive only, no lights): hot flicker
      // at full charge, steady warm glow below — same language as the old
      // barrel glow so charge readability is unchanged.
      if (charge01 >= 0.8) {
        material.emissive.setHex(0xff4400);
        material.emissiveIntensity = 2.0 + Math.sin(glowTime * 40) * 0.5 + Math.sin(glowTime * 13.7) * 0.3;
      } else {
        material.emissive.setHex(0xff8800);
        material.emissiveIntensity = charge01 * 1.6;
      }
      // Throw flick (visible forward snap) runs concurrently with the reload
      // clock: both start at release, the flick ends after ~0.15s, and the
      // ball stays hidden until the 2.5s reload elapses, then pops back.
      if (flickT >= 0) {
        flickT += deltaSeconds;
        reloadT += deltaSeconds;
        const flickDuration = HANDBALL_THROW_FLICK_S > 0 ? HANDBALL_THROW_FLICK_S : 0.15;
        const k = Math.min(1, flickT / flickDuration);
        if (k >= 1) {
          flickT = -1;
        } else {
          group.position.z = HANDBALL_OFFSET_Z + Math.sin(k * Math.PI) * 0.35;
          group.position.y = HANDBALL_OFFSET_Y + Math.sin(k * Math.PI) * 0.1;
          const punch = 1 + Math.sin(k * Math.PI) * 0.25;
          ball.scale.setScalar(punch * (1 + charge01 * 0.6));
          return;
        }
      } else if (reloadT >= 0) {
        reloadT += deltaSeconds;
      }
      if (reloadT >= 0) {
        if (reloadT >= reloadDurationS) {
          reloadT = -1;
          reappearT = 0;
          group.visible = true;
        } else {
          group.visible = false;
          return;
        }
      }
      // Held pose: idle bob + charge swell (up to ~1.6x) with a slight pulse.
      group.visible = true;
      group.position.z = HANDBALL_OFFSET_Z;
      group.position.y = HANDBALL_OFFSET_Y + Math.sin(bobTime * 2.2) * 0.03;
      let scale = 1 + charge01 * 0.6;
      if (charge01 > 0) {
        scale *= 1 + Math.sin(bobTime * 10) * 0.05 * charge01;
      }
      if (reappearT >= 0) {
        reappearT += deltaSeconds;
        const pop = Math.min(1, reappearT / 0.25);
        scale *= pop;
        if (pop >= 1) {
          reappearT = -1;
        }
      }
      ball.scale.setScalar(Math.max(0.001, scale));
    },
    reset(): void {
      charge01 = 0;
      flickT = -1;
      reloadT = -1;
      reappearT = -1;
      group.visible = true;
      group.position.set(HANDBALL_OFFSET_X, HANDBALL_OFFSET_Y, HANDBALL_OFFSET_Z);
      ball.scale.setScalar(1);
    },
    dispose(): void {
      if (group.parent !== null) {
        group.parent.remove(group);
      }
      group.remove(ball);
      // Per-handle material is disposed with the handle (charge emissive is
      // per-fighter); the shared ball geometry stays alive (module lifetime)
      // for the other avatars.
      material.dispose();
    },
  };
  return handle;
}

// One call for both avatar paths (local SceneManager + RemoteAvatars) so
// the ball + face stay identical everywhere. update()/reset()/dispose()
// cover the ball; the face is static (no per-frame work, no texture churn).
// sessionId picks the face variant ("" = pre-join default); remotes pass
// their snapshot id, the local avatar re-assigns via setFaceSource on join.
export function attachAvatarVisuals(
  parent: THREE.Object3D,
  color: number,
  sessionId = "",
): AvatarVisualsHandle {
  const face = new THREE.Group();
  const decal = createFaceDecal(sessionId);
  face.add(decal);
  parent.add(face);
  const ball = attachHandBall(parent, color);
  return {
    ball,
    face,
    setFaceSource(nextSessionId: string): void {
      // Cached per-variant material swap — no new texture, no needsUpdate
      // churn (materials compile once each).
      decal.material = faceMaterialFor(faceVariantForSession(nextSessionId));
    },
    setTranslucent(active: boolean): void {
      ball.setTranslucent(active);
    },
    getBallOpacity(): number {
      return ball.getBallOpacity();
    },
    update(deltaSeconds: number): void {
      ball.update(deltaSeconds);
    },
    reset(): void {
      ball.reset();
    },
    dispose(): void {
      ball.dispose();
      if (face.parent !== null) {
        face.parent.remove(face);
      }
      // Shared decal geometry + cached variant textures/materials stay alive
      // (module lifetime) for the other avatars — only links torn down here.
    },
  };
}
