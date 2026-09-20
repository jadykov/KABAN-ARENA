import { describe, expect, it } from "vitest";
import { AIM_PITCH_DAMP, AIM_YAW_DAMP, CAMERA_PITCH_MAX, CAMERA_PITCH_MIN } from "../config";
import {
  beginChargeLevel,
  mirrorChargeCameraPitch,
  pitchRateScale,
  shouldTrackAimFromCamera,
  stepChargeLevel,
  unmirrorChargeCameraPitch,
  yawRateScale,
} from "./chargeAim";

const FRAME = 1 / 60;

describe("charge pitch leveling (one-shot ease toward horizon)", () => {
  it("eases a high pitch toward 0 with no input and completes", () => {
    const level = beginChargeLevel();
    expect(level.active).toBe(true);
    let pitch = 0.5;
    for (let i = 0; i < 240; i += 1) {
      pitch = stepChargeLevel(level, pitch, false, FRAME);
    }
    expect(pitch).toBe(0);
    expect(level.active).toBe(false);
  });

  it("eases a downward pitch upward toward 0 (never pushes past horizon)", () => {
    const level = beginChargeLevel();
    let pitch = -0.12;
    let crossed = false;
    for (let i = 0; i < 240; i += 1) {
      const before = pitch;
      pitch = stepChargeLevel(level, pitch, false, FRAME);
      if (before < 0 && pitch > 0) {
        crossed = true;
      }
    }
    expect(crossed).toBe(false);
    expect(pitch).toBe(0);
  });

  it("any aim deflection cancels the ease instantly, pitch untouched", () => {
    const level = beginChargeLevel();
    const pitch = stepChargeLevel(level, 0.4, true, FRAME);
    expect(pitch).toBe(0.4);
    expect(level.active).toBe(false);
    // Afterwards it is a passthrough even without deflection.
    expect(stepChargeLevel(level, 0.4, false, FRAME)).toBe(0.4);
  });

  it("passes through when inactive or dt is not positive", () => {
    const level = beginChargeLevel();
    level.active = false;
    expect(stepChargeLevel(level, 0.3, false, FRAME)).toBe(0.3);
    const armed = beginChargeLevel();
    expect(stepChargeLevel(armed, 0.3, false, 0)).toBe(0.3);
    expect(armed.active).toBe(true);
  });

  it("never clamps: full down/up aim range survives takeover", () => {
    const level = beginChargeLevel();
    // Aiming down from elevation stays fully possible — the helper only
    // eases or yields, it never clips the pitch band.
    expect(stepChargeLevel(level, CAMERA_PITCH_MIN, true, FRAME)).toBe(CAMERA_PITCH_MIN);
    const second = beginChargeLevel();
    expect(stepChargeLevel(second, CAMERA_PITCH_MAX, true, FRAME)).toBe(CAMERA_PITCH_MAX);
  });
});

describe("charge pitch damping (vertical rate scale)", () => {
  it("mutes vertical rate while charging only", () => {
    expect(AIM_PITCH_DAMP).toBeGreaterThan(0.4);
    expect(AIM_PITCH_DAMP).toBeLessThan(0.8);
    expect(pitchRateScale(true)).toBe(AIM_PITCH_DAMP);
    expect(pitchRateScale(false)).toBe(1);
  });
});

describe("charge yaw damping (horizontal rate scale, 4d.2-fix2)", () => {
  it("runs calmer while charging, full rate otherwise", () => {
    // Mirrors the pitch damp band (0.5-0.65 of normal): aiming feels calmer
    // on both axes, base stick behavior without aiming stays as-is.
    expect(AIM_YAW_DAMP).toBeGreaterThanOrEqual(0.5);
    expect(AIM_YAW_DAMP).toBeLessThanOrEqual(0.65);
    expect(yawRateScale(true)).toBe(AIM_YAW_DAMP);
    expect(yawRateScale(true)).toBeLessThan(1);
    expect(yawRateScale(false)).toBe(1);
  });
});

describe("aim-mirror camera pitch (fix round 3, TPS mirror)", () => {
  it("negates the aim pitch: aim up -> camera pitch negative (drops)", () => {
    expect(mirrorChargeCameraPitch(0.3)).toBeCloseTo(-0.3, 12);
    expect(mirrorChargeCameraPitch(0)).toBe(0);
  });

  it("is symmetric: aim down -> camera pitch positive (rises)", () => {
    expect(mirrorChargeCameraPitch(-0.1)).toBeCloseTo(0.1, 12);
    expect(mirrorChargeCameraPitch(-CAMERA_PITCH_MIN)).toBeCloseTo(CAMERA_PITCH_MIN, 12);
  });

  it("clamps symmetrically to [-CAMERA_PITCH_MAX, +CAMERA_PITCH_MAX]", () => {
    expect(mirrorChargeCameraPitch(1.0)).toBeCloseTo(-CAMERA_PITCH_MAX, 12);
    expect(mirrorChargeCameraPitch(-1.0)).toBeCloseTo(CAMERA_PITCH_MAX, 12);
    expect(mirrorChargeCameraPitch(CAMERA_PITCH_MAX)).toBeCloseTo(-CAMERA_PITCH_MAX, 12);
    // The full aim band mirrors inside the symmetric clamp untouched.
    expect(mirrorChargeCameraPitch(CAMERA_PITCH_MIN)).toBeCloseTo(-CAMERA_PITCH_MIN, 12);
  });

  it("passes non-finite input through (call sites treat it as no-move)", () => {
    expect(mirrorChargeCameraPitch(Number.NaN)).toBeNaN();
    expect(mirrorChargeCameraPitch(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });

  it("is an exact involution on the symmetric band: mirror(mirror(x)) = x", () => {
    // In-band the negation never hits either clamp, so the double mirror is
    // the identity — this is what makes unmirrorChargeCameraPitch exact for
    // every aim pitch main.ts can hold during charge ([MIN, MAX] subset).
    const samples = [
      0,
      0.05,
      0.15,
      0.3,
      -0.1,
      CAMERA_PITCH_MIN,
      -CAMERA_PITCH_MIN,
      CAMERA_PITCH_MAX,
      -CAMERA_PITCH_MAX,
    ];
    for (const x of samples) {
      expect(mirrorChargeCameraPitch(mirrorChargeCameraPitch(x))).toBeCloseTo(x, 12);
    }
  });

  it("collapses out-of-band input to the band edge (safe backstop, not a live path)", () => {
    // Unreachable in the fixed wiring (aim is always in [MIN, MAX] once the
    // F2 feedback copy is gone); documents the honest semantic instead of
    // pretending the involution holds everywhere. Single application pins to
    // the edge (mirror(1.0) = -MAX, covered above); the double application
    // below just mirrors that edge back.
    expect(mirrorChargeCameraPitch(mirrorChargeCameraPitch(1.0))).toBeCloseTo(CAMERA_PITCH_MAX, 12);
    expect(mirrorChargeCameraPitch(mirrorChargeCameraPitch(-2.5))).toBeCloseTo(-CAMERA_PITCH_MAX, 12);
  });
});

describe("unmirror camera->aim pitch (F1 fix, shared helper)", () => {
  it("recovers the true aim pitch from the mirrored camera pitch", () => {
    // Aim +0.3 shows camera -0.3 while charging; release must read +0.3.
    expect(unmirrorChargeCameraPitch(-0.3)).toBeCloseTo(0.3, 12);
    expect(unmirrorChargeCameraPitch(0.1)).toBeCloseTo(-0.1, 12);
    expect(unmirrorChargeCameraPitch(0)).toBe(0);
    expect(unmirrorChargeCameraPitch(-CAMERA_PITCH_MAX)).toBeCloseTo(CAMERA_PITCH_MAX, 12);
    expect(unmirrorChargeCameraPitch(-CAMERA_PITCH_MIN)).toBeCloseTo(CAMERA_PITCH_MIN, 12);
  });

  it("round-trips every in-band aim pitch exactly (pins the F1 release path)", () => {
    const samples = [0, 0.05, 0.15, 0.3, -0.1, CAMERA_PITCH_MIN, CAMERA_PITCH_MAX];
    for (const aim of samples) {
      const camera = mirrorChargeCameraPitch(aim);
      expect(unmirrorChargeCameraPitch(camera)).toBeCloseTo(aim, 12);
    }
  });

  it("collapses out-of-band input to the edge and passes non-finite through", () => {
    expect(unmirrorChargeCameraPitch(1.0)).toBeCloseTo(-CAMERA_PITCH_MAX, 12);
    expect(unmirrorChargeCameraPitch(Number.NaN)).toBeNaN();
    expect(unmirrorChargeCameraPitch(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("idle aim-track gate (F2 fix)", () => {
  it("never tracks while charging, even with both sticks idle", () => {
    // The old wiring copied camera->aim unconditionally here: while charging
    // the camera holds mirror(aim), so the copy fed -aim back into aim and
    // the next mirror flipped it again (~30Hz oscillation).
    expect(shouldTrackAimFromCamera(true, true, true)).toBe(false);
    expect(shouldTrackAimFromCamera(true, false, true)).toBe(false);
    expect(shouldTrackAimFromCamera(true, true, false)).toBe(false);
    expect(shouldTrackAimFromCamera(true, false, false)).toBe(false);
  });

  it("tracks only when not charging with both sticks idle (RMB look path)", () => {
    expect(shouldTrackAimFromCamera(false, true, true)).toBe(true);
    expect(shouldTrackAimFromCamera(false, false, true)).toBe(false);
    expect(shouldTrackAimFromCamera(false, true, false)).toBe(false);
    expect(shouldTrackAimFromCamera(false, false, false)).toBe(false);
  });
});
