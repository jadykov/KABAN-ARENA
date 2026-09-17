// Aim-assist unit tests: subtle deterministic pull (blend <= 50%) inside a
// narrow 12deg / 18m cone, untouched outside cone/range, deterministic.
import { describe, expect, it } from "vitest";
import { AIM_ASSIST_BLEND, AIM_ASSIST_CONE_DEG, AIM_ASSIST_MAX_DIST_M } from "../config";
import { ASSIST_MUZZLE_HEIGHT, ASSIST_TARGET_HEIGHT, applyAimAssist } from "./aimAssist";
import { yawPitchFromDirection } from "./protocol";

describe("aim assist (subtle deterministic blend)", () => {
  it("exposes the tuned cone/range/blend constants", () => {
    expect(AIM_ASSIST_MAX_DIST_M).toBe(18);
    expect(AIM_ASSIST_CONE_DEG).toBe(12);
    expect(AIM_ASSIST_BLEND).toBe(0.5);
  });

  it("pulls at most 50% toward an in-cone target", () => {
    const yaw = 0;
    const pitch = 0.0;
    const self = { x: 0, z: 0 };
    // Slightly off-axis but well inside the 12deg cone at 6m.
    const candidates = [{ sessionId: "e1", x: 0.5, z: -6, alive: true }];
    const out = applyAimAssist(yaw, pitch, self, candidates);
    const dx = 0.5 - self.x;
    const dz = -6 - self.z;
    const dy = ASSIST_TARGET_HEIGHT - ASSIST_MUZZLE_HEIGHT;
    const length = Math.hypot(dx, dy, dz);
    const desired = yawPitchFromDirection(dx / length, dy / length, dz / length);
    const yawGap = desired.yaw - yaw;
    const pitchGap = desired.pitch - pitch;
    // Moved toward the target, never past the halfway blend.
    expect(Math.abs(out.yaw - yaw)).toBeGreaterThan(0);
    expect(Math.abs(out.yaw - yaw)).toBeLessThanOrEqual(Math.abs(yawGap) * 0.5 + 1e-9);
    expect(Math.abs(out.pitch - pitch)).toBeLessThanOrEqual(Math.abs(pitchGap) * 0.5 + 1e-9);
    // Same direction as the gap (no overshoot to the other side).
    expect(Math.sign(out.yaw - yaw) === Math.sign(yawGap) || out.yaw === yaw).toBe(true);
  });

  it("leaves aim untouched for out-of-cone targets", () => {
    const yaw = 0;
    const pitch = 0.25;
    const self = { x: 0, z: 0 };
    // 90deg off-axis: far outside the 12deg cone.
    const out = applyAimAssist(yaw, pitch, self, [{ sessionId: "e1", x: 6, z: 0, alive: true }]);
    expect(out.yaw).toBe(yaw);
    expect(out.pitch).toBe(pitch);
  });

  it("leaves aim untouched for out-of-range and dead targets", () => {
    const yaw = 0.2;
    const pitch = 0.3;
    const self = { x: 0, z: 0 };
    const far = applyAimAssist(yaw, pitch, self, [{ sessionId: "e1", x: 0, z: -30, alive: true }]);
    expect(far.yaw).toBe(yaw);
    expect(far.pitch).toBe(pitch);
    const dead = applyAimAssist(yaw, pitch, self, [{ sessionId: "e1", x: 0, z: -5, alive: false }]);
    expect(dead.yaw).toBe(yaw);
    expect(dead.pitch).toBe(pitch);
  });

  it("is deterministic for identical inputs", () => {
    const self = { x: 1, z: 2 };
    const candidates = [
      { sessionId: "e1", x: 1.2, z: -4, alive: true },
      { sessionId: "e2", x: -3, z: -5, alive: true },
    ];
    const first = applyAimAssist(0.1, 0.3, self, candidates);
    const second = applyAimAssist(0.1, 0.3, self, candidates);
    expect(second).toEqual(first);
  });
});
