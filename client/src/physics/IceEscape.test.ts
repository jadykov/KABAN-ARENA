import * as THREE from "three";
import { afterEach, describe, expect, it } from "vitest";
import { getSlipperyZones } from "../arena/Arena";
import { SLIPPERY_RADIUS } from "../config";
import { SceneManager } from "../engine/SceneManager";

const FRAME = 1 / 60;
const NO_LOOK = { dx: 0, dy: 0 };
const PUSH = { x: 1, y: 0 };

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

// Ice escape: starting from rest in the middle of a puddle, steady input
// must carry the body out of the slippery radius (blending redirects slowly
// on ice, but never traps the player).
describe("SceneManager ice escape (zero velocity + input leaves the puddle)", () => {
  it("escapes the puddle with steady input from rest", async () => {
    expect(SLIPPERY_RADIUS).toBeCloseTo(2.64, 10);
    const manager = await createSceneManager();
    const zone = getSlipperyZones()[0];
    if (zone === undefined) {
      throw new Error("no slippery zone defined");
    }
    manager.debugSetPlayerState(
      { x: zone.x, y: 1.1, z: zone.z },
      { x: 0, y: 0, z: 0 },
    );
    for (let i = 0; i < 600; i += 1) {
      manager.update(FRAME, PUSH, NO_LOOK);
    }
    const end = manager.getAvatarPosition();
    const dist = Math.hypot(end.x - zone.x, end.z - zone.z);
    expect(dist).toBeGreaterThan(SLIPPERY_RADIUS);
  });
});
