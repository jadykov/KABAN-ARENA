// Aim-assist unit tests: subtle deterministic pull (blend <= 50%) inside a
// narrow 12deg / 18m cone, untouched outside cone/range, deterministic —
// and elevation-aware (bug 2): muzzle/target heights come from live body Y,
// never ground anchors.
import { describe, expect, it } from "vitest";
import {
  AIM_ASSIST_ACQUIRE_FRACTION,
  AIM_ASSIST_BLEND,
  AIM_ASSIST_CONE_DEG,
  AIM_ASSIST_MAX_DIST_M,
  AIM_ASSIST_STICKY_MARGIN_DEG,
  BALL_TORSO_OFFSET,
} from "../config";
import { ASSIST_FALLBACK_DY, applyAimAssist, applyAimAssistTo, type AssistStick } from "./aimAssist";
import { yawPitchFromDirection } from "./protocol";

describe("aim assist (subtle deterministic blend)", () => {
  it("exposes the tuned cone/range/blend constants", () => {
    expect(AIM_ASSIST_MAX_DIST_M).toBe(18);
    expect(AIM_ASSIST_CONE_DEG).toBe(12);
    expect(AIM_ASSIST_BLEND).toBe(0.5);
  });

  it("keeps the fallback drop at the nominal torso delta (no ground anchor)", () => {
    // The old ground anchors (target 1.1, muzzle 1.4) differed by -0.3;
    // only the DELTA survives, for missing heights alone.
    expect(ASSIST_FALLBACK_DY).toBe(-0.3);
  });

  it("pulls at most 50% toward an in-cone target", () => {
    const yaw = 0;
    const pitch = 0.0;
    const self = { x: 0, z: 0, y: 1.1 };
    // Slightly off-axis but well inside the 12deg cone at 6m, same height.
    const candidates = [{ sessionId: "e1", x: 0.5, z: -6, alive: true, y: 1.1 }];
    const out = applyAimAssist(yaw, pitch, self, candidates);
    const dx = 0.5 - self.x;
    const dz = -6 - self.z;
    const dy = 1.1 - (self.y + BALL_TORSO_OFFSET);
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
    const self = { x: 0, z: 0, y: 1.1 };
    // 90deg off-axis: far outside the 12deg cone.
    const out = applyAimAssist(yaw, pitch, self, [{ sessionId: "e1", x: 6, z: 0, alive: true, y: 1.1 }]);
    expect(out.yaw).toBe(yaw);
    expect(out.pitch).toBe(pitch);
  });

  it("leaves aim untouched for out-of-range and dead targets", () => {
    const yaw = 0.2;
    const pitch = 0.3;
    const self = { x: 0, z: 0, y: 1.1 };
    const far = applyAimAssist(yaw, pitch, self, [{ sessionId: "e1", x: 0, z: -30, alive: true, y: 1.1 }]);
    expect(far.yaw).toBe(yaw);
    expect(far.pitch).toBe(pitch);
    const dead = applyAimAssist(yaw, pitch, self, [{ sessionId: "e1", x: 0, z: -5, alive: false, y: 1.1 }]);
    expect(dead.yaw).toBe(yaw);
    expect(dead.pitch).toBe(pitch);
  });

  it("is deterministic for identical inputs", () => {
    const self = { x: 1, z: 2, y: 1.1 };
    const candidates = [
      { sessionId: "e1", x: 1.2, z: -4, alive: true, y: 1.1 },
      { sessionId: "e2", x: -3, z: -5, alive: true, y: 3.1 },
    ];
    const first = applyAimAssist(0.1, 0.3, self, candidates);
    const second = applyAimAssist(0.1, 0.3, self, candidates);
    expect(second).toEqual(first);
  });
});

describe("aim assist elevation awareness (bug 2)", () => {
  it("does not flatten downhill aim from a tower (no ground anchors)", () => {
    // Shooter on a 2.0m tower (body 3.1, muzzle 3.4), victim on the ground
    // (body 1.1) dead ahead at 8m. Raw pitch aims EXACTLY at the victim —
    // the assist must leave it alone (desired == raw, blend is a no-op).
    // With the old ground anchors (dy = -0.3) the assist pulled the pitch
    // ~0.12 rad toward horizontal — the fired ball flew ABOVE the preview.
    const self = { x: 0, z: 0, y: 3.1 };
    const muzzleY = self.y + BALL_TORSO_OFFSET;
    const pitch = Math.atan2(1.1 - muzzleY, 8);
    const out = applyAimAssist(0, pitch, self, [{ sessionId: "e1", x: 0, z: -8, alive: true, y: 1.1 }]);
    expect(out.yaw).toBe(0);
    expect(Math.abs(out.pitch - pitch)).toBeLessThan(1e-9);
  });

  it("does not lift uphill aim onto a tower either", () => {
    // Ground shooter (muzzle 1.4), victim on tower top (body 3.1) at 6m,
    // raw pitch exact: assist is a no-op.
    const self = { x: 0, z: 0, y: 1.1 };
    const muzzleY = self.y + BALL_TORSO_OFFSET;
    const pitch = Math.atan2(3.1 - muzzleY, 6);
    const out = applyAimAssist(0, pitch, self, [{ sessionId: "e1", x: 0, z: -6, alive: true, y: 3.1 }]);
    expect(out.yaw).toBe(0);
    expect(Math.abs(out.pitch - pitch)).toBeLessThan(1e-9);
  });

  it("falls back to the nominal drop when a height is missing", () => {
    const self = { x: 0, z: 0, y: 1.1 };
    const noHeight = [{ sessionId: "e1", x: 0.5, z: -6, alive: true }];
    const explicit = [
      {
        sessionId: "e1",
        x: 0.5,
        z: -6,
        alive: true,
        y: self.y + BALL_TORSO_OFFSET + ASSIST_FALLBACK_DY,
      },
    ];
    expect(applyAimAssist(0, 0, self, noHeight)).toEqual(applyAimAssist(0, 0, self, explicit));
  });
});

describe("applyAimAssistTo (zero-alloc shared path, preview == payload)", () => {
  it("writes into out, returns it, and matches the allocating wrapper", () => {
    const cases: Array<{
      yaw: number;
      pitch: number;
      self: { x: number; z: number; y: number };
      candidates: Array<{ sessionId: string; x: number; z: number; alive: boolean; y?: number | null }>;
    }> = [
      {
        yaw: 0,
        pitch: 0,
        self: { x: 0, z: 0, y: 1.1 },
        candidates: [{ sessionId: "e1", x: 0.5, z: -6, alive: true, y: 1.1 }],
      },
      {
        yaw: 0.3,
        pitch: -0.28,
        self: { x: 1, z: 2, y: 3.1 },
        candidates: [{ sessionId: "e1", x: 1, z: -6, alive: true, y: 1.1 }],
      },
      {
        yaw: 0.2,
        pitch: 0.3,
        self: { x: 0, z: 0, y: 1.1 },
        candidates: [
          { sessionId: "e1", x: 0, z: -30, alive: true, y: 1.1 },
          { sessionId: "e2", x: 0, z: -5, alive: false },
        ],
      },
      {
        yaw: Number.NaN,
        pitch: Number.NaN,
        self: { x: Number.NaN, z: 0, y: 1.1 },
        candidates: [],
      },
    ];
    for (const c of cases) {
      const out = { yaw: -999, pitch: -999 };
      const returned = applyAimAssistTo(out, c.yaw, c.pitch, c.self, c.candidates);
      expect(returned).toBe(out);
      expect(out).toEqual(applyAimAssist(c.yaw, c.pitch, c.self, c.candidates));
    }
  });
});

describe("assist target hysteresis (bug C: preview stops flip-flopping)", () => {
  it("exposes the sticky margin + acquire fraction constants", () => {
    expect(AIM_ASSIST_STICKY_MARGIN_DEG).toBe(2);
    expect(AIM_ASSIST_ACQUIRE_FRACTION).toBe(0.75);
  });

  it("holds a near-tied target instead of alternating every refresh", () => {
    // Heights at muzzle level (dy = 0) so cone angles read as pure yaw:
    // A ~3.6deg, B1 ~3.2deg (within the 2deg margin), B2 ~0.4deg (beats).
    const self = { x: 0, z: 0, y: 1.1 };
    const stick: AssistStick = { lastId: null };
    const out1 = { yaw: 0, pitch: 0 };
    // A alone: acquired and tracked.
    applyAimAssistTo(out1, 0, 0, self, [{ sessionId: "A", x: 0.5, z: -8, alive: true, y: 1.4 }], stick);
    expect(stick.lastId).toBe("A");
    // B slightly better (diff ~0.4deg, within margin): NO flip — same out.
    const out2 = { yaw: 0, pitch: 0 };
    applyAimAssistTo(
      out2,
      0,
      0,
      self,
      [
        { sessionId: "A", x: 0.5, z: -8, alive: true, y: 1.4 },
        { sessionId: "B", x: -0.45, z: -8, alive: true, y: 1.4 },
      ],
      stick,
    );
    expect(stick.lastId).toBe("A");
    expect(out2).toEqual(out1);
    // B clearly better (beats A by > 2deg): switch, stick follows.
    const out3 = { yaw: 0, pitch: 0 };
    applyAimAssistTo(
      out3,
      0,
      0,
      self,
      [
        { sessionId: "A", x: 0.5, z: -8, alive: true, y: 1.4 },
        { sessionId: "B", x: 0.05, z: -8, alive: true, y: 1.4 },
      ],
      stick,
    );
    expect(stick.lastId).toBe("B");
    expect(out3).not.toEqual(out1);
  });

  it("keeps the tracked target to the cone edge, drops it outside", () => {
    const self = { x: 0, z: 0, y: 1.1 };
    const stick: AssistStick = { lastId: null };
    const tracked = { yaw: 0, pitch: 0 };
    // A at ~5deg: acquired.
    applyAimAssistTo(tracked, 0, 0, self, [{ sessionId: "A", x: 0.7, z: -8, alive: true, y: 1.1 }], stick);
    expect(stick.lastId).toBe("A");
    // A drifts to ~11deg (inside the 12deg cone, past the 9deg acquire
    // dead zone), no rival: still tracked, still pulling.
    const edge = { yaw: 0, pitch: 0 };
    applyAimAssistTo(
      edge,
      0,
      0,
      self,
      [{ sessionId: "A", x: 1.55, z: -8, alive: true, y: 1.1 }],
      stick,
    );
    expect(stick.lastId).toBe("A");
    expect(edge.yaw).not.toBe(0);
    // A leaves the cone (~13deg): dropped, aim untouched, stick cleared.
    const out = { yaw: 0, pitch: 0 };
    applyAimAssistTo(
      out,
      0,
      0,
      self,
      [{ sessionId: "A", x: 1.85, z: -8, alive: true, y: 1.1 }],
      stick,
    );
    expect(stick.lastId).toBe(null);
    expect(out.yaw).toBe(0);
    expect(out.pitch).toBe(0);
  });

  it("does not acquire newcomers inside the dead zone", () => {
    const self = { x: 0, z: 0, y: 1.1 };
    const stick: AssistStick = { lastId: null };
    // ~11deg: inside the 12deg cone but past the 9deg acquire fraction.
    const out = { yaw: 0, pitch: 0 };
    applyAimAssistTo(
      out,
      0,
      0,
      self,
      [{ sessionId: "A", x: 1.55, z: -8, alive: true, y: 1.1 }],
      stick,
    );
    expect(stick.lastId).toBe(null);
    expect(out.yaw).toBe(0);
    expect(out.pitch).toBe(0);
  });

  it("clears a dead tracked target and picks the living rival", () => {
    const self = { x: 0, z: 0, y: 1.1 };
    const stick: AssistStick = { lastId: "A" };
    const out = { yaw: 0, pitch: 0 };
    applyAimAssistTo(
      out,
      0,
      0,
      self,
      [
        { sessionId: "A", x: 0.5, z: -8, alive: false, y: 1.1 },
        { sessionId: "B", x: 0.5, z: -8, alive: true, y: 1.1 },
      ],
      stick,
    );
    expect(stick.lastId).toBe("B");
    expect(out.yaw).not.toBe(0);
  });
});
