import { describe, expect, it } from "vitest";
import { AIM_PITCH_DAMP, CAMERA_PITCH_MAX, CAMERA_PITCH_MIN } from "../config";
import { beginChargeLevel, pitchRateScale, stepChargeLevel } from "./chargeAim";

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
