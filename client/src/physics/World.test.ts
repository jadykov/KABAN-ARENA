import { describe, expect, it } from "vitest";
import { KNOCKBACK_IMPULSE, TRAMPOLINE_IMPULSE } from "../config";
import { PhysicsWorld } from "./World";

const SPAWN = { x: 0, y: 1.1, z: 0 };

describe("PhysicsWorld rapier wrapper", () => {
  it("replaces rising, falling and trampoline velocity for jelly while preserving horizontal motion", async () => {
    const physics = await PhysicsWorld.create(SPAWN);
    try {
      for (const previousY of [-3, 10]) {
        physics.setPlayerVelocity(2, previousY, 4);
        physics.setPlayerVerticalVelocity(10);
        expect(physics.getPlayerVelocity()).toEqual({ x: 2, y: 10, z: 4 });
      }
      physics.launchTrampoline();
      expect(physics.getPlayerVelocity()).toEqual({ x: 2, y: TRAMPOLINE_IMPULSE, z: 4 });
      physics.setPlayerVerticalVelocity(10);
      expect(physics.getPlayerVelocity()).toEqual({ x: 2, y: 10, z: 4 });
    } finally { physics.dispose(); }
  });

  it("sweeps vacuum reconciliation before walls and retains vertical/horizontal momentum", async () => {
    const physics = await PhysicsWorld.create(SPAWN);
    try {
      physics.addStaticBox(0.2, 3, 4, 2, 3, 0);
      for (let i = 0; i < 60; i += 1) physics.step(1 / 60);
      physics.setPlayerVelocity(0.3, 2, -0.4);
      const velocity = physics.getPlayerVelocity();
      const beforeY = physics.getPlayerPosition().y;
      const next = physics.movePlayerSafely(4, 0);
      expect(next.x).toBeLessThanOrEqual(1.31);
      expect(next.x).toBeGreaterThan(0.5);
      expect(next.y).toBe(beforeY);
      expect(physics.getPlayerVelocity()).toEqual(velocity);
      expect(physics.hasLineOfSight(4, 1, 0)).toBe(false);
      expect(physics.hasLineOfSight(0, 1, -4)).toBe(true);
    } finally { physics.dispose(); }
  });

  it("spawns the capsule at the requested position", async () => {
    const physics = await PhysicsWorld.create({ x: 1, y: 2, z: 3 });
    try {
      const position = physics.getPlayerPosition();
      expect(position.x).toBeCloseTo(1);
      expect(position.y).toBeCloseTo(2);
      expect(position.z).toBeCloseTo(3);
    } finally {
      physics.dispose();
    }
  });

  it("integrates gravity with decoupled fixed steps", async () => {
    const physics = await PhysicsWorld.create(SPAWN);
    try {
      physics.setPlayerVelocity(0, 0, 0);
      physics.step(0.25);
      expect(physics.getPlayerPosition().y).toBeLessThan(SPAWN.y);
    } finally {
      physics.dispose();
    }
  });

  it("rests on the floor instead of falling forever", async () => {
    const physics = await PhysicsWorld.create(SPAWN);
    try {
      physics.setPlayerVelocity(0, 0, 0);
      physics.step(1);
      const position = physics.getPlayerPosition();
      expect(position.y).toBeGreaterThan(0.3);
      expect(position.y).toBeLessThanOrEqual(SPAWN.y);
    } finally {
      physics.dispose();
    }
  });

  it("applies true rapier impulses for knockback", async () => {
    const physics = await PhysicsWorld.create(SPAWN);
    try {
      const before = physics.getPlayerVelocity();
      expect(before.x).toBeCloseTo(0);
      physics.applyPlayerImpulse(KNOCKBACK_IMPULSE, 0, 0);
      const after = physics.getPlayerVelocity();
      expect(after.x).toBeGreaterThan(before.x);
    } finally {
      physics.dispose();
    }
  });

  it("launches trampolines deterministically inside the tuned band", async () => {
    const physics = await PhysicsWorld.create(SPAWN);
    try {
      physics.setPlayerVelocity(1, -2, 0.5);
      physics.launchTrampoline();
      const velocity = physics.getPlayerVelocity();
      expect(velocity.y).toBeCloseTo(TRAMPOLINE_IMPULSE);
      expect(velocity.x).toBeCloseTo(1);
      expect(velocity.z).toBeCloseTo(0.5);
      // Owner directive 2026-09-20: 13.5 (+12.5%, extends the old 8-12 band
      // for easier tower landings — the band proof lives in Arena.test).
      expect(TRAMPOLINE_IMPULSE).toBe(13.5);
    } finally {
      physics.dispose();
    }
  });

  it("toggles slippery mode and adds static boxes without throwing", async () => {
    const physics = await PhysicsWorld.create(SPAWN);
    try {
      expect(() => physics.setSlippery(true)).not.toThrow();
      physics.step(1 / 60);
      expect(() => physics.setSlippery(false)).not.toThrow();
      physics.step(1 / 60);
      expect(() => physics.addStaticBox(1, 0.5, 1, 4, 0.5, 4)).not.toThrow();
      physics.step(1 / 60);
    } finally {
      physics.dispose();
    }
  });

  it("resets to spawn and refuses use after dispose", async () => {
    const physics = await PhysicsWorld.create(SPAWN);
    physics.setPlayerVelocity(5, 5, 5);
    physics.step(1 / 60);
    physics.reset(SPAWN);
    const position = physics.getPlayerPosition();
    expect(position.x).toBeCloseTo(SPAWN.x);
    expect(position.y).toBeCloseTo(SPAWN.y);
    expect(position.z).toBeCloseTo(SPAWN.z);
    const velocity = physics.getPlayerVelocity();
    expect(velocity.x).toBeCloseTo(0);
    expect(velocity.y).toBeCloseTo(0);
    expect(velocity.z).toBeCloseTo(0);
    physics.dispose();
    expect(() => physics.getPlayerPosition()).toThrow();
    expect(() => physics.step(1 / 60)).toThrow();
  });
});
