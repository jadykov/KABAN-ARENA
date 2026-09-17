import * as THREE from "three";
import { afterEach, describe, expect, it } from "vitest";
import {
  AIRBORNE_VY_THRESHOLD,
  ARENA_HALF_SIZE,
  AVATAR_CHARGE_OPACITY,
  CAMERA_CHARGE_DISTANCE,
  CAMERA_FOLLOW_DISTANCE,
  CAMERA_WALL_MARGIN,
  DEATH_BURST_COUNT,
  DEATH_BURST_ORANGE,
  DEATH_BURST_RED,
  DEATH_BURST_YELLOW,
  RECOIL_FULL_M,
  WALL_FADE_OPACITY,
} from "../config";
import { SceneManager } from "./SceneManager";

const FRAME = 1 / 60;
const NO_MOVE = { x: 0, y: 0 };
const NO_LOOK = { dx: 0, dy: 0 };

const managers: SceneManager[] = [];

async function createManager(): Promise<SceneManager> {
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

describe("SceneManager camera clamp + wall fade", () => {
  it("clamps the follow camera within HALF+MARGIN", async () => {
    const manager = await createManager();
    manager.teleportSelf(ARENA_HALF_SIZE, ARENA_HALF_SIZE);
    manager.update(FRAME, NO_MOVE, NO_LOOK);
    const camera = manager.debugGetCameraPosition();
    const limit = ARENA_HALF_SIZE + CAMERA_WALL_MARGIN;
    expect(Math.abs(camera.x)).toBeLessThanOrEqual(limit + 1e-6);
    expect(Math.abs(camera.z)).toBeLessThanOrEqual(limit + 1e-6);
  });

  it("fades walls to 0.25 when occluded, restores to 1 otherwise", async () => {
    expect(WALL_FADE_OPACITY).toBe(0.25);
    const manager = await createManager();
    // Open arena center: camera well inside, walls fully opaque.
    manager.teleportSelf(0, 0);
    manager.update(FRAME, NO_MOVE, NO_LOOK);
    expect(manager.getWallOpacity()).toBe(1);
    // Corner: the raw follow position sits past the wall line, so the
    // camera clamps and the walls fade to the occlusion opacity. The follow
    // camera eases toward its target (CAMERA_SMOOTH_RATE), so pump frames
    // until the smoothed position converges past the wall line first.
    manager.teleportSelf(ARENA_HALF_SIZE, ARENA_HALF_SIZE);
    for (let i = 0; i < 120; i += 1) {
      manager.update(FRAME, NO_MOVE, NO_LOOK);
    }
    expect(manager.getWallOpacity()).toBeCloseTo(WALL_FADE_OPACITY, 10);
  });
});

describe("SceneManager death burst (30, palette 10/30/60)", () => {
  it("spawns 30 pooled particles with the white/pale-violet/muted-red split", async () => {
    expect(DEATH_BURST_COUNT).toBe(30);
    expect(DEATH_BURST_YELLOW).toBe(0xf5f0ff);
    expect(DEATH_BURST_ORANGE).toBe(0xb9a3e6);
    expect(DEATH_BURST_RED).toBe(0xa8434e);
    // 10% white / 30% pale violet / 60% muted red of the 30-burst.
    expect(Math.round(DEATH_BURST_COUNT * 0.1)).toBe(3);
    expect(Math.round(DEATH_BURST_COUNT * 0.3)).toBe(9);
    expect(DEATH_BURST_COUNT - 3 - 9).toBe(18);
    const manager = await createManager();
    expect(manager.getAliveParticleCount()).toBe(0);
    manager.spawnDeathBurst(0, 1.2, 0);
    expect(manager.getAliveParticleCount()).toBe(30);
  });
});

describe("SceneManager recoil kick (opposite fire dir, clamped)", () => {
  it("nudges the avatar opposite the fire dir by the full 0.8m", async () => {
    expect(RECOIL_FULL_M).toBe(0.8);
    const manager = await createManager();
    manager.teleportSelf(0, 0);
    // yaw 0 fires toward -Z, so the kick must push +Z with x unchanged.
    manager.setAimAngles(0, 0.25);
    manager.applyRecoilKick(1.0);
    const after = manager.getAvatarPosition();
    expect(after.x).toBeCloseTo(0, 5);
    expect(after.z).toBeCloseTo(RECOIL_FULL_M, 4);
  });

  it("clamps the kick to the arena bounds", async () => {
    const manager = await createManager();
    manager.teleportSelf(ARENA_HALF_SIZE, ARENA_HALF_SIZE);
    manager.setAimAngles(0, 0.25);
    manager.applyRecoilKick(1.0);
    const after = manager.getAvatarPosition();
    expect(after.x).toBeLessThanOrEqual(ARENA_HALF_SIZE + 1e-6);
    expect(after.z).toBeLessThanOrEqual(ARENA_HALF_SIZE + 1e-6);
  });
});

describe("SceneManager charge zoom (4m default, ~3.2m held until shot)", () => {
  it("defaults to 4m, eases to ~3.2m at full charge, back to 4m after", async () => {
    expect(CAMERA_FOLLOW_DISTANCE).toBe(4);
    expect(CAMERA_CHARGE_DISTANCE).toBe(3.2);
    const manager = await createManager();
    expect(manager.getCameraDistance()).toBe(4);
    manager.setChargeZoom01(1);
    for (let i = 0; i < 240; i += 1) {
      manager.update(FRAME, NO_MOVE, NO_LOOK);
    }
    expect(manager.getCameraDistance()).toBeCloseTo(CAMERA_CHARGE_DISTANCE, 2);
    // Held until the shot: aim/camera moves mid-charge never reset it.
    manager.setCameraAngles(1.2, 0.4);
    manager.update(FRAME, NO_MOVE, NO_LOOK);
    expect(manager.getCameraDistance()).toBeCloseTo(CAMERA_CHARGE_DISTANCE, 2);
    // After the actual shot (or cancel) it eases back to default.
    manager.setChargeZoom01(0);
    for (let i = 0; i < 240; i += 1) {
      manager.update(FRAME, NO_MOVE, NO_LOOK);
    }
    expect(manager.getCameraDistance()).toBeCloseTo(CAMERA_FOLLOW_DISTANCE, 2);
  });
});

describe("SceneManager charge translucency (local avatar only)", () => {  it("fades body + hand ball to ~0.3 while active, restores to 1 after", async () => {
    expect(AVATAR_CHARGE_OPACITY).toBe(0.3);
    const manager = await createManager();
    expect(manager.getAvatarOpacity()).toBe(1);
    expect(manager.getHandBallOpacity()).toBe(1);
    manager.setChargeTranslucent(true);
    expect(manager.getAvatarOpacity()).toBeCloseTo(AVATAR_CHARGE_OPACITY, 10);
    expect(manager.getHandBallOpacity()).toBeCloseTo(AVATAR_CHARGE_OPACITY, 10);
    manager.setChargeTranslucent(false);
    expect(manager.getAvatarOpacity()).toBe(1);
    expect(manager.getHandBallOpacity()).toBe(1);
  });

  it("keeps hit-flash emissive working while translucent", async () => {
    const manager = await createManager();
    manager.setChargeTranslucent(true);
    manager.applyTestHit();
    manager.update(FRAME, NO_MOVE, NO_LOOK);
    // Flash writes emissiveIntensity — independent of the opacity fade.
    expect(manager.debugGetAvatarEmissive()).toBeGreaterThan(0);
    expect(manager.getAvatarOpacity()).toBeCloseTo(AVATAR_CHARGE_OPACITY, 10);
    manager.setChargeTranslucent(false);
    expect(manager.getAvatarOpacity()).toBe(1);
  });
});

describe("SceneManager airborne flight gate (glide, no bounce mid-air)", () => {
  it("flags airborne from physics vertical speed, clears at rest", async () => {
    expect(AIRBORNE_VY_THRESHOLD).toBe(2.0);
    const manager = await createManager();
    expect(manager.isAirborne()).toBe(false);
    // Rising fast (trampoline-class vy): airborne from the next tick.
    manager.debugSetPlayerState({ x: 0, y: 3, z: 0 }, { x: 0, y: 5, z: 0 });
    manager.update(FRAME, NO_MOVE, NO_LOOK);
    expect(manager.isAirborne()).toBe(true);
    // Back to rest on the ground: the exit hold keeps the flag briefly,
    // then sustained rest clears it (no apex-style flutter on landing).
    // ~30 frames: the 0.1m spawn drop + Rapier settle consume the first
    // ~8, the 0.25s hold needs 15 more (probe-verified, gate code untouched).
    manager.debugSetPlayerState({ x: 0, y: 1.1, z: 0 }, { x: 0, y: 0, z: 0 });
    manager.update(FRAME, NO_MOVE, NO_LOOK);
    expect(manager.isAirborne()).toBe(true);
    for (let i = 0; i < 30; i += 1) {
      manager.update(FRAME, NO_MOVE, NO_LOOK);
    }
    expect(manager.isAirborne()).toBe(false);
  });

  it("a trampoline launch trips the gate naturally", async () => {
    const manager = await createManager();
    // Pad at (0, 4.2): teleporting over it auto-launches (vy = 10).
    manager.teleportSelf(0, 4.2);
    expect(manager.isAirborne()).toBe(false);
    // The gate reads post-step velocity but the launch fires after the
    // measurement, so the flag trips on the second tick — honest ordering,
    // one frame of lag, then solidly airborne.
    manager.update(FRAME, NO_MOVE, NO_LOOK);
    manager.update(FRAME, NO_MOVE, NO_LOOK);
    expect(manager.isAirborne()).toBe(true);
  });
});
