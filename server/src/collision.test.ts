import { describe, expect, it } from "vitest";
import {
  PLAYER_BODY_RADIUS,
  RAMP_ENTRY_TOL,
  RAMP_LANE_CAPTURE_TOL,
  SERVER_OBSTACLES,
  SERVER_PLATFORMS,
  SUPPORT_STICK_TOL,
} from "./config.js";
import { rampBandHeightAt } from "./hits.js";
import { resolveGroundMove, resolvePlayerMove } from "./rooms/ArenaRoom.js";

// Through-wall fix: authoritative per-axis XZ collision for humans + bots.
// Obstacle corner block is at (4.8, 4.8) hx=hz=1; with the 0.5 body radius
// the expanded faces sit at 3.3 / 6.3. Platform 0 is at (13.8, -8.5)
// hx=hz=1.2 with the ramp on +z (open max-z face at -6.8 expanded).
// NOTE: face coords are decimal-subtracted (4.8 - 1 - 0.5), so assertions
// use toBeCloseTo, never exact toEqual on positions.
describe("resolvePlayerMove (server authoritative movement collision)", () => {
  it("runs on the 0.5 body radius mirror", () => {
    expect(PLAYER_BODY_RADIUS).toBe(0.5);
  });

  it("leaves free movement untouched", () => {
    expect(resolvePlayerMove(0, 0, 1, 1)).toEqual({ x: 1, z: 1 });
    expect(resolvePlayerMove(-10, 5, -9.5, 5.2)).toEqual({ x: -9.5, z: 5.2 });
  });

  it("stops dead at the obstacle face on a head-on push", () => {
    const headOn = resolvePlayerMove(1.0, 4.8, 4.0, 4.8);
    expect(headOn.x).toBeCloseTo(3.3, 9);
    expect(headOn.z).toBeCloseTo(4.8, 9);
    // Resting contact stays pinned, never creeps in.
    const resting = resolvePlayerMove(3.3, 4.8, 3.6, 4.8);
    expect(resting.x).toBeCloseTo(3.3, 9);
    expect(resting.z).toBeCloseTo(4.8, 9);
    // From the far side the max face stops symmetrically.
    const far = resolvePlayerMove(8.0, 4.8, 5.0, 4.8);
    expect(far.x).toBeCloseTo(6.3, 9);
    expect(far.z).toBeCloseTo(4.8, 9);
  });

  it("slides along the face on diagonal input (X blocked, Z free)", () => {
    const slid = resolvePlayerMove(3.2, 4.8, 4.0, 5.6);
    expect(slid.x).toBeCloseTo(3.3, 9);
    expect(slid.z).toBeCloseTo(5.6, 9);
  });

  it("slides along the face on a corner approach, never ending inside", () => {
    const first = resolvePlayerMove(3.0, 3.0, 4.5, 4.5);
    expect(first.x).toBeCloseTo(4.5, 9);
    expect(first.z).toBeCloseTo(3.3, 9);
    // Resting exactly ON the expanded face still collides (strict-inside
    // escape rule) — the next diagonal step slides, it does not penetrate.
    const second = resolvePlayerMove(first.x, first.z, first.x + 0.2, first.z + 0.2);
    expect(second.x).toBeCloseTo(4.7, 9);
    expect(second.z).toBeCloseTo(3.3, 9);
    const insideX = Math.abs(second.x - 4.8) < 1.5 - 1e-9;
    const insideZ = Math.abs(second.z - 4.8) < 1.5 - 1e-9;
    expect(insideX && insideZ).toBe(false);
  });

  it("blocks the platform sheer sides", () => {
    // Platform 0 min-x face at 13.8 - 1.2 - 0.5 = 12.1.
    const minX = resolvePlayerMove(10, -8.5, 13, -8.5);
    expect(minX.x).toBeCloseTo(12.1, 9);
    expect(minX.z).toBeCloseTo(-8.5, 9);
    // Max-x face at 15.5.
    const maxX = resolvePlayerMove(17, -8.5, 14, -8.5);
    expect(maxX.x).toBeCloseTo(15.5, 9);
    expect(maxX.z).toBeCloseTo(-8.5, 9);
    // Min-z face at -8.5 - 1.2 - 0.5 = -10.2.
    const minZ = resolvePlayerMove(13.8, -12, 13.8, -9);
    expect(minZ.x).toBeCloseTo(13.8, 9);
    expect(minZ.z).toBeCloseTo(-10.2, 9);
  });

  it("admits climbing fighters through the ramp-side face, blocks ground entry", () => {
    // Platform 0 ramp is on +z: the max-z face (-6.8 expanded) opens only
    // for a mover that is actually climbing (feet above RAMP_ADMIT_MIN_FEET).
    const cross = resolvePlayerMove(13.8, -6.0, 13.8, -7.5, 0.5, 2.0);
    expect(cross.x).toBeCloseTo(13.8, 9);
    expect(cross.z).toBeCloseTo(-7.5, 9);
    // Full entry from the ramp side walks into the footprint at climb height.
    const entry = resolvePlayerMove(13.8, -4, 13.8, -8.5, 0.5, 1.8);
    expect(entry.x).toBeCloseTo(13.8, 9);
    expect(entry.z).toBeCloseTo(-8.5, 9);
    // Same steps at ground level: clamped at the face like a sheer wall.
    const grounded = resolvePlayerMove(13.8, -6.0, 13.8, -7.5, 0.5, 0);
    expect(grounded.z).toBeCloseTo(-6.8, 9);
  });

  it("ejects ground-level embeds toward the nearest face (never trapped, never through)", () => {
    // Embedded at platform 0's center below the top: ejected to the nearest
    // faces (tie goes min), never a free pass to the far side.
    const embedded = resolvePlayerMove(13.8, -8.5, 16, -8.5, 0.5, 0);
    expect(embedded.x).toBeCloseTo(12.1, 9);
    expect(embedded.z).toBeCloseTo(-10.2, 9);
    // Embedded at the tower center: corner eject onto the faces...
    const towerEmbed = resolvePlayerMove(4.8, 4.8, 5.5, 4.8, 0.5, 0);
    expect(towerEmbed.x).toBeCloseTo(3.3, 9);
    expect(towerEmbed.z).toBeCloseTo(3.3, 9);
    // ...and the next step away walks off freely (escape still works).
    const walkOff = resolvePlayerMove(towerEmbed.x, towerEmbed.z, 3.0, 3.0, 0.5, 0);
    expect(walkOff.x).toBeCloseTo(3.0, 9);
    expect(walkOff.z).toBeCloseTo(3.0, 9);
    // At/above the top the old free pass is kept: on-top fighters walk out.
    const offTop = resolvePlayerMove(13.8, -8.5, 16, -8.5, 0.5, 2.6);
    expect(offTop.x).toBeCloseTo(16, 9);
    expect(offTop.z).toBeCloseTo(-8.5, 9);
  });

  it("refuses garbage instead of teleporting", () => {
    expect(resolvePlayerMove(1, 2, Number.NaN, 4)).toEqual({ x: 1, z: 2 });
    expect(resolvePlayerMove(1, 2, 3, 4, -1)).toEqual({ x: 1, z: 2 });
  });

  it("resting contact survives float dust (pinned fighter cannot leak through)", () => {
    // Production sequence that once leaked: the face clamp lands ~1 ULP
    // inside the expanded bound (different rounding of x-hx-r vs |x-px|),
    // and the next push must re-clamp — never flip into the inside-escape.
    const pinned = resolvePlayerMove(12.024999999999997, -8.5, 12.25, -8.5);
    expect(pinned.x).toBeCloseTo(12.1, 9);
    expect(pinned.z).toBeCloseTo(-8.5, 9);
    for (let i = 0; i < 10; i += 1) {
      const next = resolvePlayerMove(pinned.x, pinned.z, pinned.x + 0.225, pinned.z);
      expect(next.x).toBeCloseTo(12.1, 9);
      expect(next.z).toBeCloseTo(-8.5, 9);
      pinned.x = next.x;
      pinned.z = next.z;
    }
  });
});

// Elevation gate (bug B): solids at/below the mover's feet never clamp.
// Central tower (4.8, 4.8) topY 2.0, expanded faces 3.3/6.3; outer block
// (10.8, 0) topY 0.8, expanded min-x face 8.8; platform 0 (13.8, -8.5) topY
// 2.6 with the +z ramp corridor |x - 13.8| <= 1.0 (support band, no radius
// widening), open face -6.8 admitting climbers only (feet > 0.3).
describe("resolvePlayerMove elevation gate + ramp corridor", () => {
  it("lets a tower-top fighter walk the CENTER (no invisible wall)", () => {
    // Feet 2.0 on the 2.0 tower top: straight through the middle. Starts
    // are OUTSIDE the expanded footprint, so the old inside-escape cannot
    // explain the pass — only the elevation gate lets these through (on the
    // pre-fix code both clamp at the 6.3 face).
    const cross = resolvePlayerMove(6.5, 4.8, 5.5, 4.8, 0.5, 2.0);
    expect(cross.x).toBeCloseTo(5.5, 9);
    expect(cross.z).toBeCloseTo(4.8, 9);
    const walkIn = resolvePlayerMove(6.5, 4.8, 4.8, 4.8, 0.5, 2.0);
    expect(walkIn.x).toBeCloseTo(4.8, 9);
    expect(walkIn.z).toBeCloseTo(4.8, 9);
  });

  it("blocks ground-level entry from all four sides (feet 0)", () => {
    expect(resolvePlayerMove(1.0, 4.8, 4.0, 4.8, 0.5, 0).x).toBeCloseTo(3.3, 9);
    expect(resolvePlayerMove(8.0, 4.8, 5.0, 4.8, 0.5, 0).x).toBeCloseTo(6.3, 9);
    expect(resolvePlayerMove(4.8, 1.0, 4.8, 4.0, 0.5, 0).z).toBeCloseTo(3.3, 9);
    expect(resolvePlayerMove(4.8, 8.0, 4.8, 5.0, 0.5, 0).z).toBeCloseTo(6.3, 9);
    // Diagonal corner approach at ground stays out too.
    const corner = resolvePlayerMove(3.0, 3.0, 4.5, 4.5, 0.5, 0);
    const insideX = Math.abs(corner.x - 4.8) < 1.5 - 1e-9;
    const insideZ = Math.abs(corner.z - 4.8) < 1.5 - 1e-9;
    expect(insideX && insideZ).toBe(false);
  });

  it("lets trampoline flights cross low blocks, blocks low flight into them", () => {
    // Feet 1.0 above the 0.8 outer-block top: full crossing, no clamp.
    const over = resolvePlayerMove(8.0, 0, 12.0, 0, 0.5, 1.0);
    expect(over.x).toBeCloseTo(12.0, 9);
    expect(over.z).toBeCloseTo(0, 9);
    // Feet 0.5 below the top: the min-x face (8.8) stops the flight, like
    // the client capsule hitting the wall mid-jump.
    const into = resolvePlayerMove(8.0, 0, 12.0, 0, 0.5, 0.5);
    expect(into.x).toBeCloseTo(8.8, 9);
    expect(into.z).toBeCloseTo(0, 9);
  });

  it("admits ramp-corridor entry for climbers, blocks ground skirting", () => {
    // Inside the +z corridor (|13.0 - 13.8| = 0.8 <= 1.0) at climb height:
    // open face passes.
    const inCorridor = resolvePlayerMove(13.0, -6.5, 13.0, -7.5, 0.5, 2.0);
    expect(inCorridor.z).toBeCloseTo(-7.5, 9);
    // Same step at ground level: the open face behaves closed.
    const grounded = resolvePlayerMove(13.0, -6.5, 13.0, -7.5, 0.5, 0);
    expect(grounded.z).toBeCloseTo(-6.8, 9);
    // Outside the corridor but inside the face span (sliver [12.1, 12.3)):
    // the open face behaves closed even at climb height — no +radius band.
    const skirt = resolvePlayerMove(12.2, -6.5, 12.2, -7.5, 0.5, 2.0);
    expect(skirt.z).toBeCloseTo(-6.8, 9);
    // Sheer faces keep blocking at ground even next to the ramp.
    const sheer = resolvePlayerMove(10, -8.5, 13, -8.5, 0.5, 0);
    expect(sheer.x).toBeCloseTo(12.1, 9);
  });

  it("captures just-outside-corridor climbers into the lane, blocks the rest", () => {
    // Bug round 4, defect 2: platform 0 (+z ramp, corridor |x - 13.8| <= 1.0,
    // open max-z face -6.8, slope at the face ~2.53m). An admitted climber
    // crossing just outside the corridor is re-laned instead of clamped.
    expect(RAMP_LANE_CAPTURE_TOL).toBe(0.5);
    const captured = resolvePlayerMove(15.0, -6.5, 15.0, -7.0, 0.5, 2.4);
    expect(captured.z).toBeCloseTo(-7.0, 9);
    // Precision 6: the projection sits FOOTPRINT_EPS infield of the lane
    // edge (float-dust guard), not exactly on it.
    expect(captured.x).toBeCloseTo(14.8, 6);
    // Drifting out mid-crossing (from in-lane, target just out) is pulled
    // back into the lane instead of landing off-lane and ejecting.
    const relaned = resolvePlayerMove(14.7, -6.5, 14.9, -7.2, 0.5, 2.4);
    expect(relaned.z).toBeCloseTo(-7.2, 9);
    expect(relaned.x).toBeCloseTo(14.8, 6);
    // Well outside the reach (1.6 > 1.0 + 0.5): the face stays closed.
    const far = resolvePlayerMove(15.4, -6.5, 15.4, -7.0, 0.5, 2.4);
    expect(far.z).toBeCloseTo(-6.8, 9);
    expect(far.x).toBeCloseTo(15.4, 9);
    // Grounded at the same geometry: never admitted through any face.
    const grounded = resolvePlayerMove(15.0, -6.5, 15.0, -7.0, 0.5, 0);
    expect(grounded.z).toBeCloseTo(-6.8, 9);
    expect(grounded.x).toBeCloseTo(15.0, 9);
  });

  it("captures off-corridor climbers at ±x ramps too", () => {
    // Platform 4 (-x ramp, open min-x face 3.5, lane z in [12.7, 14.3],
    // slope at the projected entry ~1.93m): an admitted climber crossing
    // just north of the lane is re-laned south instead of clamped.
    const captured = resolvePlayerMove(3.3, 12.4, 3.7, 12.4, 0.5, 1.85);
    expect(captured.x).toBeCloseTo(3.7, 9);
    expect(captured.z).toBeCloseTo(12.7, 6);
    // Same geometry grounded: the sheer-side behavior is unchanged.
    const grounded = resolvePlayerMove(3.3, 12.4, 3.7, 12.4, 0.5, 0);
    expect(grounded.x).toBeCloseTo(3.5, 9);
  });

  it("lane capture never touches obstacles (corridorAxis null)", () => {
    // Central tower (4.8, 4.8) topY 2.0: an admitted mover below the top
    // still stops at the max-x face (6.3) — no open face, no capture.
    const tower = resolvePlayerMove(6.5, 4.8, 5.5, 4.8, 0.5, 1.0);
    expect(tower.x).toBeCloseTo(6.3, 9);
    expect(tower.z).toBeCloseTo(4.8, 9);
  });

  it("treats non-finite feet as ground level (never a free pass)", () => {
    const grounded = resolvePlayerMove(1.0, 4.8, 4.0, 4.8, 0.5, Number.NaN);
    expect(grounded.x).toBeCloseTo(3.3, 9);
  });
});

// Wedge-side entry block (bug A leak 2): resolveGroundMove holds a grounded
// mover out of the ramp band below its surface, lets climbers through, and
// slides diagonally along the band edge. Platform 4 (-x ramp, band z in
// [12.7, 14.3], surface at x = 2.0 is 1.50m).
describe("resolveGroundMove wedge-side block", () => {
  it("holds ground-level lateral entry at the band edge", () => {
    const held = resolveGroundMove(2.0, 12.0, 2.0, 12.9, 0.5, 0);
    expect(held.x).toBeCloseTo(2.0, 9);
    expect(held.z).toBeCloseTo(12.0, 9);
  });

  it("lets a climber at slope height step in", () => {
    const climb = resolveGroundMove(2.0, 12.0, 2.0, 12.9, 0.5, 1.6);
    expect(climb.x).toBeCloseTo(2.0, 9);
    expect(climb.z).toBeCloseTo(12.9, 9);
  });

  it("slides diagonally along the band edge instead of sticking", () => {
    const slide = resolveGroundMove(1.5, 12.0, 2.2, 12.9, 0.5, 0);
    expect(slide.x).toBeCloseTo(2.2, 9);
    expect(slide.z).toBeCloseTo(12.0, 9);
  });

  it("refuses garbage instead of teleporting", () => {
    expect(resolveGroundMove(1, 2, Number.NaN, 4, 0.5, 0)).toEqual({ x: 1, z: 2 });
    expect(resolveGroundMove(1, 2, 3, 4, -1, 0)).toEqual({ x: 1, z: 2 });
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
