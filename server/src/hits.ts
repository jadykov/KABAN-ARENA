import {
  ARENA_HALF_SIZE,
  BALL_MAX_SPEED,
  BALL_MIN_SPEED,
  BALL_MUZZLE_OFFSET,
  BALL_TORSO_OFFSET,
  BODY_CENTER_Y,
  CHARGE_MAX_S,
  DEFAULT_NICK_PREFIX,
  FULL_DAMAGE,
  FULL_POWER_THRESHOLD,
  HIT_COOLDOWN_MS,
  HIT_DAMAGE,
  HIT_MAX_RANGE,
  HIT_SCORE,
  INVULN_MS,
  KILL_SCORE,
  MAX_HP,
  MAX_PLAYERS,
  NICK_MAX_LENGTH,
  NICK_MIN_LENGTH,
  RAMP_SLOPE_DEG,
  RECOIL_FULL_M,
  RECOIL_WEAK_M,
  SERVER_OBSTACLES,
  SERVER_PLATFORMS,
  SPAWN_INSET,
  SUPER_DAMAGE_MULT,
  TRAMPOLINE_AIR_DAMPING,
  TRAMPOLINE_GRAVITY,
  TRAMPOLINE_IMPULSE,
  TRAMPOLINE_RADIUS,
  TRAMPOLINE_SPOTS,
  WEAK_DAMAGE,
  WIN_SCORE,
  type ServerPlatformDef,
} from "./config.js";
import type { PlayerState } from "./state.js";

// Six FFA spawn points: the first four mirror the client corner spawns
// (ARENA_HALF_SIZE - SPAWN_INSET), plus two mid-lane
// extras so 5-6 player rooms never stack two avatars on one marker.
export function getSpawnForIndex(index: number): { x: number; z: number } {
  const inset = ARENA_HALF_SIZE - SPAWN_INSET;
  const corners = [
    { x: -inset, z: -inset },
    { x: inset, z: -inset },
    { x: -inset, z: inset },
    { x: inset, z: inset },
  ];
  const extra = [
    { x: 0, z: -inset },
    { x: 0, z: inset },
  ];
  const all = [...corners, ...extra];
  const slot = ((index % all.length) + all.length) % all.length;
  const picked = all[slot];
  if (picked === undefined) {
    return { x: 0, z: 0 };
  }
  return { x: picked.x, z: picked.z };
}

// Guest nick validation (no auth): 2-16 chars, trimmed; dedupe by suffix.
export function sanitizeNick(raw: unknown, taken: ReadonlySet<string>): string {
  const text = typeof raw === "string" ? raw.trim().slice(0, NICK_MAX_LENGTH) : "";
  const base = text.length >= NICK_MIN_LENGTH ? text : DEFAULT_NICK_PREFIX;
  if (!taken.has(base)) {
    return base;
  }
  for (let i = 2; i < MAX_PLAYERS * 10; i += 1) {
    const candidate = `${base.slice(0, NICK_MAX_LENGTH - String(i).length - 1)}-${i}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
  return `${base.slice(0, 8)}-${Math.floor(Math.random() * 900 + 100)}`;
}

// R2 halves: 4 hearts = 8 halves, half heart = 12.5 HP.
// Returns 0-8 (UI renders full/half/empty). 4 max hits to kill, 8 weak hits.
export function heartsForHp(hp: number): number {
  if (!Number.isFinite(hp)) {
    return 0;
  }
  return Math.max(0, Math.min(8, Math.ceil(hp / WEAK_DAMAGE)));
}

export function heartsFullForHp(hp: number): number {
  return Math.max(0, Math.min(4, Math.ceil(hp / HIT_DAMAGE)));
}

// Charge (seconds held, 0-1.0) -> power01 in [0.5, 1].
// Early release bottoms at ~0.5 (half-power shorter-range shot).
export function chargeToPower01(chargeS: number): number {
  if (!Number.isFinite(chargeS) || chargeS <= 0) {
    return 0.5;
  }
  const clamped = Math.max(0, Math.min(1, chargeS / CHARGE_MAX_S));
  return 0.5 + 0.5 * clamped;
}

// Power01 -> ballistic speed lerp (weak = shorter range, max still arcs).
export function powerToSpeed(power01: number): number {
  const clamped = Number.isFinite(power01) ? Math.max(0.5, Math.min(1, power01)) : 0.5;
  return BALL_MIN_SPEED + (BALL_MAX_SPEED - BALL_MIN_SPEED) * ((clamped - 0.5) / 0.5);
}

// Power01 -> damage: threshold 0.8 rewards committed charges.
// SUPER x2 applies on top (50 / 25).
export function damageForPower(power01: number, superBuff: boolean): number {
  const base = power01 >= FULL_POWER_THRESHOLD ? FULL_DAMAGE : WEAK_DAMAGE;
  return superBuff ? base * SUPER_DAMAGE_MULT : base;
}

// Recoil distance for a shot (weak 0.4m -> full 0.8m by charge power).
// Pure helper so tests pin the mapping; the room clamps the result.
export function recoilDistanceForPower(power01: number): number {
  const clamped = Number.isFinite(power01) ? Math.max(0.5, Math.min(1, power01)) : 0.5;
  return RECOIL_WEAK_M + (RECOIL_FULL_M - RECOIL_WEAK_M) * ((clamped - 0.5) / 0.5);
}

// Authoritative muzzle math (single source for spawn + tests):
// muzzle = bodyCenter(XZ) + dir(yaw,pitch) * BALL_MUZZLE_OFFSET,
// y = thrower body-center y + BALL_TORSO_OFFSET (torso/hand height). On the
// ground bodyY is 1.1 so spawn y == 1.4 exactly as before; on platforms (or
// mid-jump, via the client-sent throwerY) it tracks the thrower's elevation.
// dir convention (-sin(yaw)*cos(pitch), sin(pitch), -cos(yaw)*cos(pitch))
// must stay identical to client directionFromYawPitch/muzzleForShot.
export function muzzleForShot(
  shooterX: number,
  shooterY: number,
  shooterZ: number,
  yaw: number,
  pitch: number,
): { x: number; y: number; z: number; dirX: number; dirY: number; dirZ: number } {
  const safeYaw = Number.isFinite(yaw) ? yaw : 0;
  const safePitch = Number.isFinite(pitch) ? pitch : 0.25;
  const bodyY = Number.isFinite(shooterY) ? shooterY : BODY_CENTER_Y;
  const cosPitch = Math.cos(safePitch);
  const dirX = -Math.sin(safeYaw) * cosPitch;
  const dirZ = -Math.cos(safeYaw) * cosPitch;
  const dirY = Math.sin(safePitch);
  return {
    x: shooterX + dirX * BALL_MUZZLE_OFFSET,
    y: bodyY + BALL_TORSO_OFFSET,
    z: shooterZ + dirZ * BALL_MUZZLE_OFFSET,
    dirX,
    dirY,
    dirZ,
  };
}

// 4d.1 thrower elevation: server movement is XZ-kinematic (moveHumans never
// trusted blindly from the wire, but since the elevation patch the room
// maintains player.y every tick (grounded derivation + trampoline arcs), so
// this derivation is the grounded anchor the room writes into player.y:
// - groundTopAt: highest walkable top under (x,z) — platform tops, OBSTACLE
//   tops (tower tops are standable), and RAMP SLOPE heights along each
//   platform's walk-up band (0 at the ramp foot, topY at the platform edge).
//   0 on open ground.
// - bodyCenterYAt: groundTop + BODY_CENTER_Y (capsule center on that level).
// - sanitizeThrowerY: client-sent body-center y clamped to absolute 0..8
//   (NaN/garbage -> null = derive).
// - resolveThrowerY: sanitized client y wins when inside [derived-1,
//   derived+6] (covers trampoline jumps, apex ~+3m), otherwise the derived
//   value. Bots (no client y) always derive. Pure + unit-tested.
// - rampRunForTop / rampHeightAt: ramp-band geometry mirror of the client
//   Arena.getRamps (run = topY / tan(RAMP_SLOPE_DEG), height lerps foot->edge).
//   The band stays STRICT (halfW): grounded support must never read slope
//   height beside the slab (bug A leak 1 — a ground-level lift would admit a
//   walk-through the next tick). The capsule-overlap sliver (halfW + radius)
//   is evaluated only through rampBandHeightAt (wedge-side seal + capture
//   surface checks) and through the feet-gated ramp candidate in the room's
//   groundSupport (bug round 6, BUG 1) — never as strict support.
// - trampolineArcY: closed-form damped vertical arc for server trampoline
//   jumps (same model the client Arena.test pins: y0 = BODY_CENTER_Y,
//   v0 = TRAMPOLINE_IMPULSE, exp damping TRAMPOLINE_AIR_DAMPING, gravity
//   TRAMPOLINE_GRAVITY). Pure + unit-tested.
// - isOnTrampolinePad: XZ inside a TRAMPOLINE_SPOTS pad (launch trigger).
export function rampRunForTop(topY: number): number {
  if (!Number.isFinite(topY) || topY <= 0) {
    return 0;
  }
  const tan = Math.tan((RAMP_SLOPE_DEG * Math.PI) / 180);
  if (!(tan > 0)) {
    return 0;
  }
  return topY / tan;
}

export function rampHeightAt(
  platform: ServerPlatformDef,
  x: number,
  z: number,
  extraBand: number = 0,
): number {
  if (!Number.isFinite(x) || !Number.isFinite(z)) {
    return 0;
  }
  const run = rampRunForTop(platform.topY);
  if (!(run > 0)) {
    return 0;
  }
  const halfW = platform.rampWidth / 2;
  const band = halfW + (extraBand > 0 ? extraBand : 0);
  let lateral = 0;
  let outward = -1;
  switch (platform.rampSide) {
    case "+z":
      lateral = x - platform.x;
      outward = z - (platform.z + platform.hz);
      break;
    case "-z":
      lateral = x - platform.x;
      outward = platform.z - platform.hz - z;
      break;
    case "+x":
      lateral = z - platform.z;
      outward = x - (platform.x + platform.hx);
      break;
    case "-x":
      lateral = z - platform.z;
      outward = platform.x - platform.hx - x;
      break;
    default:
      return 0;
  }
  if (Math.abs(lateral) > band || outward < 0 || outward > run) {
    return 0;
  }
  return platform.topY * (1 - outward / run);
}

// Ramp-band-only height (bug A leak 2): max rampHeightAt over platforms,
// WITHOUT footprint tops — the wedge-side entry check needs the surface a
// step would land on, not the platform top behind it. Evaluated over the
// STRICT band: the wedge seals stepping into the slab below its surface, and
// a center past the slab edge keeps sliding along the slab side to the face
// corner (the client Rapier slides the same way) instead of stopping in thin
// air — the face resolver owns the sliver (grounded clamps, admitted climbers
// pass through the overlap lane).
export function rampBandHeightAt(x: number, z: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(z)) {
    return 0;
  }
  let top = 0;
  for (const platform of SERVER_PLATFORMS) {
    const rampH = rampHeightAt(platform, x, z);
    if (rampH > top) {
      top = rampH;
    }
  }
  return top;
}

// Capsule-overlap band height (bug round 6, BUG 1): same as rampBandHeightAt
// but spanning extraBand past each slab edge. Used ONLY through feet-gated
// support (the room's groundSupport ramp candidate): a center past the edge
// by up to one body radius still rests on the slab. Never used for strict
// support or the wedge seal — grounded fighters must not read slope height
// beside a slab (bug A leak 1).
export function rampBandHeightAtExpanded(x: number, z: number, extraBand: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(z) || !(extraBand > 0)) {
    return rampBandHeightAt(x, z);
  }
  let top = 0;
  for (const platform of SERVER_PLATFORMS) {
    const rampH = rampHeightAt(platform, x, z, extraBand);
    if (rampH > top) {
      top = rampH;
    }
  }
  return top;
}

export function groundTopAt(x: number, z: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(z)) {
    return 0;
  }
  let top = 0;
  for (const platform of SERVER_PLATFORMS) {
    if (Math.abs(x - platform.x) <= platform.hx && Math.abs(z - platform.z) <= platform.hz) {
      if (platform.topY > top) {
        top = platform.topY;
      }
    }
    const rampH = rampHeightAt(platform, x, z);
    if (rampH > top) {
      top = rampH;
    }
  }
  for (const block of SERVER_OBSTACLES) {
    if (Math.abs(x - block.x) <= block.hx && Math.abs(z - block.z) <= block.hz) {
      if (block.topY > top) {
        top = block.topY;
      }
    }
  }
  return top;
}

export function bodyCenterYAt(x: number, z: number): number {
  return groundTopAt(x, z) + BODY_CENTER_Y;
}

// Radius-expanded support (bug B): same tops as groundTopAt but measured
// against the radius-expanded footprints — the SAME test collision uses.
// Lets landings clip a top edge (physical: capsule overlapping the edge at
// support height rests on it) and implements support hysteresis: a fighter
// walking off a top keeps it through the 0.5m ring, falling only once fully
// outside. Ramp bands stay STRICT (unexpanded): the wedge-entry block owns
// the band sides, and widening support there would re-open leak 2.
// Callers gate the widened value by feet (see ArenaRoom groundSupport), so
// ground fighters beside a solid never snap up.
export function groundTopAtExpanded(x: number, z: number, radius: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(z) || !(radius >= 0)) {
    return groundTopAt(x, z);
  }
  let top = 0;
  for (const platform of SERVER_PLATFORMS) {
    if (Math.abs(x - platform.x) <= platform.hx + radius && Math.abs(z - platform.z) <= platform.hz + radius) {
      if (platform.topY > top) {
        top = platform.topY;
      }
    }
    const rampH = rampHeightAt(platform, x, z);
    if (rampH > top) {
      top = rampH;
    }
  }
  for (const block of SERVER_OBSTACLES) {
    if (Math.abs(x - block.x) <= block.hx + radius && Math.abs(z - block.z) <= block.hz + radius) {
      if (block.topY > top) {
        top = block.topY;
      }
    }
  }
  return top;
}

export function bodyCenterYAtExpanded(x: number, z: number, radius: number): number {
  return groundTopAtExpanded(x, z, radius) + BODY_CENTER_Y;
}

export function sanitizeThrowerY(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return null;
  }
  return Math.max(0, Math.min(8, raw));
}

export function resolveThrowerY(throwerY: number | null, x: number, z: number): number {
  const derived = bodyCenterYAt(x, z);
  if (throwerY === null) {
    return derived;
  }
  return Math.max(derived - 1, Math.min(derived + 6, throwerY));
}

// Server trampoline-jump arc (bugs 1/3a: tower tops must be reachable
// server-side, not just client-side): closed-form damped vertical motion,
// the same model the client Arena.test pins for the impulse proof —
// y(t) = y0 + (A/d)(1-e^-dt) - (g/d)t with A = v0 + g/d, y0 = BODY_CENTER_Y
// (pads sit on open ground), v0 = TRAMPOLINE_IMPULSE, d =
// TRAMPOLINE_AIR_DAMPING, g = TRAMPOLINE_GRAVITY. Non-finite/negative input
// reads as t = 0 (launch height), never NaN.
export function trampolineArcY(airTimeS: number): number {
  const t = Number.isFinite(airTimeS) && airTimeS > 0 ? airTimeS : 0;
  const d = TRAMPOLINE_AIR_DAMPING;
  const g = TRAMPOLINE_GRAVITY;
  const a = TRAMPOLINE_IMPULSE + g / d;
  return BODY_CENTER_Y + (a / d) * (1 - Math.exp(-d * t)) - ((g / d) * t);
}

// Launch trigger: XZ inside a trampoline pad (client getTrampolines mirror).
export function isOnTrampolinePad(x: number, z: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(z)) {
    return false;
  }
  for (const pad of TRAMPOLINE_SPOTS) {
    const dx = x - pad.x;
    const dz = z - pad.z;
    if (dx * dx + dz * dz <= TRAMPOLINE_RADIUS * TRAMPOLINE_RADIUS) {
      return true;
    }
  }
  return false;
}

// Throw-polish: shot randomness is removed (SPRAY_DEG/BOT_SPRAY_DEG are 0 —
// the parabola alone is enough chaos). sprayForSeed stays as a dead compat
// helper so old call sites/tests keep compiling; no live path may call it.
export function sprayForSeed(seed: number, maxDeg: number): number {
  const pseudo = pseudo01(seed);
  return (pseudo * 2 - 1) * maxDeg;
}

function pseudo01(seed: number): number {
  let value = (Math.floor(seed) * 1664525 + 1013904223) >>> 0;
  value ^= value >>> 15;
  value = (value * 1103515245) >>> 0;
  value ^= value >>> 12;
  return (value >>> 0) / 4294967296;
}

export function canDamage(target: PlayerState, nowMs: number): boolean {
  return target.alive && nowMs >= target.invulnUntil;
}

export interface HitCheck {
  ok: boolean;
  reason: string;
}

// Server-side hitscan validation: alive shooter/target, cooldown, range,
// target vulnerability (respawn invuln). Pure w.r.t. the two players.
export function validateHit(
  shooter: PlayerState | undefined,
  target: PlayerState | undefined,
  nowMs: number,
  lastShotAt: number | undefined,
): HitCheck {
  if (shooter === undefined) {
    return { ok: false, reason: "unknown-shooter" };
  }
  if (target === undefined) {
    return { ok: false, reason: "unknown-target" };
  }
  if (shooter.sessionId === target.sessionId) {
    return { ok: false, reason: "no-self-hit" };
  }
  // R1 pre-join spectator: non-ready fighters never deal or take damage.
  if (shooter.spectator || !shooter.ready) {
    return { ok: false, reason: "not-ready" };
  }
  if (target.spectator || !target.ready) {
    return { ok: false, reason: "not-ready" };
  }
  if (!shooter.alive || !target.alive) {
    return { ok: false, reason: "dead" };
  }
  if (lastShotAt !== undefined && nowMs - lastShotAt < HIT_COOLDOWN_MS) {
    return { ok: false, reason: "cooldown" };
  }
  const dx = shooter.x - target.x;
  const dz = shooter.z - target.z;
  if (dx * dx + dz * dz > HIT_MAX_RANGE * HIT_MAX_RANGE) {
    return { ok: false, reason: "out-of-range" };
  }
  if (!canDamage(target, nowMs)) {
    return { ok: false, reason: "invulnerable" };
  }
  return { ok: true, reason: "ok" };
}

export interface HitResult {
  killed: boolean;
  damage: number;
  targetHp: number;
}

// Applies variable cannon damage (FULL 25 / WEAK 12.5, SUPER x2).
// Hit scores +1, kill +10. Mutates shooter/target schema instances;
// respawn/invuln are scheduled by the room.
export function applyHit(
  shooter: PlayerState,
  target: PlayerState,
  nowMs: number,
  damage: number = HIT_DAMAGE,
): HitResult {
  const dealt = Number.isFinite(damage) && damage > 0 ? damage : HIT_DAMAGE;
  target.hp = Math.max(0, target.hp - dealt);
  shooter.score += HIT_SCORE;
  if (target.hp <= 0) {
    target.alive = false;
    target.hp = 0;
    shooter.score += KILL_SCORE;
    return { killed: true, damage: dealt, targetHp: 0 };
  }
  void nowMs;
  return { killed: false, damage: dealt, targetHp: target.hp };
}

// Respawn after RESPAWN_DELAY_MS with full HP + INVULN_MS protection.
export function respawnPlayer(player: PlayerState, spawnIndex: number, nowMs: number): void {
  const spawn = getSpawnForIndex(spawnIndex);
  player.x = spawn.x;
  player.z = spawn.z;
  player.y = BODY_CENTER_Y;
  player.rotY = 0;
  player.hp = MAX_HP;
  player.alive = true;
  player.invulnUntil = nowMs + INVULN_MS;
}

export function isScoreWin(score: number): boolean {
  return score >= WIN_SCORE;
}
