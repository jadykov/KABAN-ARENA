import * as THREE from "three";
import { MAX_LIVE_BALLS, SUPER_BLINK_S } from "../config";
import type { NetBallSnapshot, NetSuperSnapshot } from "../net/protocol";
import { ACCENT_BALL_CAP, ACCENT_SPARK, ACCENT_TRAIL, BASE_BASALT, HL_CHARTREUSE, NEUTRAL_WHITE } from "../palette";

export const BALL_RADIUS = 0.38;
export const BALL_BASALT_COLOR = BASE_BASALT;
export const BALL_CAP_COLOR = ACCENT_BALL_CAP;
export const SUPER_BALL_COLOR = HL_CHARTREUSE;
export const SUPER_INNER_COLOR = NEUTRAL_WHITE;
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

// Pooled cannonballs (MAX_LIVE_BALLS two-tone cores): dark violet basalt
// body + owner-color cap for normal shots (per-color cached materials, no
// per-frame alloc), chartreuse body + white inner for SUPER shots (group
// scaled x2 via SUPER_BALL_SCALE so the buff reads on a phone screen).
// Shared geometries across the pool, MeshBasicMaterial only (no new lights,
// no transparency).
// Fire trail: 2 pooled glow sprites per live ball slot tinted by the owner's
// ball.color (chartreuse for SUPER). Impact feedback is the pooled puff burst
// (8 sprites): environmental vanishes pop a small NEUTRAL mini-puff (never
// red); player hits skip it via markPlayerHit (the red blood burst covers
// those through the server event). Vanished ids pop a puff.
// Mapping is STABLE by ballId (slotIds parallel to groups): insert/delete/
// order shifts never teleport a ball to another slot. Positions ease toward
// the latest snapshot target (exponential lerp in update); new ids snap once
// on assignment so the first frame sits at the muzzle.
export class BallsPool {
  private readonly scene: THREE.Scene;
  private readonly bodyGeometry = new THREE.SphereGeometry(BALL_RADIUS, 10, 8);
  private readonly capGeometry = new THREE.SphereGeometry(BALL_RADIUS * 0.45, 8, 6);
  private readonly bodyMaterial = new THREE.MeshBasicMaterial({ color: BALL_BASALT_COLOR });
  private readonly capMaterial = new THREE.MeshBasicMaterial({ color: BALL_CAP_COLOR });
  private readonly superBodyMaterial = new THREE.MeshBasicMaterial({ color: SUPER_BALL_COLOR });
  private readonly superInnerMaterial = new THREE.MeshBasicMaterial({ color: SUPER_INNER_COLOR });
  // Per-owner-color cap cache: one shared MeshBasicMaterial per distinct
  // ball.color (fighter color) so normal cores read as their thrower's
  // without allocating a material per ball per frame. Disposed in dispose().
  private readonly capMaterials = new Map<number, THREE.MeshBasicMaterial>();
  private readonly glowTexture = makeGlowTexture();
  private readonly groups: THREE.Group[] = [];
  private readonly superFlags: boolean[] = [];
  private readonly slotColors: number[] = [];
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
  private pulseTime = 0;

  public constructor(scene: THREE.Scene) {
    this.scene = scene;
    for (let i = 0; i < MAX_LIVE_BALLS; i += 1) {
      const group = new THREE.Group();
      group.visible = false;
      const body = new THREE.Mesh(this.bodyGeometry, this.bodyMaterial);
      const cap = new THREE.Mesh(this.capGeometry, this.capMaterial);
      cap.position.set(0, BALL_RADIUS * 0.55, 0);
      group.add(body);
      group.add(cap);
      this.scene.add(group);
      this.groups.push(group);
      this.superFlags.push(false);
      this.slotColors.push(BALL_CAP_COLOR);
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

  // Per-owner-color cap material (cached by color, created once per
  // distinct fighter color). Falls back to BALL_CAP_COLOR for non-finite
  // colors (compat path for snapshots predating the color field).
  private capMaterialFor(color: number): THREE.MeshBasicMaterial {
    const key = Number.isFinite(color) ? color : BALL_CAP_COLOR;
    const cached = this.capMaterials.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const created = new THREE.MeshBasicMaterial({ color: key });
    this.capMaterials.set(key, created);
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
        group.position.set(ball.x, ball.y, ball.z);
        target.set(ball.x, ball.y, ball.z);
      } else {
        target.set(ball.x, ball.y, ball.z);
      }
      group.visible = true;
      this.superFlags[slot] = isSuper;
      this.slotColors[slot] = ball.color;
      // SUPER cores read the x2 buff at a glance: the whole group scales by
      // SUPER_BALL_SCALE; normal cores stay at scale 1 (reset on reuse so a
      // recycled SUPER slot never keeps a giant normal core).
      group.scale.setScalar(isSuper ? SUPER_BALL_SCALE : 1);
      const body = group.children[0] as THREE.Mesh | undefined;
      const cap = group.children[1] as THREE.Mesh | undefined;
      if (body !== undefined) {
        body.material = isSuper ? this.superBodyMaterial : this.bodyMaterial;
      }
      if (cap !== undefined) {
        cap.material = isSuper ? this.superInnerMaterial : this.capMaterialFor(ball.color);
        if (!isSuper) {
          cap.scale.setScalar(1);
        }
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
    this.pulseTime += deltaSeconds;
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
        this.showTrailsForSlot(i, group.position, this.superFlags[i] === true, this.slotColors[i] ?? BALL_CAP_COLOR);
      }
      if (this.superFlags[i] !== true) {
        continue;
      }
      if (group === undefined || !group.visible) {
        continue;
      }
      const cap = group.children[1] as THREE.Mesh | undefined;
      if (cap !== undefined) {
        cap.scale.setScalar(1 + 0.3 * Math.sin(this.pulseTime * 8));
      }
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

  private showTrailsForSlot(slot: number, position: THREE.Vector3, isSuper: boolean, ownerColor: number): void {
    const tint = isSuper ? TRAIL_SUPER_COLOR : Number.isFinite(ownerColor) ? ownerColor : TRAIL_GOLD_COLOR;
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
    this.capGeometry.dispose();
    this.bodyMaterial.dispose();
    this.capMaterial.dispose();
    for (const cached of this.capMaterials.values()) {
      cached.dispose();
    }
    this.capMaterials.clear();
    this.superBodyMaterial.dispose();
    this.superInnerMaterial.dispose();
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
