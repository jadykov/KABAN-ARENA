import { describe, expect, it } from "vitest";
import {
  POWERUP_PICKUP_RADIUS,
  POWERUP_RESPAWN_S,
  SHIELD_MAX_HITS,
  SPEED_DURATION_S,
  SPEED_MULTIPLIER,
} from "../config";
import { PowerUpPickups, PowerUpState, getPickupSlots } from "./PowerUps";

describe("PowerUpState skill set A1", () => {
  it("applies speed x1.3 and expires after the duration", () => {
    const state = new PowerUpState();
    expect(state.getSpeedMultiplier()).toBe(1);
    state.applyPickup("speed");
    expect(state.isSpeedActive()).toBe(true);
    expect(state.getSpeedMultiplier()).toBe(SPEED_MULTIPLIER);
    expect(SPEED_MULTIPLIER).toBe(1.3);
    expect(state.getSpeedRemaining()).toBeGreaterThan(0);
    state.update(SPEED_DURATION_S + 1);
    expect(state.isSpeedActive()).toBe(false);
    expect(state.getSpeedMultiplier()).toBe(1);
    expect(state.getSpeedRemaining()).toBe(0);
  });

  it("refreshes speed on re-pickup", () => {
    const state = new PowerUpState();
    state.applyPickup("speed");
    state.update(SPEED_DURATION_S - 1);
    state.applyPickup("speed");
    expect(state.getSpeedRemaining()).toBeCloseTo(SPEED_DURATION_S, 5);
  });

  it("absorbs exactly SHIELD_MAX_HITS hits", () => {
    const state = new PowerUpState();
    expect(SHIELD_MAX_HITS).toBe(1);
    expect(state.hasShield()).toBe(false);
    expect(state.consumeShieldHit()).toBe(false);
    state.applyPickup("shield");
    expect(state.hasShield()).toBe(true);
    expect(state.consumeShieldHit()).toBe(true);
    expect(state.hasShield()).toBe(false);
    expect(state.consumeShieldHit()).toBe(false);
  });

  it("holds no timed state for impulse knockback", () => {
    const state = new PowerUpState();
    state.applyPickup("impulse");
    expect(state.isSpeedActive()).toBe(false);
    expect(state.hasShield()).toBe(false);
  });

  it("resets all state", () => {
    const state = new PowerUpState();
    state.applyPickup("speed");
    state.applyPickup("shield");
    state.update(1);
    state.reset();
    expect(state.isSpeedActive()).toBe(false);
    expect(state.hasShield()).toBe(false);
    expect(state.now).toBe(0);
  });
});

describe("PowerUpPickups pedestals", () => {
  it("exposes one pedestal per kind", () => {
    const slots = getPickupSlots();
    expect(slots).toHaveLength(3);
    expect(new Set(slots.map((slot) => slot.kind))).toEqual(
      new Set(["speed", "shield", "impulse"]),
    );
  });

  it("collects by proximity and respawns after the delay", () => {
    const pickups = new PowerUpPickups();
    try {
      const speedSlot = getPickupSlots().find((slot) => slot.kind === "speed");
      expect(speedSlot).toBeDefined();
      if (speedSlot === undefined) {
        return;
      }
      expect(pickups.isAvailable("speed")).toBe(true);
      // Far away: nothing collected.
      expect(pickups.update(1 / 60, 5, 5)).toHaveLength(0);
      // Outside the pickup radius: still nothing.
      const outside = pickups.update(
        1 / 60,
        speedSlot.x + POWERUP_PICKUP_RADIUS * 2,
        speedSlot.z,
      );
      expect(outside).toHaveLength(0);
      // On the pedestal: collected and hidden.
      const collected = pickups.update(1 / 60, speedSlot.x, speedSlot.z);
      expect(collected).toEqual(["speed"]);
      expect(pickups.isAvailable("speed")).toBe(false);
      // Still gone before the respawn delay.
      pickups.update(POWERUP_RESPAWN_S - 1, speedSlot.x, speedSlot.z);
      expect(pickups.isAvailable("speed")).toBe(false);
      // Back after the delay.
      pickups.update(1.5, 5, 5);
      expect(pickups.isAvailable("speed")).toBe(true);
    } finally {
      pickups.dispose();
    }
  });

  it("grants and resets directly", () => {
    const pickups = new PowerUpPickups();
    try {
      pickups.grant("shield");
      expect(pickups.isAvailable("shield")).toBe(false);
      pickups.reset();
      expect(pickups.isAvailable("shield")).toBe(true);
    } finally {
      pickups.dispose();
    }
  });
});
