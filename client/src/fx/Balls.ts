import * as THREE from "three";
import { MAX_LIVE_BALLS, SUPER_BLINK_S } from "../config";
import type { NetBallSnapshot, NetSuperSnapshot } from "../net/protocol";
import {
  ACCENT_BALL_CAP,
  ACCENT_SPARK,
  ACCENT_TRAIL,
  BALL_BASE,
  BALL_BASE_DARK,
  BALL_BASE_LIGHT,
  HL_CHARTREUSE,
  NEUTRAL_WHITE,
} from "../palette";

export const BALL_RADIUS = 0.38;
// Owner fallback marking tint (compat path for snapshots predating the color
// field): a non-finite ball.color renders its painted dot in this pale
// violet over the shared neutral base.
export const BALL_CAP_COLOR = ACCENT_BALL_CAP;
export const SUPER_BALL_COLOR = HL_CHARTREUSE;
export const SUPER_INNER_COLOR = NEUTRAL_WHITE;
// Shared polished-stone ball base (visual round: the old BASE_BG base + big
// 1/3 thrower-color cap read garish). Chosen BALL_BASE 0x141024 — a dark
// amethyst stone in the violet family (HSL lightness ~0.10: slightly lighter
// than the arena background so the core reads on the brightened floor, still
// dark enough that even the darkest fighter keeps >= 0.2 lightness delta for
// the subtle accent below). The polished read comes from the painted vertical
// gradient (DARK poles -> BASE -> LIGHT equatorial sheen) plus a soft
// highlight, not from geometry. Every normal core shares this base; the
// thrower's identity appears ONLY as the subtle ring + polar dot.
export const BALL_NEUTRAL_BASE = BALL_BASE;
// SUPER pickup orb (center spawn): slightly bigger shells so the x2 buff
// reads at a glance on a phone screen. No lights, still one draw group.
export const SUPER_CORE_OUTER_RADIUS = 1.0;
export const SUPER_CORE_INNER_RADIUS = 0.5;
// Fired SUPER ball visual scale (group scale multiplier vs a normal core).
export const SUPER_BALL_SCALE = 2;
// Ball snapshot smoothing: exponential lerp rate (1/s) toward the latest
// authoritative target; teleports beyond SNAP snap immediately (respawn/warp).
export const BALL_LERP_RATE = 20;
export const BALL_SNAP_DIST_SQ = 36;
// Instant local muzzle feedback: short pooled flash at the barrel tip on
// release (<1 frame, zero network wait). No lights, no alloc, sprite pool.
export const MUZZLE_FLASH_LIFE_S = 0.12;
export const MUZZLE_FLASH_GROW = 1.2;
// Double flash: two sprites pop at the tip (core + halo) for a punchier
// release read without lights or extra draw-call spikes (pooled).
export const MUZZLE_FLASH_COUNT = 2;
// Ball skin texture: equirect canvas size (128x64) + SUBTLE ownership accent
// (visual round option B: the old 1/3 polar cap + band at ~40% coverage read
// garish and distracting). Layout, painted FLAT so the sphere stays
// geometrically smooth:
//   - stone gradient: vertical DARK -> BASE -> LIGHT -> BASE -> DARK bands
//     (see BALL_GRADIENT_STOPS) giving a polished dark-amethyst orb read,
//     plus a soft translucent sheen highlight near the upper third;
//   - polar dot: full-width thrower-color band over the top CAP fraction of
//     the texture (1/16 = 4px on the 64px canvas, ~6.25%) — a small dot
//     around the north pole, readable from above without dominating;
//   - equator ring: one thin full-width thrower-color stripe centered on the
//     equator (4px, ~6.25%) — the main ownership read, orbiting visibly as
//     the ball rolls (the accent doubles as the roll-spin carrier; no
//     geometric bump needed).
// Combined accent coverage is 12.5% of the texels (4px + 4px of 64px) —
// clearly smaller than the old ~40%, still enough to tell whose ball is
// flying at gameplay distance, while the dark stone between dot and ring
// keeps the dominant read quiet and stylish.
export const BALL_TEXTURE_SIZE = 128;
export const BALL_CAP_FRACTION = 1 / 16;
export const BALL_EQUATOR_BAND_PX = 4;
// Painted stone gradient stops (offsets in v, canvas top = north pole):
// dark poles, amethyst base, lighter equatorial sheen. Exported so tests pin
// the polished-stone design without sampling canvas pixels; the canvas path
// below builds its linear gradient verbatim from this table.
export const BALL_GRADIENT_STOPS: readonly { readonly offset: number; readonly color: number }[] = [
  { offset: 0, color: BALL_BASE_DARK },
  { offset: 0.25, color: BALL_BASE },
  { offset: 0.5, color: BALL_BASE_LIGHT },
  { offset: 0.75, color: BALL_BASE },
  { offset: 1, color: BALL_BASE_DARK },
];
// Per-thrower skin cache bound: 7 fighter colors + non-finite fallback is the
// legitimate set; the bound only guards against pathological color spam
// (oldest entry evicted, Map insertion order). Never grows per-frame —
// skins are created once per distinct color in skinFor(), never in update().
export const MAX_CACHED_BALL_SKINS = 16;
// Fire trail pool: fixed per-slot trail sprites (2 per ball, 24 total) in
// pale violet (normal fallback) / chartreuse (super). Tied to ball-slot
// visibility (no spawn rate issues, no per-frame alloc); one shared glow
// texture.
export const TRAILS_PER_BALL = 2;
export const TRAIL_POOL_SIZE = MAX_LIVE_BALLS * TRAILS_PER_BALL;
export const TRAIL_GOLD_COLOR = ACCENT_TRAIL;
export const TRAIL_SUPER_COLOR = SUPER_BALL_COLOR;
export const TRAIL_SCALES = [0.42, 0.26] as const;
export const TRAIL_OPACITIES = [0.55, 0.32] as const;
// Environmental impact feedback (bug round 3, blood-only-on-damage): a ball
// that vanishes WITHOUT a server player-hit event pops a SMALL NEUTRAL
// mini-puff (pale violet, never red) — wall/block/floor/boundary deaths keep
// a soft read without faking blood. The red burst spawns ONLY through the
// "ball-hit-player" event (SceneManager blood FX); marked balls skip this
// puff (see markPlayerHit) so a real hit never doubles up.
export const ENV_PUFF_COLOR = ACCENT_SPARK;
export const ENV_PUFF_LIFE_S = 0.3;
export const ENV_PUFF_GROW = 1.5;
export const ENV_PUFF_SUPER_GROW = 3;

// Thrower marking color (polished-stone redesign): the identity appears ONLY
// as the subtle painted accent (polar dot + equator ring) — the raw fighter
// color, no derivation. Non-finite colors fall back to BALL_CAP_COLOR (compat
// path for snapshots predating the color field). Pure function, called only
// when a new distinct color enters the skin cache (never per-frame).
export function markingColorFor(color: number): number {
  return Number.isFinite(color) ? color : BALL_CAP_COLOR;
}

function cssFor(hex: number): string {
  const r = (hex >> 16) & 0xff;
  const g = (hex >> 8) & 0xff;
  const b = hex & 0xff;
  return `rgb(${r},${g},${b})`;
}

// Painted ball skin texture: polished dark-amethyst stone + SUBTLE
// thrower-color accent (thin polar dot + thin equator ring), drawn FLAT so
// the sphere silhouette stays perfectly round. Headless unit tests (vitest
// node env, no DOM canvas) fall back to a 16x16 DataTexture mirroring the
// accent layout only (polar row 0 + equator row 8 in the marking color, all
// other rows in the base — the stone gradient and sheen are canvas-only
// polish, pinned separately via BALL_GRADIENT_STOPS) — selection and layout
// stay testable via texture texels and material userData in both
// environments. SUPER skins (chartreuse base) skip the violet gradient and
// paint flat + sheen so the chartreuse stays pure and distinguishable.
function makeBallTexture(baseHex: number, markingHex: number): THREE.Texture {
  const base = Number.isFinite(baseHex) ? baseHex : BALL_NEUTRAL_BASE;
  const marking = markingColorFor(markingHex);
  const isSuper = base === SUPER_BALL_COLOR;
  if (typeof document === "undefined") {
    const size = 16;
    const data = new Uint8Array(size * size * 4);
    const br = (base >> 16) & 0xff;
    const bg = (base >> 8) & 0xff;
    const bb = base & 0xff;
    const mr = (marking >> 16) & 0xff;
    const mg = (marking >> 8) & 0xff;
    const mb = marking & 0xff;
    // Honest mirror of the canvas accent layout below: the polar dot is the
    // top CAP fraction (ceil(16/16) = row 0 only), the equator ring is the
    // middle row 8 (canvas ring 30-34px of 64 maps to row ~8). All other rows
    // carry the flat base (gradient/sheen are canvas-only polish).
    const capRows = Math.ceil(size * BALL_CAP_FRACTION);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const i = (y * size + x) * 4;
        const isMarking = y < capRows || y === Math.floor(size / 2);
        data[i] = isMarking ? mr : br;
        data[i + 1] = isMarking ? mg : bg;
        data[i + 2] = isMarking ? mb : bb;
        data[i + 3] = 0xff;
      }
    }
    const fallback = new THREE.DataTexture(data, size, size);
    fallback.colorSpace = THREE.SRGBColorSpace;
    fallback.needsUpdate = true;
    return fallback;
  }
  const canvas = document.createElement("canvas");
  canvas.width = BALL_TEXTURE_SIZE;
  canvas.height = BALL_TEXTURE_SIZE / 2;
  const context = canvas.getContext("2d");
  if (context !== null) {
    if (isSuper) {
      // SUPER stays flat chartreuse (no violet gradient) so the power read
      // never muddies; a soft white sheen gives the same polished finish.
      context.fillStyle = cssFor(base);
      context.fillRect(0, 0, canvas.width, canvas.height);
    } else {
      // Polished stone: vertical gradient from BALL_GRADIENT_STOPS (dark
      // poles, lighter equatorial sheen), seamless around all longitudes.
      const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
      for (const stop of BALL_GRADIENT_STOPS) {
        gradient.addColorStop(stop.offset, cssFor(stop.color));
      }
      context.fillStyle = gradient;
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    // Soft sheen highlight near the upper third (translucent white ellipse,
    // alpha ~0.10): a polished glint with no lights, painted under the
    // accent so the thrower color stays pure.
    context.save();
    context.globalAlpha = 0.1;
    context.fillStyle = cssFor(NEUTRAL_WHITE);
    context.beginPath();
    context.ellipse(
      canvas.width * 0.35,
      canvas.height * 0.3,
      canvas.width * 0.16,
      canvas.height * 0.12,
      -0.5,
      0,
      Math.PI * 2,
    );
    context.fill();
    context.restore();
    context.fillStyle = cssFor(marking);
    // Polar dot: thin full-width band over the top fraction (north-pole dot,
    // 4px on the 64px canvas), seamless around all longitudes.
    const capHeight = canvas.height * BALL_CAP_FRACTION;
    context.fillRect(0, 0, canvas.width, capHeight);
    // Equator ring: thin full-width stripe centered on the equator.
    const bandTop = canvas.height / 2 - BALL_EQUATOR_BAND_PX / 2;
    context.fillRect(0, bandTop, canvas.width, BALL_EQUATOR_BAND_PX);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

interface BallSkin {
  texture: THREE.Texture;
  material: THREE.MeshBasicMaterial;
}

// One painted skin per distinct thrower color: shared polished-stone base,
// subtle per-color accent (polar dot + equator ring). userData carries
// { base, marking } hexes so tests (and future readers) can assert the design
// without sampling texels. Disposed in dispose(); SUPER shots use a dedicated
// chartreuse/white skin below.
function makeBallSkin(baseHex: number, markingHex: number): BallSkin {
  const texture = makeBallTexture(baseHex, markingHex);
  const material = new THREE.MeshBasicMaterial({ map: texture });
  material.userData["base"] = Number.isFinite(baseHex) ? baseHex : BALL_NEUTRAL_BASE;
  material.userData["marking"] = markingColorFor(markingHex);
  return { texture, material };
}

function makeGlowTexture(): THREE.Texture {
  if (typeof document === "undefined") {
    // Headless unit tests (vitest node env) have no DOM canvas: fall back
    // to a 1x1 white texture so SceneManager.build() stays constructible.
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

interface Puff {
  sprite: THREE.Sprite;
  life: number;
  maxLife: number;
  grow: number;
}

interface TrackedBall {
  x: number;
  y: number;
  z: number;
  super: boolean;
  color: number;
}

// Reused across render() calls so no Set is allocated per frame.
const renderSeen: Set<string> = new Set();

// Roll-spin scratch axis (module-level, reused every frame): rolling balls
// rotate around the horizontal axis perpendicular to (vx, vz) at
// hypot(vx, vz) / BALL_RADIUS rad/s. Zero per-frame allocs by construction.
const spinAxis = new THREE.Vector3(0, 0, 1);

// Pooled cannonballs (MAX_LIVE_BALLS smooth spheres): every normal core is
// ONE mesh — a shared 16x12 smooth SphereGeometry with a per-thrower painted
// skin (polished-stone BALL_NEUTRAL_BASE base with a vertical gradient +
// sheen, plus a SUBTLE thrower-color accent: thin polar dot + thin equator
// ring at ~12.5% coverage, flat in the texture, per-color cached skins
// bounded by MAX_CACHED_BALL_SKINS, no per-frame alloc). All balls share the
// single stone tone; the thrower's identity reads from the small ring/dot
// accent, which orbits as the ball rolls so the roll spin stays perceptible
// with a perfectly spherical silhouette (no bumps, no protrusions).
// SUPER shots use a dedicated chartreuse skin with a white painted marking
// (same smooth sphere, group scaled x2 via SUPER_BALL_SCALE so the buff reads
// on a phone screen). MeshBasicMaterial only (no new lights, no
// transparency).
// Rolling cores spin while ball.rolling (axis perpendicular to the snapshot
// planar velocity, rate speed/BALL_RADIUS — scalar scratch only, no new
// meshes/lights); resting/standing cores never rotate.
// Fire trail: 2 pooled glow sprites per live ball slot in neutral pale violet
// (chartreuse for SUPER — normal trails no longer copy the owner color so the
// subtle ball accent stays the only ownership read). Impact feedback is the
// pooled puff burst
// (8 sprites): environmental vanishes pop a small NEUTRAL mini-puff (never
// red); player hits skip it via markPlayerHit (the red blood burst covers
// those through the server event). Vanished ids pop a puff.
// Mapping is STABLE by ballId (slotIds parallel to groups): insert/delete/
// order shifts never teleport a ball to another slot. Positions ease toward
// the latest snapshot target (exponential lerp in update); new ids snap once
// on assignment so the first frame sits at the muzzle.
export class BallsPool {
  private readonly scene: THREE.Scene;
  private readonly bodyGeometry = new THREE.SphereGeometry(BALL_RADIUS, 16, 12);
  // Dedicated SUPER skin: chartreuse base + white painted marking (same
  // smooth sphere as normal cores — no protruding inner dome on the flying
  // ball; the power read comes from the chartreuse tone + x2 group scale).
  private readonly superSkin: BallSkin = makeBallSkin(SUPER_BALL_COLOR, SUPER_INNER_COLOR);
  // Per-thrower-color skin cache: one shared painted skin (neutral base +
  // thrower marking dot) per distinct ball.color so cores carry their
  // thrower's marking without allocating a texture/material per ball per
  // frame. Disposed in dispose(). SUPER shots never touch this cache
  // (dedicated skin above).
  private readonly skins = new Map<number, BallSkin>();
  private readonly glowTexture = makeGlowTexture();
  private readonly groups: THREE.Group[] = [];
  private readonly superFlags: boolean[] = [];
  private readonly slotColors: number[] = [];
  // Roll state per slot (mirrors the latest snapshot: rolling flag + planar
  // velocity for the spin rate). Plain parallel arrays, written in render(),
  // read in update() — no allocation on either path.
  private readonly slotRolling: boolean[] = [];
  private readonly slotVelX: number[] = [];
  private readonly slotVelZ: number[] = [];
  private readonly slotIds: Array<string | null> = [];
  private readonly slotTargets: THREE.Vector3[] = [];
  private readonly puffs: Puff[] = [];
  private readonly trails: THREE.Sprite[] = [];
  private readonly tracked = new Map<string, TrackedBall>();
  // Player-hit markers (bug round 3): ball ids confirmed by the server
  // "ball-hit-player" event. Marked ids skip the neutral vanish puff — the
  // red blood burst already covers the impact. Written only on rare hit
  // events (never per-frame), capped so stale ids never accumulate.
  private readonly hitIds = new Set<string>();

  public constructor(scene: THREE.Scene) {
    this.scene = scene;
    // Invisible until the first snapshot assigns a slot: the skin is resolved
    // per snapshot in render(), so the construction skin is irrelevant (never
    // visible with it).
    const seedSkin = this.skinFor(BALL_CAP_COLOR);
    for (let i = 0; i < MAX_LIVE_BALLS; i += 1) {
      const group = new THREE.Group();
      group.visible = false;
      // Single smooth sphere per ball — no cap dome, no second mesh, nothing
      // protruding past BALL_RADIUS (owner: balls must be round, no bumps).
      const body = new THREE.Mesh(this.bodyGeometry, seedSkin.material);
      group.add(body);
      this.scene.add(group);
      this.groups.push(group);
      this.superFlags.push(false);
      this.slotColors.push(BALL_CAP_COLOR);
      this.slotRolling.push(false);
      this.slotVelX.push(0);
      this.slotVelZ.push(0);
      this.slotIds.push(null);
      this.slotTargets.push(new THREE.Vector3());
    }
    for (let i = 0; i < 8; i += 1) {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.glowTexture,
          color: NEUTRAL_WHITE,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        }),
      );
      sprite.visible = false;
      this.scene.add(sprite);
      this.puffs.push({ sprite, life: 0, maxLife: 0.45, grow: 3 });
    }
    // Fire trail pool: TRAILS_PER_BALL sprites per ball slot, hidden until
    // the slot goes live. Shared glow texture, no lights.
    for (let i = 0; i < TRAIL_POOL_SIZE; i += 1) {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.glowTexture,
          color: TRAIL_GOLD_COLOR,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        }),
      );
      sprite.visible = false;
      this.scene.add(sprite);
      this.trails.push(sprite);
    }
  }

  // Per-thrower-color painted skin (cached by color, created once per
  // distinct fighter color: shared polished-stone base, subtle accent
  // (polar dot + equator ring) in the thrower's color). Falls back to
  // BALL_CAP_COLOR for non-finite colors (compat path for snapshots predating
  // the color field). Bounded by MAX_CACHED_BALL_SKINS (oldest evicted) so
  // pathological color spam can never grow the cache; the legitimate set is
  // 7 fighters + the fallback, so eviction never fires in practice.
  private skinFor(color: number): BallSkin {
    const key = Number.isFinite(color) ? color : BALL_CAP_COLOR;
    const cached = this.skins.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const created = makeBallSkin(BALL_NEUTRAL_BASE, key);
    this.skins.set(key, created);
    if (this.skins.size > MAX_CACHED_BALL_SKINS) {
      const oldest = this.skins.keys().next();
      if (!oldest.done) {
        const victim = this.skins.get(oldest.value);
        this.skins.delete(oldest.value);
        victim?.texture.dispose();
        victim?.material.dispose();
      }
    }
    return created;
  }

  // Player-hit marker (bug round 3): call when the server "ball-hit-player"
  // event arrives for a ball id. The id's snapshot vanish then skips the
  // neutral env puff (the red burst covers it). The event lands ahead of or
  // with the snapshot that drops the ball, so the marker is always armed in
  // time; the cap + consume keep the set bounded even if a marked ball never
  // vanishes (reconnect races).
  public markPlayerHit(ballId: string): void {
    if (typeof ballId !== "string" || ballId === "") {
      return;
    }
    this.hitIds.add(ballId);
    if (this.hitIds.size > MAX_LIVE_BALLS * 2) {
      const oldest = this.hitIds.values().next();
      if (!oldest.done && typeof oldest.value === "string") {
        this.hitIds.delete(oldest.value);
      }
    }
  }

  private consumePlayerHit(ballId: string): boolean {
    if (!this.hitIds.has(ballId)) {
      return false;
    }
    this.hitIds.delete(ballId);
    return true;
  }

  public render(balls: readonly NetBallSnapshot[]): void {
    renderSeen.clear();
    for (const ball of balls) {
      renderSeen.add(ball.ballId);
    }
    // Release vanished ids first so freed slots are reusable in the same
    // frame (no order-shift teleport): puff at the last tracked position.
    for (let i = 0; i < this.groups.length; i += 1) {
      const slotId = this.slotIds[i];
      if (slotId === null || slotId === undefined) {
        continue;
      }
      if (renderSeen.has(slotId)) {
        continue;
      }
      const group = this.groups[i];
      if (group !== undefined) {
        group.visible = false;
        group.scale.setScalar(1);
      }
      this.superFlags[i] = false;
      this.slotColors[i] = BALL_CAP_COLOR;
      this.slotRolling[i] = false;
      this.slotVelX[i] = 0;
      this.slotVelZ[i] = 0;
      this.slotIds[i] = null;
      const last = this.tracked.get(slotId);
      this.tracked.delete(slotId);
      if (last !== undefined && !this.consumePlayerHit(slotId)) {
        this.spawnEnvPuff(last.x, last.y, last.z, last.super);
      }
    }
    // Assign by ballId (stable) or update the existing slot target. New ids
    // snap once to the authoritative position; existing ids only move the
    // target — update() eases toward it (no hard snap, no teleport).
    for (const ball of balls) {
      let slot = -1;
      for (let i = 0; i < this.slotIds.length; i += 1) {
        if (this.slotIds[i] === ball.ballId) {
          slot = i;
          break;
        }
      }
      if (slot < 0) {
        for (let i = 0; i < this.slotIds.length; i += 1) {
          if (this.slotIds[i] === null || this.slotIds[i] === undefined) {
            slot = i;
            break;
          }
        }
      }
      if (slot < 0) {
        // Pool exhausted (server caps at 12, pool is 12): still track the
        // id so its vanish pops a puff instead of leaking.
        this.tracked.set(ball.ballId, {
          x: ball.x,
          y: ball.y,
          z: ball.z,
          super: ball.super === true,
          color: ball.color,
        });
        continue;
      }
      const group = this.groups[slot];
      const target = this.slotTargets[slot];
      if (group === undefined || target === undefined) {
        continue;
      }
      const isSuper = ball.super === true;
      const isNew = this.slotIds[slot] !== ball.ballId;
      this.slotIds[slot] = ball.ballId;
      if (isNew) {
        group.visible = true;
        // Recycled slots must not keep the previous ball's roll orientation:
        // a fresh core starts axis-aligned (reviewer note 5).
        group.quaternion.identity();
        group.position.set(ball.x, ball.y, ball.z);
        target.set(ball.x, ball.y, ball.z);
      } else {
        target.set(ball.x, ball.y, ball.z);
      }
      group.visible = true;
      this.superFlags[slot] = isSuper;
      this.slotColors[slot] = ball.color;
      // Roll state mirrors the snapshot every frame (no prediction): update()
      // spins rolling slots around the velocity-perpendicular axis; resting
      // or flying slots never rotate. Non-finite velocities read as 0.
      this.slotRolling[slot] = ball.rolling === true;
      this.slotVelX[slot] = typeof ball.vx === "number" && Number.isFinite(ball.vx) ? ball.vx : 0;
      this.slotVelZ[slot] = typeof ball.vz === "number" && Number.isFinite(ball.vz) ? ball.vz : 0;
      // SUPER cores read the x2 buff at a glance: the whole group scales by
      // SUPER_BALL_SCALE; normal cores stay at scale 1 (reset on reuse so a
      // recycled SUPER slot never keeps a giant normal core).
      group.scale.setScalar(isSuper ? SUPER_BALL_SCALE : 1);
      const skin = this.skinFor(ball.color);
      const body = group.children[0] as THREE.Mesh | undefined;
      if (body !== undefined) {
        // Thrower identity (polished-stone redesign): every normal core shares
        // the stone base — the thrower reads from the SUBTLE painted accent
        // (thin polar dot + equator ring in the skin texture, same fighter
        // color, flat paint, silhouette stays spherical). SUPER keeps the
        // dedicated chartreuse/white skin.
        body.material = isSuper ? this.superSkin.material : skin.material;
      }
      this.tracked.set(ball.ballId, { x: ball.x, y: ball.y, z: ball.z, super: isSuper, color: ball.color });
    }
    // Defensive: tracked ids that never got a slot (pool-exhausted edge)
    // still vanish quietly; player-hit marks are honored here too.
    for (const [ballId, last] of this.tracked) {
      if (!renderSeen.has(ballId)) {
        this.tracked.delete(ballId);
        if (!this.consumePlayerHit(ballId)) {
          this.spawnEnvPuff(last.x, last.y, last.z, last.super);
        }
      }
    }
    // Cap the tracked map (stale ids never accumulate).
    if (this.tracked.size > MAX_LIVE_BALLS * 2) {
      const keys = [...this.tracked.keys()].slice(0, this.tracked.size - MAX_LIVE_BALLS * 2);
      for (const key of keys) {
        this.tracked.delete(key);
      }
    }
  }

  public update(deltaSeconds: number): void {
    if (!(deltaSeconds > 0)) {
      return;
    }
    const lerpAlpha = 1 - Math.exp(-BALL_LERP_RATE * deltaSeconds);
    for (let i = 0; i < this.groups.length; i += 1) {
      const slotId = this.slotIds[i];
      const group = this.groups[i];
      if (group === undefined || slotId === null || slotId === undefined || !group.visible) {
        this.hideTrailsForSlot(i);
        // Still tick SUPER pulse below for visible supers only; skip lerp.
      } else {
        const target = this.slotTargets[i];
        if (target !== undefined) {
          const distSq = group.position.distanceToSquared(target);
          if (distSq > BALL_SNAP_DIST_SQ) {
            group.position.copy(target);
          } else if (distSq > 1e-10) {
            group.position.lerp(target, lerpAlpha);
          }
        }
        // Roll spin (owner 4d.4): while the snapshot says rolling, rotate the
        // mesh around the horizontal axis perpendicular to (vx, vz) at
        // speed/BALL_RADIUS rad/s — rolling without slipping. The axis is the
        // up×velocity direction (vz, 0, -vx), normalized; resting, flying and
        // zero-speed slots never rotate. Scalar math on the shared scratch
        // axis only: zero per-frame allocs, no new meshes/lights.
        if (this.slotRolling[i] === true) {
          const vx = this.slotVelX[i] ?? 0;
          const vz = this.slotVelZ[i] ?? 0;
          const speed = Math.hypot(vx, vz);
          if (speed > 1e-6) {
            spinAxis.set(vz / speed, 0, -vx / speed);
            group.rotateOnWorldAxis(spinAxis, (speed / BALL_RADIUS) * deltaSeconds);
          }
        }
        this.showTrailsForSlot(i, group.position, this.superFlags[i] === true, this.slotColors[i] ?? BALL_CAP_COLOR);
      }
      // No SUPER pulse: the flying SUPER core is one smooth sphere (same
      // silhouette as a normal core) — the chartreuse skin + white marking +
      // x2 scale carry the power read without any scaling inner mesh.
    }
    for (const puff of this.puffs) {
      if (puff.life <= 0) {
        continue;
      }
      puff.life -= deltaSeconds;
      if (puff.life <= 0) {
        puff.life = 0;
        puff.sprite.visible = false;
        continue;
      }
      const t = 1 - puff.life / puff.maxLife;
      const scale = 0.6 + t * puff.grow;
      puff.sprite.scale.set(scale, scale, 1);
      (puff.sprite.material as THREE.SpriteMaterial).opacity = 0.9 * (1 - t);
    }
  }

  public spawnPuff(x: number, y: number, z: number, superShot: boolean, color: number = BALL_CAP_COLOR): void {
    let slot: Puff | null = null;
    for (const puff of this.puffs) {
      if (puff.life <= 0) {
        slot = puff;
        break;
      }
    }
    if (slot === null) {
      return;
    }
    slot.life = superShot ? 0.7 : 0.45;
    slot.maxLife = slot.life;
    slot.grow = superShot ? 7 : 3;
    slot.sprite.visible = true;
    slot.sprite.position.set(x, y, z);
    slot.sprite.scale.set(0.6, 0.6, 1);
    const material = slot.sprite.material as THREE.SpriteMaterial;
    const tint = superShot ? SUPER_BALL_COLOR : Number.isFinite(color) ? color : ACCENT_TRAIL;
    material.color.set(tint);
    material.opacity = 0.9;
  }

  // Environmental vanish puff (bug round 3): SMALL NEUTRAL mini-puff in pale
  // violet (never red, never the thrower color) for wall/block/floor/
  // boundary deaths. Reuses the same pooled sprites (no new draw calls, no
  // alloc); SUPER vanishes read slightly bigger but stay neutral.
  public spawnEnvPuff(x: number, y: number, z: number, superShot: boolean): void {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return;
    }
    let slot: Puff | null = null;
    for (const puff of this.puffs) {
      if (puff.life <= 0) {
        slot = puff;
        break;
      }
    }
    if (slot === null) {
      return;
    }
    slot.life = ENV_PUFF_LIFE_S;
    slot.maxLife = ENV_PUFF_LIFE_S;
    slot.grow = superShot ? ENV_PUFF_SUPER_GROW : ENV_PUFF_GROW;
    slot.sprite.visible = true;
    slot.sprite.position.set(x, y, z);
    slot.sprite.scale.set(0.6, 0.6, 1);
    const material = slot.sprite.material as THREE.SpriteMaterial;
    material.color.set(ENV_PUFF_COLOR);
    material.opacity = 0.9;
  }

  // Instant local feedback (<1 frame, zero network wait): a DOUBLE pooled
  // flash AT the barrel tip on release (core + halo). Reuses the puff sprite
  // pool (no alloc, no lights, DOM-free); the authoritative ball arrives
  // later via render(). Life is MUZZLE_FLASH_LIFE_S so the eye sees origin
  // at cannon. Tint follows the thrower: owner color for normal shots (falls
  // back to pale violet for non-finite colors), chartreuse for SUPER.
  public flashMuzzle(x: number, y: number, z: number, superShot: boolean, color: number = TRAIL_GOLD_COLOR): void {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return;
    }
    let used = 0;
    for (const puff of this.puffs) {
      if (puff.life > 0) {
        continue;
      }
      puff.life = MUZZLE_FLASH_LIFE_S;
      puff.maxLife = MUZZLE_FLASH_LIFE_S;
      puff.grow = used === 0 ? MUZZLE_FLASH_GROW : MUZZLE_FLASH_GROW * 2.2;
      puff.sprite.visible = true;
      puff.sprite.position.set(x, y, z);
      const startScale = used === 0 ? 0.5 : 0.9;
      puff.sprite.scale.set(startScale, startScale, 1);
      const flashMaterial = puff.sprite.material as THREE.SpriteMaterial;
      const flashTint = superShot ? SUPER_BALL_COLOR : Number.isFinite(color) ? color : TRAIL_GOLD_COLOR;
      flashMaterial.color.set(flashTint);
      flashMaterial.opacity = used === 0 ? 0.95 : 0.6;
      used += 1;
      if (used >= MUZZLE_FLASH_COUNT) {
        break;
      }
    }
  }

  // Normal trails stay neutral pale violet regardless of owner (visual round:
  // the subtle ring/dot accent is the only ownership read; owner-tinted
  // trails would reintroduce the garishness the redesign removes). SUPER
  // trails stay chartreuse. The ownerColor parameter is kept for call-site
  // back-compat and is intentionally ignored for normal balls.
  private showTrailsForSlot(slot: number, position: THREE.Vector3, isSuper: boolean, _ownerColor: number): void {
    const tint = isSuper ? TRAIL_SUPER_COLOR : TRAIL_GOLD_COLOR;
    for (let k = 0; k < TRAILS_PER_BALL; k += 1) {
      const sprite = this.trails[slot * TRAILS_PER_BALL + k];
      if (sprite === undefined) {
        continue;
      }
      sprite.visible = true;
      sprite.position.copy(position);
      const scale = TRAIL_SCALES[k] ?? 0.3;
      sprite.scale.set(scale, scale, 1);
      const material = sprite.material as THREE.SpriteMaterial;
      material.color.set(tint);
      material.opacity = TRAIL_OPACITIES[k] ?? 0.4;
    }
  }

  private hideTrailsForSlot(slot: number): void {
    for (let k = 0; k < TRAILS_PER_BALL; k += 1) {
      const sprite = this.trails[slot * TRAILS_PER_BALL + k];
      if (sprite !== undefined) {
        sprite.visible = false;
      }
    }
  }

  public dispose(): void {
    for (const group of this.groups) {
      this.scene.remove(group);
    }
    this.groups.length = 0;
    this.superFlags.length = 0;
    this.slotColors.length = 0;
    this.slotRolling.length = 0;
    this.slotVelX.length = 0;
    this.slotVelZ.length = 0;
    this.slotIds.length = 0;
    this.slotTargets.length = 0;
    for (const puff of this.puffs) {
      this.scene.remove(puff.sprite);
      (puff.sprite.material as THREE.SpriteMaterial).dispose();
    }
    this.puffs.length = 0;
    for (const trail of this.trails) {
      this.scene.remove(trail);
      (trail.material as THREE.SpriteMaterial).dispose();
    }
    this.trails.length = 0;
    this.tracked.clear();
    this.hitIds.clear();
    this.bodyGeometry.dispose();
    this.superSkin.texture.dispose();
    this.superSkin.material.dispose();
    for (const skin of this.skins.values()) {
      skin.texture.dispose();
      skin.material.dispose();
    }
    this.skins.clear();
    this.glowTexture.dispose();
  }
}

// Floating SUPER core: icosahedron with emissive-look basic material (no new
// lights), slow spin + bob + inner scale pulse, blinks via visible toggle
// in the last 3s of life.
export class SuperCore {
  private readonly scene: THREE.Scene;
  private readonly group = new THREE.Group();
  private readonly mesh: THREE.Mesh;
  private readonly inner: THREE.Mesh;
  private spinTime = 0;

  public constructor(scene: THREE.Scene) {
    this.scene = scene;
    const geometry = new THREE.IcosahedronGeometry(SUPER_CORE_OUTER_RADIUS, 0);
    const material = new THREE.MeshBasicMaterial({ color: SUPER_BALL_COLOR, wireframe: true });
    this.mesh = new THREE.Mesh(geometry, material);
    this.group.add(this.mesh);
    const core = new THREE.Mesh(
      new THREE.OctahedronGeometry(SUPER_CORE_INNER_RADIUS, 0),
      new THREE.MeshBasicMaterial({ color: NEUTRAL_WHITE }),
    );
    core.name = "super-core-inner";
    this.inner = core;
    this.group.add(core);
    this.group.visible = false;
    this.group.position.set(0, 1.2, 0);
    this.scene.add(this.group);
  }

  public render(superSnapshot: NetSuperSnapshot | null, nowMs: number): void {
    if (superSnapshot === null || !superSnapshot.active) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    this.group.position.set(superSnapshot.x, 1.2, superSnapshot.z);
    const remainingMs = superSnapshot.expiresAt - nowMs;
    if (remainingMs < SUPER_BLINK_S * 1000) {
      // Blink: visible toggle at ~5Hz for the last 3s.
      this.group.visible = Math.floor(nowMs / 200) % 2 === 0;
    }
  }

  public update(deltaSeconds: number): void {
    if (!this.group.visible || !(deltaSeconds > 0)) {
      return;
    }
    this.spinTime += deltaSeconds;
    this.group.rotation.y += deltaSeconds * 1.5;
    this.mesh.rotation.x += deltaSeconds * 0.8;
    this.group.position.y = 1.2 + Math.sin(this.spinTime * 2) * 0.15;
    this.inner.scale.setScalar(1 + 0.18 * Math.sin(this.spinTime * 4));
  }

  public dispose(): void {
    this.scene.remove(this.group);
    for (const child of [...this.group.children]) {
      const mesh = child as THREE.Mesh;
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      this.group.remove(child);
    }
  }
}
