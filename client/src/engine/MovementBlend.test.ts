import * as THREE from "three";
import { afterEach, describe, expect, it } from "vitest";
import { getSlipperyZones } from "../arena/Arena";
import { ICE_SPEED_MULT, MOVE_SPEED } from "../config";
import { SceneManager } from "./SceneManager";

const FRAME = 1 / 60;
const NO_MOVE = { x: 0, y: 0 };
const NO_LOOK = { dx: 0, dy: 0 };

const managers: SceneManager[] = [];

async function createSceneManager(): Promise<SceneManager> {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 200);
  const manager = new SceneManager(scene, camera);
  manager.build();
  const ready = await manager.initPhysics();
  expect(ready).toBe(true);
  managers.push(manager);
  return manager;
}

afterEach(() => {
  for (const manager of managers.splice(0, managers.length)) {
    manager.dispose();
  }
});

function horizontalSpeed(manager: SceneManager): number {
  const velocity = manager.getPlayerVelocity();
  if (velocity === null) {
    throw new Error("physics not ready");
  }
  return Math.hypot(velocity.x, velocity.z);
}

// Sticky ice (owner 1A): blending steers toward a HALVED target on ice
// (MOVE * ICE_SPEED_MULT, 50% cut) at ICE_ACCEL, so coasting decays FAST
// instead of gliding for a full second — but never hard-zeroes in one
// frame (the old absolute-set bug) and stays escapable with steady input.
describe("SceneManager movement blending (ice/impulse regression)", () => {
  it("does not zero instantly but decays fast on ice with no input (sticky)", async () => {
    expect(ICE_SPEED_MULT).toBe(0.5);
    const manager = await createSceneManager();
    const zone = getSlipperyZones()[0];
    if (zone === undefined) {
      throw new Error("no slippery zone defined");
    }
    // Start inside the ice zone, clear of the far edge along +x.
    manager.debugSetPlayerState(
      { x: zone.x - 2, y: 1.1, z: zone.z },
      { x: 2.5, y: 0, z: 0 },
    );
    const start = manager.getAvatarPosition();
    manager.update(FRAME, NO_MOVE, NO_LOOK);
    // Old code: exactly 0 after one frame. Blended: barely decayed.
    expect(horizontalSpeed(manager)).toBeGreaterThan(2.0);
    for (let i = 1; i < 60; i += 1) {
      manager.update(FRAME, NO_MOVE, NO_LOOK);
    }
    // Sticky: blending toward the zero target at ICE_ACCEL + ice damping
    // grinds coasting to a fast stop (well under the old 0.5 glide floor).
    expect(horizontalSpeed(manager)).toBeLessThan(0.5);
    // ...but the pre-stop glide still carried the body (not stuck in place).
    expect(manager.getAvatarPosition().x - start.x).toBeGreaterThan(0.5);
  });

  it("caps steady-input speed on ice near 50% of ground speed (sticky)", async () => {
    expect(ICE_SPEED_MULT).toBeCloseTo(0.5, 10);
    const manager = await createSceneManager();
    const zone = getSlipperyZones()[0];
    if (zone === undefined) {
      throw new Error("no slippery zone defined");
    }
    // Full forward input held on ice: velocity settles near the halved
    // target (MOVE * 0.5), never the full ground speed.
    manager.debugSetPlayerState(
      { x: zone.x, y: 1.1, z: zone.z },
      { x: 0, y: 0, z: 0 },
    );
    const push = { x: 0, y: 1 };
    for (let i = 0; i < 120; i += 1) {
      manager.update(FRAME, push, NO_LOOK);
      // Re-pin to the zone center so the surface stays ice throughout.
      const pos = manager.getAvatarPosition();
      const vel = manager.getPlayerVelocity();
      if (vel !== null) {
        manager.debugSetPlayerState(
          { x: zone.x, y: pos.y, z: zone.z },
          { x: vel.x, y: vel.y, z: vel.z },
        );
      }
    }
    const iceSpeed = horizontalSpeed(manager);
    expect(iceSpeed).toBeGreaterThan(0.5);
    expect(iceSpeed).toBeLessThan(MOVE_SPEED * 0.75);
  });

  it("lets an impulse power-up carry the player >0.5m within 0.5s", async () => {
    const manager = await createSceneManager();
    manager.debugSetPlayerState({ x: 0, y: 1.1, z: 0 }, { x: 0, y: 0, z: 0 });
    const start = manager.getAvatarPosition();
    manager.grantPowerUp("impulse");
    for (let i = 0; i < 30; i += 1) {
      manager.update(FRAME, NO_MOVE, NO_LOOK);
    }
    const end = manager.getAvatarPosition();
    const displacement = Math.hypot(end.x - start.x, end.z - start.z);
    // Old code: the next update() wiped the horizontal kick (only the hop
    // remained), so displacement stayed ~0.
    expect(displacement).toBeGreaterThan(0.5);
  });
});
