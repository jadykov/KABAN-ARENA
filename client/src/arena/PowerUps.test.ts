import { describe, expect, it } from "vitest";
import { SHIELD_CAPACITY, SPEED_MULTIPLIER } from "../config";
import { ARENA_LAYOUT } from "../layout";
import { PowerUpPickups, PowerUpState, getPickupSlots } from "./PowerUps";

describe("PowerUpState mirrors server effects", () => {
  it("uses the synchronized five-second speed deadline for prediction", () => {
    const state = new PowerUpState();
    expect(state.getSpeedMultiplier()).toBe(1);
    state.sync({ shieldHp: 0, shieldUntil: 0, speedUntil: 6000 }, 1000);
    expect(SPEED_MULTIPLIER).toBe(1.25);
    expect(state.getSpeedMultiplier()).toBe(SPEED_MULTIPLIER);
    expect(state.getSpeedRemaining()).toBe(5);
    state.update(4.9);
    expect(state.isSpeedActive()).toBe(true);
    state.update(0.1);
    expect(state.isSpeedActive()).toBe(false);
    expect(state.getSpeedMultiplier()).toBe(1);
  });

  it("mirrors partial shield capacity and ends it at its server deadline", () => {
    const state = new PowerUpState();
    state.sync({ shieldHp: SHIELD_CAPACITY, shieldUntil: 11000, speedUntil: 0 }, 1000);
    expect(SHIELD_CAPACITY).toBe(25);
    expect(state.hasShield()).toBe(true);
    expect(state.getShieldHp()).toBe(25);
    expect(state.getShieldRemaining()).toBe(10);

    // A stronger hit can consume only part of the server shield capacity.
    state.sync({ shieldHp: 12.5, shieldUntil: 11000, speedUntil: 0 }, 2000);
    expect(state.getShieldHp()).toBe(12.5);
    expect(state.getShieldFraction()).toBe(0.5);
    state.update(9);
    expect(state.hasShield()).toBe(false);
    expect(state.getShieldHp()).toBe(0);
  });

  it("replaces local state with each snapshot and ignores invalid values", () => {
    const state = new PowerUpState();
    state.sync({ shieldHp: 25, shieldUntil: 11000, speedUntil: 6000 }, 1000);
    state.sync({ shieldHp: 0, shieldUntil: 0, speedUntil: 0 }, 1500);
    expect(state.hasShield()).toBe(false);
    expect(state.isSpeedActive()).toBe(false);

    state.sync({
      shieldHp: Number.POSITIVE_INFINITY,
      shieldUntil: Number.NaN,
      speedUntil: Number.NaN,
    }, Number.NaN);
    expect(state.hasShield()).toBe(false);
    expect(state.getSpeedMultiplier()).toBe(1);
    state.reset();
    expect(state.getShieldFraction()).toBe(0);
    expect(state.getSpeedRemaining()).toBe(0);
  });
});

describe("three neutral pickup visuals", () => {
  it("uses stable decimal layout indexes, with no preselected kind", () => {
    const slots = getPickupSlots();
    expect(slots).toHaveLength(3);
    expect(slots.map((slot) => slot.id)).toEqual([0, 1, 2]);
    expect(slots.map(({ x, z }) => ({ x, z }))).toEqual(ARENA_LAYOUT.pickups);
    expect(slots.every((slot) => !("kind" in slot))).toBe(true);
  });

  it("changes availability only from replicated state", () => {
    const pickups = new PowerUpPickups();
    try {
      expect(pickups.object.children).toHaveLength(3);
      expect(getPickupSlots().every((slot) => !pickups.isAvailable(slot.id))).toBe(true);

      pickups.sync([
        { id: 0, active: true },
        { id: 1, active: false },
        { id: 2, active: true },
      ]);
      expect(pickups.isAvailable(0)).toBe(true);
      expect(pickups.isAvailable(1)).toBe(false);
      expect(pickups.isAvailable(2)).toBe(true);

      // Time and proximity cannot collect or respawn a pedestal locally.
      pickups.update(100);
      expect(pickups.isAvailable(0)).toBe(true);
      expect(pickups.isAvailable(1)).toBe(false);
      pickups.sync([{ id: 0, active: false }, { id: 1, active: false }, { id: 2, active: false }]);
      pickups.update(100);
      expect(pickups.isAvailable(0)).toBe(false);
      expect(pickups.isAvailable(1)).toBe(false);
      pickups.sync([{ id: 1, active: true }]);
      expect(pickups.isAvailable(1)).toBe(true);
      expect(pickups.isAvailable(0)).toBe(false);
    } finally {
      pickups.dispose();
    }
  });

  it("hides stale pickup visuals on reset", () => {
    const pickups = new PowerUpPickups();
    try {
      pickups.sync([{ id: 0, active: true }]);
      pickups.reset();
      expect(pickups.isAvailable(0)).toBe(false);
      expect(pickups.isAvailable(1)).toBe(false);
      expect(pickups.isAvailable(2)).toBe(false);
    } finally {
      pickups.dispose();
    }
  });
});
