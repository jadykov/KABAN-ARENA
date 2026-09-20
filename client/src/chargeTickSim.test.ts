import * as THREE from "three";
import { afterEach, describe, expect, it } from "vitest";
import {
  CAMERA_PITCH_MAX,
  CAMERA_PITCH_MIN,
  FLOAT_DEADZONE,
  IDLE_FOLLOW_PITCH,
  IDLE_RECENTER_DELAY_S,
  RELOAD_MS,
} from "./config";
import { SceneManager } from "./engine/SceneManager";
import {
  beginChargeLevel,
  mirrorChargeCameraPitch,
  shouldTrackAimFromCamera,
  stepChargeLevel,
  unmirrorChargeCameraPitch,
  type ChargeLevel,
} from "./net/chargeAim";
import {
  shouldIdleFollow,
  shouldIdleRecenter,
  stepIdleRecenterPitch,
  stepIdleRecenterYaw,
  tolerantCameraPitchMin,
  type IdleFollowGate,
  type IdleRecenterGate,
} from "./net/idleFollow";
import { buildFirePayload } from "./net/protocol";

// Tick-simulation of the main.ts charge wiring (reviewer mandate, F1+F2+F3).
//
// Seam honesty: boot()'s closure (engine/input/net/DOM) cannot be unit-tested
// directly, so this file replicates the REAL per-frame ordering of the aim /
// camera section of engine.onUpdate (each step cites its main.ts site) using
// the REAL SceneManager plus the REAL helpers main.ts calls — no re-made
// easing, no copied clamp logic. If main.ts changes order or arguments, the
// comments here say exactly which site to re-check. The one deliberate
// simplification: sticks are (0,0) throughout (idle-aim flows under review),
// and idleTimerS is set explicitly instead of accumulated (accumulation is
// unit-covered by the shouldIdleRecenter gate tests).
const FRAME = 1 / 60;
const NO_MOVE = { x: 0, y: 0 };

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

// Boot-closure locals mirrored 1:1 (main.ts charge state).
interface ChargeSim {
  aimYaw: number;
  aimPitch: number;
  aimVector: { x: number; y: number };
  floatVector: { x: number; y: number };
  isCharging: boolean;
  chargeMirrored: boolean;
  chargeLevel: ChargeLevel;
}

function idleChargeSim(aimYaw: number, aimPitch: number): ChargeSim {
  return {
    aimYaw,
    aimPitch,
    aimVector: { x: 0, y: 0 },
    floatVector: { x: 0, y: 0 },
    isCharging: true,
    chargeMirrored: false,
    chargeLevel: beginChargeLevel(),
  };
}

// One charge tick in exact main.ts order:
// 1. stick/float integration (idle vectors below FLOAT_DEADZONE -> no-op);
// 2. idle-follow + idle-recenter gates (must stay shut while charging);
// 3. idle aim-track copy (F2: shouldTrackAimFromCamera -> skipped in charge);
// 4. charge block: one-shot level step + mirrored camera write + flag;
// 5. aim feed: setAimAngles.
function runChargeFrame(manager: SceneManager, sim: ChargeSim): void {
  const aimDeflected =
    Math.hypot(sim.aimVector.x, sim.aimVector.y) >= FLOAT_DEADZONE ||
    Math.hypot(sim.floatVector.x, sim.floatVector.y) >= FLOAT_DEADZONE;
  expect(aimDeflected).toBe(false);
  const followGate: IdleFollowGate = {
    playing: true,
    charging: sim.isCharging,
    alive: true,
    lookDx: 0,
    lookDy: 0,
    moveX: 0,
    moveY: 0,
  };
  expect(shouldIdleFollow(followGate)).toBe(false);
  const recenterGate: IdleRecenterGate = { ...followGate, idleTimerS: 0 };
  expect(shouldIdleRecenter(recenterGate)).toBe(false);
  const stickIdle = Math.abs(sim.aimVector.x) < 0.05 && Math.abs(sim.aimVector.y) < 0.05;
  const floatIdle = Math.abs(sim.floatVector.x) < 0.05 && Math.abs(sim.floatVector.y) < 0.05;
  if (shouldTrackAimFromCamera(sim.isCharging, stickIdle, floatIdle)) {
    const cam = manager.getCameraAngles();
    sim.aimYaw = cam.yaw;
    sim.aimPitch = cam.pitch;
  }
  if (sim.isCharging) {
    sim.aimPitch = stepChargeLevel(sim.chargeLevel, sim.aimPitch, false, FRAME);
    manager.setCameraAngles(
      sim.aimYaw,
      mirrorChargeCameraPitch(sim.aimPitch),
      -CAMERA_PITCH_MAX,
      CAMERA_PITCH_MAX,
    );
    sim.chargeMirrored = true;
  }
  manager.setAimAngles(sim.aimYaw, sim.aimPitch);
}

// Exact main.ts stopCharge release derivation (fire-time aim site): with both
// sticks idle the shot takes the release-moment camera, un-mirrored (F1),
// clamped to the aim band. Returns the fire payload pitch end-to-end.
function resolveReleasePayloadPitch(manager: SceneManager, sim: ChargeSim): number {
  const stickIdle = Math.abs(sim.aimVector.x) < 0.05 && Math.abs(sim.aimVector.y) < 0.05;
  const floatIdle = Math.abs(sim.floatVector.x) < 0.05 && Math.abs(sim.floatVector.y) < 0.05;
  if (stickIdle && floatIdle) {
    const releaseAngles = manager.getCameraAngles();
    sim.aimYaw = releaseAngles.yaw;
    const unmirrored = sim.chargeMirrored
      ? unmirrorChargeCameraPitch(releaseAngles.pitch)
      : releaseAngles.pitch;
    sim.aimPitch = Math.max(CAMERA_PITCH_MIN, Math.min(CAMERA_PITCH_MAX, unmirrored));
    sim.chargeMirrored = false;
  }
  return buildFirePayload(0.9, sim.aimYaw, sim.aimPitch, false).pitch;
}

describe("charge tick sim (F2: no oscillation with idle sticks)", () => {
  it("aimPitch stays exact and camera = mirror(aimPitch) over 120 frames", async () => {
    const manager = await createManager();
    manager.teleportSelf(0, 0);
    const sim = idleChargeSim(0.5, 0.3);
    // First deflection hands control back to the stick (main.ts charge
    // block): isolates the feedback loop from the accepted one-shot
    // horizon leveling, which would otherwise ease 0.3 toward 0 here.
    sim.aimPitch = stepChargeLevel(sim.chargeLevel, sim.aimPitch, true, FRAME);
    expect(sim.chargeLevel.active).toBe(false);
    for (let i = 0; i < 120; i += 1) {
      runChargeFrame(manager, sim);
      expect(sim.aimPitch).toBe(0.3);
      expect(sim.aimYaw).toBe(0.5);
      expect(manager.getCameraAngles().pitch).toBeCloseTo(-0.3, 12);
      expect(manager.getCameraAngles().yaw).toBeCloseTo(0.5, 12);
    }
    expect(sim.chargeMirrored).toBe(true);
  });

  it("documents the F2 mechanism: the pre-fix unconditional copy oscillates", () => {
    // Scalar model of the PRE-FIX ordering (copy-then-mirror every frame, no
    // gate) with the REAL mirror helper: proves this suite can see the bug —
    // the fixed wiring above settles, this one never does.
    let aim = 0.3;
    const seen = new Set<string>();
    for (let i = 0; i < 6; i += 1) {
      const camera = mirrorChargeCameraPitch(aim);
      aim = camera; // old unconditional track copy
      seen.add(aim.toFixed(12));
    }
    expect(seen.has((0.3).toFixed(12))).toBe(true);
    expect(seen.has((-0.3).toFixed(12))).toBe(true);
    expect(seen.size).toBe(2);
  });
});

describe("release tick sim (F1: payload pitch = true aim, sign correct)", () => {
  it("aim-up charge releases aim-up (not mirrored)", async () => {
    const manager = await createManager();
    manager.teleportSelf(0, 0);
    const sim = idleChargeSim(0.5, 0.3);
    sim.chargeLevel.active = false;
    for (let i = 0; i < 10; i += 1) {
      runChargeFrame(manager, sim);
    }
    expect(manager.getCameraAngles().pitch).toBeCloseTo(-0.3, 12);
    const payloadPitch = resolveReleasePayloadPitch(manager, sim);
    expect(payloadPitch).toBeCloseTo(0.3, 12);
    // The old raw copy produced the mirrored value end-to-end:
    expect(payloadPitch).not.toBeCloseTo(-0.3, 6);
  });

  it("aim-down charge releases aim-down, and float parity takes the same path", async () => {
    const manager = await createManager();
    manager.teleportSelf(0, 0);
    const sim = idleChargeSim(-1.2, -0.1);
    sim.chargeLevel.active = false;
    for (let i = 0; i < 10; i += 1) {
      runChargeFrame(manager, sim);
    }
    expect(manager.getCameraAngles().pitch).toBeCloseTo(0.1, 12);
    // Float LMB pointerup zeroes floatVector BEFORE stopCharge
    // (handleFloatPointerUp), so the float flow always lands on the same
    // idle derivation as Space keyup — replicate that ordering exactly.
    sim.floatVector = { x: 0, y: 0 };
    const payloadPitch = resolveReleasePayloadPitch(manager, sim);
    expect(payloadPitch).toBeCloseTo(-0.1, 12);
  });

  it("a charge with zero ticks copies plainly (camera never mirrored)", async () => {
    const manager = await createManager();
    manager.teleportSelf(0, 0);
    // Background-tab rAF stall: startCharge ran, no tick mirrored the
    // camera, release fires anyway. The plain copy is already true aim —
    // un-mirroring it would sign-flip a shot that was never mirrored.
    manager.setCameraAngles(0.2, 0.15);
    const sim = idleChargeSim(0.2, 0.15);
    sim.chargeMirrored = false;
    const payloadPitch = resolveReleasePayloadPitch(manager, sim);
    expect(payloadPitch).toBeCloseTo(0.15, 12);
  });
});

describe("post-shot tick sim (F3: smooth return to rest, no snap)", () => {
  it("eases from the mirrored value to 0.05 with per-frame steps <= 0.05 rad", async () => {
    const manager = await createManager();
    manager.teleportSelf(0, 0);
    // End of a full-up charge: the camera holds mirror(MAX) exactly as the
    // charge write leaves it post-shot (main.ts mirror site, symmetric band).
    manager.setCameraAngles(
      0.5,
      mirrorChargeCameraPitch(CAMERA_PITCH_MAX),
      -CAMERA_PITCH_MAX,
      CAMERA_PITCH_MAX,
    );
    expect(manager.getCameraAngles().pitch).toBeCloseTo(-CAMERA_PITCH_MAX, 12);
    // Stick released, past the recenter delay (main.ts accumulates idleTimerS
    // to IDLE_RECENTER_DELAY_S; the sim starts there — accumulation itself is
    // unit-covered by the shouldIdleRecenter gate tests).
    const gate: IdleRecenterGate = {
      playing: true,
      charging: false,
      alive: true,
      lookDx: 0,
      lookDy: 0,
      moveX: 0,
      moveY: 0,
      idleTimerS: IDLE_RECENTER_DELAY_S,
    };
    expect(shouldIdleRecenter(gate)).toBe(true);
    // Isolate pitch: the yaw target is the current yaw (no yaw motion).
    const targetYaw = manager.getCameraAngles().yaw;
    let previous = manager.getCameraAngles().pitch;
    let maxStep = 0;
    let pitch = previous;
    let frames = 0;
    for (; frames < 600; frames += 1) {
      const settled = manager.getCameraAngles();
      // Exact main.ts recenter site, including the F3 tolerant min override.
      manager.setCameraAngles(
        stepIdleRecenterYaw(settled.yaw, targetYaw, FRAME),
        stepIdleRecenterPitch(settled.pitch, FRAME),
        tolerantCameraPitchMin(settled.pitch),
        CAMERA_PITCH_MAX,
      );
      pitch = manager.getCameraAngles().pitch;
      maxStep = Math.max(maxStep, Math.abs(pitch - previous));
      // Exp ease from below: monotonic glide, never overshoots rest.
      expect(pitch).toBeGreaterThanOrEqual(previous - 1e-12);
      previous = pitch;
      if (Math.abs(pitch - IDLE_FOLLOW_PITCH) < 1e-4) {
        break;
      }
    }
    expect(frames).toBeLessThan(600);
    expect(pitch).toBeCloseTo(IDLE_FOLLOW_PITCH, 3);
    expect(maxStep).toBeLessThanOrEqual(0.05);
  });

  it("pins the F3 contrast: the plain clamp would snap frame one by 0.21 rad", () => {
    // One eased step from -0.36 moves UP continuously...
    const easedOnce = stepIdleRecenterPitch(-CAMERA_PITCH_MAX, FRAME);
    expect(easedOnce).toBeGreaterThan(-CAMERA_PITCH_MAX);
    // ...but the DEFAULT-band clamp (pre-fix wiring) pins it to MIN (-0.15):
    // a single-frame jump of ~0.21 rad (~12 deg). The sim above never does.
    expect(Math.max(CAMERA_PITCH_MIN, Math.min(CAMERA_PITCH_MAX, easedOnce))).toBeCloseTo(
      CAMERA_PITCH_MIN,
      12,
    );
    expect(CAMERA_PITCH_MIN - -CAMERA_PITCH_MAX).toBeGreaterThan(0.2);
  });
});

describe("welcome tick sim (F3 note: out-of-band normalization + respawn persistence)", () => {
  it("normalizes a stale mirrored pitch across the camera cut, then copies", async () => {
    const manager = await createManager();
    manager.teleportSelf(0, 0);
    manager.setCameraAngles(0.7, -CAMERA_PITCH_MAX, -CAMERA_PITCH_MAX, CAMERA_PITCH_MAX);
    // Exact main.ts onWelcome site: normalize into the default band first
    // (the hover->follow cut hides the step), then copy to aim.
    const angles = manager.getCameraAngles();
    manager.setCameraAngles(angles.yaw, angles.pitch);
    const normalized = manager.getCameraAngles();
    const aimYaw = normalized.yaw;
    const aimPitch = normalized.pitch;
    expect(normalized.pitch).toBeCloseTo(CAMERA_PITCH_MIN, 12);
    expect(aimPitch).toBeGreaterThanOrEqual(CAMERA_PITCH_MIN);
    expect(aimPitch).toBeLessThanOrEqual(CAMERA_PITCH_MAX);
    expect(aimYaw).toBeCloseTo(0.7, 12);
  });

  it("teleportSelf never touches the camera: mirrored pitch persists through respawn", async () => {
    const manager = await createManager();
    manager.teleportSelf(0, 0);
    manager.setCameraAngles(0.7, -CAMERA_PITCH_MAX, -CAMERA_PITCH_MAX, CAMERA_PITCH_MAX);
    // Authoritative placement (welcome spawn / respawn / snap) moves the
    // body only — the stale pitch survives and is eased back by the F3
    // recenter path (previous describe), never snapped.
    manager.teleportSelf(3, -2);
    expect(manager.getCameraAngles().pitch).toBeCloseTo(-CAMERA_PITCH_MAX, 12);
    expect(manager.getCameraAngles().yaw).toBeCloseTo(0.7, 12);
  });
});

describe("post-shot safety note (aim-track vs recenter ordering)", () => {
  it("stale tracking is safe because reload outlasts the recenter delay", async () => {
    // After the shot (not charging, sticks idle) the plain track copy runs
    // again, so the LOCAL aim follows the stale mirrored camera until the
    // recenter converges. Ordering pin: a new charge is impossible before
    // RELOAD_MS, while the recenter starts easing after IDLE_RECENTER_DELAY_S
    // — by reload end the camera (and the tracking aim) are back in-band.
    expect(RELOAD_MS).toBeGreaterThan(IDLE_RECENTER_DELAY_S * 1000);
    const manager = await createManager();
    manager.teleportSelf(0, 0);
    manager.setCameraAngles(
      0,
      mirrorChargeCameraPitch(CAMERA_PITCH_MAX),
      -CAMERA_PITCH_MAX,
      CAMERA_PITCH_MAX,
    );
    let aimPitch = CAMERA_PITCH_MAX; // pre-shot true aim, untouched by the shot
    // Phase 1 (0..0.8s): recenter gate shut; the track copy follows stale.
    for (let i = 0; i < 48; i += 1) {
      const gate: IdleRecenterGate = {
        playing: true,
        charging: false,
        alive: true,
        lookDx: 0,
        lookDy: 0,
        moveX: NO_MOVE.x,
        moveY: NO_MOVE.y,
        idleTimerS: i * FRAME,
      };
      expect(shouldIdleRecenter(gate)).toBe(false);
      if (shouldTrackAimFromCamera(false, true, true)) {
        aimPitch = manager.getCameraAngles().pitch;
      }
    }
    expect(aimPitch).toBeCloseTo(-CAMERA_PITCH_MAX, 12);
    // Protocol backstop even here: the stale value still sends in-band with
    // its sign kept (never a mirrored-then-fired shot).
    expect(buildFirePayload(1, 0, aimPitch, false).pitch).toBeCloseTo(CAMERA_PITCH_MIN, 12);
    // Phase 2 (0.8s..2.5s = reload end): recenter eases, aim keeps tracking.
    for (let i = 0; i < 150; i += 1) {
      const settled = manager.getCameraAngles();
      manager.setCameraAngles(
        stepIdleRecenterYaw(settled.yaw, settled.yaw, FRAME),
        stepIdleRecenterPitch(settled.pitch, FRAME),
        tolerantCameraPitchMin(settled.pitch),
        CAMERA_PITCH_MAX,
      );
      if (shouldTrackAimFromCamera(false, true, true)) {
        aimPitch = manager.getCameraAngles().pitch;
      }
    }
    const camPitch = manager.getCameraAngles().pitch;
    expect(camPitch).toBeGreaterThanOrEqual(CAMERA_PITCH_MIN);
    expect(aimPitch).toBeGreaterThanOrEqual(CAMERA_PITCH_MIN);
    expect(camPitch).toBeCloseTo(IDLE_FOLLOW_PITCH, 2);
  });
});
