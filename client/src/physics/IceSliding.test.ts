import { describe, expect, it } from "vitest";
import { KNOCKBACK_IMPULSE } from "../config";
import { PhysicsWorld } from "./World";

const SPAWN = { x: 0, y: 1.1, z: 0 };
const FRAME = 1 / 60;

// Physics-level proof for the Stage 3 ice/impulse criteria: with slippery
// mode forced (no input, no velocity overwrite) the body must keep sliding
// on ice for a full second, and a knockback impulse must carry it more than
// half a meter within half a second.
describe("PhysicsWorld ice sliding and impulse displacement", () => {
  it("keeps horizontal velocity for >=1s of step() on ice with no input", async () => {
    const physics = await PhysicsWorld.create(SPAWN);
    try {
      physics.setSlippery(true);
      physics.setPlayerVelocity(4, 0, 0);
      const startX = physics.getPlayerPosition().x;
      for (let i = 0; i < 60; i += 1) {
        physics.step(FRAME);
      }
      const velocity = physics.getPlayerVelocity();
      const speed = Math.hypot(velocity.x, velocity.z);
      // Damping near zero intent (config ICE_LINEAR_DAMPING): most of the
      // speed must survive the full second, not grind to a halt.
      expect(speed).toBeGreaterThan(1.0);
      // And the glide must actually carry the body (sliding, not crawling).
      expect(physics.getPlayerPosition().x - startX).toBeGreaterThan(1.0);
    } finally {
      physics.dispose();
    }
  });

  it("carries an impulse >0.5m within 0.5s with no input", async () => {
    const physics = await PhysicsWorld.create(SPAWN);
    try {
      physics.setSlippery(false);
      physics.setPlayerVelocity(0, 0, 0);
      physics.applyPlayerImpulse(KNOCKBACK_IMPULSE, 0, 0);
      const startX = physics.getPlayerPosition().x;
      for (let i = 0; i < 30; i += 1) {
        physics.step(FRAME);
      }
      expect(physics.getPlayerPosition().x - startX).toBeGreaterThan(0.5);
    } finally {
      physics.dispose();
    }
  });
});
