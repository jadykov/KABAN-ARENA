import { describe, expect, it } from "vitest";
import {
  CAMERA_PITCH_MAX,
  CAMERA_PITCH_MIN,
  IDLE_RECENTER_DELAY_S,
  SHOT_BODY_TURN_DONE_RAD,
  SHOT_BODY_TURN_RATE_S,
} from "../config";
import {
  beginShotBodyTurn,
  bodyFacingForShotYaw,
  cameraYawBehindFacing,
  isShotBodyTurnDone,
  shouldIdleRecenter,
  stepIdleFollowYaw,
  stepIdleRecenterYaw,
  stepShotBodyTurnYaw,
  type IdleRecenterGate,
} from "./idleFollow";
import { buildFirePayload, directionFromYawPitch } from "./protocol";

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

describe("post-shot body turn convention (shot yaw -> body facing)", () => {
  it("bodyFacingForShotYaw aims the body along the ball direction for many yaws", () => {
    // (sin r, cos r) must be parallel to directionFromYawPitch(shotYaw, 0):
    // the body looks where the ball flies. Pitch 0 keeps the horizontal
    // projection exact (length 1), so the dot must be ~1, not just > 0.9.
    const yaws = [0, Math.PI / 2, -Math.PI / 2, Math.PI, -Math.PI, 0.7, -2.4, Math.PI - 0.05, -(Math.PI - 0.05)];
    for (const shotYaw of yaws) {
      const facing = bodyFacingForShotYaw(shotYaw);
      expect(facing).toBeGreaterThanOrEqual(-Math.PI);
      expect(facing).toBeLessThanOrEqual(Math.PI);
      const fx = Math.sin(facing);
      const fz = Math.cos(facing);
      const dir = directionFromYawPitch(shotYaw, 0);
      const horizontal = Math.hypot(dir.x, dir.z);
      expect(horizontal).toBeGreaterThan(0.99);
      const dot = (fx * dir.x + fz * dir.z) / horizontal;
      expect(dot).toBeGreaterThan(0.999);
    }
  });

  it("spot checks: aimYaw 0 -> facing PI (faces -Z flight), shotYaw PI -> facing 0", () => {
    expect(wrapPi(bodyFacingForShotYaw(0) - Math.PI)).toBeCloseTo(0, 12);
    expect(wrapPi(bodyFacingForShotYaw(Math.PI) - 0)).toBeCloseTo(0, 12);
    expect(wrapPi(bodyFacingForShotYaw(-Math.PI) - 0)).toBeCloseTo(0, 12);
  });

  it("wrong-sign control: raw shot yaw as facing points BACKWARDS (dot ~ -1)", () => {
    // Proves the convention test above is sensitive: dropping the +PI flip
    // (the sign error this test exists to catch) fails it loudly.
    for (const shotYaw of [0, Math.PI / 2, -Math.PI / 2, 0.7, -2.4]) {
      const wrong = wrapPi(shotYaw);
      const dir = directionFromYawPitch(shotYaw, 0);
      const dot = Math.sin(wrong) * dir.x + Math.cos(wrong) * dir.z;
      expect(dot).toBeLessThan(-0.9);
    }
  });

  it("non-finite shot yaw passes through (call sites treat it as do-not-arm)", () => {
    expect(bodyFacingForShotYaw(Number.NaN)).toBeNaN();
    expect(beginShotBodyTurn(Number.NaN)).toEqual({ active: false, target: 0 });
  });

  it("beginShotBodyTurn arms with the derived target for finite yaw", () => {
    const turn = beginShotBodyTurn(0.7);
    expect(turn.active).toBe(true);
    expect(turn.target).toBeCloseTo(bodyFacingForShotYaw(0.7), 12);
  });
});

describe("post-shot body turn easing", () => {
  it("settles a full PI flip to < 0.12 rad within ~0.3s at SHOT_BODY_TURN_RATE_S", () => {
    expect(SHOT_BODY_TURN_RATE_S).toBe(12);
    const target = bodyFacingForShotYaw(Math.PI); // 0
    let current = Math.PI;
    let previous = Math.abs(wrapPi(target - current));
    for (let i = 0; i < 18; i += 1) {
      current = stepShotBodyTurnYaw(current, target, FRAME);
      const gap = Math.abs(wrapPi(target - current));
      expect(gap).toBeLessThanOrEqual(previous + 1e-12);
      previous = gap;
    }
    expect(previous).toBeLessThan(0.12);
    // Keeps converging to ~0 given more frames (well before the 0.8s
    // recenter delay elapses).
    for (let i = 0; i < 60; i += 1) {
      current = stepShotBodyTurnYaw(current, target, FRAME);
    }
    expect(Math.abs(wrapPi(target - current))).toBeLessThan(SHOT_BODY_TURN_DONE_RAD);
    expect(isShotBodyTurnDone(current, target)).toBe(true);
  });

  it("takes the shortest arc across +/-PI instead of spinning the long way", () => {
    expect(stepShotBodyTurnYaw(3.0, -3.0, FRAME)).toBeGreaterThan(3.0);
    expect(stepShotBodyTurnYaw(-3.0, 3.0, FRAME)).toBeLessThan(-3.0);
  });

  it("eases at SHOT_BODY_TURN_RATE_S (same step pattern as the follow, new rate)", () => {
    expect(stepShotBodyTurnYaw(0, 1.0, FRAME)).toBeCloseTo(
      stepIdleFollowYaw(0, 1.0, FRAME, SHOT_BODY_TURN_RATE_S),
      12,
    );
  });

  it("isShotBodyTurnDone: far gaps run, DONE band completes, non-finite never completes", () => {
    expect(isShotBodyTurnDone(Math.PI, 0)).toBe(false);
    expect(isShotBodyTurnDone(0.5, 0)).toBe(false);
    expect(isShotBodyTurnDone(SHOT_BODY_TURN_DONE_RAD, 0)).toBe(true);
    expect(isShotBodyTurnDone(0, 0)).toBe(true);
    expect(isShotBodyTurnDone(Number.NaN, 0)).toBe(false);
    expect(isShotBodyTurnDone(0, Number.NaN)).toBe(false);
  });

  it("passes through on non-positive dt or non-finite input", () => {
    expect(stepShotBodyTurnYaw(0.5, 1.0, 0)).toBe(0.5);
    expect(stepShotBodyTurnYaw(0.5, 1.0, -FRAME)).toBe(0.5);
    expect(stepShotBodyTurnYaw(Number.NaN, 1.0, FRAME)).toBeNaN();
    expect(stepShotBodyTurnYaw(0.5, Number.NaN, FRAME)).toBe(0.5);
  });
});

describe("no-swing owner scenario (run -> charge -> 180 aim flip -> fire -> release)", () => {
  // Honest per-frame model of the shipped loop: the body eases toward the
  // shot facing (SceneManager.update turn branch, stick released) while the
  // camera recenter gate reads the LIVE facing every frame (main.ts), with
  // the real idleTimerS accumulation and the real shouldIdleRecenter gate.
  // Setup mirrors the report: ran facing PI, stopped, charged, flipped the
  // aim 180 deg (camera now at PI = shot yaw), fired, released the stick.
  function runScenario(withTurn: boolean, frames = 240): { travel: number; finalGap: number } {
    const shotYaw = Math.PI;
    const target = bodyFacingForShotYaw(shotYaw); // 0
    let bodyYaw = Math.PI; // stale run facing, frozen while stopped
    let turnActive = withTurn;
    let camYaw = Math.PI; // camera copied the flipped aim during charge
    let idleTimerS = 0;
    let travel = 0;
    const gate: IdleRecenterGate = {
      playing: true,
      charging: false,
      alive: true,
      lookDx: 0,
      lookDy: 0,
      moveX: 0,
      moveY: 0,
      idleTimerS: 0,
    };
    for (let i = 0; i < frames; i += 1) {
      // SceneManager.update turn branch (stick released: lengthSq 0 <= MAX^2).
      if (turnActive) {
        const stepped = stepShotBodyTurnYaw(bodyYaw, target, FRAME);
        if (isShotBodyTurnDone(stepped, target)) {
          bodyYaw = target;
          turnActive = false;
        } else {
          bodyYaw = stepped;
        }
      }
      // main.ts idle timer + recenter block (released stick, no look input).
      idleTimerS += FRAME;
      gate.idleTimerS = idleTimerS;
      if (shouldIdleRecenter(gate)) {
        const next = stepIdleRecenterYaw(camYaw, cameraYawBehindFacing(bodyYaw), FRAME);
        travel += Math.abs(next - camYaw);
        camYaw = next;
      }
    }
    return { travel, finalGap: Math.abs(wrapPi(cameraYawBehindFacing(target) - camYaw)) };
  }

  it("with the body turn the camera stays put: travel < 0.2 rad, recenter ends behind the shot dir", () => {
    const result = runScenario(true);
    // The camera already sits behind the shot dir (aim ended there) and the
    // body converges underneath it before the 0.8s recenter delay elapses,
    // so the recenter target never diverges from the current yaw.
    expect(result.travel).toBeLessThan(0.2);
    expect(result.finalGap).toBeLessThan(0.05);
  });

  it("without-turn control swings the full 180 deg (the bug being fixed)", () => {
    const result = runScenario(false);
    // Stale facing PI keeps the recenter target PI away from the camera, so
    // the camera swings all the way around to behind the stale facing — and
    // ends up PI away from behind the shot dir (the jarring swing).
    expect(result.travel).toBeGreaterThan(2.5);
    expect(result.finalGap).toBeGreaterThan(2.5);
  });

  it("ordering: the turn completes before the recenter delay elapses", () => {
    // A PI flip at rate 12 is inside the DONE band after ~0.5s < 0.8s, so
    // when the recenter first fires the facing is already settled.
    const target = bodyFacingForShotYaw(Math.PI);
    let current = Math.PI;
    let settledFrame = -1;
    for (let i = 0; i < 240; i += 1) {
      current = stepShotBodyTurnYaw(current, target, FRAME);
      if (isShotBodyTurnDone(current, target)) {
        settledFrame = i + 1;
        break;
      }
    }
    expect(settledFrame).toBeGreaterThan(0);
    expect(settledFrame * FRAME).toBeLessThan(IDLE_RECENTER_DELAY_S);
  });
});

describe("vertical aim pitch limit (post-playtest round 2)", () => {
  it("CAMERA_PITCH_MAX is 0.36 (another ~20% down from 0.45)", () => {
    expect(CAMERA_PITCH_MAX).toBeCloseTo(0.36, 12);
    expect(CAMERA_PITCH_MIN).toBe(-0.15);
  });

  it("fire payload clamps pitch to the shared constant", () => {
    expect(buildFirePayload(1, 0, 0.45, false).pitch).toBeCloseTo(CAMERA_PITCH_MAX, 12);
    expect(buildFirePayload(1, 0, 1.4, false).pitch).toBeCloseTo(CAMERA_PITCH_MAX, 12);
    expect(buildFirePayload(1, 0, 0.2, false).pitch).toBeCloseTo(0.2, 12);
    expect(buildFirePayload(1, 0, CAMERA_PITCH_MIN, false).pitch).toBeCloseTo(CAMERA_PITCH_MIN, 12);
  });
});
