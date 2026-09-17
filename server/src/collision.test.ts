import { describe, expect, it } from "vitest";
import { PLAYER_BODY_RADIUS } from "./config.js";
import { resolvePlayerMove } from "./rooms/ArenaRoom.js";

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

  it("lets fighters through the ramp-side face (climbing stays possible)", () => {
    // Platform 0 ramp is on +z: the max-z face (-6.8 expanded) is open.
    const cross = resolvePlayerMove(13.8, -6.0, 13.8, -7.5);
    expect(cross.x).toBeCloseTo(13.8, 9);
    expect(cross.z).toBeCloseTo(-7.5, 9);
    // Full entry from the ramp side walks into the footprint.
    const entry = resolvePlayerMove(13.8, -4, 13.8, -8.5);
    expect(entry.x).toBeCloseTo(13.8, 9);
    expect(entry.z).toBeCloseTo(-8.5, 9);
  });

  it("frees fighters already inside a footprint (platform top / knockback)", () => {
    // Standing on platform 0's top: free to walk off in any direction.
    const offTop = resolvePlayerMove(13.8, -8.5, 16, -8.5);
    expect(offTop.x).toBeCloseTo(16, 9);
    expect(offTop.z).toBeCloseTo(-8.5, 9);
    // Embedded inside a block by a knockback shove: free to walk out.
    const embedded = resolvePlayerMove(4.8, 4.8, 5.5, 4.8);
    expect(embedded.x).toBeCloseTo(5.5, 9);
    expect(embedded.z).toBeCloseTo(4.8, 9);
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
