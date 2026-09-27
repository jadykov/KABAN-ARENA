import * as THREE from "three";
import { afterEach, describe, expect, it } from "vitest";
import { getIceZones, isOnIce } from "../arena/Arena";
import { ICE_RADIUS, MOVE_SPEED } from "../config";
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

// Ice escape: after losing momentum inside a puddle, steady input must carry
// the body out; normal speed returns once the body crosses the edge.
describe("SceneManager ice escape", () => {
  it("escapes from a stop inside the puddle and regains ground speed outside", async () => {
    const manager = await createSceneManager();
    const zone = getIceZones()[0];
    if (zone === undefined) {
      throw new Error("no ice zone defined");
    }
    expect(ICE_RADIUS).toBe(zone.radius);
    manager.debugSetPlayerState(
      { x: zone.x, y: 1.1, z: zone.z },
      { x: 2.5, y: 0, z: 0 },
    );
    for (let i = 0; i < 120; i += 1) {
      manager.update(FRAME, { x: 0, y: 0 }, NO_LOOK);
    }
    const stopped = manager.getAvatarPosition();
    const stoppedVelocity = manager.getPlayerVelocity();
    expect(isOnIce(stopped.x, stopped.z)).toBe(true);
    expect(stoppedVelocity).not.toBeNull();
    expect(Math.hypot(stoppedVelocity?.x ?? 0, stoppedVelocity?.z ?? 0)).toBeLessThan(0.1);

    let exited = false;
    for (let i = 0; i < 360; i += 1) {
      manager.update(FRAME, PUSH, NO_LOOK);
      const position = manager.getAvatarPosition();
      if (!isOnIce(position.x, position.z)) {
        exited = true;
        break;
      }
    }
    expect(exited).toBe(true);
    for (let i = 0; i < 24; i += 1) {
      manager.update(FRAME, PUSH, NO_LOOK);
    }
    const velocity = manager.getPlayerVelocity();
    expect(velocity).not.toBeNull();
    expect(Math.hypot(velocity?.x ?? 0, velocity?.z ?? 0)).toBeGreaterThan(MOVE_SPEED * 0.7);
  });
});
