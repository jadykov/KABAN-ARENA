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
  RECOIL_FULL_M,
  RECOIL_WEAK_M,
  SERVER_PLATFORMS,
  SPAWN_INSET,
  SUPER_DAMAGE_MULT,
  WEAK_DAMAGE,
  WIN_SCORE,
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
// writes player.y), so the authoritative body-center y is DERIVED here —
// never trusted blindly from the wire:
// - groundTopAt: highest platform top under (x,z), 0 on open ground
//   (SERVER_PLATFORMS mirror of the client Arena PLATFORM_FIGURES).
// - bodyCenterYAt: groundTop + BODY_CENTER_Y (capsule center on that level).
// - sanitizeThrowerY: client-sent body-center y clamped to absolute 0..8
//   (NaN/garbage -> null = derive).
// - resolveThrowerY: sanitized client y wins when inside [derived-1,
//   derived+6] (covers trampoline jumps, apex ~+5m), otherwise the derived
//   value. Bots (no client y) always derive. Pure + unit-tested.
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
  }
  return top;
}

export function bodyCenterYAt(x: number, z: number): number {
  return groundTopAt(x, z) + BODY_CENTER_Y;
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
