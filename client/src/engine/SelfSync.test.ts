import * as THREE from "three";
import { afterEach, describe, expect, it } from "vitest";
import { SELF_RECONCILE_MIN_M, SELF_RECONCILE_SNAP_M } from "../config";
import { SceneManager } from "./SceneManager";

const FRAME = 1 / 60;

const managers: SceneManager[] = [];

async function createFighter(): Promise<SceneManager> {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 200);
  const manager = new SceneManager(scene, camera);
  manager.build();
  const ready = await manager.initPhysics();
  expect(ready).toBe(true);
  manager.setSpectating(false);
  managers.push(manager);
  return manager;
}

afterEach(() => {
  for (const manager of managers.splice(0, managers.length)) {
    manager.dispose();
  }
});

describe("self spawn teleport (welcome/respawn gap fix)", () => {
  it("teleports avatar + Rapier body to the server spawn", async () => {
    const manager = await createFighter();
    manager.teleportSelf(-12, 12);
    const avatar = manager.getAvatarPosition();
    expect(avatar.x).toBeCloseTo(-12, 5);
    expect(avatar.z).toBeCloseTo(12, 5);
    const body = manager.getPlayerVelocity();
    expect(body).not.toBe(null);
    // Velocity zeroed by the teleport (physics.reset path).
    if (body !== null) {
      expect(Math.hypot(body.x, body.z)).toBeCloseTo(0, 5);
    }
  });

  it("ignores non-finite coords instead of corrupting the body", async () => {
    const manager = await createFighter();
    manager.teleportSelf(3, 4);
    manager.teleportSelf(Number.NaN, 0);
    const avatar = manager.getAvatarPosition();
    expect(avatar.x).toBeCloseTo(3, 5);
    expect(avatar.z).toBeCloseTo(4, 5);
  });
});

describe("self reconciliation (bounded drift, no jitter)", () => {
  it("holds local position when drift is under the min band", async () => {
    const manager = await createFighter();
    manager.teleportSelf(0, 0);
    const before = manager.getAvatarPosition();
    const small = SELF_RECONCILE_MIN_M / 2;
    const result = manager.reconcileSelf(small, 0, FRAME);
    expect(result).toBe("ok");
    const after = manager.getAvatarPosition();
    expect(after.x).toBeCloseTo(before.x, 10);
    expect(after.z).toBeCloseTo(before.z, 10);
  });

  it("lerps partway toward mid-range drift (no snap, no jitter)", async () => {
    const manager = await createFighter();
    manager.teleportSelf(0, 0);
    const result = manager.reconcileSelf(2, 0, FRAME);
    expect(result).toBe("lerp");
    const after = manager.getAvatarPosition();
    expect(after.x).toBeGreaterThan(0);
    expect(after.x).toBeLessThan(2);
  });

  it("snaps far drift beyond the snap band (spawn/respawn scale)", async () => {
    const manager = await createFighter();
    manager.teleportSelf(0, 0);
    const far = SELF_RECONCILE_SNAP_M + 5;
    const result = manager.reconcileSelf(far, 0, FRAME);
    expect(result).toBe("snap");
    const after = manager.getAvatarPosition();
    expect(after.x).toBeCloseTo(far, 5);
    expect(after.z).toBeCloseTo(0, 5);
  });

  it("skips while spectating", async () => {
    const manager = await createFighter();
    manager.setSpectating(true);
    expect(manager.reconcileSelf(10, 10, FRAME)).toBe("skipped");
  });

  it("converges toward a legal server target near an obstacle (no pass-through)", async () => {
    // Through-wall fix regression pin: the server now only emits positions
    // outside geometry, so reconcile must ease onto a legal target — and the
    // reconcile path itself is untouched (deadband hold + lerp, no clip).
    // Note the honest contract: inside the 0.7m deadband reconcile HOLDS
    // (returns "ok", no jitter correction), so convergence stops at the
    // band edge, not exactly on the target.
    const manager = await createFighter();
    manager.teleportSelf(1.0, 4.8);
    for (let i = 0; i < 120; i += 1) {
      manager.reconcileSelf(2.5, 4.8, FRAME);
    }
    const after = manager.getAvatarPosition();
    // Eased from 1.0 to the deadband edge (~1.8), never past the target…
    expect(after.x).toBeGreaterThan(1.7);
    expect(after.x).toBeLessThanOrEqual(2.5);
    expect(after.z).toBeCloseTo(4.8, 5);
    // …and the eased path never ends embedded in the block (3.3 face).
    expect(after.x).toBeLessThanOrEqual(3.3 + 0.15);
  });

  it("does not fight a tower-top server position (bug 3a end state)", async () => {
    // The server now tracks tower-top XZ authoritatively (bugs 1/3a fix), so
    // when the local body stands at the tower center and the snapshot agrees,
    // reconcile holds inside the deadband instead of tugging the avatar off.
    const manager = await createFighter();
    manager.teleportSelf(4.8, 4.8);
    const result = manager.reconcileSelf(4.8, 4.8, FRAME);
    expect(result).toBe("ok");
    const after = manager.getAvatarPosition();
    expect(after.x).toBeCloseTo(4.8, 5);
    expect(after.z).toBeCloseTo(4.8, 5);
  });
});
