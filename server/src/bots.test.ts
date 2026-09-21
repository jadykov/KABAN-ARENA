import { describe, expect, it } from "vitest";
import {
  BALL_GRAVITY,
  BALL_HIT_RADIUS,
  BODY_CENTER_Y,
  BOT_FIRE_RANGE,
  MAX_HP,
} from "./config.js";
import { createBrain, pitchForTarget, planBotFire } from "./bots.js";
import { muzzleForShot, powerToSpeed } from "./hits.js";
import { PlayerState } from "./state.js";

function makeFighter(sessionId: string, x: number, z: number, bodyY: number, isBot: boolean): PlayerState {
  const player = new PlayerState();
  player.sessionId = sessionId;
  player.nick = sessionId;
  player.x = x;
  player.z = z;
  player.y = bodyY;
  player.hp = MAX_HP;
  player.alive = true;
  player.invulnUntil = 0;
  player.ready = true;
  player.spectator = false;
  player.isBot = isBot;
  return player;
}

// Min 3D distance from the victim body center along the full solved-arc
// flight (server ballistics: muzzle + speed + BALL_GRAVITY, dt 5ms, 3s).
function minArcDistance(
  shooterX: number,
  shooterY: number,
  shooterZ: number,
  yaw: number,
  pitch: number,
  power01: number,
  victimX: number,
  victimY: number,
  victimZ: number,
): number {
  const muzzle = muzzleForShot(shooterX, shooterY, shooterZ, yaw, pitch);
  const speed = powerToSpeed(power01);
  let px = muzzle.x;
  let py = muzzle.y;
  let pz = muzzle.z;
  const vx = muzzle.dirX * speed;
  let vy = muzzle.dirY * speed;
  const vz = muzzle.dirZ * speed;
  const dt = 0.005;
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 600; i += 1) {
    vy -= BALL_GRAVITY * dt;
    px += vx * dt;
    py += vy * dt;
    pz += vz * dt;
    const dx = victimX - px;
    const dy = victimY - py;
    const dz = victimZ - pz;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < min) {
      min = dist;
    }
    if (py < 0) {
      break;
    }
  }
  return min;
}

describe("pitchForTarget (ballistic solve for elevated victims)", () => {
  // The solve measures from the LAUNCH point: production refines the solve
  // from the muzzle XZ/height (see planBotFire), so these cases solve from
  // the muzzle too — solving from the body center while launching 0.7m
  // ahead passes ~0.3m off (caught by the first version of this test).
  it("solves flat shots that integrate back to the target", () => {
    // Shooter (0,0) yaw 0 (-z): muzzle ≈ (0, 1.4, -0.7), victim (0,1.1,-6).
    const pitch = pitchForTarget(20, 5.3, -0.3);
    expect(pitch).not.toBe(null);
    if (pitch === null) {
      return;
    }
    // Nearly level (muzzle 1.4 -> victim 1.1 is slightly downhill, so the
    // low-arc solve is a touch negative — |lob| < ~0.15 rad either way).
    expect(Math.abs(pitch)).toBeLessThan(0.15);
    const min = minArcDistance(0, BODY_CENTER_Y, 0, 0, pitch, 1, 0, BODY_CENTER_Y, -6);
    expect(min).toBeLessThan(0.15);
  });

  it("solves upward shots onto tower-top height", () => {
    // Muzzle (0, 1.4, -0.7), victim body 3.1 at (0,-6): dy = +1.7 over ~5.3m.
    const pitch = pitchForTarget(20, 5.3, 1.7);
    expect(pitch).not.toBe(null);
    if (pitch === null) {
      return;
    }
    expect(pitch).toBeGreaterThan(0.2);
    const min = minArcDistance(0, BODY_CENTER_Y, 0, 0, pitch, 1, 0, 3.1, -6);
    expect(min).toBeLessThan(0.15);
  });

  it("returns null when unreachable or degenerate", () => {
    // Far weak shot that cannot get there: negative discriminant (weak-ball
    // max range is v^2/g = 121/3.5 = 34.6m, so 40m out + 10m up is out).
    expect(pitchForTarget(11, 40, 10)).toBe(null);
    expect(pitchForTarget(0, 6, 0)).toBe(null);
    expect(pitchForTarget(20, 0.1, 0)).toBe(null);
    expect(pitchForTarget(Number.NaN, 6, 0)).toBe(null);
  });
});

describe("planBotFire aims at the victim body Y (bug 3b)", () => {
  it("hits a tower-top victim inside range (arc integration proof)", () => {
    const bot = makeFighter("bot-1", 0, 0, BODY_CENTER_Y, true);
    const victim = makeFighter("s1", 0, -6, 3.1, false);
    const brain = createBrain(-10000, 7);
    const plan = planBotFire(bot, [bot, victim], brain, 0);
    expect(plan).not.toBe(null);
    if (plan === null) {
      return;
    }
    expect(plan.targetId).toBe("s1");
    // The solved pitch aims UP at the elevation (flat-ground lob at 6m
    // would be ~0.3; the tower-top solve must clear it).
    expect(plan.pitch).toBeGreaterThan(0.3);
    const min = minArcDistance(
      bot.x,
      bot.y,
      bot.z,
      plan.yaw,
      plan.pitch,
      plan.power01,
      victim.x,
      victim.y,
      victim.z,
    );
    expect(min).toBeLessThanOrEqual(BALL_HIT_RADIUS);
  });

  it("keeps the distance lob for unreachable geometry", () => {
    const bot = makeFighter("bot-1", 0, 0, BODY_CENTER_Y, true);
    // 12m out (range edge) and 5m above the muzzle: unsolvable, lob kept.
    const victim = makeFighter("s1", 0, -12, 6.4, false);
    expect(BOT_FIRE_RANGE).toBe(12);
    const brain = createBrain(-10000, 7);
    const plan = planBotFire(bot, [bot, victim], brain, 0);
    expect(plan).not.toBe(null);
    if (plan === null) {
      return;
    }
    expect(plan.pitch).toBeGreaterThanOrEqual(0.08);
    expect(plan.pitch).toBeLessThanOrEqual(0.7);
  });
});
