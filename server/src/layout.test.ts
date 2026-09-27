import { describe, expect, it } from "vitest";
import {
  ARENA_LAYOUT,
  ICE_ZONES,
  SERVER_OBSTACLES,
  SERVER_PLATFORMS,
  SWAMP_ZONES,
  TRAMPOLINE_SPOTS,
} from "./config.js";
import { getSpawnForIndex, isOnTrampolinePad } from "./hits.js";
import { validateArenaLayout } from "../../shared/arena-layout.mjs";

describe("authoritative shared arena layout", () => {
  it("uses the same JSON objects for solids, surfaces, pads, and all six spawns", () => {
    expect(SERVER_OBSTACLES).toBe(ARENA_LAYOUT.obstacles);
    expect(SERVER_PLATFORMS).toBe(ARENA_LAYOUT.platforms);
    expect(SWAMP_ZONES).toBe(ARENA_LAYOUT.swampZones);
    expect(ICE_ZONES).toBe(ARENA_LAYOUT.iceZones);
    expect(TRAMPOLINE_SPOTS).toBe(ARENA_LAYOUT.trampolines);
    expect(ARENA_LAYOUT.spawns).toHaveLength(6);
    ARENA_LAYOUT.spawns.forEach((spawn, index) => {
      expect(getSpawnForIndex(index)).toEqual(spawn);
    });
  });

  it("uses each trampoline's own radius for launch checks", () => {
    for (const pad of ARENA_LAYOUT.trampolines) {
      expect(isOnTrampolinePad(pad.x + pad.radius - 0.001, pad.z)).toBe(true);
      expect(isOnTrampolinePad(pad.x + pad.radius + 0.001, pad.z)).toBe(false);
    }
    const first = ARENA_LAYOUT.trampolines[0];
    if (first === undefined) throw new Error("default map needs a trampoline");
    const oldRadius = first.radius;
    try {
      first.radius = 0.3;
      expect(isOnTrampolinePad(first.x + 0.29, first.z)).toBe(true);
      expect(isOnTrampolinePad(first.x + 0.31, first.z)).toBe(false);
    } finally {
      first.radius = oldRadius;
    }
  });

  it("keeps at most three distinct neutral pickup points", () => {
    expect(ARENA_LAYOUT.pickups).toHaveLength(3);
    for (const pickup of ARENA_LAYOUT.pickups) {
      expect(pickup).toEqual({ x: expect.any(Number), z: expect.any(Number) });
    }
    const extra = structuredClone(ARENA_LAYOUT);
    extra.pickups.push({ x: 0, z: 8 });
    expect(() => validateArenaLayout(extra)).toThrow(/at most three neutral pickup/);
    const duplicate = structuredClone(ARENA_LAYOUT);
    duplicate.pickups[1] = { ...duplicate.pickups[0]! };
    expect(() => validateArenaLayout(duplicate)).toThrow(/duplicate pickup position/);
  });
});
