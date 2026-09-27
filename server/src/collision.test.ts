import { describe, expect, it } from "vitest";
import { rampRunForTop } from "../../shared/arena-layout.mjs";
import {
  BODY_CENTER_Y,
  PLAYER_BODY_RADIUS,
  RAMP_ENTRY_TOL,
  RAMP_LANE_CAPTURE_TOL,
  SERVER_OBSTACLES,
  SERVER_PLATFORMS,
  SUPPORT_STICK_TOL,
} from "./config.js";
import { bodyCenterYForFighterAt, rampBandHeightAt, rampClearsCapsuleAt } from "./hits.js";
import { resolveGroundMove, resolvePlayerMove } from "./rooms/ArenaRoom.js";

// Use the saved layout's collision geometry. Editors can move these solids,
// so tests should not keep the positions from the previous arena layout.
const tower = SERVER_OBSTACLES.find((block) => block.x > 0 && block.z > 0 && block.topY >= 2)!;
const outerBlock = SERVER_OBSTACLES.find((block) => block.x > 0 && block.z > 0 && block.topY < 2)!;
const frontRamp = SERVER_PLATFORMS.find((platform) => platform.rampSide === "+z")!;
const sideRamp = SERVER_PLATFORMS.find((platform) => platform.rampSide === "-x")!;
const radius = PLAYER_BODY_RADIUS;
const towerWest = tower.x - tower.hx - radius;
const towerEast = tower.x + tower.hx + radius;
const towerNorth = tower.z - tower.hz - radius;
const towerSouth = tower.z + tower.hz + radius;
const frontWest = frontRamp.x - frontRamp.hx - radius;
const frontEast = frontRamp.x + frontRamp.hx + radius;
const frontNorth = frontRamp.z - frontRamp.hz - radius;
const frontMouth = frontRamp.z + frontRamp.hz + radius;

// Face assertions use toBeCloseTo because decimal subtraction introduces
// roundoff at the radius-expanded boundary.
describe("resolvePlayerMove (server authoritative movement collision)", () => {
  it("runs on the 0.5 body radius mirror", () => {
    expect(PLAYER_BODY_RADIUS).toBe(0.5);
  });

  it("leaves free movement untouched", () => {
    expect(resolvePlayerMove(0, 0, 1, 1)).toEqual({ x: 1, z: 1 });
    expect(resolvePlayerMove(-10, 5, -9.5, 5.2)).toEqual({ x: -9.5, z: 5.2 });
  });

  it("stops dead at the obstacle face on a head-on push", () => {
    const headOn = resolvePlayerMove(towerWest - 2, tower.z, towerWest + 0.7, tower.z);
    expect(headOn.x).toBeCloseTo(towerWest, 9);
    expect(headOn.z).toBeCloseTo(tower.z, 9);
    // Resting contact stays pinned, never creeps in.
    const resting = resolvePlayerMove(towerWest, tower.z, towerWest + 0.3, tower.z);
    expect(resting.x).toBeCloseTo(towerWest, 9);
    expect(resting.z).toBeCloseTo(tower.z, 9);
    // From the far side the max face stops symmetrically.
    const far = resolvePlayerMove(towerEast + 1.7, tower.z, towerEast - 1.3, tower.z);
    expect(far.x).toBeCloseTo(towerEast, 9);
    expect(far.z).toBeCloseTo(tower.z, 9);
  });

  it("slides along the face on diagonal input (X blocked, Z free)", () => {
    const slid = resolvePlayerMove(towerWest - 0.1, tower.z, towerWest + 0.7, tower.z + 0.8);
    expect(slid.x).toBeCloseTo(towerWest, 9);
    expect(slid.z).toBeCloseTo(tower.z + 0.8, 9);
  });

  it("slides along the face on a corner approach, never ending inside", () => {
    const first = resolvePlayerMove(towerWest - 0.3, towerNorth - 0.3, tower.x - 0.3, tower.z - 0.3);
    expect(first.x).toBeCloseTo(tower.x - 0.3, 9);
    expect(first.z).toBeCloseTo(towerNorth, 9);
    // Resting exactly ON the expanded face still collides (strict-inside
    // escape rule) — the next diagonal step slides, it does not penetrate.
    const second = resolvePlayerMove(first.x, first.z, first.x + 0.2, first.z + 0.2);
    expect(second.x).toBeCloseTo(tower.x - 0.1, 9);
    expect(second.z).toBeCloseTo(towerNorth, 9);
    const insideX = Math.abs(second.x - tower.x) < tower.hx + radius - 1e-9;
    const insideZ = Math.abs(second.z - tower.z) < tower.hz + radius - 1e-9;
    expect(insideX && insideZ).toBe(false);
  });

  it("blocks the platform sheer sides", () => {
    const minX = resolvePlayerMove(frontWest - 2, frontRamp.z, frontWest + 0.9, frontRamp.z);
    expect(minX.x).toBeCloseTo(frontWest, 9);
    expect(minX.z).toBeCloseTo(frontRamp.z, 9);
    const maxX = resolvePlayerMove(frontEast + 2, frontRamp.z, frontEast - 0.9, frontRamp.z);
    expect(maxX.x).toBeCloseTo(frontEast, 9);
    expect(maxX.z).toBeCloseTo(frontRamp.z, 9);
    const minZ = resolvePlayerMove(frontRamp.x, frontNorth - 2, frontRamp.x, frontNorth + 1.2);
    expect(minZ.x).toBeCloseTo(frontRamp.x, 9);
    expect(minZ.z).toBeCloseTo(frontNorth, 9);
  });

  it("admits climbing fighters through the ramp-side face, blocks ground entry", () => {
    // The +z mouth admits a fighter already climbing the slope.
    const climbFeet = frontRamp.topY - 0.6;
    const cross = resolvePlayerMove(frontRamp.x, frontMouth + 0.8, frontRamp.x, frontMouth - 0.7, radius, climbFeet);
    expect(cross.x).toBeCloseTo(frontRamp.x, 9);
    expect(cross.z).toBeCloseTo(frontMouth - 0.7, 9);
    // Full entry from the ramp side walks into the footprint at climb height.
    const entry = resolvePlayerMove(frontRamp.x, frontMouth + 4, frontRamp.x, frontRamp.z, radius, climbFeet);
    expect(entry.x).toBeCloseTo(frontRamp.x, 9);
    expect(entry.z).toBeCloseTo(frontRamp.z, 9);
    // Same steps at ground level: clamped at the face like a sheer wall.
    const grounded = resolvePlayerMove(frontRamp.x, frontMouth + 0.8, frontRamp.x, frontMouth - 0.7, radius, 0);
    expect(grounded.z).toBeCloseTo(frontMouth, 9);
  });

  it("ejects ground-level embeds toward the nearest face (never trapped, never through)", () => {
    // Embedded at the platform center below the top: ejected to the nearest
    // faces (tie goes min), never a free pass to the far side.
    const embedded = resolvePlayerMove(frontRamp.x, frontRamp.z, frontEast + 0.5, frontRamp.z, radius, 0);
    expect(embedded.x).toBeCloseTo(frontWest, 9);
    expect(embedded.z).toBeCloseTo(frontNorth, 9);
    // Embedded at the tower center: corner eject onto the faces...
    const towerEmbed = resolvePlayerMove(tower.x, tower.z, tower.x + 0.7, tower.z, radius, 0);
    expect(towerEmbed.x).toBeCloseTo(towerWest, 9);
    expect(towerEmbed.z).toBeCloseTo(towerNorth, 9);
    // ...and the next step away walks off freely (escape still works).
    const walkOff = resolvePlayerMove(towerEmbed.x, towerEmbed.z, towerWest - 0.3, towerNorth - 0.3, radius, 0);
    expect(walkOff.x).toBeCloseTo(towerWest - 0.3, 9);
    expect(walkOff.z).toBeCloseTo(towerNorth - 0.3, 9);
    // At/above the top, fighters can walk out freely.
    const offTop = resolvePlayerMove(frontRamp.x, frontRamp.z, frontEast + 0.5, frontRamp.z, radius, frontRamp.topY);
    expect(offTop.x).toBeCloseTo(frontEast + 0.5, 9);
    expect(offTop.z).toBeCloseTo(frontRamp.z, 9);
  });

  it("refuses garbage instead of teleporting", () => {
    expect(resolvePlayerMove(1, 2, Number.NaN, 4)).toEqual({ x: 1, z: 2 });
    expect(resolvePlayerMove(1, 2, 3, 4, -1)).toEqual({ x: 1, z: 2 });
  });

  it("resting contact survives float dust (pinned fighter cannot leak through)", () => {
    // Production sequence that once leaked: the face clamp lands ~1 ULP
    // inside the expanded bound (different rounding of x-hx-r vs |x-px|),
    // and the next push must re-clamp — never flip into the inside-escape.
    const pinned = resolvePlayerMove(frontWest - 0.075000000000003, frontRamp.z, frontWest + 0.15, frontRamp.z);
    expect(pinned.x).toBeCloseTo(frontWest, 9);
    expect(pinned.z).toBeCloseTo(frontRamp.z, 9);
    for (let i = 0; i < 10; i += 1) {
      const next = resolvePlayerMove(pinned.x, pinned.z, pinned.x + 0.225, pinned.z);
      expect(next.x).toBeCloseTo(frontWest, 9);
      expect(next.z).toBeCloseTo(frontRamp.z, 9);
      pinned.x = next.x;
      pinned.z = next.z;
    }
  });
});

// Elevation gate: solids at/below the mover's feet never clamp. The +z ramp
// admits climbers across its open mouth within rampWidth / 2 + body radius.
describe("resolvePlayerMove elevation gate + ramp corridor", () => {
  it("lets a tower-top fighter walk the CENTER (no invisible wall)", () => {
    // Starts outside the expanded footprint, so only the elevation gate
    // explains the pass into the center.
    const cross = resolvePlayerMove(towerEast + 0.2, tower.z, towerEast - 0.8, tower.z, radius, tower.topY);
    expect(cross.x).toBeCloseTo(towerEast - 0.8, 9);
    expect(cross.z).toBeCloseTo(tower.z, 9);
    const walkIn = resolvePlayerMove(towerEast + 0.2, tower.z, tower.x, tower.z, radius, tower.topY);
    expect(walkIn.x).toBeCloseTo(tower.x, 9);
    expect(walkIn.z).toBeCloseTo(tower.z, 9);
  });

  it("blocks ground-level entry from all four sides (feet 0)", () => {
    expect(resolvePlayerMove(towerWest - 2, tower.z, towerWest + 0.7, tower.z, radius, 0).x).toBeCloseTo(towerWest, 9);
    expect(resolvePlayerMove(towerEast + 1.7, tower.z, towerEast - 1.3, tower.z, radius, 0).x).toBeCloseTo(towerEast, 9);
    expect(resolvePlayerMove(tower.x, towerNorth - 2, tower.x, towerNorth + 0.7, radius, 0).z).toBeCloseTo(towerNorth, 9);
    expect(resolvePlayerMove(tower.x, towerSouth + 1.7, tower.x, towerSouth - 1.3, radius, 0).z).toBeCloseTo(towerSouth, 9);
    // Diagonal corner approach at ground stays out too.
    const corner = resolvePlayerMove(towerWest - 0.3, towerNorth - 0.3, tower.x - 0.3, tower.z - 0.3, radius, 0);
    const insideX = Math.abs(corner.x - tower.x) < tower.hx + radius - 1e-9;
    const insideZ = Math.abs(corner.z - tower.z) < tower.hz + radius - 1e-9;
    expect(insideX && insideZ).toBe(false);
  });

  it("lets trampoline flights cross low blocks, blocks low flight into them", () => {
    const west = outerBlock.x - outerBlock.hx - radius;
    const east = outerBlock.x + outerBlock.hx + radius;
    const over = resolvePlayerMove(west - 0.8, outerBlock.z, east + 0.8, outerBlock.z, radius, outerBlock.topY + 0.2);
    expect(over.x).toBeCloseTo(east + 0.8, 9);
    expect(over.z).toBeCloseTo(outerBlock.z, 9);
    // A low flight still hits the block's radius-expanded west face.
    const into = resolvePlayerMove(west - 0.8, outerBlock.z, east + 0.8, outerBlock.z, radius, outerBlock.topY - 0.5);
    expect(into.x).toBeCloseTo(west, 9);
    expect(into.z).toBeCloseTo(outerBlock.z, 9);
  });

  it("admits ramp-corridor entry for climbers, blocks ground skirting", () => {
    const laneX = frontRamp.x - frontRamp.rampWidth / 2 + 0.2;
    const feet = frontRamp.topY - 0.6;
    const inCorridor = resolvePlayerMove(laneX, frontMouth + 0.3, laneX, frontMouth - 0.7, radius, feet);
    expect(inCorridor.z).toBeCloseTo(frontMouth - 0.7, 9);
    // Same step at ground level: the open face behaves closed.
    const grounded = resolvePlayerMove(laneX, frontMouth + 0.3, laneX, frontMouth - 0.7, radius, 0);
    expect(grounded.z).toBeCloseTo(frontMouth, 9);
    // Past the lane's radius overlap, the mouth remains a wall.
    const skirtX = frontRamp.x - frontRamp.rampWidth / 2 - radius - 0.1;
    const skirt = resolvePlayerMove(skirtX, frontMouth + 0.3, skirtX, frontMouth - 0.7, radius, feet);
    expect(skirt.z).toBeCloseTo(frontMouth, 9);
    // Sheer faces keep blocking at ground even next to the ramp.
    const sheer = resolvePlayerMove(frontWest - 1, frontRamp.z, frontWest + 0.9, frontRamp.z, radius, 0);
    expect(sheer.x).toBeCloseTo(frontWest, 9);
  });

  it("admits capsule-overlap climbers outside the visual ramp lane, blocks the rest", () => {
    expect(RAMP_LANE_CAPTURE_TOL).toBe(radius);
    const justOutsideX = frontRamp.x + frontRamp.rampWidth / 2 + 0.2;
    const feet = frontRamp.topY - 0.6;
    const overlap = resolvePlayerMove(justOutsideX, frontMouth + 0.3, justOutsideX, frontMouth - 0.2, radius, feet);
    expect(overlap.z).toBeCloseTo(frontMouth - 0.2, 9);
    expect(overlap.x).toBeCloseTo(justOutsideX, 9);
    const drift = resolvePlayerMove(frontRamp.x + 0.9, frontMouth + 0.3, frontRamp.x + 1.1, frontMouth - 0.3, radius, feet);
    expect(drift.z).toBeCloseTo(frontMouth - 0.3, 9);
    expect(drift.x).toBeCloseTo(frontRamp.x + 1.1, 9);
    const farX = frontRamp.x + frontRamp.rampWidth / 2 + radius + 0.1;
    const far = resolvePlayerMove(farX, frontMouth + 0.3, farX, frontMouth - 0.2, radius, feet);
    expect(far.z).toBeCloseTo(frontMouth, 9);
    expect(far.x).toBeCloseTo(farX, 9);
    const grounded = resolvePlayerMove(justOutsideX, frontMouth + 0.3, justOutsideX, frontMouth - 0.2, radius, 0);
    expect(grounded.z).toBeCloseTo(frontMouth, 9);
    expect(grounded.x).toBeCloseTo(justOutsideX, 9);
  });

  it("admits capsule-overlap climbers at ±x ramps too", () => {
    const mouth = sideRamp.x - sideRamp.hx - radius;
    const laneZ = sideRamp.z - sideRamp.rampWidth / 2 - 0.3;
    const climbFeet = sideRamp.topY - 0.3;
    const crossing = resolvePlayerMove(mouth - 0.2, laneZ, mouth + 0.2, laneZ, radius, climbFeet);
    expect(crossing.x).toBeCloseTo(mouth + 0.2, 9);
    expect(crossing.z).toBeCloseTo(laneZ, 9);
    // Same geometry grounded: the sheer-side behavior is unchanged.
    const grounded = resolvePlayerMove(mouth - 0.2, laneZ, mouth + 0.2, laneZ, radius, 0);
    expect(grounded.x).toBeCloseTo(mouth, 9);
  });

  it("lane capture never touches obstacles (corridorAxis null)", () => {
    const belowTop = resolvePlayerMove(towerEast + 0.2, tower.z, towerEast - 0.8, tower.z, radius, tower.topY - 1);
    expect(belowTop.x).toBeCloseTo(towerEast, 9);
    expect(belowTop.z).toBeCloseTo(tower.z, 9);
  });

  it("treats non-finite feet as ground level (never a free pass)", () => {
    const grounded = resolvePlayerMove(towerWest - 2, tower.z, towerWest + 0.7, tower.z, radius, Number.NaN);
    expect(grounded.x).toBeCloseTo(towerWest, 9);
  });
});

// At the low part of a -x ramp, the wedge still blocks lateral ground entry.
// Its height is half the platform top and below the standing capsule height.
describe("resolveGroundMove wedge-side block", () => {
  const lowSlopeX = sideRamp.x - sideRamp.hx - rampRunForTop(sideRamp.topY) / 2;
  const outsideZ = sideRamp.z - sideRamp.rampWidth / 2 - radius - 0.2;
  const insideZ = sideRamp.z - sideRamp.rampWidth / 2 + 0.3;

  it("holds ground-level lateral entry at the band edge", () => {
    const held = resolveGroundMove(lowSlopeX, outsideZ, lowSlopeX, insideZ, radius, 0);
    expect(held.x).toBeCloseTo(lowSlopeX, 9);
    expect(held.z).toBeCloseTo(outsideZ, 9);
  });

  it("lets a climber at slope height step in", () => {
    const feet = rampBandHeightAt(lowSlopeX, sideRamp.z);
    const climb = resolveGroundMove(lowSlopeX, outsideZ, lowSlopeX, insideZ, radius, feet + 0.1);
    expect(climb.x).toBeCloseTo(lowSlopeX, 9);
    expect(climb.z).toBeCloseTo(insideZ, 9);
  });

  it("slides diagonally along the band edge instead of sticking", () => {
    const slide = resolveGroundMove(lowSlopeX, outsideZ, lowSlopeX - 0.3, insideZ, radius, 0);
    expect(slide.x).toBeCloseTo(lowSlopeX - 0.3, 9);
    expect(slide.z).toBeCloseTo(outsideZ, 9);
  });

  it("refuses garbage instead of teleporting", () => {
    expect(resolveGroundMove(1, 2, Number.NaN, 4, 0.5, 0)).toEqual({ x: 1, z: 2 });
    expect(resolveGroundMove(1, 2, 3, 4, -1, 0)).toEqual({ x: 1, z: 2 });
  });
});

describe("ramp clearance for a grounded two-metre capsule", () => {
  const rampEdgeZ = frontRamp.z + frontRamp.hz;
  const rampRun = rampRunForTop(frontRamp.topY);
  const zAtHeight = (height: number): number => rampEdgeZ + rampRun * (1 - height / frontRamp.topY);
  const highZ = zAtHeight(2.6);
  const lowZ = zAtHeight(1.5);
  const outsideX = frontRamp.x - frontRamp.rampWidth / 2 - radius - 0.25;
  const insideX = frontRamp.x - frontRamp.rampWidth / 2 + 0.25;

  it("allows lateral running under the high section without lifting the fighter", () => {
    expect(rampBandHeightAt(frontRamp.x, highZ)).toBeCloseTo(2.6, 9);
    expect(rampClearsCapsuleAt(frontRamp, insideX, highZ, 0, radius)).toBe(true);
    const enter = resolveGroundMove(outsideX, highZ, insideX, highZ, radius, 0);
    expect(enter).toEqual({ x: insideX, z: highZ });
    const continueAcross = resolveGroundMove(enter.x, enter.z, frontRamp.x, highZ, radius, 0);
    expect(continueAcross).toEqual({ x: frontRamp.x, z: highZ });
    expect(bodyCenterYForFighterAt(frontRamp.x, highZ, 0, radius)).toBeCloseTo(BODY_CENTER_Y, 9);
  });

  it("keeps the low section solid at ground level", () => {
    expect(rampBandHeightAt(frontRamp.x, lowZ)).toBeCloseTo(1.5, 9);
    expect(rampClearsCapsuleAt(frontRamp, insideX, lowZ, 0, radius)).toBe(false);
    const blocked = resolveGroundMove(outsideX, lowZ, insideX, lowZ, radius, 0);
    expect(blocked.x).toBeCloseTo(outsideX, 9);
    expect(blocked.z).toBeCloseTo(lowZ, 9);
  });

  it("still lets a fighter advance up the ramp at its surface height", () => {
    const fromZ = zAtHeight(1);
    const toZ = fromZ - 0.2;
    const feet = rampBandHeightAt(frontRamp.x, fromZ);
    expect(feet).toBeCloseTo(1, 9);
    const climbed = resolveGroundMove(frontRamp.x, fromZ, frontRamp.x, toZ, radius, feet);
    expect(climbed.x).toBeCloseTo(frontRamp.x, 9);
    expect(climbed.z).toBeCloseTo(toZ, 9);
  });
});

// Grounded airtightness fuzz (bug round 4): an exhaustive deterministic grid
// around every solid sweeps 8 directions at walk-step (0.225m) and knockback
// length (1.2m) with feet 0. A grounded mover must never finish strictly
// inside a radius-expanded footprint below its top: faces clamp, embeds eject
// to the boundary, and the lane capture never fires without feet. 1e-6 slack
// is far above float dust (~1e-15 at these magnitudes) and far below any real
// penetration, so boundary rests pass and any pass-through fails.
describe("resolveGroundMove airtightness fuzz (grounded)", () => {
  it("a grounded sweep never ends inside any solid below its top", () => {
    const solids: ReadonlyArray<{ x: number; z: number; hx: number; hz: number; topY: number }> = [
      ...SERVER_OBSTACLES,
      ...SERVER_PLATFORMS,
    ];
    const dirs: ReadonlyArray<readonly [number, number]> = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ];
    const r = PLAYER_BODY_RADIUS;
    let checked = 0;
    let violations = 0;
    for (const solid of solids) {
      for (
        let gx = solid.x - solid.hx - r - 1;
        gx <= solid.x + solid.hx + r + 1 + 1e-9;
        gx += 0.25
      ) {
        for (
          let gz = solid.z - solid.hz - r - 1;
          gz <= solid.z + solid.hz + r + 1 + 1e-9;
          gz += 0.25
        ) {
          for (const [dx, dz] of dirs) {
            for (const step of [0.225, 1.2]) {
              const out = resolveGroundMove(gx, gz, gx + dx * step, gz + dz * step, r, 0);
              checked += 1;
              if (!Number.isFinite(out.x) || !Number.isFinite(out.z)) {
                violations += 1;
                continue;
              }
              for (const other of solids) {
                const insideX = Math.abs(out.x - other.x) < other.hx + r - 1e-6;
                const insideZ = Math.abs(out.z - other.z) < other.hz + r - 1e-6;
                if (insideX && insideZ && other.topY > 1e-6) {
                  violations += 1;
                }
              }
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(10000);
    expect(violations).toBe(0);
  });

  it("ring-zone supported-band walks stay fully free (never clamp-hover stuck)", () => {
    // Bug round 5, defect 1 companion: from every ring-zone position (inside
    // the radius-expanded footprint, outside the strict one) with feet in the
    // hysteresis stick band [top - SUPPORT_STICK_TOL, top], an 8-direction
    // walk-step must pass through untouched — the mover is still supported on
    // top there (groundSupport holds the expanded top), so the elevation gate
    // must skip the solid instead of clamping/ejecting. Pre-fix the TOL
    // window below EPS clamped or ejected (invisible wall at the footprint
    // boundary). 1e-9 exactness: a skipped solid leaves the target
    // bit-identical (scalar copy, no math), far above float dust and far
    // below any real clamp (>= 0.05 shortfall to count as stuck).
    expect(SUPPORT_STICK_TOL).toBe(0.05);
    const solids: ReadonlyArray<{ x: number; z: number; hx: number; hz: number; topY: number }> = [
      ...SERVER_OBSTACLES,
      ...SERVER_PLATFORMS,
    ];
    const dirs: ReadonlyArray<readonly [number, number]> = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ];
    const r = PLAYER_BODY_RADIUS;
    let checked = 0;
    let stuck = 0;
    for (const solid of solids) {
      for (const feetBelow of [0, 0.02, SUPPORT_STICK_TOL]) {
        const feet = solid.topY - feetBelow;
        for (
          let gx = solid.x - solid.hx - r - 0.25;
          gx <= solid.x + solid.hx + r + 0.25 + 1e-9;
          gx += 0.25
        ) {
          for (
            let gz = solid.z - solid.hz - r - 0.25;
            gz <= solid.z + solid.hz + r + 0.25 + 1e-9;
            gz += 0.25
          ) {
            const strictIn =
              Math.abs(gx - solid.x) <= solid.hx && Math.abs(gz - solid.z) <= solid.hz;
            const expandIn =
              Math.abs(gx - solid.x) <= solid.hx + r && Math.abs(gz - solid.z) <= solid.hz + r;
            if (strictIn || !expandIn) {
              continue;
            }
            for (const [dx, dz] of dirs) {
              const length = Math.hypot(dx, dz);
              const tx = gx + (dx / length) * 0.225;
              const tz = gz + (dz / length) * 0.225;
              // Wedge-governed targets (stepping into another solid's ramp
              // band below its surface) are held by design — bug A leak 2,
              // pinned by the wedge-side block tests. The gate assertion
              // below only covers targets the wedge lets through, so it
              // isolates the round-5 gate behavior instead of re-pinning the
              // wedge.
              if (rampBandHeightAt(tx, tz) > feet + RAMP_ENTRY_TOL) {
                continue;
              }
              const out = resolveGroundMove(gx, gz, tx, tz, r, feet);
              checked += 1;
              if (!Number.isFinite(out.x) || !Number.isFinite(out.z)) {
                stuck += 1;
                continue;
              }
              if (Math.abs(out.x - tx) > 1e-9 || Math.abs(out.z - tz) > 1e-9) {
                stuck += 1;
              }
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(10000);
    expect(stuck).toBe(0);
  });
});
