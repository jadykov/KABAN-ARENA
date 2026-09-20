import * as THREE from "three";
import { afterEach, describe, expect, it } from "vitest";
import {
  AIM_EXPO,
  AIM_PITCH_DAMP,
  AIM_PITCH_RATE,
  AIM_YAW_DAMP,
  AIM_YAW_RATE,
  CAMERA_PITCH_MAX,
  CAMERA_PITCH_MIN,
  FLOAT_DEADZONE,
  FLOAT_DRAG_RADIUS_PX,
} from "../config";
import { SceneManager } from "../engine/SceneManager";
import {
  mirrorChargeCameraPitch,
  pitchRateScale,
  shouldTrackAimFromCamera,
  unmirrorChargeCameraPitch,
  yawRateScale,
} from "./chargeAim";
import {
  shouldIdleFollow,
  type IdleFollowGate,
} from "./idleFollow";
import { applyExpo, buildFirePayload } from "./protocol";
import {
  TouchAimState,
  computeTouchAimVector,
  isAimDeflected,
  isRightHalf,
  type TouchDragPoint,
} from "./touchAim";

// Stage 4e mobile scheme (PUBG-style): right-half touch drag is free camera
// with NO charge; the FIRE button hold charges + aims. These tests drive the
// REAL TouchAimState router plus the REAL SceneManager/helpers that main.ts
// wires per frame (same tick-sim precedent as chargeTickSim.test.ts): boot()'s
// closure cannot be imported, so each sim replicates the exact main.ts sites
// and cites them. Where feasible the tests fail on pre-change semantics —
// pre-change, ANY right-half touch called startCharge (float path) and no
// camera-sync block existed, so "camera rotates while isCharging stays false"
// and "camDown ignored while charging" cannot pass on the old wiring.
const FRAME = 1 / 60;

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

function point(pointerId: number, x: number, y: number): TouchDragPoint {
  return { pointerId, x, y };
}

describe("isRightHalf (camera zone predicate)", () => {
  it("routes right-half touches to the camera, left-half to the move stick", () => {
    expect(isRightHalf(600, 800)).toBe(true);
    expect(isRightHalf(799, 800)).toBe(true);
    expect(isRightHalf(399, 800)).toBe(false);
    expect(isRightHalf(0, 800)).toBe(false);
  });

  it("is boundary-inclusive so a midline tap still rotates", () => {
    expect(isRightHalf(400, 800)).toBe(true);
  });

  it("rejects non-finite input (never routes garbage to the camera)", () => {
    expect(isRightHalf(Number.NaN, 800)).toBe(false);
    expect(isRightHalf(600, Number.NaN)).toBe(false);
  });
});

describe("computeTouchAimVector (drag math parity with the legacy float path)", () => {
  it("returns exact zero at the origin (no negative zero)", () => {
    expect(computeTouchAimVector(0, 0)).toEqual({ x: 0, y: 0 });
  });

  it("maps full-radius drags to unit vectors, screen-up means +y", () => {
    expect(FLOAT_DRAG_RADIUS_PX).toBe(80);
    expect(computeTouchAimVector(80, 0)).toEqual({ x: 1, y: 0 });
    expect(computeTouchAimVector(0, -80)).toEqual({ x: 0, y: 1 });
    expect(computeTouchAimVector(0, 80)).toEqual({ x: 0, y: -1 });
  });

  it("shapes partial drags with the shared expo", () => {
    expect(AIM_EXPO).toBe(1.4);
    const half = computeTouchAimVector(40, 0);
    expect(half.x).toBeCloseTo(applyExpo(0.5, AIM_EXPO), 12);
    expect(half.x).toBeCloseTo(0.3789, 4);
    expect(half.y).toBe(0);
  });

  it("clamps over-long drags to unit length (diagonal included)", () => {
    const far = computeTouchAimVector(800, 0);
    expect(far.x).toBeCloseTo(1, 12);
    expect(far.y).toBe(0);
    const diagonal = computeTouchAimVector(800, 800);
    expect(Math.hypot(diagonal.x, diagonal.y)).toBeLessThanOrEqual(1.0001);
    expect(diagonal.x).toBeCloseTo(applyExpo(Math.SQRT1_2, AIM_EXPO), 10);
    expect(diagonal.y).toBeCloseTo(applyExpo(-Math.SQRT1_2, AIM_EXPO), 10);
  });

  it("matches the legacy float formula sample-for-sample (identical feel)", () => {
    // Inline replication of the pre-4e main.ts float move math (radius
    // normalize, length clamp, expo, screen-up +y): the router must produce
    // bit-identical vectors so FIRE aim feels exactly like the old float aim.
    const legacy = (deltaX: number, deltaY: number): { x: number; y: number } => {
      const radius = FLOAT_DRAG_RADIUS_PX > 0 ? FLOAT_DRAG_RADIUS_PX : 80;
      let dx = deltaX / radius;
      let dy = deltaY / radius;
      const length = Math.hypot(dx, dy);
      if (length > 1) {
        dx /= length;
        dy /= length;
      }
      return { x: applyExpo(dx, AIM_EXPO), y: applyExpo(-dy, AIM_EXPO) };
    };
    const samples: Array<[number, number]> = [
      [0, 0],
      [10, -5],
      [40, 20],
      [-80, 40],
      [80, -80],
      [200, -150],
      [-3, 7],
    ];
    for (const [dx, dy] of samples) {
      const expected = legacy(dx, dy);
      const actual = computeTouchAimVector(dx, dy);
      expect(actual.x).toBeCloseTo(expected.x, 12);
      expect(actual.y).toBeCloseTo(expected.y, 12);
    }
  });

  it("maps non-finite drags to zero (call sites treat them as no aim)", () => {
    expect(computeTouchAimVector(Number.NaN, 0)).toEqual({ x: 0, y: 0 });
    expect(computeTouchAimVector(0, Number.POSITIVE_INFINITY)).toEqual({ x: 0, y: 0 });
  });
});

describe("isAimDeflected (per-frame drive threshold)", () => {
  it("pins the shared deadzone and its boundary", () => {
    expect(FLOAT_DEADZONE).toBe(0.05);
    expect(isAimDeflected(0.04, 0)).toBe(false);
    expect(isAimDeflected(0, 0)).toBe(false);
    expect(isAimDeflected(0.05, 0)).toBe(true);
    expect(isAimDeflected(0.03, 0.04)).toBe(true);
  });

  it("never deflects on non-finite input", () => {
    expect(isAimDeflected(Number.NaN, 0)).toBe(false);
    expect(isAimDeflected(1, Number.NaN)).toBe(false);
  });
});

describe("TouchAimState FIRE routing (charge + aim, slide-off keeps aiming)", () => {
  it("arms tracking on down with a zeroed vector", () => {
    const state = new TouchAimState();
    expect(state.fireDown(point(7, 700, 300))).toBe(true);
    expect(state.isFireActive()).toBe(true);
    expect(state.isFirePointer(7)).toBe(true);
    expect(state.isFirePointer(8)).toBe(false);
    expect(state.isFirePointer(null)).toBe(false);
    expect(state.fireVector()).toEqual({ x: 0, y: 0 });
  });

  it("ignores a second FIRE pointer while one is tracked (single-pointer guard)", () => {
    const state = new TouchAimState();
    expect(state.fireDown(point(7, 700, 300))).toBe(true);
    expect(state.fireDown(point(9, 710, 310))).toBe(false);
    // The first pointer still maps from its own origin, undisturbed.
    expect(state.fireMove(point(7, 780, 300))).toBe(true);
    expect(state.fireVector()).toEqual(computeTouchAimVector(80, 0));
  });

  it("keeps aiming when the thumb slides off the button (routing by id, never target)", () => {
    const state = new TouchAimState();
    state.fireDown(point(7, 700, 300));
    // Slide far off the 76px button — even onto the left half: no cancel
    // exists on this path (there is deliberately no fireLeave/pointerleave
    // API; main.ts registers no pointerleave listener — see grep proof).
    expect("fireLeave" in state).toBe(false);
    expect(state.fireMove(point(7, 100, 500))).toBe(true);
    expect(state.fireVector()).toEqual(computeTouchAimVector(-600, 200));
    expect(state.isFireActive()).toBe(true);
  });

  it("ignores moves from other fingers (multi-touch isolation)", () => {
    const state = new TouchAimState();
    state.fireDown(point(7, 700, 300));
    expect(state.fireMove(point(8, 780, 300))).toBe(false);
    expect(state.fireVector()).toEqual({ x: 0, y: 0 });
    expect(state.fireMove(point(7, 740, 300))).toBe(true);
    expect(state.fireMove(point(8, 780, 300))).toBe(false);
    expect(state.fireVector()).toEqual(computeTouchAimVector(40, 0));
  });

  it("release ends the hold with a zeroed vector (caller fires via stopCharge)", () => {
    const state = new TouchAimState();
    state.fireDown(point(7, 700, 300));
    state.fireMove(point(7, 780, 300));
    expect(isAimDeflected(state.fireVector().x, state.fireVector().y)).toBe(true);
    // Release anywhere (even off-element coords) ends the tracked hold; the
    // zero-first ordering lets stopCharge resolve from the mirrored camera.
    expect(state.fireUp(7)).toBe(true);
    expect(state.isFireActive()).toBe(false);
    expect(state.fireVector()).toEqual({ x: 0, y: 0 });
    expect(state.fireUp(7)).toBe(false);
  });

  it("rejects release for the wrong pointer, accepts the null-id convention", () => {
    const state = new TouchAimState();
    state.fireDown(point(7, 700, 300));
    expect(state.fireUp(8)).toBe(false);
    expect(state.isFireActive()).toBe(true);
    expect(state.fireUp(null)).toBe(true);
    expect(state.isFireActive()).toBe(false);
  });

  it("cancel drops the hold the same way (caller discards via cancelCharge)", () => {
    const state = new TouchAimState();
    state.fireDown(point(7, 700, 300));
    state.fireMove(point(7, 780, 300));
    expect(state.fireCancel(7)).toBe(true);
    expect(state.isFireActive()).toBe(false);
    expect(state.fireVector()).toEqual({ x: 0, y: 0 });
    expect(state.fireCancel(7)).toBe(false);
  });
});

describe("TouchAimState free-camera routing (look only, never charge)", () => {
  it("tracks a right-half drag with no charge side effect", () => {
    const state = new TouchAimState();
    // Mimics main.ts handleCamPointerDown tail: preventDefault + camDown and
    // NEVER startCharge. The test-owned charge flag proves the gesture cannot
    // start a charge (pre-change the float path always called startCharge).
    const charging = false;
    expect(state.camDown(point(3, 600, 400), charging)).toBe(true);
    expect(state.isCamActive()).toBe(true);
    expect(charging).toBe(false);
    expect(state.isFireActive()).toBe(false);
    expect(state.camVector()).toEqual({ x: 0, y: 0 });
  });

  it("refuses new drags while charging (second finger never swings aim)", () => {
    const state = new TouchAimState();
    expect(state.camDown(point(3, 600, 400), true)).toBe(false);
    expect(state.isCamActive()).toBe(false);
    expect(state.camMove(point(3, 680, 400))).toBe(false);
    expect(state.camVector()).toEqual({ x: 0, y: 0 });
  });

  it("ignores a second camera finger while one drags", () => {
    const state = new TouchAimState();
    expect(state.camDown(point(3, 600, 400), false)).toBe(true);
    expect(state.camDown(point(4, 650, 420), false)).toBe(false);
    expect(state.camMove(point(4, 730, 420))).toBe(false);
    expect(state.camMove(point(3, 680, 400))).toBe(true);
    expect(state.camVector()).toEqual(computeTouchAimVector(80, 0));
  });

  it("lift and cancel drop tracking with no charge calls", () => {
    const state = new TouchAimState();
    state.camDown(point(3, 600, 400), false);
    state.camMove(point(3, 680, 400));
    expect(state.camUp(4)).toBe(false);
    expect(state.isCamActive()).toBe(true);
    expect(state.camUp(3)).toBe(true);
    expect(state.isCamActive()).toBe(false);
    expect(state.camVector()).toEqual({ x: 0, y: 0 });
    state.camDown(point(3, 600, 400), false);
    expect(state.camCancel(3)).toBe(true);
    expect(state.isCamActive()).toBe(false);
    expect(state.camUp(3)).toBe(false);
  });

  it("clearCam drops an active drag on charge start (fresh touch after)", () => {
    const state = new TouchAimState();
    state.camDown(point(3, 600, 400), false);
    state.camMove(point(3, 680, 400));
    expect(isAimDeflected(state.camVector().x, state.camVector().y)).toBe(true);
    // Exact main.ts startCharge site: a successful charge start clears cam.
    state.clearCam();
    expect(state.isCamActive()).toBe(false);
    expect(state.camVector()).toEqual({ x: 0, y: 0 });
    expect(state.camMove(point(3, 700, 400))).toBe(false);
    // After the charge ends a fresh touch tracks again from its own origin.
    expect(state.camDown(point(3, 700, 400), false)).toBe(true);
    expect(state.camMove(point(3, 740, 400))).toBe(true);
    expect(state.camVector()).toEqual(computeTouchAimVector(40, 0));
  });

  it("reset drops both gestures and zeroes both vectors", () => {
    const state = new TouchAimState();
    state.fireDown(point(7, 700, 300));
    state.fireMove(point(7, 780, 300));
    state.camDown(point(3, 600, 400), false);
    state.camMove(point(3, 680, 400));
    state.reset();
    expect(state.isFireActive()).toBe(false);
    expect(state.isCamActive()).toBe(false);
    expect(state.fireVector()).toEqual({ x: 0, y: 0 });
    expect(state.camVector()).toEqual({ x: 0, y: 0 });
    // Vector references stay live across reset (per-frame loop holds them).
    const fireRef = state.fireVector();
    const camRef = state.camVector();
    state.fireDown(point(7, 700, 300));
    state.camDown(point(3, 600, 400), false);
    expect(state.fireVector()).toBe(fireRef);
    expect(state.camVector()).toBe(camRef);
  });
});

describe("free-camera tick sim (A1: right-half drag rotates, never charges)", () => {
  it("rotates aimYaw/aimPitch + camera at full rate with isCharging false", async () => {
    const manager = await createManager();
    manager.teleportSelf(0, 0);
    manager.setCameraAngles(0.5, 0.15);
    const state = new TouchAimState();
    // main.ts per-frame sites replicated in order: full non-charging rates
    // (pitchRateScale/yawRateScale return 1), cam integration, then the
    // camera takes aim directly (default band) — zero separate camera state.
    expect(yawRateScale(false)).toBe(1);
    expect(pitchRateScale(false)).toBe(1);
    // Const by design: nothing on the free-camera path may ever charge
    // (pre-change this gesture always called startCharge).
    const isCharging = false;
    let aimYaw = 0.5;
    let aimPitch = 0.15;
    // Right-half touch down + 40px right drag (no charge — pre-change this
    // gesture always called startCharge, so isCharging would be true there).
    expect(isRightHalf(600, 800)).toBe(true);
    expect(state.camDown(point(3, 600, 400), isCharging)).toBe(true);
    expect(state.camMove(point(3, 640, 400))).toBe(true);
    const drag = computeTouchAimVector(40, 0);
    expect(isAimDeflected(drag.x, drag.y)).toBe(true);
    const yawScale = yawRateScale(isCharging);
    const pitchScale = pitchRateScale(isCharging);
    for (let i = 0; i < 60; i += 1) {
      const camVector = state.camVector();
      if (Math.hypot(camVector.x, camVector.y) >= FLOAT_DEADZONE) {
        aimYaw -= camVector.x * AIM_YAW_RATE * yawScale * FRAME;
        const nextCamPitch = aimPitch + camVector.y * AIM_PITCH_RATE * pitchScale * FRAME;
        aimPitch = Math.max(CAMERA_PITCH_MIN, Math.min(CAMERA_PITCH_MAX, nextCamPitch));
        manager.setCameraAngles(aimYaw, aimPitch);
      }
      expect(isCharging).toBe(false);
    }
    const expectedYaw = 0.5 - drag.x * AIM_YAW_RATE * 1 * (60 * FRAME);
    expect(aimYaw).toBeCloseTo(expectedYaw, 10);
    expect(aimYaw).toBeLessThan(0.5);
    expect(manager.getCameraAngles().yaw).toBeCloseTo(aimYaw, 10);
    expect(manager.getCameraAngles().pitch).toBeCloseTo(aimPitch, 10);
    expect(aimPitch).toBeGreaterThanOrEqual(CAMERA_PITCH_MIN);
    expect(aimPitch).toBeLessThanOrEqual(CAMERA_PITCH_MAX);
  });

  it("idle gates treat the drag as look (follow/track never fight it)", async () => {
    const manager = await createManager();
    manager.teleportSelf(0, 0);
    const state = new TouchAimState();
    state.camDown(point(3, 600, 400), false);
    state.camMove(point(3, 680, 400));
    expect(isAimDeflected(state.camVector().x, state.camVector().y)).toBe(true);
    // Exact main.ts gate wiring: an active drag feeds camLook = 1 as lookDx/Dy.
    const camLook = state.isCamActive() ? 1 : 0;
    expect(camLook).toBe(1);
    const followGate: IdleFollowGate = {
      playing: true,
      charging: false,
      alive: true,
      lookDx: camLook,
      lookDy: camLook,
      moveX: 0,
      moveY: 0,
    };
    expect(shouldIdleFollow(followGate)).toBe(false);
    const camIdle =
      Math.abs(state.camVector().x) < 0.05 && Math.abs(state.camVector().y) < 0.05;
    expect(camIdle).toBe(false);
    // Exact main.ts track site (mouse float idle here): the drag forces the
    // floatIdle arg false, so the camera->aim copy must not run mid-drag.
    const floatIdle = true;
    expect(shouldTrackAimFromCamera(false, true, floatIdle && camIdle)).toBe(false);
    // Finger lifts: track resumes, and with the stick released and no look
    // input the follow gate stays shut too — no automatic catch-up by
    // design (the camera holds until the player moves or looks again).
    expect(state.camUp(3)).toBe(true);
    expect(state.isCamActive()).toBe(false);
    const afterLook = state.isCamActive() ? 1 : 0;
    expect(afterLook).toBe(0);
    const released: IdleFollowGate = {
      playing: true,
      charging: false,
      alive: true,
      lookDx: afterLook,
      lookDy: afterLook,
      moveX: 0,
      moveY: 0,
    };
    expect(shouldIdleFollow(released)).toBe(false);
    // Running forward re-opens the follow (the only automatic camera path).
    expect(shouldIdleFollow({ ...released, moveX: 0, moveY: 1 })).toBe(true);
    const camIdleAfter =
      Math.abs(state.camVector().x) < 0.05 && Math.abs(state.camVector().y) < 0.05;
    expect(shouldTrackAimFromCamera(false, true, floatIdle && camIdleAfter)).toBe(true);
  });
});

describe("FIRE-held aim tick sim (damped rates, identical to the old float feel)", () => {
  it("integrates at AIM_YAW_DAMP/AIM_PITCH_DAMP while charging", () => {
    expect(AIM_YAW_DAMP).toBe(0.6);
    expect(AIM_PITCH_DAMP).toBe(0.42);
    expect(yawRateScale(true)).toBe(AIM_YAW_DAMP);
    expect(pitchRateScale(true)).toBe(AIM_PITCH_DAMP);
    const state = new TouchAimState();
    state.fireDown(point(7, 700, 300));
    // Full-right drag (unit vector) held for one second of frames.
    state.fireMove(point(7, 780, 300));
    expect(state.fireVector()).toEqual({ x: 1, y: 0 });
    let aimYaw = 0.5;
    const yawScale = yawRateScale(true);
    for (let i = 0; i < 60; i += 1) {
      const fireVector = state.fireVector();
      if (Math.hypot(fireVector.x, fireVector.y) >= FLOAT_DEADZONE) {
        aimYaw -= fireVector.x * AIM_YAW_RATE * yawScale * FRAME;
      }
    }
    // Damped: exactly 0.6 of the full-rate sweep, matching the legacy float
    // path which ran the same scales (spec A8: identical feel).
    expect(aimYaw).toBeCloseTo(0.5 - AIM_YAW_RATE * AIM_YAW_DAMP * 1, 10);
    expect(aimYaw).toBeCloseTo(0.5 - 2.4 * 0.6, 10);
    expect(aimYaw).toBeGreaterThan(0.5 - AIM_YAW_RATE * 1);
  });

  it("release resolves from the mirrored camera to true aim (zero-first order)", async () => {
    const manager = await createManager();
    manager.teleportSelf(0, 0);
    const state = new TouchAimState();
    // Charge with true aim +0.3 (leveling disarmed, like the tick sim): the
    // per-frame mirror writes camera -0.3 every tick (main.ts charge block).
    const aimYaw = 0.5;
    const aimPitch = 0.3;
    state.fireDown(point(7, 700, 300));
    manager.setCameraAngles(
      aimYaw,
      mirrorChargeCameraPitch(aimPitch),
      -CAMERA_PITCH_MAX,
      CAMERA_PITCH_MAX,
    );
    expect(manager.getCameraAngles().pitch).toBeCloseTo(-0.3, 12);
    // FIRE pointerup: the router zeroes first, then stopCharge derives the
    // payload from the camera via the shared un-mirror (main.ts release site).
    expect(state.fireUp(7)).toBe(true);
    const releaseAngles = manager.getCameraAngles();
    const unmirrored = unmirrorChargeCameraPitch(releaseAngles.pitch);
    const resolved = Math.max(CAMERA_PITCH_MIN, Math.min(CAMERA_PITCH_MAX, unmirrored));
    expect(resolved).toBeCloseTo(0.3, 12);
    expect(buildFirePayload(0.9, aimYaw, resolved, false).pitch).toBeCloseTo(0.3, 12);
  });
});
