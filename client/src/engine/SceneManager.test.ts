import * as THREE from "three";
import { afterEach, describe, expect, it } from "vitest";
import {
  AIRBORNE_VY_THRESHOLD,
  ARENA_HALF_SIZE,
  AVATAR_CHARGE_OPACITY,
  CAMERA_CHARGE_DISTANCE,
  CAMERA_FOLLOW_DISTANCE,
  CAMERA_FOLLOW_HEIGHT,
  CAMERA_LOOK_AT_HEIGHT,
  CAMERA_PITCH_MAX,
  CAMERA_PITCH_MIN,
  CAMERA_REST_PITCH,
  CAMERA_SENSITIVITY,
  CAMERA_WALL_MARGIN,
  DEATH_BURST_COUNT,
  DEATH_BURST_ORANGE,
  DEATH_BURST_RED,
  DEATH_BURST_YELLOW,
  IDLE_FOLLOW_PITCH,
  RECOIL_FULL_M,
  WALL_FADE_OPACITY,
} from "../config";
import { mirrorChargeCameraPitch } from "../net/chargeAim";
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

describe("SceneManager post-shot body turn (owner fix round 2)", () => {
  it("arms on a real shot and eases the body toward the shot facing when stopped", async () => {
    const manager = await createManager();
    manager.teleportSelf(0, 0);
    expect(manager.getAvatarFacing()).toBeCloseTo(0, 10);
    expect(manager.isShotBodyTurnActive()).toBe(false);
    // Shot yaw 0 flies toward -Z: the body must turn to facing PI.
    manager.setShotTurnTarget(0);
    expect(manager.isShotBodyTurnActive()).toBe(true);
    // Converges fast: a PI flip is under 0.15 rad residual after ~0.3s.
    for (let i = 0; i < 18; i += 1) {
      manager.update(FRAME, NO_MOVE, NO_LOOK);
    }
    const mid = manager.getAvatarFacing();
    const wrapGap = (angle: number): number => {
      const twoPi = Math.PI * 2;
      let wrapped = angle % twoPi;
      if (wrapped > Math.PI) {
        wrapped -= twoPi;
      } else if (wrapped < -Math.PI) {
        wrapped += twoPi;
      }
      return wrapped;
    };
    expect(Math.abs(wrapGap(Math.PI - mid))).toBeLessThan(0.15);
    expect(manager.isShotBodyTurnActive()).toBe(true);
    // Settles exactly and deactivates (snap inside the DONE band).
    for (let i = 0; i < 120; i += 1) {
      manager.update(FRAME, NO_MOVE, NO_LOOK);
    }
    expect(manager.getAvatarFacing()).toBeCloseTo(Math.PI, 2);
    expect(manager.isShotBodyTurnActive()).toBe(false);
  });

  it("resumed movement cancels the turn and the movement writer owns yaw", async () => {
    const manager = await createManager();
    manager.teleportSelf(0, 0);
    manager.setShotTurnTarget(0);
    expect(manager.isShotBodyTurnActive()).toBe(true);
    // Camera yaw is 0, so pushing forward gives worldMove (0, 0, -1) and the
    // movement writer sets facing atan2(0, -1) = PI while killing the turn.
    manager.update(FRAME, { x: 0, y: 1 }, NO_LOOK);
    expect(manager.isShotBodyTurnActive()).toBe(false);
    expect(manager.getAvatarFacing()).toBeCloseTo(Math.PI, 5);
  });

  it("teleport / reset / spectate transitions cancel a pending turn", async () => {
    const manager = await createManager();
    manager.teleportSelf(0, 0);
    manager.setShotTurnTarget(0);
    expect(manager.isShotBodyTurnActive()).toBe(true);
    manager.teleportSelf(3, -2);
    expect(manager.isShotBodyTurnActive()).toBe(false);
    manager.setShotTurnTarget(0);
    expect(manager.isShotBodyTurnActive()).toBe(true);
    manager.reset();
    expect(manager.isShotBodyTurnActive()).toBe(false);
    manager.setShotTurnTarget(0);
    expect(manager.isShotBodyTurnActive()).toBe(true);
    manager.setSpectating(true);
    expect(manager.isShotBodyTurnActive()).toBe(false);
    manager.setSpectating(false);
  });

  it("explicit cancel drops the turn and non-finite yaw never arms it", async () => {
    const manager = await createManager();
    manager.teleportSelf(0, 0);
    manager.setShotTurnTarget(0);
    expect(manager.isShotBodyTurnActive()).toBe(true);
    manager.cancelShotBodyTurn();
    expect(manager.isShotBodyTurnActive()).toBe(false);
    manager.setShotTurnTarget(Number.NaN);
    expect(manager.isShotBodyTurnActive()).toBe(false);
  });
});

describe("SceneManager pitch clamp (post-playtest round 2: max 0.36)", () => {
  it("clamps setCameraAngles pitch to the shared CAMERA_PITCH_MAX", async () => {
    expect(CAMERA_PITCH_MAX).toBeCloseTo(0.36, 12);
    const manager = await createManager();
    manager.setCameraAngles(0, 1.0);
    expect(manager.getCameraAngles().pitch).toBeCloseTo(CAMERA_PITCH_MAX, 10);
    manager.setCameraAngles(0, -1.0);
    expect(manager.getCameraAngles().pitch).toBeCloseTo(CAMERA_PITCH_MIN, 10);
  });

  it("keeps the plain [-0.15, 0.36] band by default (non-charge look paths unchanged)", async () => {
    expect(CAMERA_PITCH_MIN).toBe(-0.15);
    const manager = await createManager();
    // Just below MIN still pins to MIN without an override — the mirror band
    // must never leak into normal look.
    manager.setCameraAngles(0, -0.2);
    expect(manager.getCameraAngles().pitch).toBeCloseTo(CAMERA_PITCH_MIN, 10);
  });

  it("accepts the symmetric mirror band only via the min/max override", async () => {
    const manager = await createManager();
    // Widest mirror (-0.36) survives with the explicit override ...
    manager.setCameraAngles(0, -CAMERA_PITCH_MAX, -CAMERA_PITCH_MAX, CAMERA_PITCH_MAX);
    expect(manager.getCameraAngles().pitch).toBeCloseTo(-CAMERA_PITCH_MAX, 10);
    // ... but the same value through the default path pins to MIN.
    manager.setCameraAngles(0, -CAMERA_PITCH_MAX);
    expect(manager.getCameraAngles().pitch).toBeCloseTo(CAMERA_PITCH_MIN, 10);
  });
});

describe("SceneManager resting pitch (fix round 3: 0.15 resting, 0.05 follow pitch)", () => {
  it("pins the resting constants above MIN", () => {
    expect(CAMERA_REST_PITCH).toBeCloseTo(0.15, 12);
    expect(IDLE_FOLLOW_PITCH).toBeCloseTo(0.05, 12);
    expect(CAMERA_PITCH_MIN).toBe(-0.15);
    expect(IDLE_FOLLOW_PITCH).toBeGreaterThan(CAMERA_PITCH_MIN);
    expect(CAMERA_REST_PITCH).toBeGreaterThan(CAMERA_PITCH_MIN);
  });

  it("spawns and resets at CAMERA_REST_PITCH", async () => {
    const manager = await createManager();
    expect(manager.getCameraAngles().pitch).toBeCloseTo(CAMERA_REST_PITCH, 10);
    manager.setCameraAngles(0.7, 0.3);
    expect(manager.getCameraAngles().pitch).toBeCloseTo(0.3, 10);
    manager.reset();
    expect(manager.getCameraAngles().pitch).toBeCloseTo(CAMERA_REST_PITCH, 10);
  });
});

describe("SceneManager aim-mirror camera (fix round 3, charge path)", () => {
  // Camera-behind convention (updateCameraTransform): camera sits at
  // avatar + (sin c, cos c)*d with y = avatar.y + 2.1 + sin(p)*d and looks
  // at avatar.y + (CAMERA_LOOK_AT_HEIGHT - 1.1). View pitch from the live
  // camera position to that look target.
  function viewPitchToAvatar(manager: SceneManager): number {
    const cam = manager.debugGetCameraPosition();
    const avatar = manager.getAvatarPosition();
    const lookY = avatar.y + (CAMERA_LOOK_AT_HEIGHT - 1.1);
    const horizontal = Math.hypot(cam.x - avatar.x, cam.z - avatar.z);
    return Math.atan2(lookY - cam.y, Math.max(0.0001, horizontal));
  }

  async function convergedAtChargeZoom(manager: SceneManager): Promise<void> {
    manager.teleportSelf(0, 0);
    manager.setChargeZoom01(1);
    for (let i = 0; i < 240; i += 1) {
      manager.update(FRAME, NO_MOVE, NO_LOOK);
    }
  }

  it("routes aim-up through the mirror: camera pitch goes NEGATIVE (drops)", async () => {
    const manager = await createManager();
    await convergedAtChargeZoom(manager);
    // The exact main.ts charge call shape: mirrored pitch + symmetric band.
    manager.setCameraAngles(
      0,
      mirrorChargeCameraPitch(0.3),
      -CAMERA_PITCH_MAX,
      CAMERA_PITCH_MAX,
    );
    expect(manager.getCameraAngles().pitch).toBeCloseTo(-0.3, 10);
    expect(manager.getCameraAngles().pitch).toBeLessThan(0);
  });

  it("tilts the view UP along the trajectory vs the direct copy (acceptance)", async () => {
    const manager = await createManager();
    await convergedAtChargeZoom(manager);
    for (let i = 0; i < 120; i += 1) {
      manager.setCameraAngles(
        0,
        mirrorChargeCameraPitch(0.3),
        -CAMERA_PITCH_MAX,
        CAMERA_PITCH_MAX,
      );
      manager.update(FRAME, NO_MOVE, NO_LOOK);
    }
    const mirroredView = viewPitchToAvatar(manager);
    // Control: the old direct-copy wiring at the same aim pitch.
    for (let i = 0; i < 120; i += 1) {
      manager.setCameraAngles(0, 0.3);
      manager.update(FRAME, NO_MOVE, NO_LOOK);
    }
    const directView = viewPitchToAvatar(manager);
    // Honest form of the acceptance: the camera lookAts the avatar, so the
    // absolute view pitch can never equal the aim pitch — but the mirror
    // must tilt the view UP relative to the direct copy (and to neutral),
    // by a substantial fraction of the aim deflection.
    expect(mirroredView).toBeGreaterThan(directView);
    expect(mirroredView - directView).toBeGreaterThan(0.3);
    for (let i = 0; i < 120; i += 1) {
      manager.setCameraAngles(0, 0);
      manager.update(FRAME, NO_MOVE, NO_LOOK);
    }
    expect(mirroredView).toBeGreaterThan(viewPitchToAvatar(manager));
  });

  it("stays above ground at the widest mirror (charge zoom 3.2m)", async () => {
    const manager = await createManager();
    await convergedAtChargeZoom(manager);
    // Widest mirror: full-up aim (MAX) -> camera pitch -MAX.
    for (let i = 0; i < 120; i += 1) {
      manager.setCameraAngles(
        0,
        mirrorChargeCameraPitch(CAMERA_PITCH_MAX),
        -CAMERA_PITCH_MAX,
        CAMERA_PITCH_MAX,
      );
      manager.update(FRAME, NO_MOVE, NO_LOOK);
    }
    const cam = manager.debugGetCameraPosition();
    const avatar = manager.getAvatarPosition();
    // camera y = avatar.y + 2.1 + sin(-0.36)*3.2 ~= avatar.y + 0.97.
    expect(cam.y - avatar.y).toBeCloseTo(
      CAMERA_FOLLOW_HEIGHT + Math.sin(-CAMERA_PITCH_MAX) * CAMERA_CHARGE_DISTANCE,
      1,
    );
    expect(cam.y).toBeGreaterThan(1.0);
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

describe("SceneManager aim clamp (F2 fix: stored aim always in-band)", () => {
  it("clamps setAimAngles pitch to [CAMERA_PITCH_MIN, CAMERA_PITCH_MAX]", async () => {
    const manager = await createManager();
    // A stale mirrored pitch must never lodge in the stored aim (it feeds
    // recoil/spark/muzzle math); the old unclamped setter kept it verbatim.
    manager.setAimAngles(0.5, -CAMERA_PITCH_MAX);
    expect(manager.debugGetAimAngles().pitch).toBeCloseTo(CAMERA_PITCH_MIN, 10);
    manager.setAimAngles(0.5, 0.5);
    expect(manager.debugGetAimAngles().pitch).toBeCloseTo(CAMERA_PITCH_MAX, 10);
    manager.setAimAngles(0.5, 0.2);
    expect(manager.debugGetAimAngles().pitch).toBeCloseTo(0.2, 10);
    expect(manager.debugGetAimAngles().yaw).toBeCloseTo(0.5, 10);
    // Non-finite input is ignored (previous aim survives).
    manager.setAimAngles(Number.NaN, Number.NaN);
    expect(manager.debugGetAimAngles().pitch).toBeCloseTo(0.2, 10);
    expect(manager.debugGetAimAngles().yaw).toBeCloseTo(0.5, 10);
  });
});

describe("SceneManager out-of-band RMB tolerance (F3 fix)", () => {
  it("an upward drag from the stale mirrored pitch glides back, never snaps", async () => {
    const manager = await createManager();
    manager.teleportSelf(0, 0);
    // Widest stale mirror, exactly as the charge path leaves it post-shot.
    manager.setCameraAngles(0, -CAMERA_PITCH_MAX, -CAMERA_PITCH_MAX, CAMERA_PITCH_MAX);
    expect(manager.getCameraAngles().pitch).toBeCloseTo(-CAMERA_PITCH_MAX, 10);
    // Honest guarantee: the clamp provides CONTINUITY (no clamp-induced
    // jump), so each frame moves by at most the input step |dy| * SENS —
    // never the 0.21 rad snap the plain clamp produced on frame one.
    const step = 10 * CAMERA_SENSITIVITY;
    expect(step).toBeLessThan(0.05);
    let previous = manager.getCameraAngles().pitch;
    for (let i = 0; i < 10; i += 1) {
      manager.update(FRAME, NO_MOVE, { dx: 0, dy: 10 });
      const pitch = manager.getCameraAngles().pitch;
      expect(pitch).toBeGreaterThan(previous);
      expect(pitch - previous).toBeLessThanOrEqual(step + 1e-9);
      expect(pitch - previous).toBeLessThan(0.05);
      previous = pitch;
    }
    // Still gliding monotonically — never jumped to the band edge.
    expect(previous).toBeGreaterThan(-CAMERA_PITCH_MAX);
  });

  it("a downward drag from out-of-band holds instead of escaping further", async () => {
    const manager = await createManager();
    manager.teleportSelf(0, 0);
    manager.setCameraAngles(0, -CAMERA_PITCH_MAX, -CAMERA_PITCH_MAX, CAMERA_PITCH_MAX);
    manager.update(FRAME, NO_MOVE, { dx: 0, dy: -10 });
    // The old plain clamp snapped this to CAMERA_PITCH_MIN in one frame;
    // the tolerant bound holds the pitch (lower bound = current).
    expect(manager.getCameraAngles().pitch).toBeCloseTo(-CAMERA_PITCH_MAX, 10);
  });

  it("in-band RMB drags behave exactly as before (sign/rate/band untouched)", async () => {
    expect(CAMERA_SENSITIVITY).toBeCloseTo(0.0045, 12);
    const manager = await createManager();
    manager.teleportSelf(0, 0);
    manager.setCameraAngles(0, 0);
    manager.update(FRAME, NO_MOVE, { dx: 0, dy: 10 });
    expect(manager.getCameraAngles().pitch).toBeCloseTo(10 * CAMERA_SENSITIVITY, 10);
    manager.update(FRAME, NO_MOVE, { dx: -20, dy: 0 });
    expect(manager.getCameraAngles().yaw).toBeCloseTo(20 * CAMERA_SENSITIVITY, 10);
  });
});
