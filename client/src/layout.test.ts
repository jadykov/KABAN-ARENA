import { describe, expect, it } from "vitest";
import { rampRunForTop } from "../../shared/arena-layout.mjs";
import { getObstacleLayout, getPlatforms, getSpawnPoints, getTrampolines } from "./arena/Arena";
import { getPickupSlots } from "./arena/PowerUps";
import { ARENA_HALF_SIZE, ARENA_LAYOUT, validateArenaLayout } from "./layout";

describe("shared arena layout", () => {
  it("drives the client geometry, markers, and pickups", () => {
    expect(getObstacleLayout()).toEqual(ARENA_LAYOUT.obstacles.map((block) => ({
      x: block.x, z: block.z, hx: block.hx, hz: block.hz, hy: block.topY / 2,
    })));
    expect(getPlatforms()).toEqual(ARENA_LAYOUT.platforms.map((platform) => ({
      x: platform.x, z: platform.z, hx: platform.hx, hz: platform.hz, topY: platform.topY,
    })));
    expect(getTrampolines()).toEqual(ARENA_LAYOUT.trampolines);
    expect(getSpawnPoints()).toEqual(ARENA_LAYOUT.spawns);
    expect(getPickupSlots()).toEqual(ARENA_LAYOUT.pickups);
  });

  it("rejects edits that cannot produce a valid six-player arena", () => {
    const fewSpawns = structuredClone(ARENA_LAYOUT);
    fewSpawns.spawns.pop();
    expect(() => validateArenaLayout(fewSpawns)).toThrow(/spawns.*at least six/);

    const missingFace = structuredClone(ARENA_LAYOUT);
    const face = missingFace.platforms[0]!;
    missingFace.platforms[0]!.rampWidth = (face.rampSide.endsWith("x") ? face.hz : face.hx) * 2 + 0.01;
    expect(() => validateArenaLayout(missingFace)).toThrow(/platforms\[0\]\.rampWidth/);

    const outsideRamp = structuredClone(ARENA_LAYOUT);
    outsideRamp.platforms[0]!.x = ARENA_HALF_SIZE - outsideRamp.platforms[0]!.hx;
    outsideRamp.platforms[0]!.rampSide = "+x";
    expect(() => validateArenaLayout(outsideRamp)).toThrow(/platforms\[0\]\.rampSide/);

    const buriedPickup = structuredClone(ARENA_LAYOUT);
    buriedPickup.pickups[0]!.x = buriedPickup.obstacles[0]!.x;
    buriedPickup.pickups[0]!.z = buriedPickup.obstacles[0]!.z;
    expect(() => validateArenaLayout(buriedPickup)).toThrow(/pickups\[0\].*buried/);

    const buriedInRamp = structuredClone(ARENA_LAYOUT);
    const platform = buriedInRamp.platforms[0]!;
    const outward = rampRunForTop(platform.topY) * 0.1;
    if (platform.rampSide === "+x") {
      buriedInRamp.pickups[0]!.x = platform.x + platform.hx + outward;
      buriedInRamp.pickups[0]!.z = platform.z;
    } else if (platform.rampSide === "-x") {
      buriedInRamp.pickups[0]!.x = platform.x - platform.hx - outward;
      buriedInRamp.pickups[0]!.z = platform.z;
    } else if (platform.rampSide === "+z") {
      buriedInRamp.pickups[0]!.x = platform.x;
      buriedInRamp.pickups[0]!.z = platform.z + platform.hz + outward;
    } else {
      buriedInRamp.pickups[0]!.x = platform.x;
      buriedInRamp.pickups[0]!.z = platform.z - platform.hz - outward;
    }
    expect(() => validateArenaLayout(buriedInRamp)).toThrow(/pickups\[0\].*ramp/);
  });
});
