import * as THREE from "three";
import { afterEach, describe, expect, it } from "vitest";
import { getIceZones } from "../arena/Arena";
import type { NetPlayerSnapshot } from "../net/protocol";
import { SceneManager } from "./SceneManager";

const FRAME = 1 / 60;
const NO_MOVE = { x: 0, y: 0 };
const RUN = { x: 0, y: 1 };
const NO_LOOK = { dx: 0, dy: 0 };
const managers: SceneManager[] = [];

function player(overrides: Partial<NetPlayerSnapshot> = {}): NetPlayerSnapshot {
  return {
    sessionId: "self", nick: "Игрок", x: 0, y: 1.1, z: 0, rotY: 0,
    hp: 100, score: 0, alive: true, isBot: false, ready: true,
    spectator: false, superBuff: false, reloadUntil: 0, shieldHp: 0,
    shieldUntil: 0, speedUntil: 6000, chargeUntil: 0,
    pickupKind: "", pickupAt: 0, pickupSeq: 0, ...overrides,
  };
}

async function createRunner(): Promise<{ manager: SceneManager; wake: THREE.Object3D }> {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 200);
  const manager = new SceneManager(scene, camera);
  manager.build();
  managers.push(manager);
  expect(await manager.initPhysics()).toBe(true);
  manager.teleportSelf(0, 0);
  const wake = scene.getObjectByName("run-wind-trail");
  if (wake === undefined) throw new Error("speed wake missing");
  return { manager, wake };
}

function run(manager: SceneManager, frames = 20): void {
  for (let frame = 0; frame < frames; frame += 1) manager.update(FRAME, RUN, NO_LOOK);
}

afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
});

describe("local speed wake integration", () => {
  it("requires both a live speed bonus and running, and hides on input release or rotation", async () => {
    const { manager, wake } = await createRunner();
    run(manager);
    expect(wake.visible).toBe(false);
    manager.syncPowerUps(player(), 1000, []);
    run(manager);
    expect(wake.visible).toBe(true);
    manager.update(FRAME, NO_MOVE, NO_LOOK);
    expect(wake.visible).toBe(false);
    manager.setShotTurnTarget(Math.PI / 2);
    for (let frame = 0; frame < 20; frame += 1) manager.update(FRAME, NO_MOVE, NO_LOOK);
    expect(wake.visible).toBe(false);
    expect(manager.getPowerUpHudState().speedRemaining).toBeGreaterThan(0);
  });

  it("clears immediately at authoritative expiry, predicted expiry, death, spectating and reset", async () => {
    const { manager, wake } = await createRunner();
    manager.syncPowerUps(player(), 1000, []);
    run(manager);
    expect(wake.visible).toBe(true);
    manager.syncPowerUps(player(), 6000, []);
    expect(wake.visible).toBe(false);
    manager.syncPowerUps(player(), 5950, []);
    run(manager, 1);
    expect(wake.visible).toBe(true);
    run(manager, 4);
    expect(wake.visible).toBe(false);
    manager.syncPowerUps(player(), 1000, []);
    run(manager, 1);
    expect(wake.visible).toBe(true);
    manager.syncPowerUps(player({ alive: false }), 1000, []);
    expect(wake.visible).toBe(false);
    expect(manager.getPowerUpHudState().speedRemaining).toBe(0);
    manager.syncPowerUps(player(), 1000, []);
    run(manager, 1);
    manager.setSpectating(true);
    expect(wake.visible).toBe(false);
    manager.setSpectating(false);
    run(manager, 1);
    expect(wake.visible).toBe(true);
    manager.reset();
    expect(wake.visible).toBe(false);
  });

  it("hides during flight and passive ice coasting despite an active bonus", async () => {
    const { manager, wake } = await createRunner();
    manager.syncPowerUps(player(), 1000, []);
    manager.debugSetPlayerState({ x: 0, y: 8, z: 0 }, { x: 0, y: 10, z: 3 });
    run(manager, 1);
    expect(manager.isAirborne()).toBe(true);
    expect(wake.visible).toBe(false);
    const zone = getIceZones()[0];
    if (zone === undefined) throw new Error("ice zone missing");
    manager.teleportSelf(zone.x, zone.z, 1.1);
    manager.debugSetPlayerState({ x: zone.x, y: 1.1, z: zone.z }, { x: 3, y: 0, z: 0 });
    const before = manager.getAvatarPosition();
    manager.update(FRAME, NO_MOVE, NO_LOOK);
    expect(manager.getAvatarPosition().x).toBeGreaterThan(before.x);
    expect(wake.visible).toBe(false);
    expect(manager.getPowerUpHudState().speedRemaining).toBeGreaterThan(0);
  });
});
