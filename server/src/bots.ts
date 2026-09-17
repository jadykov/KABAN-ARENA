import {
  BOT_CHARGE_MAX_S,
  BOT_CHARGE_MIN_S,
  BOT_FIRE_RANGE,
  BOT_RELOAD_MS,
  BOT_RETARGET_MS,
  CHARGE_MAX_S,
} from "./config.js";
import type { PlayerState } from "./state.js";

// Weak server-side bot brain: random-walk toward a retarget point, cannon
// fire at the nearest living enemy inside BOT_FIRE_RANGE. R2: bots use the
// same cannon (random charge 0.3-1.0s, 2.5s cooldown + jitter, exact aim) —
// throw-polish removed yaw spray, so a bot miss comes from its lead/pitch
// choice only, never from randomness.
export interface BotBrain {
  targetX: number;
  targetZ: number;
  retargetAt: number;
  nextFireAt: number;
  seed: number;
}

export function createBrain(nowMs: number, seed: number): BotBrain {
  return {
    targetX: pseudoRandom(seed) * 20 - 10,
    targetZ: pseudoRandom(seed + 101) * 20 - 10,
    retargetAt: nowMs + BOT_RETARGET_MS,
    nextFireAt: nowMs + BOT_RELOAD_MS,
    seed,
  };
}

// Deterministic PRNG (mulberry-ish) so bot tests are stable.
export function pseudoRandom(seed: number): number {
  let value = (seed * 1664525 + 1013904223) >>> 0;
  value ^= value >>> 15;
  value = (value * 1103515245) >>> 0;
  value ^= value >>> 12;
  return (value >>> 0) / 4294967296;
}

export interface BotStep {
  moveX: number;
  moveZ: number;
  rotY: number;
}

// One fixed-step update: steer toward the wander target, retarget on arrival
// or timeout. Returns a normalized planar move vector + facing.
export function stepBot(bot: PlayerState, brain: BotBrain, nowMs: number): BotStep {
  if (nowMs >= brain.retargetAt) {
    brain.seed += 1;
    brain.targetX = pseudoRandom(brain.seed) * 20 - 10;
    brain.targetZ = pseudoRandom(brain.seed + 101) * 20 - 10;
    brain.retargetAt = nowMs + BOT_RETARGET_MS;
  }
  const dx = brain.targetX - bot.x;
  const dz = brain.targetZ - bot.z;
  const length = Math.hypot(dx, dz);
  if (length < 0.75) {
    brain.retargetAt = 0; // force retarget next step
    return { moveX: 0, moveZ: 0, rotY: bot.rotY };
  }
  const moveX = dx / length;
  const moveZ = dz / length;
  return { moveX, moveZ, rotY: Math.atan2(moveX, moveZ) };
}

export interface BotFirePlan {
  targetId: string;
  chargeS: number;
  power01: number;
  yaw: number;
  pitch: number;
}

// Cannon fire plan: nearest living ready fighter in range + reload elapsed.
// Aim points exactly at the target (zero spray); charge is uniform-random
// in 0.3-1.0s via the brain seed.
// Returns null when holding fire; advances nextFireAt only on a real plan.
export function planBotFire(
  bot: PlayerState,
  players: Iterable<PlayerState>,
  brain: BotBrain,
  nowMs: number,
): BotFirePlan | null {
  if (!bot.alive || nowMs < brain.nextFireAt) {
    return null;
  }
  let best: PlayerState | null = null;
  let bestDistSq = BOT_FIRE_RANGE * BOT_FIRE_RANGE;
  for (const candidate of players) {
    if (candidate.sessionId === bot.sessionId || !candidate.alive) {
      continue;
    }
    if (candidate.spectator || !candidate.ready) {
      continue;
    }
    const dx = candidate.x - bot.x;
    const dz = candidate.z - bot.z;
    const distSq = dx * dx + dz * dz;
    if (distSq <= bestDistSq) {
      bestDistSq = distSq;
      best = candidate;
    }
  }
  if (best === null) {
    return null;
  }
  brain.seed += 1;
  const chargeRange = BOT_CHARGE_MAX_S - BOT_CHARGE_MIN_S;
  const chargeS = BOT_CHARGE_MIN_S + pseudoRandom(brain.seed) * chargeRange;
  const power01 = 0.5 + 0.5 * Math.max(0, Math.min(1, chargeS / CHARGE_MAX_S));
  // Base yaw toward the target (-Z forward convention: atan2(-dx, -dz)).
  // No yaw spray: the ball flies exactly along this yaw + pitch below.
  const dx = best.x - bot.x;
  const dz = best.z - bot.z;
  const dist = Math.max(0.001, Math.hypot(dx, dz));
  const yaw = Math.atan2(-dx, -dz);
  // Lob pitch by distance: farther targets get a higher arc (always parabolic).
  const pitch = Math.max(0.08, Math.min(0.7, 0.15 + dist / 40));
  const jitterMs = Math.floor(pseudoRandom(brain.seed + 9000) * 2000);
  brain.nextFireAt = nowMs + BOT_RELOAD_MS + jitterMs;
  return { targetId: best.sessionId, chargeS, power01, yaw, pitch };
}

// Legacy hitscan target pick (kept for unit compat): nearest living enemy
// in range + interval elapsed. R2 rooms use planBotFire + cannonballs.
export function pickBotTarget(
  bot: PlayerState,
  players: Iterable<PlayerState>,
  brain: BotBrain,
  nowMs: number,
): string | null {
  const plan = planBotFire(bot, players, brain, nowMs);
  return plan === null ? null : plan.targetId;
}
