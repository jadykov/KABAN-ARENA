import * as THREE from "three";
import { afterEach, describe, expect, it } from "vitest";
import { getIceZones, getSpawnPoints, getSwampZones, isOnIce, isOnSwamp } from "../arena/Arena";
import { CHARGE_MOVE_MULT, ICE_INPUT_THRESHOLD, ICE_SPEED_MULT, KNOCKBACK_IMPULSE, MOVE_SPEED, SWAMP_SPEED_MULT } from "../config";
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

describe("SceneManager surface movement and impulse", () => {
  it("keeps swamp ripples moving while spectating", () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 200);
    const manager = new SceneManager(scene, camera);
    manager.build();
    managers.push(manager);
    const bubbles = scene.getObjectByName("swamp-bubbles") as THREE.InstancedMesh;
    expect(bubbles).toBeDefined();
    const before = new THREE.Matrix4();
    const after = new THREE.Matrix4();
    bubbles.getMatrixAt(0, before);
    manager.setSpectating(true);
    manager.update(0.25, NO_MOVE, NO_LOOK);
    bubbles.getMatrixAt(0, after);
    expect(after.elements).not.toEqual(before.elements);
  });

  it("coasts across ice after input release", async () => {
    expect(ICE_SPEED_MULT).toBe(0.65);
    const manager = await createSceneManager();
    const zone = getIceZones()[0];
    if (zone === undefined) {
      throw new Error("no ice zone defined");
    }
    manager.debugSetPlayerState(
      { x: zone.x - 1, y: 1.1, z: zone.z },
      { x: 2.5, y: 0, z: 0 },
    );
    const start = manager.getAvatarPosition();
    manager.update(FRAME, NO_MOVE, NO_LOOK);
    expect(horizontalSpeed(manager)).toBeGreaterThan(2.0);
    for (let i = 1; i < 12; i += 1) {
      manager.update(FRAME, NO_MOVE, NO_LOOK);
    }
    expect(horizontalSpeed(manager)).toBeGreaterThan(1.0);
    expect(manager.getAvatarPosition().x - start.x).toBeGreaterThan(0.3);
  });

  it("treats tiny joystick input as release on ice, while larger analog input still moves", async () => {
    const zone = getIceZones()[0];
    if (zone === undefined) throw new Error("missing ice zone");
    const released = await createSceneManager();
    const tiny = await createSceneManager();
    for (const manager of [released, tiny]) {
      manager.debugSetPlayerState(
        { x: zone.x - 1, y: 1.1, z: zone.z },
        { x: 2.5, y: 0, z: 0 },
      );
    }
    expect(ICE_INPUT_THRESHOLD).toBe(0.06);
    for (let i = 0; i < 12; i += 1) {
      released.update(FRAME, NO_MOVE, NO_LOOK);
      tiny.update(FRAME, { x: ICE_INPUT_THRESHOLD / 2, y: 0 }, NO_LOOK);
    }
    expect(Math.abs(horizontalSpeed(tiny) - horizontalSpeed(released))).toBeLessThan(0.02);
    expect(Math.abs(tiny.getAvatarPosition().x - released.getAvatarPosition().x)).toBeLessThan(0.02);
    expect(horizontalSpeed(tiny)).toBeGreaterThan(1.0);

    const analog = await createSceneManager();
    analog.debugSetPlayerState(
      { x: zone.x, y: 1.1, z: zone.z },
      { x: 0, y: 0, z: 0 },
    );
    for (let i = 0; i < 15; i += 1) {
      analog.update(FRAME, { x: ICE_INPUT_THRESHOLD * 1.5, y: 0 }, NO_LOOK);
    }
    expect(analog.getAvatarPosition().x - zone.x).toBeGreaterThan(0.02);
  });

  it("moves farther on ice than in swamp from rest at 0.25s and 0.5s", async () => {
    async function distances(zone: { x: number; z: number }): Promise<[number, number]> {
      const manager = await createSceneManager();
      manager.debugSetPlayerState(
        { x: zone.x, y: 1.1, z: zone.z },
        { x: 0, y: 0, z: 0 },
      );
      let atQuarter = 0;
      for (let i = 1; i <= 30; i += 1) {
        manager.update(FRAME, { x: 1, y: 0 }, NO_LOOK);
        if (i === 15) {
          const pos = manager.getAvatarPosition();
          atQuarter = Math.hypot(pos.x - zone.x, pos.z - zone.z);
        }
      }
      const pos = manager.getAvatarPosition();
      return [atQuarter, Math.hypot(pos.x - zone.x, pos.z - zone.z)];
    }
    const ice = getIceZones()[0];
    const swamp = getSwampZones()[0];
    if (ice === undefined || swamp === undefined) throw new Error("missing surface zone");
    const [iceQuarter, iceHalf] = await distances(ice);
    const [swampQuarter, swampHalf] = await distances(swamp);
    expect(iceQuarter).toBeGreaterThan(swampQuarter * 1.1);
    expect(iceHalf).toBeGreaterThan(swampHalf * 1.5);
  });

  it("keeps lateral momentum for several frames after reversing direction on ice", async () => {
    const manager = await createSceneManager();
    const zone = getIceZones()[0];
    if (zone === undefined) throw new Error("missing ice zone");
    manager.debugSetPlayerState(
      { x: zone.x, y: 1.1, z: zone.z },
      { x: 2.5, y: 0, z: 0 },
    );
    for (let i = 0; i < 3; i += 1) manager.update(FRAME, { x: -1, y: 0 }, NO_LOOK);
    expect(manager.getPlayerVelocity()?.x).toBeGreaterThan(1.0);
  });

  it("keeps sustained ice movement much faster than swamp", async () => {
    expect(ICE_SPEED_MULT).toBeCloseTo(0.65, 10);
    const manager = await createSceneManager();
    const zone = getIceZones()[0];
    if (zone === undefined) {
      throw new Error("no ice zone defined");
    }
    // Re-pin to stay on the surface while the velocity settles.
    manager.debugSetPlayerState(
      { x: zone.x, y: 1.1, z: zone.z },
      { x: 0, y: 0, z: 0 },
    );
    const push = { x: 0, y: 1 };
    for (let i = 0; i < 300; i += 1) {
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
    expect(iceSpeed).toBeGreaterThan(MOVE_SPEED * ICE_SPEED_MULT * 0.75);
    expect(iceSpeed).toBeLessThan(MOVE_SPEED * ICE_SPEED_MULT * 1.1);
  });

  it("erases inherited momentum immediately in swamp and keeps walking slow", async () => {
    expect(SWAMP_SPEED_MULT).toBe(0.22);
    const manager = await createSceneManager();
    const zone = getSwampZones()[0];
    if (zone === undefined) throw new Error("no swamp zone defined");
    manager.debugSetPlayerState(
      { x: zone.x, y: 1.1, z: zone.z },
      { x: 2.5, y: 0, z: 0 },
    );
    const start = manager.getAvatarPosition();
    manager.update(FRAME, NO_MOVE, NO_LOOK);
    expect(horizontalSpeed(manager)).toBeLessThan(0.05);
    expect(Math.abs(manager.getAvatarPosition().x - start.x)).toBeLessThan(0.05);
    for (let i = 0; i < 120; i += 1) {
      manager.update(FRAME, { x: 0, y: 1 }, NO_LOOK);
      const pos = manager.getAvatarPosition();
      const vel = manager.getPlayerVelocity();
      if (vel !== null) {
        manager.debugSetPlayerState({ x: zone.x, y: pos.y, z: zone.z }, vel);
      }
    }
    expect(horizontalSpeed(manager)).toBeGreaterThan(MOVE_SPEED * SWAMP_SPEED_MULT * 0.7);
    expect(horizontalSpeed(manager)).toBeLessThan(MOVE_SPEED * SWAMP_SPEED_MULT * 1.1);
  });

  it("ignores floor puddles while moving on raised ground", async () => {
    for (const zone of [getIceZones()[0], getSwampZones()[0]]) {
      if (zone === undefined) throw new Error("missing surface zone");
      const manager = await createSceneManager();
      manager.debugSetPlayerState(
        { x: zone.x, y: 5, z: zone.z },
        { x: MOVE_SPEED, y: 0, z: 0 },
      );
      for (let i = 0; i < 10; i += 1) manager.update(FRAME, { x: 1, y: 0 }, NO_LOOK);
      expect(horizontalSpeed(manager)).toBeGreaterThan(MOVE_SPEED * 0.85);
    }
  });

  it("preserves hit knockback momentum through the local steering blend", async () => {
    const manager = await createSceneManager();
    manager.debugSetPlayerState({ x: 0, y: 1.1, z: 0 }, { x: KNOCKBACK_IMPULSE, y: 0, z: 0 });
    const start = manager.getAvatarPosition();
    for (let i = 0; i < 12; i += 1) {
      manager.update(FRAME, NO_MOVE, NO_LOOK);
    }
    const end = manager.getAvatarPosition();
    const displacement = Math.hypot(end.x - start.x, end.z - start.z);
    expect(displacement).toBeGreaterThan(0.25);
  });

  it("halves local move speed while charging (server mirror, bug C)", async () => {
    // The server simulates charging fighters at CHARGE_MOVE_MULT; unscaled
    // client prediction diverged ~2.25 m/s during charge+walk and reconcile
    // tugged the preview origin every frame. Use a spawn on ordinary ground
    // because the saved map now has ice at (0,0). Re-pin each frame so the
    // surface never changes.
    expect(CHARGE_MOVE_MULT).toBe(0.5);
    const push = { x: 1, y: 0 };
    const ground = getSpawnPoints().find((spawn) =>
      !isOnIce(spawn.x, spawn.z) && !isOnSwamp(spawn.x, spawn.z),
    );
    if (ground === undefined) throw new Error("no spawn on ordinary ground");
    const { x: groundX, z: groundZ } = ground;
    async function settledSpeed(charging: boolean): Promise<number> {
      const manager = await createSceneManager();
      try {
        manager.setCharging(charging);
        manager.debugSetPlayerState(
          { x: groundX, y: 1.1, z: groundZ },
          { x: 0, y: 0, z: 0 },
        );
        for (let i = 0; i < 120; i += 1) {
          manager.update(FRAME, push, NO_LOOK);
          const pos = manager.getAvatarPosition();
          const vel = manager.getPlayerVelocity();
          if (vel !== null) {
            manager.debugSetPlayerState(
              { x: groundX, y: pos.y, z: groundZ },
              { x: vel.x, y: vel.y, z: vel.z },
            );
          }
        }
        return horizontalSpeed(manager);
      } finally {
        manager.dispose();
        const index = managers.indexOf(manager);
        if (index >= 0) {
          managers.splice(index, 1);
        }
      }
    }
    const free = await settledSpeed(false);
    expect(free).toBeGreaterThan(MOVE_SPEED * 0.9);
    const charged = await settledSpeed(true);
    expect(charged).toBeGreaterThan(MOVE_SPEED * CHARGE_MOVE_MULT * 0.9);
    expect(charged).toBeLessThan(MOVE_SPEED * CHARGE_MOVE_MULT * 1.1);
    expect(charged / free).toBeGreaterThan(0.4);
    expect(charged / free).toBeLessThan(0.6);
  });
});
