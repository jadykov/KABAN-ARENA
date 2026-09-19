// Stage 4 wire protocol helpers: pure, dependency-free, unit-tested.
// Shapes mirror server src/state.ts (minimal @type state: positions,
// rotations, health, active states); the server config is authoritative,
// client config.ts mirrors display-only copies.

import {
  AIM_EXPO,
  BALL_MAX_SPEED,
  BALL_MIN_SPEED,
  BALL_MUZZLE_OFFSET,
  BALL_TORSO_OFFSET,
  CAMERA_PITCH_MAX,
  CHARGE_MAX_S,
  DEFAULT_NICK,
  FULL_DAMAGE,
  FULL_POWER_THRESHOLD,
  GUEST_NICK_PREFIX,
  HIT_DAMAGE,
  HIT_MAX_RANGE,
  LOCAL_AVATAR_COLOR,
  MAX_HALVES,
  MAX_HEARTS,
  NICK_MAX_LENGTH,
  NICK_MIN_LENGTH,
  RECOIL_FULL_M,
  RECOIL_WEAK_M,
  REMOTE_PALETTE,
  SELF_SPAWN_Y,
  SUPER_DAMAGE_MULT,
  WEAK_DAMAGE,
} from "../config";

export type RoundPhase = "lobby" | "countdown" | "playing" | "ended";

// Decoded snapshot of one replicated player (server PlayerState fields).
// R1: ready/spectator mark pre-join spectators (alive=false, not rendered,
// never counted as players).
export interface NetPlayerSnapshot {
  sessionId: string;
  nick: string;
  x: number;
  y: number;
  z: number;
  rotY: number;
  hp: number;
  score: number;
  alive: boolean;
  isBot: boolean;
  ready: boolean;
  spectator: boolean;
  superBuff: boolean;
  reloadUntil: number;
}

export interface InputPayload {
  x: number;
  y: number;
  rotY: number;
  seq: number;
  charging?: boolean;
}

// Guest nick validation (no auth): trim, cap length, fallback when blank.
export function normalizeNick(raw: unknown): string {
  const text = typeof raw === "string" ? raw.trim().slice(0, NICK_MAX_LENGTH) : "";
  return text.length >= NICK_MIN_LENGTH ? text : DEFAULT_NICK;
}

// R1 Play nick: trimmed (max 16 chars); empty input falls back to a local
// Guest-XXXX suggestion — the server re-validates and dedupes anyway.
export function buildGuestNick(): string {
  return `${GUEST_NICK_PREFIX}-${Math.floor(1000 + Math.random() * 9000)}`;
}

export function normalizePlayNick(raw: unknown): string {
  const text = typeof raw === "string" ? raw.trim().slice(0, NICK_MAX_LENGTH) : "";
  return text.length === 0 ? buildGuestNick() : text;
}

// Live counters for the HUD status line (Players N | Watching M).
// Runners see counters only — never a spectator nick list.
export function countFighters(players: readonly NetPlayerSnapshot[]): number {
  return players.filter((player) => player.ready && !player.spectator).length;
}

export function countSpectators(players: readonly NetPlayerSnapshot[]): number {
  return players.filter((player) => !player.ready || player.spectator).length;
}

export function formatCounters(players: readonly NetPlayerSnapshot[]): string {
  return `Players: ${countFighters(players)} | Watching: ${countSpectators(players)}`;
}

function clampAxis(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(-1, Math.min(1, value));
}

// Clamp + normalize a planar move vector so inputs-only upstream stays in
// the 20-30 ticks/s band the server expects (length at most 1).
export function clampMoveInput(x: number, y: number): { x: number; y: number } {
  const clampedX = clampAxis(x) + 0;
  const clampedY = clampAxis(y) + 0;
  const length = Math.hypot(clampedX, clampedY);
  if (length > 1) {
    return { x: clampedX / length, y: clampedY / length };
  }
  return { x: clampedX === 0 ? 0 : clampedX, y: clampedY === 0 ? 0 : clampedY };
}

// World-space move transform (single shared formula, also used by
// SceneManager.update for local physics): camera-relative stick input
// (x = strafe right, y = forward) rotated by the camera yaw into world XZ.
// forward = (-sin(yaw), -cos(yaw)), right = (-forward.z, forward.x), so
// worldX = -sin*moveY + cos*moveX, worldZ = -cos*moveY - sin*moveX.
// The client sends the result as the input payload (x = world X, y = world
// Z); the server applies it as world-space directly (no re-transform).
// Returns payload-shaped {x, y} with x = world X, y = world Z.
export function worldMoveFromYaw(moveX: number, moveY: number, cameraYaw: number): { x: number; y: number } {
  const yaw = Number.isFinite(cameraYaw) ? cameraYaw : 0;
  const mx = Number.isFinite(moveX) ? moveX : 0;
  const my = Number.isFinite(moveY) ? moveY : 0;
  const sinYaw = Math.sin(yaw);
  const cosYaw = Math.cos(yaw);
  const worldX = -sinYaw * my + cosYaw * mx;
  const worldZ = -cosYaw * my - sinYaw * mx;
  return clampMoveInput(worldX, worldZ);
}

export function buildInputPayload(x: number, y: number, rotY: number, seq: number, charging = false): InputPayload {
  const clamped = clampMoveInput(x, y);
  const angle = Number.isFinite(rotY) ? rotY : 0;
  const sequence = Number.isFinite(seq) ? Math.floor(seq) : 0;
  return { x: clamped.x, y: clamped.y, rotY: angle, seq: sequence, charging };
}

// Hearts mapping for hitscan A: 100HP / 25 dmg = 4 hits = 4 hearts (QD3).
export function heartsForHp(hp: number): number {
  if (!Number.isFinite(hp)) {
    return 0;
  }
  return Math.max(0, Math.min(MAX_HEARTS, Math.ceil(hp / HIT_DAMAGE)));
}

// R2 halves: 4 hearts = 8 halves, half heart = 12.5 HP (WEAK hit).
// Returns 0-8; UI renders full (2) / half (1) / empty (0) per heart.
export function halvesForHp(hp: number): number {
  if (!Number.isFinite(hp)) {
    return 0;
  }
  return Math.max(0, Math.min(MAX_HALVES, Math.ceil(hp / WEAK_DAMAGE)));
}

// Per-heart fill in halves (0/1/2) for the 4-heart HUD row.
export function halvesPerHeart(halves: number): [number, number, number, number] {
  const clamped = Math.max(0, Math.min(MAX_HALVES, Math.floor(halves)));
  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (let i = 0; i < 4; i += 1) {
    out[i] = Math.max(0, Math.min(2, clamped - i * 2));
  }
  return out;
}

// Charge seconds held (0-1.0) -> power01 in [0.5, 1] (mirrors server).
export function chargeToPower01(chargeS: number): number {
  if (!Number.isFinite(chargeS) || chargeS <= 0) {
    return 0.5;
  }
  const clamped = Math.max(0, Math.min(1, chargeS / CHARGE_MAX_S));
  return 0.5 + 0.5 * clamped;
}

// Power01 -> ballistic speed lerp (mirrors server).
export function powerToSpeed(power01: number): number {
  const clamped = Number.isFinite(power01) ? Math.max(0.5, Math.min(1, power01)) : 0.5;
  return BALL_MIN_SPEED + (BALL_MAX_SPEED - BALL_MIN_SPEED) * ((clamped - 0.5) / 0.5);
}

// Power01 -> damage: threshold 0.8 rewards committed charges, SUPER x2.
export function damageForPower(power01: number, superBuff: boolean): number {
  const base = power01 >= FULL_POWER_THRESHOLD ? FULL_DAMAGE : WEAK_DAMAGE;
  return superBuff ? base * SUPER_DAMAGE_MULT : base;
}

// Recoil mirror of server hits.recoilDistanceForPower (weak 0.4m -> full
// 0.8m by charge power). The client applies it instantly as local feedback
// (SceneManager.applyRecoilKick); the server re-applies authoritatively.
export function recoilDistanceForPower(power01: number): number {
  const clamped = Number.isFinite(power01) ? Math.max(0.5, Math.min(1, power01)) : 0.5;
  return RECOIL_WEAK_M + (RECOIL_FULL_M - RECOIL_WEAK_M) * ((clamped - 0.5) / 0.5);
}

// R2 fire payload: release-to-fire with charge power + aim + SUPER flag +
// the thrower's body-center y (avatar position.y) so the server spawns the
// ball at torso height on ANY elevation. Optional for wire compat: omitted
// when not finite, the server then derives the elevation from the platform
// footprint instead.
export interface FirePayload {
  power01: number;
  yaw: number;
  pitch: number;
  super: boolean;
  throwerY?: number;
}

export function buildFirePayload(
  power01: number,
  yaw: number,
  pitch: number,
  superBuff: boolean,
  throwerY?: number | null,
): FirePayload {
  const power = Number.isFinite(power01) ? Math.max(0.5, Math.min(1, power01)) : 0.5;
  const payload: FirePayload = {
    power01: power,
    yaw: Number.isFinite(yaw) ? yaw : 0,
    pitch: Number.isFinite(pitch) ? Math.max(-0.15, Math.min(CAMERA_PITCH_MAX, pitch)) : 0.25,
    super: superBuff === true,
  };
  if (typeof throwerY === "number" && Number.isFinite(throwerY)) {
    payload.throwerY = throwerY;
  }
  return payload;
}

// Replicated cannonball (server BallState, tolerant decode with defaults).
// color carries the owner's fighter color (local orange / remote palette
// hash) so every core renders in its thrower's colors; SUPER shots keep the
// purple body but scale up instead.
export interface NetBallSnapshot {
  ballId: string;
  ownerId: string;
  x: number;
  y: number;
  z: number;
  power01: number;
  super: boolean;
  color: number;
}

// Fighter color for a session: the local player reads identity red, every
// remote reads its palette hash — the same mapping RemoteAvatars paints
// bodies with, shared here so balls, trails and glows match the thrower.
export function paletteForSession(sessionId: string): number {
  let hash = 0;
  for (let i = 0; i < sessionId.length; i += 1) {
    hash = (hash * 31 + sessionId.charCodeAt(i)) >>> 0;
  }
  const color = REMOTE_PALETTE[hash % REMOTE_PALETTE.length];
  return color ?? REMOTE_PALETTE[0] ?? LOCAL_AVATAR_COLOR;
}

export function ownerColorForSession(ownerId: string, selfId: string | null): number {
  if (selfId !== null && ownerId === selfId) {
    return LOCAL_AVATAR_COLOR;
  }
  return paletteForSession(ownerId);
}

// Super-core lifecycle (server ArenaState super* fields, compat defaults).
export interface NetSuperSnapshot {
  active: boolean;
  x: number;
  z: number;
  expiresAt: number;
  nextAt: number;
}

export function applyExpo(value: number, expo: number = AIM_EXPO): number {
  if (!Number.isFinite(value) || !Number.isFinite(expo) || expo <= 0) {
    return 0;
  }
  const clamped = Math.max(-1, Math.min(1, value));
  return Math.sign(clamped) * Math.pow(Math.abs(clamped), expo);
}

// Aim helpers: yaw/pitch (radians, -Z forward) <-> unit direction vector.
export function directionFromYawPitch(yaw: number, pitch: number): { x: number; y: number; z: number } {
  const safeYaw = Number.isFinite(yaw) ? yaw : 0;
  const safePitch = Number.isFinite(pitch) ? pitch : 0.25;
  const cosPitch = Math.cos(safePitch);
  return {
    x: -Math.sin(safeYaw) * cosPitch,
    y: Math.sin(safePitch),
    z: -Math.cos(safeYaw) * cosPitch,
  };
}

export function yawPitchFromDirection(x: number, y: number, z: number): { yaw: number; pitch: number } {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return { yaw: 0, pitch: 0.25 };
  }
  const yaw = Math.atan2(-x, -z);
  const horizontal = Math.hypot(x, z);
  return { yaw, pitch: Math.atan2(y, Math.max(0.0001, horizontal)) };
}

// Client muzzle math (mirror of server hits.muzzleForShot):
// muzzle = bodyCenter(XZ) + dir(yaw,pitch) * BALL_MUZZLE_OFFSET,
// y = thrower body-center y + BALL_TORSO_OFFSET (torso/hand height). On the
// ground bodyY is 1.1 so spawn y == 1.4 exactly as before; on platforms (or
// mid-jump) it tracks the thrower's elevation instead of the feet.
// Uses directionFromYawPitch so the dir formula stays identical by construction.
export function muzzleForShot(
  selfX: number,
  selfY: number,
  selfZ: number,
  yaw: number,
  pitch: number,
): { x: number; y: number; z: number; dirX: number; dirY: number; dirZ: number } {
  const dir = directionFromYawPitch(yaw, pitch);
  const bodyY = Number.isFinite(selfY) ? selfY : SELF_SPAWN_Y;
  return {
    x: selfX + dir.x * BALL_MUZZLE_OFFSET,
    y: bodyY + BALL_TORSO_OFFSET,
    z: selfZ + dir.z * BALL_MUZZLE_OFFSET,
    dirX: dir.x,
    dirY: dir.y,
    dirZ: dir.z,
  };
}

export function roundPhaseFromString(raw: unknown): RoundPhase {
  if (raw === "countdown" || raw === "playing" || raw === "ended") {
    return raw;
  }
  return "lobby";
}

export interface HitCandidate {
  sessionId: string;
  x: number;
  z: number;
  alive: boolean;
}

// Client-side hitscan target pick: nearest living non-self candidate inside
// HIT_MAX_RANGE. The server re-validates (range/cooldown/invuln) anyway.
export function pickHitTarget(
  selfId: string,
  selfX: number,
  selfZ: number,
  candidates: readonly HitCandidate[],
  maxRange: number = HIT_MAX_RANGE,
): string | null {
  let bestId: string | null = null;
  let bestDistSq = maxRange * maxRange;
  for (const candidate of candidates) {
    if (candidate.sessionId === selfId || !candidate.alive) {
      continue;
    }
    const dx = candidate.x - selfX;
    const dz = candidate.z - selfZ;
    const distSq = dx * dx + dz * dz;
    if (distSq <= bestDistSq) {
      bestDistSq = distSq;
      bestId = candidate.sessionId;
    }
  }
  return bestId;
}
