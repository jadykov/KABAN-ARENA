import { describe, expect, it } from "vitest";
import { decodeSnapshot } from "./NetworkManager";
import { BonusControlState } from "./BonusControlState";
import { damageForPower, type NetPlayerSnapshot } from "./protocol";
import { boomerangPreviewDistance } from "./bonusTrajectory";

function player(overrides: Partial<NetPlayerSnapshot> = {}): NetPlayerSnapshot {
  return decodeSnapshot({ players: new Map([["self", { alive: true, ready: true, ...overrides }]]) }).players[0]!;
}

describe("super bonus wire compatibility", () => {
  it("normalizes missing and unknown kinds and control fields", () => {
    const snapshot = decodeSnapshot({
      players: new Map([["self", { alive: true, superKind: "unknown", frozenUntil: NaN, turkeyUntil: -10, launchSeq: 2.9 }]]),
      balls: new Map([["ball", { bonusKind: "unknown" }]]),
      superActive: true, superKind: "unknown",
      bonusEffects: new Map([["bad", { kind: "unknown" }], ["cloud", { kind: "herring", radius: -2, vx: Infinity }]]),
    });
    expect(snapshot.players[0]).toMatchObject({ superKind: "", superUntil: 0, frozenUntil: 0, turkeyUntil: 0,
      controlImmuneUntil: 0, launchSeq: 2, launchVelocity: 0 });
    expect(snapshot.balls[0]?.bonusKind).toBe("");
    expect(snapshot.super?.kind).toBe("");
    expect(snapshot.bonusEffects).toHaveLength(1);
    expect(snapshot.bonusEffects?.[0]).toMatchObject({ effectId: "cloud", kind: "herring", radius: 0, vx: 0, y: 0 });
    expect(decodeSnapshot({}).bonusEffects).toEqual([]);
  });

  it("decodes recognized held, centre, projectile and deployed bonuses", () => {
    const snapshot = decodeSnapshot({
      players: new Map([["self", { superKind: "sheep", superUntil: 21_000, frozenUntil: 2000, turkeyUntil: 3000,
        controlImmuneUntil: 4000, launchSeq: 3, launchVelocity: 10 }]]),
      balls: new Map([["ball", { bonusKind: "boomerang" }]]),
      superActive: true, superKind: "vacuum",
      bonusEffects: new Map([["zone", { kind: "ice", ownerId: "self", throwId: "throw", phase: "active",
        x: 2, y: 4, z: 3, radius: 2, createdAt: 1000, expiresAt: 6000, armedAt: 1200, triggerAt: 1400, vx: 1, vy: 2, vz: 3 }]]),
    });
    expect(snapshot.players[0]?.superKind).toBe("sheep");
    expect(snapshot.players[0]?.launchVelocity).toBe(10);
    expect(snapshot.balls[0]?.bonusKind).toBe("boomerang");
    expect(snapshot.super?.kind).toBe("vacuum");
    expect(snapshot.bonusEffects?.[0]).toMatchObject({ effectId: "zone", throwId: "throw", kind: "ice", phase: "active", y: 4, vz: 3 });
  });

  it("a malformed effect map leaves player and projectile data available", () => {
    expect(decodeSnapshot({ players: new Map([["self", { alive: true }]]), bonusEffects: { forEach: (): never => { throw new Error("bad patch"); } } }).players).toHaveLength(1);
  });
});

describe("server-timed local bonus control", () => {
  it("holds exactly to the deadlines and charge cancellation does not consume the item", () => {
    const state = new BonusControlState();
    state.sync(player({ superKind: "freeze", superUntil: 21_000, frozenUntil: 2000, turkeyUntil: 3000 }), 1000);
    expect(state.heldRemaining(1000)).toBe(20);
    expect(state.isFrozen(1999)).toBe(true);
    expect(state.isFrozen(2000)).toBe(false);
    expect(state.hasTurkeyMask(2999)).toBe(true);
    expect(state.hasTurkeyMask(3000)).toBe(false);
    expect(state.heldKind(3000)).toBe("freeze");
    expect(state.heldKind(21_000)).toBe("");
    state.consumeHeld();
    expect(state.heldRemaining(1000)).toBe(0);
  });

  it("deduplicates launch sequences, tolerates old patches and baselines late joins", () => {
    const state = new BonusControlState();
    expect(state.sync(player({ launchSeq: 3, launchVelocity: 10 }), 1000)).toBe(0);
    expect(state.sync(player({ launchSeq: 4, launchVelocity: 10 }), 1050)).toBe(10);
    expect(state.sync(player({ launchSeq: 4, launchVelocity: 10 }), 1100)).toBe(0);
    expect(state.sync(player({ launchSeq: 3, launchVelocity: 10 }), 1150)).toBe(0);
    expect(state.sync(player({ launchSeq: 4, launchVelocity: 10 }), 1200)).toBe(0);
    expect(state.sync(player({ launchSeq: 5, launchVelocity: 10 }), 1250)).toBe(10);
  });

  it("clears held/control effects on death, spectating, end/disconnect and accepts a fresh life", () => {
    for (const inactive of [player({ alive: false }), player({ spectator: true }), player({ ready: false }), null]) {
      const state = new BonusControlState();
      state.sync(player({ superKind: "sheep", superUntil: 21_000, frozenUntil: 2000, turkeyUntil: 3000 }), 1000);
      state.sync(inactive, 1000);
      expect(state.heldKind(1000)).toBe("");
      expect(state.isFrozen(1000)).toBe(false);
      expect(state.hasTurkeyMask(1000)).toBe(false);
      expect(state.sync(player({ launchSeq: 9, launchVelocity: 10 }), 1050)).toBe(0);
    }
  });
});

describe("super bonus shot preview", () => {
  it("uses base plus immediate bonus damage without the old multiplier", () => {
    expect(damageForPower(0.8, true, "turkey")).toBe(37.5);
    expect(damageForPower(0.799, true, "turkey")).toBe(25);
    expect(damageForPower(0.8, true, "boomerang")).toBe(50);
    for (const kind of ["sheep", "herring", "swamp", "ice", "soda", "vacuum"] as const) {
      expect(damageForPower(0.8, true, kind)).toBe(25);
      expect(damageForPower(0.799, true, kind)).toBe(12.5);
    }
  });

  it("previews the gravity-free outgoing and returning boomerang for both charges", () => {
    for (const speed of [11, 20]) {
      const distances = Array.from({ length: 8 }, (_, i) => boomerangPreviewDistance(speed, i, 8));
      const active = distances.filter((value): value is number => value !== null);
      expect(active[0]).toBeCloseTo(speed * 0.05);
      const peak = Math.max(...active);
      expect(peak).toBeGreaterThanOrEqual(6);
      expect(active[active.length - 1]).toBeLessThan(peak - 1);
    }
    expect(boomerangPreviewDistance(NaN, 0, 6)).toBeNull();
  });
});
