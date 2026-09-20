import { describe, expect, it } from "vitest";
import {
  CAMERA_PITCH_MAX,
  CAMERA_PITCH_MIN,
  IDLE_FOLLOW_MAX_STICK_ANGLE,
  IDLE_FOLLOW_MOVE_MIN,
  IDLE_FOLLOW_PITCH,
  IDLE_FOLLOW_RATE,
  IDLE_RECENTER_DELAY_S,
  IDLE_RECENTER_MOVE_MAX,
  IDLE_RECENTER_RATE_S,
} from "../config";
import {
  cameraYawBehindFacing,
  forwardnessRateScale,
  shouldIdleFollow,
  shouldIdleRecenter,
  stepIdleFollowPitch,
  stepIdleFollowYaw,
  stepIdleRecenterPitch,
  stepIdleRecenterYaw,
  stickAngleFromForward,
  tolerantCameraPitchMin,
  type IdleRecenterGate,
} from "./idleFollow";
import { worldMoveFromYaw } from "./protocol";

const FRAME = 1 / 60;

function wrapPi(angle: number): number {
  const twoPi = Math.PI * 2;
  let wrapped = angle % twoPi;
  if (wrapped > Math.PI) {
    wrapped -= twoPi;
  } else if (wrapped < -Math.PI) {
    wrapped += twoPi;
  }
  return wrapped;
}

function idleGate(): Parameters<typeof shouldIdleFollow>[0] {
  return { playing: true, charging: false, alive: true, lookDx: 0, lookDy: 0, moveX: 0, moveY: 1 };
}

function recenterGate(): IdleRecenterGate {
  return {
    playing: true,
    charging: false,
    alive: true,
    lookDx: 0,
    lookDy: 0,
    moveX: 0,
    moveY: 0,
    idleTimerS: IDLE_RECENTER_DELAY_S,
  };
}

describe("idle soft-follow gate (4d.2-fix2)", () => {
  it("runs when idle and moving, stops while charging or on look input", () => {
    expect(shouldIdleFollow(idleGate())).toBe(true);
    expect(shouldIdleFollow({ ...idleGate(), charging: true })).toBe(false);
    expect(shouldIdleFollow({ ...idleGate(), lookDx: 5 })).toBe(false);
    expect(shouldIdleFollow({ ...idleGate(), lookDy: -3 })).toBe(false);
  });

  it("stays off when not playing, dead, or standing still", () => {
    expect(shouldIdleFollow({ ...idleGate(), playing: false })).toBe(false);
    expect(shouldIdleFollow({ ...idleGate(), alive: false })).toBe(false);
    expect(shouldIdleFollow({ ...idleGate(), moveX: 0, moveY: 0 })).toBe(false);
    // Below the move threshold: stick at rest must not drag the camera.
    expect(
      shouldIdleFollow({ ...idleGate(), moveX: IDLE_FOLLOW_MOVE_MIN / 2, moveY: 0 }),
    ).toBe(false);
    expect(
      shouldIdleFollow({ ...idleGate(), moveX: 0, moveY: IDLE_FOLLOW_MOVE_MIN }),
    ).toBe(true);
  });

  it("rejects non-finite move input", () => {
    expect(shouldIdleFollow({ ...idleGate(), moveX: Number.NaN })).toBe(false);
    expect(shouldIdleFollow({ ...idleGate(), moveY: Number.POSITIVE_INFINITY })).toBe(false);
  });
});

describe("idle soft-follow stick-forwardness gate (round-2 FAIL #1)", () => {
  it("reports the stick angle from forward: 0 forward, PI/2 strafe, PI backpedal", () => {
    expect(stickAngleFromForward(0, 1)).toBeCloseTo(0, 12);
    expect(stickAngleFromForward(1, 0)).toBeCloseTo(Math.PI / 2, 12);
    expect(stickAngleFromForward(-1, 0)).toBeCloseTo(Math.PI / 2, 12);
    expect(stickAngleFromForward(0, -1)).toBeCloseTo(Math.PI, 12);
    expect(stickAngleFromForward(Math.sin(0.2), Math.cos(0.2))).toBeCloseTo(0.2, 12);
    expect(stickAngleFromForward(Number.NaN, 1)).toBeNaN();
    expect(stickAngleFromForward(0, Number.POSITIVE_INFINITY)).toBeNaN();
  });

  it("rejects backpedal and strafe, accepts forward diagonals in the widened gate", () => {
    // Backpedal (S): phi = PI.
    expect(shouldIdleFollow({ ...idleGate(), moveX: 0, moveY: -1 })).toBe(false);
    // Strafe (A/D): phi = +/-PI/2.
    expect(shouldIdleFollow({ ...idleGate(), moveX: 1, moveY: 0 })).toBe(false);
    expect(shouldIdleFollow({ ...idleGate(), moveX: -1, moveY: 0 })).toBe(false);
    // S+A backpedal diagonal: |phi| = 3PI/4 > gate.
    expect(shouldIdleFollow({ ...idleGate(), moveX: 1, moveY: -1 })).toBe(false);
    // W+A / W+D forward diagonals (Option A, 0.8 rad gate): |phi| = PI/4.
    expect(shouldIdleFollow({ ...idleGate(), moveX: 1, moveY: 1 })).toBe(true);
    expect(shouldIdleFollow({ ...idleGate(), moveX: -1, moveY: 1 })).toBe(true);
    // Near-forward runs inside the gate still follow.
    expect(shouldIdleFollow({ ...idleGate(), moveX: 0, moveY: 1 })).toBe(true);
    expect(
      shouldIdleFollow({ ...idleGate(), moveX: Math.sin(0.2), moveY: Math.cos(0.2) }),
    ).toBe(true);
  });

  it("gate boundary: just above MAX stays off, just below follows", () => {
    const above = IDLE_FOLLOW_MAX_STICK_ANGLE + 0.02;
    const below = IDLE_FOLLOW_MAX_STICK_ANGLE - 0.02;
    expect(
      shouldIdleFollow({ ...idleGate(), moveX: Math.sin(above), moveY: Math.cos(above) }),
    ).toBe(false);
    expect(
      shouldIdleFollow({ ...idleGate(), moveX: Math.sin(below), moveY: Math.cos(below) }),
    ).toBe(true);
    expect(
      shouldIdleFollow({ ...idleGate(), moveX: -Math.sin(above), moveY: Math.cos(above) }),
    ).toBe(false);
    expect(
      shouldIdleFollow({ ...idleGate(), moveX: -Math.sin(below), moveY: Math.cos(below) }),
    ).toBe(true);
  });
});

describe("parameterized live-loop model (round-2 FAIL #2)", () => {
  // Exact SceneManager.update generative formulas (re-derived from the
  // shipped code): forward = (-sin c, -cos c), right = (cos c, -sin c),
  // worldMove = my*fwd(c) + mx*right(c), rotY = atan2(worldMove.x,
  // worldMove.z). Identical to the shared worldMoveFromYaw helper up to its
  // length normalization (direction-preserving, so rotY agrees exactly).
  function facingFromStick(camYaw: number, moveX: number, moveY: number): number {
    const worldX = -Math.sin(camYaw) * moveY + Math.cos(camYaw) * moveX;
    const worldZ = -Math.cos(camYaw) * moveY - Math.sin(camYaw) * moveX;
    return Math.atan2(worldX, worldZ);
  }

  // Full per-frame wiring: main.ts idle-follow block (gate -> ease behind
  // facing) feeding SceneManager.update (facing recomputed from the
  // just-followed yaw). Returns yaw travel accumulated over the run.
  function runGatedLoop(moveX: number, moveY: number, frames = 240, startYaw = 0.5): number {
    let yaw = startYaw;
    let travel = 0;
    for (let i = 0; i < frames; i += 1) {
      if (shouldIdleFollow({ ...idleGate(), moveX, moveY })) {
        const next = stepIdleFollowYaw(yaw, cameraYawBehindFacing(facingFromStick(yaw, moveX, moveY)), FRAME);
        travel += Math.abs(next - yaw);
        yaw = next;
      }
    }
    return travel;
  }

  it("loop model matches the shared worldMoveFromYaw formula", () => {
    const sticks: Array<[number, number]> = [
      [0, 1],
      [0, -1],
      [1, 0],
      [-1, 0],
      [0.5, 0.5],
      [Math.sin(0.2), Math.cos(0.2)],
    ];
    for (const [mx, my] of sticks) {
      for (const yaw of [0, 0.5, -2.1, Math.PI - 0.05]) {
        const payload = worldMoveFromYaw(mx, my, yaw);
        const modelX = -Math.sin(yaw) * my + Math.cos(yaw) * mx;
        const modelZ = -Math.cos(yaw) * my - Math.sin(yaw) * mx;
        // Direction-preserving normalization only: rotY must agree exactly.
        expect(Math.atan2(payload.x, payload.y)).toBeCloseTo(Math.atan2(modelX, modelZ), 12);
      }
    }
  });

  it("backpedal (phi=PI) produces zero yaw travel under the gate", () => {
    expect(runGatedLoop(0, -1)).toBe(0);
  });

  it("strafe (phi=+/-PI/2) produces zero yaw travel under the gate", () => {
    expect(runGatedLoop(1, 0)).toBe(0);
    expect(runGatedLoop(-1, 0)).toBe(0);
  });

  it("forward diagonals (|phi| = PI/4 <= gate) now follow with cos-scaled bounded travel", () => {
    // Mirrors the main.ts wiring: gate -> yaw ease at
    // IDLE_FOLLOW_RATE * forwardnessRateScale(phi) behind the live facing.
    for (const [mx, my] of [
      [1, 1],
      [-1, 1],
    ] as Array<[number, number]>) {
      const phi = Math.PI / 4;
      expect(stickAngleFromForward(mx, my)).toBeCloseTo(phi, 12);
      expect(shouldIdleFollow({ ...idleGate(), moveX: mx, moveY: my })).toBe(true);
      const scaledRate = IDLE_FOLLOW_RATE * forwardnessRateScale(phi);
      const perFrame = 1 - Math.exp(-scaledRate * FRAME);
      let yaw = 0.5;
      let travel = 0;
      let maxStep = 0;
      for (let i = 0; i < 240; i += 1) {
        const target = cameraYawBehindFacing(facingFromStick(yaw, mx, my));
        const gapBefore = Math.abs(wrapPi(target - yaw));
        // Per-frame delta is -phi: bounded by the gate constant, never a jump.
        expect(gapBefore).toBeLessThanOrEqual(phi + 1e-9);
        const next = stepIdleFollowYaw(yaw, target, FRAME, scaledRate);
        const step = Math.abs(next - yaw);
        expect(step).toBeLessThanOrEqual(phi * perFrame + 1e-9);
        maxStep = Math.max(maxStep, step);
        travel += step;
        yaw = next;
      }
      expect(travel).toBeGreaterThan(0);
      // Travel per second stays bounded by RATE * phi * cos(phi) (cos
      // softening), strictly below the unscaled RATE * phi ceiling.
      const seconds = 240 * FRAME;
      expect(travel / seconds).toBeLessThanOrEqual(scaledRate * phi + 1e-6);
      expect(travel / seconds).toBeLessThanOrEqual(IDLE_FOLLOW_RATE * phi + 1e-6);
      expect(maxStep).toBeLessThan(0.05);
    }
  });

  it("backpedal diagonal (|phi| = 3PI/4 > gate) still produces zero travel", () => {
    expect(runGatedLoop(1, -1)).toBe(0);
  });

  it("out-of-gate stick (50 deg > 0.8 gate) produces exactly zero travel", () => {
    const phi = (50 * Math.PI) / 180;
    expect(phi).toBeGreaterThan(IDLE_FOLLOW_MAX_STICK_ANGLE);
    expect(
      shouldIdleFollow({ ...idleGate(), moveX: Math.sin(phi), moveY: Math.cos(phi) }),
    ).toBe(false);
    expect(runGatedLoop(Math.sin(phi), Math.cos(phi))).toBe(0);
  });

  it("ungated backpedal control still orbits (the failure mode the gate fixes)", () => {
    // Same new-wiring target but with the gate bypassed: delta is permanently
    // -phi = -PI, i.e. +/-0.128 rad steps every frame at 60fps.
    let yaw = 0.5;
    let travel = 0;
    for (let i = 0; i < 240; i += 1) {
      const next = stepIdleFollowYaw(yaw, cameraYawBehindFacing(facingFromStick(yaw, 0, -1)), FRAME);
      travel += Math.abs(next - yaw);
      yaw = next;
    }
    expect(travel).toBeGreaterThan(5);
  });

  it("in-gate near-forward input eases with bounded per-frame delta, no runaway", () => {
    const phi = 0.2;
    const moveX = Math.sin(phi);
    const moveY = Math.cos(phi);
    const perFrame = 1 - Math.exp(-IDLE_FOLLOW_RATE * FRAME);
    let yaw = 0.5;
    let travel = 0;
    let maxStep = 0;
    for (let i = 0; i < 240; i += 1) {
      const target = cameraYawBehindFacing(facingFromStick(yaw, moveX, moveY));
      const gapBefore = Math.abs(wrapPi(target - yaw));
      // Per-frame delta is -phi: bounded by the gate constant, never a PI jump.
      expect(gapBefore).toBeLessThanOrEqual(phi + 1e-9);
      const next = stepIdleFollowYaw(yaw, target, FRAME);
      const step = Math.abs(next - yaw);
      expect(step).toBeLessThanOrEqual(phi * perFrame + 1e-9);
      // Each step moves toward that frame's target (instantaneous convergence).
      expect(Math.abs(wrapPi(target - next))).toBeLessThanOrEqual(gapBefore + 1e-12);
      maxStep = Math.max(maxStep, step);
      travel += step;
      yaw = next;
    }
    // The follow actually runs (unlike the gated-off directions above) ...
    expect(travel).toBeGreaterThan(0);
    expect(maxStep).toBeGreaterThan(0);
    // ... but travel per second stays bounded by IDLE_FOLLOW_RATE * phi.
    const seconds = 240 * FRAME;
    expect(travel / seconds).toBeLessThanOrEqual(IDLE_FOLLOW_RATE * phi + 1e-6);
    // And no wrap-edge noise: every step is a gentle ease, never a PI jump.
    expect(maxStep).toBeLessThan(0.05);
  });
});

describe("idle soft-follow yaw easing", () => {
  it("eases toward the avatar facing yaw and converges", () => {
    let yaw = 0;
    const target = 1.2;
    let previous = Math.abs(target - yaw);
    for (let i = 0; i < 240; i += 1) {
      yaw = stepIdleFollowYaw(yaw, target, FRAME);
      const gap = Math.abs(target - yaw);
      expect(gap).toBeLessThanOrEqual(previous + 1e-12);
      previous = gap;
    }
    expect(yaw).toBeCloseTo(target, 3);
  });

  it("takes the shortest arc across +/-PI instead of spinning the long way", () => {
    // yaw just below +PI, target just above -PI: the short way is forward
    // through +PI (yaw increases), not backwards across the whole circle.
    const stepped = stepIdleFollowYaw(3.0, -3.0, FRAME);
    expect(stepped).toBeGreaterThan(3.0);
    // And mirrored: yaw just above -PI eases downward toward +PI-side target.
    expect(stepIdleFollowYaw(-3.0, 3.0, FRAME)).toBeLessThan(-3.0);
  });

  it("passes through on non-positive dt or non-finite input", () => {
    expect(stepIdleFollowYaw(0.5, 1.0, 0)).toBe(0.5);
    expect(stepIdleFollowYaw(0.5, 1.0, -FRAME)).toBe(0.5);
    expect(stepIdleFollowYaw(Number.NaN, 1.0, FRAME)).toBeNaN();
    expect(stepIdleFollowYaw(0.5, Number.NaN, FRAME)).toBe(0.5);
  });

  it("holds still when already aligned", () => {
    expect(stepIdleFollowYaw(0.7, 0.7, FRAME)).toBeCloseTo(0.7, 12);
  });
});

describe("camera-behind convention (4d.2-fix2 review FAIL #1)", () => {
  it("cameraYawBehindFacing returns facing + PI wrapped to [-PI, PI]", () => {
    expect(cameraYawBehindFacing(0)).toBeCloseTo(Math.PI, 12);
    expect(cameraYawBehindFacing(Math.PI)).toBeCloseTo(0, 12);
    expect(cameraYawBehindFacing(-Math.PI)).toBeCloseTo(0, 12);
    expect(cameraYawBehindFacing(1.2)).toBeCloseTo(1.2 + Math.PI - Math.PI * 2, 12);
    expect(cameraYawBehindFacing(Number.NaN)).toBeNaN();
  });

  it("a camera yaw equal to cameraYawBehindFacing(r) sits PI behind facing", () => {
    for (const facing of [0, 0.7, 1.2, -2.4, Math.PI - 0.05, -Math.PI + 0.05]) {
      const camYaw = cameraYawBehindFacing(facing);
      // Offset from facing is PI: (camYaw - PI) coincides with facing.
      expect(wrapPi(camYaw - Math.PI - facing)).toBeCloseTo(0, 12);
    }
  });

  it("live-loop model (rotY = camYaw + PI each frame) holds still, old wiring orbits", () => {
    // Live loop: SceneManager.update recomputes rotY from camera-relative
    // worldMove every frame, so while pushing forward rotY === camYaw + PI.
    // New wiring (target = facing + PI) is then an exact fixed point.
    let yaw = 0.5;
    let travel = 0;
    for (let i = 0; i < 240; i += 1) {
      const rotY = wrapPi(yaw + Math.PI);
      const next = stepIdleFollowYaw(yaw, cameraYawBehindFacing(rotY), FRAME);
      travel += Math.abs(next - yaw);
      yaw = next;
    }
    expect(travel).toBeLessThan(1e-9);
    expect(wrapPi(yaw - 0.5)).toBeCloseTo(0, 9);
    // Control: the old wiring (target = raw facing) keeps a permanent
    // +/-PI delta in the same model and orbits (~0.13 rad/frame at 60fps).
    let oldYaw = 0.5;
    let oldTravel = 0;
    for (let i = 0; i < 240; i += 1) {
      const rotY = wrapPi(oldYaw + Math.PI);
      const next = stepIdleFollowYaw(oldYaw, rotY, FRAME);
      oldTravel += Math.abs(next - oldYaw);
      oldYaw = next;
    }
    expect(oldTravel).toBeGreaterThan(5);
  });
});

describe("idle soft-follow pitch leveling", () => {
  it("eases a high pitch down toward near-horizon", () => {
    let pitch = 0.6;
    let previous = Math.abs(pitch - IDLE_FOLLOW_PITCH);
    for (let i = 0; i < 240; i += 1) {
      pitch = stepIdleFollowPitch(pitch, FRAME);
      const gap = Math.abs(pitch - IDLE_FOLLOW_PITCH);
      expect(gap).toBeLessThanOrEqual(previous + 1e-12);
      previous = gap;
    }
    expect(pitch).toBeCloseTo(IDLE_FOLLOW_PITCH, 3);
  });

  it("eases a downward pitch up toward near-horizon (never past it in one step)", () => {
    const stepped = stepIdleFollowPitch(-0.15, FRAME);
    expect(stepped).toBeGreaterThan(-0.15);
    expect(stepped).toBeLessThanOrEqual(IDLE_FOLLOW_PITCH);
  });

  it("passes through on non-positive dt or non-finite pitch", () => {
    expect(stepIdleFollowPitch(0.4, 0)).toBe(0.4);
    expect(stepIdleFollowPitch(0.4, -FRAME)).toBe(0.4);
    expect(stepIdleFollowPitch(Number.NaN, FRAME)).toBeNaN();
  });
});

describe("forwardness rate scale (Option A cos softening)", () => {
  it("is 1 at pure forward and cos(MAX) at the gate edge", () => {
    expect(forwardnessRateScale(0)).toBe(1);
    expect(forwardnessRateScale(IDLE_FOLLOW_MAX_STICK_ANGLE)).toBeCloseTo(
      Math.cos(IDLE_FOLLOW_MAX_STICK_ANGLE),
      12,
    );
    expect(forwardnessRateScale(-IDLE_FOLLOW_MAX_STICK_ANGLE)).toBeCloseTo(
      Math.cos(IDLE_FOLLOW_MAX_STICK_ANGLE),
      12,
    );
  });

  it("decreases monotonically from forward to the edge", () => {
    let previous = forwardnessRateScale(0);
    for (let phi = 0.05; phi <= IDLE_FOLLOW_MAX_STICK_ANGLE + 1e-9; phi += 0.05) {
      const current = forwardnessRateScale(phi);
      expect(current).toBeLessThan(previous);
      previous = current;
    }
  });

  it("clamps beyond the gate instead of going negative", () => {
    expect(forwardnessRateScale(Math.PI)).toBeCloseTo(Math.cos(IDLE_FOLLOW_MAX_STICK_ANGLE), 12);
    expect(forwardnessRateScale(-Math.PI)).toBeCloseTo(Math.cos(IDLE_FOLLOW_MAX_STICK_ANGLE), 12);
  });

  it("yields 0 for non-finite input so a NaN stick never drives the camera", () => {
    expect(forwardnessRateScale(Number.NaN)).toBe(0);
    expect(forwardnessRateScale(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("caps edge drift near 1.4 rad/s, below the unscaled ceiling", () => {
    const edge = IDLE_FOLLOW_MAX_STICK_ANGLE;
    const scaled = IDLE_FOLLOW_RATE * forwardnessRateScale(edge);
    expect(scaled).toBeLessThan(IDLE_FOLLOW_RATE);
    expect(scaled).toBeCloseTo(IDLE_FOLLOW_RATE * Math.cos(IDLE_FOLLOW_MAX_STICK_ANGLE), 12);
    expect(edge * scaled).toBeLessThanOrEqual(1.45);
    expect(edge * scaled).toBeLessThanOrEqual(IDLE_FOLLOW_RATE * edge);
  });
});

describe("idle recenter gate (Option A)", () => {
  it("stays off until the idle timer passes the delay", () => {
    expect(shouldIdleRecenter({ ...recenterGate(), idleTimerS: 0 })).toBe(false);
    expect(shouldIdleRecenter({ ...recenterGate(), idleTimerS: IDLE_RECENTER_DELAY_S - 0.05 })).toBe(
      false,
    );
    expect(shouldIdleRecenter(recenterGate())).toBe(true);
    expect(
      shouldIdleRecenter({ ...recenterGate(), idleTimerS: IDLE_RECENTER_DELAY_S + 2 }),
    ).toBe(true);
  });

  it("three-way split at the two thresholds: follow owns >= MIN, recenter owns <= MAX, the creep band moves neither (no double ownership)", () => {
    // Shared release boundary, constant-referenced: exactly at MAX the stick
    // counts as released (mirrors the SceneManager facing freeze, which
    // keeps the old facing at lengthSq == MAX*MAX).
    const atMax = IDLE_RECENTER_MOVE_MAX;
    expect(shouldIdleRecenter({ ...recenterGate(), moveX: 0, moveY: atMax })).toBe(true);
    expect(shouldIdleFollow({ ...idleGate(), moveX: 0, moveY: atMax })).toBe(false);
    // Just above MAX the facing moves again: recenter stays off, follow
    // still off (below MIN) — the dead zone.
    expect(shouldIdleRecenter({ ...recenterGate(), moveX: 0, moveY: atMax + 1e-4 })).toBe(false);
    expect(shouldIdleFollow({ ...idleGate(), moveX: 0, moveY: atMax + 1e-4 })).toBe(false);
    // Mid creep band: neither path owns the frame, even with the timer long
    // past the delay (timer reset in main.ts uses the same MAX product, so
    // this could not accumulate either — belt and suspenders).
    expect(
      shouldIdleRecenter({
        ...recenterGate(),
        moveX: 0,
        moveY: 0.05,
        idleTimerS: IDLE_RECENTER_DELAY_S + 100,
      }),
    ).toBe(false);
    expect(shouldIdleFollow({ ...idleGate(), moveX: 0, moveY: 0.05 })).toBe(false);
    // Exactly at MIN the follow owns the frame, recenter stays off.
    expect(shouldIdleRecenter({ ...recenterGate(), moveX: 0, moveY: IDLE_FOLLOW_MOVE_MIN })).toBe(
      false,
    );
    expect(shouldIdleFollow({ ...idleGate(), moveX: 0, moveY: IDLE_FOLLOW_MOVE_MIN })).toBe(true);
    // Just below MIN the follow releases and the recenter is still off.
    expect(
      shouldIdleRecenter({ ...recenterGate(), moveX: 0, moveY: IDLE_FOLLOW_MOVE_MIN - 1e-6 }),
    ).toBe(false);
    expect(
      shouldIdleFollow({ ...idleGate(), moveX: 0, moveY: IDLE_FOLLOW_MOVE_MIN - 1e-6 }),
    ).toBe(false);
    // Fully released stick: recenter owns the frame, follow stays off.
    expect(shouldIdleRecenter(recenterGate())).toBe(true);
    expect(shouldIdleFollow({ ...idleGate(), moveX: 0, moveY: 0 })).toBe(false);
  });

  it("cancels on stick input, look input, charging, !playing, dead, or bad timer", () => {
    expect(shouldIdleRecenter({ ...recenterGate(), moveX: 0, moveY: 1 })).toBe(false);
    expect(shouldIdleRecenter({ ...recenterGate(), lookDx: 5 })).toBe(false);
    expect(shouldIdleRecenter({ ...recenterGate(), lookDy: -3 })).toBe(false);
    expect(shouldIdleRecenter({ ...recenterGate(), charging: true })).toBe(false);
    expect(shouldIdleRecenter({ ...recenterGate(), playing: false })).toBe(false);
    expect(shouldIdleRecenter({ ...recenterGate(), alive: false })).toBe(false);
    expect(shouldIdleRecenter({ ...recenterGate(), idleTimerS: Number.NaN })).toBe(false);
    expect(shouldIdleRecenter({ ...recenterGate(), moveX: Number.NaN })).toBe(false);
  });

  it("creep-band hold (|move| = 0.05, phi = PI) moves NEITHER path: yaw travel exactly 0 (review FAIL regression)", () => {
    // The blocking regression: the old < MIN recenter gate ran in the creep
    // band (0.01, 0.1) while SceneManager recomputed facing every frame from
    // the just-recentered yaw — sustained delta -phi for ANY stick angle, so
    // a slight backhold orbited at RATE*PI ~= 9.2 rad/s. After the fix the
    // gate mirrors the facing freeze (MAX*MAX), so both gates stay shut.
    const moveX = 0;
    const moveY = -0.05; // |move| = 0.05: inside (MAX, MIN), phi = PI backhold.
    expect(stickAngleFromForward(moveX, moveY)).toBeCloseTo(Math.PI, 12);
    const releaseLenSq = IDLE_RECENTER_MOVE_MAX * IDLE_RECENTER_MOVE_MAX;
    const moveLenSq = moveX * moveX + moveY * moveY;
    expect(moveLenSq).toBeGreaterThan(releaseLenSq); // facing NOT frozen...
    expect(moveLenSq).toBeLessThan(IDLE_FOLLOW_MOVE_MIN * IDLE_FOLLOW_MOVE_MIN); // ...nor following.
    // Full per-frame loop with the live facing mirror: SceneManager.update
    // recomputes facing from camera-relative worldMove iff lengthSq tops
    // MAX*MAX (for mags < 1 |worldMove| == |move|, orthonormal basis), then
    // BOTH gates are asked — neither fires, so yaw travel is exactly 0 even
    // with the timer long past the delay.
    let yaw = 0.5;
    let facing = 1.1;
    let travel = 0;
    for (let i = 0; i < 240; i += 1) {
      if (moveX * moveX + moveY * moveY > releaseLenSq) {
        const worldX = -Math.sin(yaw) * moveY + Math.cos(yaw) * moveX;
        const worldZ = -Math.cos(yaw) * moveY - Math.sin(yaw) * moveX;
        facing = Math.atan2(worldX, worldZ);
      }
      const target = cameraYawBehindFacing(facing);
      if (shouldIdleFollow({ ...idleGate(), moveX, moveY })) {
        const next = stepIdleFollowYaw(yaw, target, FRAME);
        travel += Math.abs(next - yaw);
        yaw = next;
      }
      if (
        shouldIdleRecenter({ ...recenterGate(), moveX, moveY, idleTimerS: IDLE_RECENTER_DELAY_S + 10 })
      ) {
        const next = stepIdleRecenterYaw(yaw, target, FRAME);
        travel += Math.abs(next - yaw);
        yaw = next;
      }
    }
    expect(travel).toBe(0);
    // Control (pre-fix behavior, gate bypassed): the same loop with the
    // recenter step forced on orbits — sustained ~0.15 rad/frame at 60fps.
    let oldYaw = 0.5;
    let oldFacing = 1.1;
    let oldTravel = 0;
    for (let i = 0; i < 240; i += 1) {
      const worldX = -Math.sin(oldYaw) * moveY + Math.cos(oldYaw) * moveX;
      const worldZ = -Math.cos(oldYaw) * moveY - Math.sin(oldYaw) * moveX;
      oldFacing = Math.atan2(worldX, worldZ);
      const next = stepIdleRecenterYaw(oldYaw, cameraYawBehindFacing(oldFacing), FRAME);
      oldTravel += Math.abs(next - oldYaw);
      oldYaw = next;
    }
    expect(oldTravel).toBeGreaterThan(5);
  });

  it("creep-band sideways hold (|move| = 0.05, phi = PI/2) also moves neither path", () => {
    const moveX = 0.05;
    const moveY = 0;
    expect(stickAngleFromForward(moveX, moveY)).toBeCloseTo(Math.PI / 2, 12);
    expect(shouldIdleFollow({ ...idleGate(), moveX, moveY })).toBe(false);
    expect(
      shouldIdleRecenter({ ...recenterGate(), moveX, moveY, idleTimerS: IDLE_RECENTER_DELAY_S + 10 }),
    ).toBe(false);
  });

  it("eases toward behind-facing with a static facing and converges to ~0 delta", () => {
    const facing = 1.1;
    const target = cameraYawBehindFacing(facing);
    let yaw = target - 0.9;
    let previous = Math.abs(wrapPi(target - yaw));
    for (let i = 0; i < 240; i += 1) {
      yaw = stepIdleRecenterYaw(yaw, target, FRAME);
      const gap = Math.abs(wrapPi(target - yaw));
      expect(gap).toBeLessThanOrEqual(previous + 1e-12);
      previous = gap;
    }
    expect(wrapPi(target - yaw)).toBeCloseTo(0, 3);
  });

  it("180-degree acceptance: camera in front of the face swings behind the last facing", () => {
    // Walked backward facing 0 with the camera sitting in front of the face
    // (yaw ~= facing, PI away from the behind target); after the delay the
    // recenter must swing it all the way behind (facing + PI wrapped).
    const facing = 0;
    const target = cameraYawBehindFacing(facing);
    expect(Math.abs(wrapPi(0 - target))).toBeCloseTo(Math.PI, 12);
    let yaw = 0;
    for (let i = 0; i < 400; i += 1) {
      yaw = stepIdleRecenterYaw(yaw, target, FRAME);
    }
    expect(wrapPi(yaw - target)).toBeCloseTo(0, 2);
  });

  it("levels pitch toward IDLE_FOLLOW_PITCH at the recenter rate", () => {
    const perFrame = 1 - Math.exp(-IDLE_RECENTER_RATE_S * FRAME);
    expect(stepIdleRecenterPitch(0.45, FRAME)).toBeCloseTo(
      0.45 + (IDLE_FOLLOW_PITCH - 0.45) * perFrame,
      12,
    );
    let pitch = 0.45;
    for (let i = 0; i < 400; i += 1) {
      pitch = stepIdleRecenterPitch(pitch, FRAME);
    }
    expect(pitch).toBeCloseTo(IDLE_FOLLOW_PITCH, 3);
  });

  it("recenter wrappers ease at IDLE_RECENTER_RATE_S, faster than the follow rate", () => {
    expect(IDLE_RECENTER_RATE_S).toBeGreaterThan(IDLE_FOLLOW_RATE);
    expect(stepIdleRecenterYaw(0, 1.0, FRAME)).toBeCloseTo(
      stepIdleFollowYaw(0, 1.0, FRAME, IDLE_RECENTER_RATE_S),
      12,
    );
    expect(stepIdleRecenterPitch(0.4, FRAME)).toBeCloseTo(
      stepIdleFollowPitch(0.4, FRAME, IDLE_RECENTER_RATE_S),
      12,
    );
  });

  it("passes through on non-positive dt or non-finite input", () => {
    expect(stepIdleRecenterYaw(0.5, 1.0, 0)).toBe(0.5);
    expect(stepIdleRecenterYaw(0.5, 1.0, -FRAME)).toBe(0.5);
    expect(stepIdleRecenterYaw(Number.NaN, 1.0, FRAME)).toBeNaN();
    expect(stepIdleRecenterYaw(0.5, Number.NaN, FRAME)).toBe(0.5);
    expect(stepIdleRecenterPitch(0.4, 0)).toBe(0.4);
    expect(stepIdleRecenterPitch(0.4, -FRAME)).toBe(0.4);
    expect(stepIdleRecenterPitch(Number.NaN, FRAME)).toBeNaN();
  });
});

describe("post-shot recenter/follow clamp tolerance (F3 fix, option a)", () => {
  it("widens the floor only while below the default band", () => {
    expect(-CAMERA_PITCH_MAX).toBeLessThan(CAMERA_PITCH_MIN);
    // Stale mirrored post-shot pitch: the recenter/follow call sites ease
    // from here with the widened floor instead of snapping to MIN.
    expect(tolerantCameraPitchMin(-CAMERA_PITCH_MAX)).toBe(-CAMERA_PITCH_MAX);
    expect(tolerantCameraPitchMin(-0.2)).toBe(-CAMERA_PITCH_MAX);
    expect(tolerantCameraPitchMin(-1.0)).toBe(-CAMERA_PITCH_MAX);
  });

  it("keeps the default floor at and inside the band", () => {
    expect(tolerantCameraPitchMin(CAMERA_PITCH_MIN)).toBe(CAMERA_PITCH_MIN);
    expect(tolerantCameraPitchMin(0)).toBe(CAMERA_PITCH_MIN);
    expect(tolerantCameraPitchMin(0.05)).toBe(CAMERA_PITCH_MIN);
    expect(tolerantCameraPitchMin(CAMERA_PITCH_MAX)).toBe(CAMERA_PITCH_MIN);
    expect(tolerantCameraPitchMin(1.0)).toBe(CAMERA_PITCH_MIN);
  });

  it("returns the default floor for non-finite input (setCameraAngles ignores NaN anyway)", () => {
    expect(tolerantCameraPitchMin(Number.NaN)).toBe(CAMERA_PITCH_MIN);
    expect(tolerantCameraPitchMin(Number.POSITIVE_INFINITY)).toBe(CAMERA_PITCH_MIN);
    expect(tolerantCameraPitchMin(Number.NEGATIVE_INFINITY)).toBe(CAMERA_PITCH_MIN);
  });
});
