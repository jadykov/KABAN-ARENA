import { describe, expect, it } from "vitest";
import {
  CHARGE_MAX_S,
  FULL_DAMAGE,
  FULL_POWER_THRESHOLD,
  HIT_DAMAGE,
  INVULN_MS,
  MAX_HP,
  RELOAD_MS,
  RESPAWN_DELAY_MS,
  SELF_ARMING_DIST_M,
  SELF_ARMING_TIME_S,
  SUPER_DAMAGE_MULT,
  WEAK_DAMAGE,
} from "./config.js";
import {
  applyHit,
  canDamage,
  chargeToPower01,
  damageForPower,
  heartsForHp,
  powerToSpeed,
  respawnPlayer,
  validateHit,
} from "./hits.js";
import { PlayerState } from "./state.js";

function makePlayer(sessionId: string, overrides: Partial<Record<string, number | boolean | string>> = {}): PlayerState {
  const player = new PlayerState();
  player.sessionId = sessionId;
  player.nick = sessionId;
  player.hp = MAX_HP;
  player.alive = true;
  player.invulnUntil = 0;
  // R1: combatants are ready fighters, never spectators.
  player.ready = true;
  player.spectator = false;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      continue;
    }
    (player as unknown as Record<string, number | boolean | string>)[key] = value;
  }
  return player;
}

describe("damage model hitscan A (100HP / 25dmg = 4 hits = 4 hearts)", () => {
  it("one hit removes exactly 25 HP and one heart", () => {
    const shooter = makePlayer("shooter");
    const target = makePlayer("target");
    const result = applyHit(shooter, target, 1000);
    expect(result.damage).toBe(HIT_DAMAGE);
    expect(result.killed).toBe(false);
    expect(target.hp).toBe(MAX_HP - HIT_DAMAGE);
    expect(heartsForHp(target.hp)).toBe(6);
    expect(shooter.score).toBe(1); // HIT_SCORE
  });

  it("four full hits kill: HP top-center hearts reach zero", () => {
    const shooter = makePlayer("shooter");
    const target = makePlayer("target");
    let killed = false;
    for (let i = 0; i < 4; i += 1) {
      killed = applyHit(shooter, target, 1000 + i).killed;
    }
    expect(killed).toBe(true);
    expect(target.alive).toBe(false);
    expect(target.hp).toBe(0);
    expect(heartsForHp(target.hp)).toBe(0);
    // 4 hits (+1 each) + killing blow bonus (+10) = 14.
    expect(shooter.score).toBe(14);
  });

  it("invulnerable targets (respawn invuln 2s) cannot be damaged", () => {
    const shooter = makePlayer("shooter");
    const target = makePlayer("target", { invulnUntil: 5000 });
    expect(canDamage(target, 4999)).toBe(false);
    expect(validateHit(shooter, target, 4999, undefined).reason).toBe("invulnerable");
    expect(canDamage(target, 5000)).toBe(true);
    expect(validateHit(shooter, target, 5000, undefined).ok).toBe(true);
  });

  it("hitscan validation rejects self-hit, dead, cooldown, range", () => {
    const shooter = makePlayer("shooter", { x: 0, z: 0 });
    const far = makePlayer("far", { x: 60, z: 0 });
    const near = makePlayer("near", { x: 3, z: 0 });
    expect(validateHit(shooter, shooter, 1000, undefined).reason).toBe("no-self-hit");
    expect(validateHit(shooter, far, 1000, undefined).reason).toBe("out-of-range");
    expect(validateHit(shooter, near, 1000, 900).reason).toBe("cooldown");
    expect(validateHit(shooter, near, 1000, undefined).ok).toBe(true);
    const dead = makePlayer("dead", { alive: false });
    expect(validateHit(shooter, dead, 1000, undefined).reason).toBe("dead");
  });

  it("respawn restores full HP + 2s invuln (respawn 100ms instant, scheduled by room)", () => {
    expect(RESPAWN_DELAY_MS).toBe(100);
    const target = makePlayer("target", { alive: false, hp: 0, x: 99, z: 99 });
    respawnPlayer(target, 1, 7000);
    expect(target.alive).toBe(true);
    expect(target.hp).toBe(MAX_HP);
    expect(target.invulnUntil).toBe(7000 + INVULN_MS);
    expect(heartsForHp(target.hp)).toBe(8);
  });
});

describe("R2 cannon halves (4 hearts = 8 halves, half heart = 12.5 HP)", () => {
  it("maps HP to 0-8 halves", () => {
    expect(heartsForHp(100)).toBe(8);
    expect(heartsForHp(87.5)).toBe(7);
    expect(heartsForHp(75)).toBe(6);
    expect(heartsForHp(62.5)).toBe(5);
    expect(heartsForHp(50)).toBe(4);
    expect(heartsForHp(37.5)).toBe(3);
    expect(heartsForHp(25)).toBe(2);
    expect(heartsForHp(12.5)).toBe(1);
    expect(heartsForHp(0)).toBe(0);
  });

  it("eight weak hits kill, four full hits kill", () => {
    const shooter = makePlayer("shooter");
    const weak = makePlayer("weak");
    for (let i = 0; i < 8; i += 1) {
      applyHit(shooter, weak, 1000 + i, WEAK_DAMAGE);
    }
    expect(weak.hp).toBe(0);
    expect(weak.alive).toBe(false);
    expect(heartsForHp(weak.hp)).toBe(0);
    const full = makePlayer("full");
    for (let i = 0; i < 4; i += 1) {
      applyHit(shooter, full, 2000 + i, FULL_DAMAGE);
    }
    expect(full.hp).toBe(0);
    expect(full.alive).toBe(false);
  });

  it("clamps out-of-range HP", () => {
    expect(heartsForHp(1000)).toBe(8);
    expect(heartsForHp(-5)).toBe(0);
    expect(heartsForHp(Number.NaN)).toBe(0);
  });
});

describe("R2 charge mapping (0-1.0s -> power01 -> speed/damage)", () => {
  it("charge seconds map to power01 in [0.5, 1]", () => {
    expect(CHARGE_MAX_S).toBe(1.0);
    expect(chargeToPower01(0)).toBe(0.5);
    expect(chargeToPower01(-1)).toBe(0.5);
    expect(chargeToPower01(Number.NaN)).toBe(0.5);
    expect(chargeToPower01(CHARGE_MAX_S)).toBeCloseTo(1);
    expect(chargeToPower01(CHARGE_MAX_S / 2)).toBeCloseTo(0.75);
    expect(chargeToPower01(999)).toBeCloseTo(1);
  });

  it("power01 maps to ballistic speed 11/15.5/20 (weak 11, mid 15.5, full 20)", () => {
    expect(powerToSpeed(0.5)).toBeCloseTo(11);
    expect(powerToSpeed(1)).toBeCloseTo(20);
    expect(powerToSpeed(0.75)).toBeCloseTo(15.5);
    // Weak shots fly strictly slower (shorter range) than full-power shots.
    expect(powerToSpeed(0.5)).toBeLessThan(powerToSpeed(1));
  });

  it("threshold 0.8 rewards committed charges (weak 12.5 < full 25)", () => {
    expect(FULL_POWER_THRESHOLD).toBe(0.8);
    expect(WEAK_DAMAGE).toBe(12.5);
    expect(FULL_DAMAGE).toBe(25);
    expect(WEAK_DAMAGE).toBeLessThan(FULL_DAMAGE);
    expect(damageForPower(0.79, false)).toBe(WEAK_DAMAGE);
    expect(damageForPower(0.8, false)).toBe(FULL_DAMAGE);
    expect(damageForPower(1, false)).toBe(FULL_DAMAGE);
    expect(damageForPower(0.5, false)).toBe(WEAK_DAMAGE);
  });

  it("SUPER buff doubles damage (50 / 25)", () => {
    expect(SUPER_DAMAGE_MULT).toBe(2);
    expect(damageForPower(1, true)).toBe(FULL_DAMAGE * 2);
    expect(damageForPower(0.5, true)).toBe(WEAK_DAMAGE * 2);
  });

  it("reload gate is 2.5s and self-arming is 1m / 0.3s", () => {
    expect(RELOAD_MS).toBe(2500);
    expect(SELF_ARMING_DIST_M).toBe(1.0);
    expect(SELF_ARMING_TIME_S).toBe(0.3);
  });
});
