import { describe, expect, it } from "vitest";
import {
  activeTemporarySurface, directBonusDamage, getSuperBonus, isSuperBonusKind,
  SUPER_BONUSES, type TemporarySurfaceEffect,
} from "../../shared/super-bonuses.mjs";

function surface(effectId: string, kind: string, overrides: Partial<TemporarySurfaceEffect> = {}): TemporarySurfaceEffect {
  return { effectId, kind, x: 0, y: 0, z: 0, radius: 2, createdAt: 100, expiresAt: 1100, ...overrides };
}

describe("selected central items", () => {
  it("includes exactly the owner's ten and rejects catalogue alternatives", () => {
    expect(SUPER_BONUSES.map(({ id }) => id)).toEqual(["01", "02", "05", "08", "14", "16", "17", "18", "23", "26"]);
    expect(new Set(SUPER_BONUSES.map(({ kind }) => kind)).size).toBe(10);
    expect(isSuperBonusKind("sheep")).toBe(true);
    expect(isSuperBonusKind("pineapple")).toBe(false);
    expect(isSuperBonusKind(undefined)).toBe(false);
    expect(getSuperBonus("turkey")?.name).toBe("Индейка-каска");
  });
  it("keeps all later-effect damage out of the extra direct hit component", () => {
    for (const kind of ["sheep", "herring", "soda", "swamp", "ice", "vacuum"]) {
      expect(directBonusDamage(kind, 0.5)).toBe(0);
      expect(directBonusDamage(kind, 1)).toBe(0);
    }
    expect(directBonusDamage("turkey", 0.5)).toBe(12.5);
    expect(directBonusDamage("freeze", 1)).toBe(12.5);
    expect(directBonusDamage("jelly", 1)).toBe(12.5);
    expect(directBonusDamage("boomerang", 0.7999)).toBe(12.5);
    expect(directBonusDamage("boomerang", 0.8)).toBe(25);
    expect(directBonusDamage("unknown", 1)).toBe(0);
  });
});

describe("shared temporary surface prediction", () => {
  it.each([["swamp", 3], ["ice", 3.6]] as const)("%s predicts coverage in the expanded outer band and stops at the new boundary", (kind, radius) => {
    const patch = surface("wide", kind, { radius });
    expect(activeTemporarySurface([patch], radius * 0.75, 1.1, 0, 200)).toBe(patch);
    expect(activeTemporarySurface([patch], radius, 1.1, 0, 200)).toBe(patch);
    expect(activeTemporarySurface([patch], radius + 0.01, 1.1, 0, 200)).toBeUndefined();
  });

  it("selects newest overlapping coverage and restores the previous patch on expiry", () => {
    const swamp = surface("a", "swamp");
    const ice = surface("b", "ice", { createdAt: 200, expiresAt: 600 });
    expect(activeTemporarySurface([ice, swamp], 0, 1.1, 0, 500)).toBe(ice);
    expect(activeTemporarySurface([swamp, ice], 0, 1.1, 0, 500)).toBe(ice);
    expect(activeTemporarySurface([swamp, ice], 0, 1.1, 0, 600)).toBe(swamp);
    expect(activeTemporarySurface([swamp, ice], 0, 1.1, 0, 1100)).toBeUndefined();
  });
  it("never reaches an upper floor or an airborne player, but supports roof patches", () => {
    const floor = surface("floor", "ice");
    const roof = surface("roof", "swamp", { y: 2 });
    expect(activeTemporarySurface([floor], 0, 3.1, 0, 200)).toBeUndefined();
    expect(activeTemporarySurface([floor], 0, 1.5, 0, 200)).toBeUndefined();
    expect(activeTemporarySurface([floor, roof], 0, 3.1, 0, 200)).toBe(roof);
    expect(activeTemporarySurface([floor], 0, 1.2, 0, 200)).toBe(floor);
  });
  it("respects radius, placement time, wall visibility and deterministic ties", () => {
    const a = surface("a", "swamp");
    const b = surface("b", "ice");
    expect(activeTemporarySurface([a, b], 0, 1.1, 0, 200)).toBe(b);
    expect(activeTemporarySurface([b, a], 0, 1.1, 0, 200)).toBe(b);
    expect(activeTemporarySurface([a], 2.1, 1.1, 0, 200)).toBeUndefined();
    expect(activeTemporarySurface([a], 0, 1.1, 0, 99)).toBeUndefined();
    expect(activeTemporarySurface([a], 0, 1.1, 0, 200, 1.1, () => false)).toBeUndefined();
    expect(activeTemporarySurface([a], Number.NaN, 1.1, 0, 200)).toBeUndefined();
    expect(activeTemporarySurface([surface("cloud", "herring")], 0, 1.1, 0, 200)).toBeUndefined();
  });
});
