import * as THREE from "three";
import { afterEach, describe, expect, it } from "vitest";
import {
  SELF_RECONCILE_BIG_DIV,
  SELF_RECONCILE_BIG_DIV_HOLD_S,
  SELF_RECONCILE_MIN_M,
  SELF_RECONCILE_SNAP_M,
  SELF_RECONCILE_SNAP_XZ_INSET,
  SELF_RECONCILE_STALL_INPUT_MIN,
  SELF_RECONCILE_STALL_MIN_DIV,
  SELF_RECONCILE_STALL_MIN_FRAMES,
  SELF_RECONCILE_STALL_MIN_PROGRESS_M,
  SELF_RECONCILE_STALL_WINDOW_S,
  SELF_RECONCILE_UP_SNAP_MAX_DIV,
} from "../config";
import { SceneManager } from "./SceneManager";

const FRAME = 1 / 60;

const managers: SceneManager[] = [];

async function createFighter(): Promise<SceneManager> {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 200);
  const manager = new SceneManager(scene, camera);
  manager.build();
  const ready = await manager.initPhysics();
  expect(ready).toBe(true);
  manager.setSpectating(false);
  managers.push(manager);
  return manager;
}

afterEach(() => {
  for (const manager of managers.splice(0, managers.length)) {
    manager.dispose();
  }
});

describe("self spawn teleport (welcome/respawn gap fix)", () => {
  it("teleports avatar + Rapier body to the server spawn", async () => {
    const manager = await createFighter();
    manager.teleportSelf(-12, 12);
    const avatar = manager.getAvatarPosition();
    expect(avatar.x).toBeCloseTo(-12, 5);
    expect(avatar.z).toBeCloseTo(12, 5);
    const body = manager.getPlayerVelocity();
    expect(body).not.toBe(null);
    // Velocity zeroed by the teleport (physics.reset path).
    if (body !== null) {
      expect(Math.hypot(body.x, body.z)).toBeCloseTo(0, 5);
    }
  });

  it("ignores non-finite coords instead of corrupting the body", async () => {
    const manager = await createFighter();
    manager.teleportSelf(3, 4);
    manager.teleportSelf(Number.NaN, 0);
    const avatar = manager.getAvatarPosition();
    expect(avatar.x).toBeCloseTo(3, 5);
    expect(avatar.z).toBeCloseTo(4, 5);
  });
});

describe("reconcile telemetry (F3 snap-gate overlay source)", () => {
  it("exposes every gate field and records a stall-snap event", async () => {
    // The overlay renders from this object only — pin the field contract:
    // pre-snap it carries the server/local Y, divergence, stall-gate
    // outcomes and the matched top; the snap itself bumps the counter and
    // timestamps it. moveMag 1 feeds the input gate (reconcile runs before
    // physics, so live input arrives as a parameter from main.ts). The body
    // sits dipped 0.15 on the strict tower top (a genuine-wedge div inside
    // the [0.03, 0.45] band) with the server snapshot on the strict top, so
    // every gate passes; the snap fires once the window holds >= 5 frames of
    // stall evidence (fresh windows report "stall-warming", never snap).
    const manager = await createFighter();
    const before = manager.getLastReconcileTelemetry();
    expect(before.result).toBe("unrun");
    expect(before.upSnapCount).toBe(0);
    expect(before.lastUpSnapAtMs).toBe(0);
    expect(before.bigHealCount).toBe(0);
    expect(before.lastBigHealAtMs).toBe(0);
    manager.debugSetPlayerState({ x: 5.5, y: 2.95, z: 4.8 }, { x: 0, y: 0, z: 0 });
    let snapped = false;
    for (let i = 0; i < 10 && !snapped; i += 1) {
      snapped = manager.reconcileSelf(5.5, 3.1, 4.8, FRAME, 1) === "snap";
    }
    expect(snapped).toBe(true);
    const after = manager.getLastReconcileTelemetry();
    expect(after.result).toBe("snap");
    expect(after.snapKind).toBe("up");
    expect(after.serverY).toBeCloseTo(3.1, 5);
    expect(after.localY).toBeCloseTo(2.95, 5);
    expect(after.divergence).toBeCloseTo(0.15, 5);
    expect(after.divOk).toBe(true);
    expect(after.moveMag).toBeCloseTo(1, 5);
    expect(after.inputOk).toBe(true);
    expect(after.stallOk).toBe(true);
    expect(after.stallFrames).toBeGreaterThanOrEqual(5);
    expect(after.stallFramesOk).toBe(true);
    expect(after.levelTopIndex).toBeGreaterThanOrEqual(0);
    expect(after.levelTopY).toBeCloseTo(3.1, 5);
    expect(after.xzOk).toBe(true);
    expect(after.srvXzOnTop).toBe(true);
    expect(after.upSnapCount).toBe(1);
    expect(after.lastUpSnapAtMs).toBeGreaterThan(0);
    expect(after.note).toBe("up-snap");
    // Per-top hold (bug round 9): the snap arms the hold on the top it
    // landed on, so F3 can show the suppress state live.
    expect(after.heldTopIndex).toBe(after.evalTopIndex);
    expect(after.heldTopIndex).toBeGreaterThanOrEqual(0);
    const landed = manager.getAvatarPosition();
    expect(landed.x).toBeCloseTo(5.5, 5);
    expect(landed.z).toBeCloseTo(4.8, 5);
    expect(landed.y).toBeCloseTo(3.0, 5);
  });
});

describe("self reconciliation (bounded drift, no jitter)", () => {
  it("holds local position when drift is under the min band", async () => {
    const manager = await createFighter();
    manager.teleportSelf(0, 0);
    const before = manager.getAvatarPosition();
    const small = SELF_RECONCILE_MIN_M / 2;
    const result = manager.reconcileSelf(small, 1.1, 0, FRAME);
    expect(result).toBe("ok");
    const after = manager.getAvatarPosition();
    expect(after.x).toBeCloseTo(before.x, 10);
    expect(after.z).toBeCloseTo(before.z, 10);
  });

  it("lerps partway toward mid-range drift (no snap, no jitter)", async () => {
    const manager = await createFighter();
    manager.teleportSelf(0, 0);
    const result = manager.reconcileSelf(2, 1.1, 0, FRAME);
    expect(result).toBe("lerp");
    const after = manager.getAvatarPosition();
    expect(after.x).toBeGreaterThan(0);
    expect(after.x).toBeLessThan(2);
  });

  it("snaps far drift beyond the snap band (spawn/respawn scale)", async () => {
    const manager = await createFighter();
    manager.teleportSelf(0, 0);
    const far = SELF_RECONCILE_SNAP_M + 5;
    const result = manager.reconcileSelf(far, 1.1, 0, FRAME);
    expect(result).toBe("snap");
    const after = manager.getAvatarPosition();
    expect(after.x).toBeCloseTo(far, 5);
    expect(after.z).toBeCloseTo(0, 5);
  });

  it("skips while spectating", async () => {
    const manager = await createFighter();
    manager.setSpectating(true);
    expect(manager.reconcileSelf(10, 1.1, 10, FRAME)).toBe("skipped");
  });

  it("converges toward a legal server target near an obstacle (no pass-through)", async () => {
    // Through-wall fix regression pin: the server now only emits positions
    // outside geometry, so reconcile must ease onto a legal target — and the
    // reconcile path itself is untouched (deadband hold + lerp, no clip).
    // Note the honest contract: inside the 0.7m deadband reconcile HOLDS
    // (returns "ok", no jitter correction), so convergence stops at the
    // band edge, not exactly on the target.
    const manager = await createFighter();
    manager.teleportSelf(1.0, 4.8);
    for (let i = 0; i < 120; i += 1) {
      manager.reconcileSelf(2.5, 1.1, 4.8, FRAME);
    }
    const after = manager.getAvatarPosition();
    // Eased from 1.0 to the deadband edge (~1.8), never past the target…
    expect(after.x).toBeGreaterThan(1.7);
    expect(after.x).toBeLessThanOrEqual(2.5);
    expect(after.z).toBeCloseTo(4.8, 5);
    // …and the eased path never ends embedded in the block (3.3 face).
    expect(after.x).toBeLessThanOrEqual(3.3 + 0.15);
  });

  it("does not fight a tower-top server position (bug 3a end state)", async () => {
    // The server now tracks tower-top XZ authoritatively (bugs 1/3a fix), so
    // when the local body stands at the tower center and the snapshot agrees
    // (including Y), reconcile holds inside the deadband instead of tugging
    // the avatar off. The body is seeded ON TOP via the teleport Y param.
    const manager = await createFighter();
    manager.teleportSelf(4.8, 4.8, 3.1);
    const result = manager.reconcileSelf(4.8, 3.1, 4.8, FRAME);
    expect(result).toBe("ok");
    const after = manager.getAvatarPosition();
    expect(after.x).toBeCloseTo(4.8, 5);
    expect(after.z).toBeCloseTo(4.8, 5);
    expect(after.y).toBeCloseTo(3.1, 5);
  });
});

// Bug round 7: stall-detector snap onto block tops + big-div downward heal.
// Round 6/6b/6c history: the Y-threshold UP-snap (0.15 -> 0.11) plus the 6c
// low-speed gate (1.5) never healed anything live — owner F3 video proved
// healthy Rapier rest sits EXACTLY 0.100 below the server nominal AND the
// resting lip-wedge sits there too, so Y-divergence alone cannot discriminate
// (the 0.11 hang gate was 0.01 above the wedge: structurally blind), and the
// only viable window (t=5.2s, div 0.154) was blocked by our own speed gate
// (body speed 3.108 > 1.5). Both constants are DELETED, not retuned: the
// discriminator is now STALL EVIDENCE (input active + XZ not progressing
// over a 0.25 s window), and the frozen -2.1 desync gets a sustained big-div
// down-pull. reconcileSelf takes the live stick magnitude as moveMag (it
// runs before physics in main.ts, so input arrives as a parameter).
// Bug round 8 (tower-top snap loop): on the two-story central towers healthy
// rest (div 0.100) always clears the stall div floor and the whole top + ring
// sits in the footprint gate, so walking could drain the travel window and
// resnap every cooldown — teleporting to RAW server XZ that the server's
// hysteresis holds over the void (fall, grind, resnap). Three hardening
// layers: the div gate is now a BAND (0.03-0.45, grounded post-fall div ~2.0
// never up-snaps), up-snap targets clamp just inside the strict lip and a
// ring-only server XZ refuses outright ("server-off-top"), and the window
// scores NET DISPLACEMENT with >= 5 observed frames before it may stall.
describe("self reconciliation stall-snap onto block tops (bug round 7)", () => {
  it("pins the stall/big-div tuning (speed gate deleted per live telemetry)", () => {
    // The round-6c speed gate (1.5) blocked the only live heal window
    // (t=5.2s: div 0.154 with body speed 3.108) while descents it prevented
    // are cosmetic next to a hard wall — removed entirely, no replacement
    // threshold. The stall window (0.25 s / 0.12 m) separates walking
    // (4.5 m/s x 0.25 s ~= 1.1 m >> 0.12) from a lip wedge (net ~0):
    // descents and step-offs progress in XZ, so no speed read is needed.
    // Round 8 (tower-top snap loop): the div gate is now a BAND (a grounded
    // post-fall desync at div ~= 2.0 must never up-snap — big-div owns it),
    // the window needs >= 5 observed frames before it may report a stall
    // (fresh/hitched windows carry no evidence), and snap landings clamp a
    // hair inside the strict lip.
    expect(SELF_RECONCILE_STALL_MIN_DIV).toBe(0.03);
    expect(SELF_RECONCILE_UP_SNAP_MAX_DIV).toBe(0.45);
    expect(SELF_RECONCILE_STALL_INPUT_MIN).toBe(0.5);
    expect(SELF_RECONCILE_STALL_WINDOW_S).toBe(0.25);
    expect(SELF_RECONCILE_STALL_MIN_PROGRESS_M).toBe(0.12);
    expect(SELF_RECONCILE_STALL_MIN_FRAMES).toBe(5);
    expect(SELF_RECONCILE_SNAP_XZ_INSET).toBe(0.01);
    expect(SELF_RECONCILE_BIG_DIV).toBe(0.5);
    expect(SELF_RECONCILE_BIG_DIV_HOLD_S).toBe(0.4);
  });

  it("snaps a stalled live wedge with input (the video's t=5.5-6.8s state)", async () => {
    // Round 7 core discriminator: a Rapier-settled lip wedge (15 cm dip, a
    // genuine wedge inside the [0.03, 0.45] div band) with the server snapshot
    // on the STRICT tower top and the stick held (moveMag 1) snaps once the
    // window holds >= 5 frames of stall evidence — and lands at Rapier rest
    // height (serverY - REST_OFFSET = 3.0) at the server XZ. Asserts within
    // 10 frames (the snap fires on the 5th tracked frame).
    const manager = await createFighter();
    manager.debugSetPlayerState({ x: 5.5, y: 2.95, z: 4.8 }, { x: 0, y: 0, z: 0 });
    let snapped = false;
    for (let i = 0; i < 10 && !snapped; i += 1) {
      snapped = manager.reconcileSelf(5.5, 3.1, 4.8, FRAME, 1) === "snap";
    }
    expect(snapped).toBe(true);
    const after = manager.getAvatarPosition();
    expect(after.x).toBeCloseTo(5.5, 5);
    expect(after.z).toBeCloseTo(4.8, 5);
    expect(after.y).toBeCloseTo(3.0, 5);
    expect(manager.getLastReconcileTelemetry().snapKind).toBe("up");
  });

  it("never snaps the same wedge without input (revert-proof: stall starved)", async () => {
    // The disabled-stall path: a would-otherwise-snap wedge (strict-top dip,
    // div 0.15 inside the band, server on the strict top) but moveMag 0 (no
    // input). No snap may ever fire over 60 frames — this is what "the stall
    // logic disabled" looks like, and it must hold "ok" (deadband XZ) while
    // the body settles onto the top via Rapier. If a future hang-gate
    // reappears, this test fails first.
    const manager = await createFighter();
    manager.debugSetPlayerState({ x: 5.5, y: 2.95, z: 4.8 }, { x: 0, y: 0, z: 0 });
    for (let i = 0; i < 60; i += 1) {
      const result = manager.reconcileSelf(5.5, 3.1, 4.8, FRAME, 0);
      expect(result).not.toBe("snap");
      manager.update(FRAME, { x: 0, y: 0 }, { dx: 0, dy: 0 });
    }
    const after = manager.getAvatarPosition();
    expect(after.y).toBeCloseTo(3.0, 1);
    expect(manager.getLastReconcileTelemetry().upSnapCount).toBe(0);
    expect(manager.getLastReconcileTelemetry().note).toBe("no-input");
  });

  it("heals a natural Rapier wedge: walk to the lip, stall, snap, walk home", async () => {
    // End to end with real Rapier, no y-override: teleport to the tower top
    // at true rest (3.0), walk east until the lip dips the body (divergence
    // >= 0.03 — the resting wedge qualifies now), grind west into the lip
    // with the stick held (reconcile moveMag 1 + west input each frame) so
    // the window drains to a stall, and the snap must fire within ~0.5 s
    // landing at rest height — then the walk reaches home.
    const manager = await createFighter();
    manager.teleportSelf(4.8, 4.8, 3.0);
    let onset = -1;
    for (let i = 0; i < 90 && onset < 0; i += 1) {
      manager.update(FRAME, { x: 1, y: 0 }, { dx: 0, dy: 0 });
      if (3.1 - manager.getAvatarPosition().y >= 0.03) {
        onset = i;
      }
    }
    expect(onset).toBeGreaterThanOrEqual(0);
    let snappedAt = -1;
    for (let i = 0; i < 30; i += 1) {
      const current = manager.getAvatarPosition();
      const result = manager.reconcileSelf(current.x, 3.1, current.z, FRAME, 1);
      if (result === "snap") {
        snappedAt = i;
        break;
      }
      manager.update(FRAME, { x: -1, y: 0 }, { dx: 0, dy: 0 });
    }
    expect(snappedAt).toBeGreaterThanOrEqual(0);
    const healed = manager.getAvatarPosition();
    expect(healed.y).toBeCloseTo(3.0, 5);
    for (let i = 0; i < 90; i += 1) {
      manager.update(FRAME, { x: -1, y: 0 }, { dx: 0, dy: 0 });
    }
    const end = manager.getAvatarPosition();
    expect(end.x).toBeLessThan(5.9);
    expect(end.y).toBeGreaterThan(2.5);
  });

  it("never snaps during healthy rest (120-frame settle, no phantom pops)", async () => {
    // No-input guard: standing still at healthy rest (divergence exactly
    // ~0.10, server agreeing) with the stick released must hold "ok" every
    // frame for 2 full seconds — the input gate, not a Y threshold, is what
    // separates rest from a wedge now. If this flakes, the input gate or the
    // window seeding regressed.
    const manager = await createFighter();
    manager.teleportSelf(4.8, 4.8, 3.0);
    let snaps = 0;
    for (let i = 0; i < 120; i += 1) {
      manager.update(FRAME, { x: 0, y: 0 }, { dx: 0, dy: 0 });
      const result = manager.reconcileSelf(4.8, 3.1, 4.8, FRAME);
      if (result === "snap") {
        snaps += 1;
      } else {
        expect(result).toBe("ok");
      }
    }
    expect(snaps).toBe(0);
    const after = manager.getAvatarPosition();
    expect(after.y).toBeCloseTo(3.0, 2);
  });

  it("lands a lip-edge snapshot just inside the strict top (clamp pin)", async () => {
    // Server snapshot at the physical lip (5.795, 0.005 inside the 1.0
    // half-extent of the (4.8, 4.8) tower): strict-on-top, so the snap fires
    // — but the landing clamps a hair inside the lip (SNAP_XZ_INSET 0.01 ->
    // 5.79), never balanced on the collider edge. The client body sits
    // dipped 0.15 nearby with the stick held; the window warms over ~5
    // frames, then the snap lands supported at Rapier rest height.
    const manager = await createFighter();
    manager.debugSetPlayerState({ x: 5.7, y: 2.95, z: 4.8 }, { x: 0, y: 0, z: 0 });
    let snapped = false;
    for (let i = 0; i < 10 && !snapped; i += 1) {
      snapped = manager.reconcileSelf(5.795, 3.1, 4.8, FRAME, 1) === "snap";
    }
    expect(snapped).toBe(true);
    const after = manager.getAvatarPosition();
    expect(after.x).toBeCloseTo(5.79, 2);
    expect(after.x).toBeLessThan(5.795);
    expect(after.z).toBeCloseTo(4.8, 5);
    expect(after.y).toBeCloseTo(3.0, 5);
    expect(manager.getLastReconcileTelemetry().snapKind).toBe("up");
  });

  it("refuses an up-snap when the server XZ lives only in the hysteresis ring", async () => {
    // Inverse pin (tower-top snap loop): the client grinds in the east ring
    // (footprint gate passes — 1.45 <= hx + radius) with a genuine-wedge div
    // (0.15) and the stick held, but the server XZ (1.2 from the tower
    // center) sits where the local collider top does not exist. Snapping
    // there would land over the void (fall, grind, resnap: the loop), so no
    // up-snap may fire — note "server-off-top". The server is about to drop
    // anyway; the big-div heal owns that case.
    const manager = await createFighter();
    manager.debugSetPlayerState({ x: 6.25, y: 2.95, z: 4.8 }, { x: 0, y: 0, z: 0 });
    let snaps = 0;
    for (let i = 0; i < 15; i += 1) {
      if (manager.reconcileSelf(6.0, 3.1, 4.8, FRAME, 1) === "snap") {
        snaps += 1;
      }
    }
    expect(snaps).toBe(0);
    const telemetry = manager.getLastReconcileTelemetry();
    expect(telemetry.upSnapCount).toBe(0);
    expect(telemetry.snapKind).toBe("none");
    expect(telemetry.note).toBe("server-off-top");
  });

  it("does not snap when the server Y is mid-flight, not a top", async () => {
    // Arc height 2.5 near the tower: not an exact support level, so no snap
    // even with the stick held (XZ drift 0.25 stays "ok", body height
    // untouched) — flights are never stolen by the snap.
    const manager = await createFighter();
    manager.teleportSelf(6.25, 4.8);
    const result = manager.reconcileSelf(6.0, 2.5, 4.8, FRAME, 1);
    expect(result).toBe("ok");
    const after = manager.getAvatarPosition();
    expect(after.y).toBeCloseTo(1.1, 5);
  });

  it("does not snap a healthy rest on top without input", async () => {
    // Body resting at 3.0 with the server nominal 3.1: div 0.1 clears
    // STALL_MIN_DIV, but the stick is released (moveMag 0) — holds "ok", no
    // pop. The input gate is what protects healthy rest now.
    const manager = await createFighter();
    manager.teleportSelf(4.8, 4.8, 3.0);
    const result = manager.reconcileSelf(4.8, 3.1, 4.8, FRAME, 0);
    expect(result).toBe("ok");
    const after = manager.getAvatarPosition();
    expect(after.y).toBeCloseTo(3.0, 5);
  });

  it("does not snap up when the body is far from that block", async () => {
    // Server on the tower top, local body 2m+ away at the ground: not at the
    // block, so the XZ lerp path owns it (result "lerp", height untouched) —
    // walkers-by are never yanked onto a block they only pass, even with the
    // stick held and a stalled window.
    const manager = await createFighter();
    manager.teleportSelf(0, 0);
    const result = manager.reconcileSelf(2.0, 3.1, 0, FRAME, 1);
    expect(result).toBe("lerp");
    const after = manager.getAvatarPosition();
    expect(after.y).toBeCloseTo(1.1, 5);
  });

  it("heals the live loop: snap then walk-back advances (Rapier)", async () => {
    // The live loop end to end with real Rapier: dipped body on the strict
    // tower top (15 cm low = wedged) + authoritative on-top snapshot + stick
    // held. The window warms over ~5 frames, the snap lifts the body onto
    // the top at a supported (clamped) spot, then inward input walks it home
    // instead of grinding at the lip. Without the snap the same drive
    // gains ~0.1m in 90 frames (see the pre-fix revert proof).
    const manager = await createFighter();
    manager.debugSetPlayerState({ x: 5.5, y: 2.95, z: 4.8 }, { x: 0, y: 0, z: 0 });
    let snapped = false;
    for (let i = 0; i < 10 && !snapped; i += 1) {
      snapped = manager.reconcileSelf(5.5, 3.1, 4.8, FRAME, 1) === "snap";
    }
    expect(snapped).toBe(true);
    for (let i = 0; i < 90; i += 1) {
      manager.update(FRAME, { x: -1, y: 0 }, { dx: 0, dy: 0 });
    }
    const end = manager.getAvatarPosition();
    expect(end.x).toBeLessThan(5.9);
    expect(end.y).toBeGreaterThan(2.5);
  });

  it("never snaps while walking across a top with input (progress gate)", async () => {
    // The complement of the wedge: same div (0.1), same top level (P1 long
    // block, nominal 2.9), same footprint, stick held — but the body covers
    // ~2 m over the measured walk, so the window sum stays far above 0.12
    // and every frame holds "no-progress". The walk stays on top the whole
    // way (east face 2.4 m away, no lip contact), so this is deterministic.
    // Twelve update-only pre-roll frames warm up REAL travel first:
    // reconcile is not called during pre-roll (production calls it every
    // frame, but teleportSelf reseeds the window empty and the ground-accel
    // ramp (24 m/s^2) keeps the first ~3 frames under 0.05 m of travel — an
    // empty-looking window that WOULD stall-snap on the first reconcile.
    // In production that first frame carries div ~= 0 (fresh spawn agrees
    // with the server) or the 0.3 s cooldown (post-snap), so neither fires;
    // here the honest model is a body already at cruise speed (~0.5 m over
    // 12 frames), whose first measured window sum (~0.48) already clears
    // 0.12. Twenty measured frames (~1.5 m) keep the total walk to ~2 m —
    // safely inside the 2.4 m half-extent, never near the east lip.
    const manager = await createFighter();
    manager.teleportSelf(-13.5, 10.0, 2.8);
    for (let i = 0; i < 12; i += 1) {
      manager.update(FRAME, { x: 1, y: 0 }, { dx: 0, dy: 0 });
    }
    let snaps = 0;
    for (let i = 0; i < 20; i += 1) {
      const before = manager.getAvatarPosition();
      const result = manager.reconcileSelf(before.x, 2.9, before.z, FRAME, 1);
      if (result === "snap") {
        snaps += 1;
      }
      manager.update(FRAME, { x: 1, y: 0 }, { dx: 0, dy: 0 });
    }
    expect(snaps).toBe(0);
    expect(manager.getLastReconcileTelemetry().upSnapCount).toBe(0);
    expect(manager.getLastReconcileTelemetry().note).toBe("no-progress");
    const end = manager.getAvatarPosition();
    expect(end.x).toBeGreaterThan(-12.5);
    expect(end.y).toBeGreaterThan(2.5);
  });

  it("never snaps walking across a top through render hitches (net-displacement window)", async () => {
    // Hitch shape (tower-top snap loop): every 6th frame delivers 0.1 s of
    // wall time with zero travel (a dropped physics frame during a render
    // hitch — the wall-time slot rotation still turns) while the fighter
    // keeps walking east on the P1 long block at full stick. Net displacement
    // from the window's oldest surviving anchor still spans real travel
    // (~0.5 m+), so no frame reports a stall — SNAPS stays 0 and the walk
    // stays on top. A single 0.1 s hitch rotates only ~3 of 8 slots, so this
    // pins current net-displacement behavior rather than a pre-fix failure.
    // Shorter walk than the gate above (10 + 18 frames) so the
    // surviving-anchor span never nears the east lip.
    const manager = await createFighter();
    manager.teleportSelf(-13.5, 10.0, 2.8);
    for (let i = 0; i < 10; i += 1) {
      manager.update(FRAME, { x: 1, y: 0 }, { dx: 0, dy: 0 });
    }
    let snaps = 0;
    for (let i = 0; i < 18; i += 1) {
      const before = manager.getAvatarPosition();
      const hitch = i % 6 === 5;
      const result = hitch
        ? manager.reconcileSelf(before.x, 2.9, before.z, 0.1, 1)
        : manager.reconcileSelf(before.x, 2.9, before.z, FRAME, 1);
      if (result === "snap") {
        snaps += 1;
      }
      if (!hitch) {
        manager.update(FRAME, { x: 1, y: 0 }, { dx: 0, dy: 0 });
      }
    }
    expect(snaps).toBe(0);
    expect(manager.getLastReconcileTelemetry().upSnapCount).toBe(0);
    const hitchEnd = manager.getAvatarPosition();
    expect(hitchEnd.x).toBeGreaterThan(-12.5);
    expect(hitchEnd.y).toBeGreaterThan(2.5);
  });

  it("never snaps pushing into a ground-level wall (serverY matches no top)", async () => {
    // Ground wall with the stick held into the tower face: the body stalls
    // (window drains, input active, div ~0) but serverY 1.1 sits within
    // TOP_TOL of NO support level (platforms 2.9-3.7, blocks 3.1/1.9), so
    // every frame holds "no-level-match" and the body stays grounded.
    const manager = await createFighter();
    manager.teleportSelf(6.25, 4.8);
    let snaps = 0;
    for (let i = 0; i < 60; i += 1) {
      const before = manager.getAvatarPosition();
      const result = manager.reconcileSelf(before.x, 1.1, before.z, FRAME, 1);
      if (result === "snap") {
        snaps += 1;
      }
      manager.update(FRAME, { x: -1, y: 0 }, { dx: 0, dy: 0 });
    }
    expect(snaps).toBe(0);
    expect(manager.getLastReconcileTelemetry().note).toBe("no-level-match");
    const end = manager.getAvatarPosition();
    // Grounded band, not an exact height: 60 frames grinding into the face
    // sinks the capsule a few cm via Rapier contact resolution (measured
    // ~1.04 vs the 1.1 spawn height). The pin is grounded-not-snapped: well
    // above any fall-through, well below any block top.
    expect(end.y).toBeGreaterThan(0.9);
    expect(end.y).toBeLessThan(1.2);
    expect(end.x).toBeGreaterThan(5.9);
  });

  it("never stall-snaps on a fast ramp descent (progress gate, lagged server)", async () => {
    // Round 7 replacement for the deleted speed-gate descent pin (live
    // telemetry at t=5.2s killed the speed gate: it blocked the only viable
    // heal window). Climb the P0 ramp on its CENTER lane to the top with a
    // live-shaped server (body XZ + nominal +0.1 healthy offset, moveMag 1
    // every frame so the stall window is live, as in production), then
    // descend: the first 20 frames hold a stuck-at-top serverY (3.7, exact
    // level — worst realistic tick+latency lag, under the 0.4 s big-div
    // hold), then the server follows the 3-frame-lagged body down. The
    // divergence crosses the stall band mid-descent but the body covers
    // meters in XZ, so the window never drains. Center lane matters: an
    // edge-offset line (x=14.65) scrapes the top's east face at ~0.01 m/frame
    // — a TRUE edge-scrape stall the net window correctly reports (the old
    // path sum was merely jitter-masked there); the scrape class is pinned
    // by the wedge tests, this one pins the fast descent. One honest
    // allowance: while the snapshot is frozen (i<20) the body wedges on the
    // crest lip pushing back toward the ramp — a TRUE stall (net ~0 with
    // input held) that heals at most once IN PLACE (same XZ, rest Y: no
    // pop); once the server tracks down (i>=20) the descent is snap-free.
    const manager = await createFighter();
    manager.debugSetPlayerState({ x: 13.8, y: 1.1, z: 2.5 }, { x: 0, y: 0, z: 0 });
    for (let i = 0; i < 300; i += 1) {
      const before = manager.getAvatarPosition();
      manager.reconcileSelf(before.x, before.y + 0.1, before.z, FRAME, 1);
      manager.update(FRAME, { x: 0, y: 1 }, { dx: 0, dy: 0 });
      if (manager.getAvatarPosition().z < -8.5) {
        break;
      }
    }
    expect(manager.getAvatarPosition().y).toBeGreaterThan(3.0);
    const history: Array<{ x: number; y: number; z: number }> = [];
    const lagged = (): { x: number; y: number; z: number } => {
      if (history.length > 3) {
        return history[history.length - 4]!;
      }
      return history[0]!;
    };
    let stuckSnaps = 0;
    let trackedSnaps = 0;
    for (let i = 0; i < 120; i += 1) {
      const before = manager.getAvatarPosition();
      history.push({ x: before.x, y: before.y, z: before.z });
      const server = lagged();
      // Stuck-at-top nominal for the first 20 frames only (0.33 s < 0.4 s
      // big-div hold — a permanently stuck snapshot while grounded MUST heal
      // downward instead, see the big-div suite below).
      const serverY = i < 20 ? 3.7 : server.y;
      const result = manager.reconcileSelf(server.x, serverY, server.z, FRAME, 1);
      if (result === "snap") {
        if (i < 20) {
          stuckSnaps += 1;
        } else {
          trackedSnaps += 1;
        }
      }
      manager.update(FRAME, { x: 0, y: -1 }, { dx: 0, dy: 0 });
    }
    expect(trackedSnaps).toBe(0);
    expect(stuckSnaps).toBeLessThanOrEqual(1);
    expect(manager.getLastReconcileTelemetry().upSnapCount).toBe(stuckSnaps);
    expect(manager.getLastReconcileTelemetry().bigHealCount).toBe(0);
    // …and the descent genuinely completed down the ramp (off the top,
    // heading south), not yanked back or left frozen on the crest.
    const descentEnd = manager.getAvatarPosition();
    expect(descentEnd.y).toBeLessThan(3.0);
    expect(descentEnd.z).toBeGreaterThan(-7.0);
  });

  it("never snaps walking off a tower edge (lagged server follows the fall)", async () => {
    // Round 7 replacement for the deleted speed-gate step-off pin: walk east
    // off the tower top with input held while the server follows with a
    // realistic 3-frame (~50 ms) lag. The lagged divergence stays small
    // through the fall, the window shows continuous travel, and airborne
    // frames reset the big-div hold — so nothing fires and the walk-off
    // completes onto the ground far east, not yanked back.
    const manager = await createFighter();
    manager.teleportSelf(4.8, 4.8, 3.0);
    const history: Array<{ x: number; y: number; z: number }> = [];
    let snaps = 0;
    for (let i = 0; i < 120; i += 1) {
      const before = manager.getAvatarPosition();
      history.push({ x: before.x, y: before.y, z: before.z });
      const server = history.length > 3 ? history[history.length - 4]! : history[0]!;
      const result = manager.reconcileSelf(server.x, server.y, server.z, FRAME, 1);
      if (result === "snap") {
        snaps += 1;
      }
      manager.update(FRAME, { x: 1, y: 0 }, { dx: 0, dy: 0 });
    }
    expect(snaps).toBe(0);
    expect(manager.getLastReconcileTelemetry().upSnapCount).toBe(0);
    expect(manager.getLastReconcileTelemetry().bigHealCount).toBe(0);
    // …and the walk-off completed onto the ground far east, not yanked back.
    const end = manager.getAvatarPosition();
    expect(end.y).toBeLessThan(1.5);
  });

  it("snaps are cooldown-spaced across leave-and-re-enter visits (no tight loop)", async () => {
    // Round-9 rewrite of the persistent-wedge rhythm pin: after a snap onto
    // top T, re-dipping on T heals NEVER again (note "snap-rate" once the
    // 0.3 s cooldown expires) — the old cooldown-cadence resnap loop is
    // structurally gone, so the rhythm assertion moves to honest visits:
    // leave T's expanded footprint for >= 1 frame (re-arms) and re-enter,
    // and consecutive heals stay >= the 0.3 s cooldown (18 frames) apart.
    const manager = await createFighter();
    const snapFrames: number[] = [];
    let frame = 0;
    const grindDip = (): boolean => {
      manager.debugSetPlayerState({ x: 5.5, y: 2.95, z: 4.8 }, { x: 0, y: 0, z: 0 });
      frame += 1;
      return manager.reconcileSelf(5.5, 3.1, 4.8, FRAME, 1) === "snap";
    };
    // Visit 1: the first heal per visit fires once the window warms.
    let first = -1;
    for (let i = 0; i < 10 && first < 0; i += 1) {
      if (grindDip()) {
        first = frame;
      }
    }
    expect(first).toBeGreaterThanOrEqual(0);
    snapFrames.push(first);
    // Persistent grind WITHOUT leaving: no second heal ever (cooldown first,
    // then the per-top hold) — 40 grind frames, longer than the old loop's
    // multi-snap span, and the tail notes "snap-rate", not "cooldown".
    let extraSnaps = 0;
    for (let i = 0; i < 40; i += 1) {
      if (grindDip()) {
        extraSnaps += 1;
      }
    }
    expect(extraSnaps).toBe(0);
    expect(manager.getLastReconcileTelemetry().note).toBe("snap-rate");
    expect(manager.getLastReconcileTelemetry().upSnapCount).toBe(1);
    // Visits 2-3: neutral ground re-arms in one frame, then a teleport
    // re-entry reseeds the stall window (5 frames to warm), so each heal
    // lands on cooldown rhythm again.
    for (let visit = 0; visit < 2; visit += 1) {
      manager.teleportSelf(0, 0);
      for (let i = 0; i < 22; i += 1) {
        frame += 1;
        manager.reconcileSelf(0, 1.1, 0, FRAME, 1);
      }
      expect(manager.getLastReconcileTelemetry().heldTopIndex).toBe(-1);
      manager.teleportSelf(5.5, 4.8, 2.95);
      for (let i = 0; i < 10; i += 1) {
        if (grindDip()) {
          snapFrames.push(frame);
          break;
        }
      }
    }
    expect(snapFrames.length).toBe(3);
    for (let i = 1; i < snapFrames.length; i += 1) {
      expect(snapFrames[i]! - snapFrames[i - 1]!).toBeGreaterThanOrEqual(18);
    }
    const end = manager.getAvatarPosition();
    expect(end.y).toBeGreaterThan(2.9);
    expect(end.y).toBeLessThan(3.1);
  });

  it("cooldown suppresses an immediate second snap", async () => {
    // Unit-level pin for the cooldown mechanism itself: warm the window into
    // a snap (fires on the 5th tracked frame), which arms the 0.3 s cooldown;
    // the next frames must hold instead of re-snapping even though the wedge
    // persists and the window stays warmed (frames gate passes, cooldown
    // blocks — note "cooldown", not "stall-warming").
    const manager = await createFighter();
    manager.debugSetPlayerState({ x: 5.5, y: 2.95, z: 4.8 }, { x: 0, y: 0, z: 0 });
    let firstSnapAt = -1;
    for (let i = 0; i < 10; i += 1) {
      if (manager.reconcileSelf(5.5, 3.1, 4.8, FRAME, 1) === "snap") {
        firstSnapAt = i;
        break;
      }
    }
    expect(firstSnapAt).toBeGreaterThanOrEqual(0);
    manager.debugSetPlayerState({ x: 5.5, y: 2.95, z: 4.8 }, { x: 0, y: 0, z: 0 });
    let snaps = 0;
    for (let i = 0; i < 6; i += 1) {
      if (manager.reconcileSelf(5.5, 3.1, 4.8, FRAME, 1) === "snap") {
        snaps += 1;
      }
    }
    expect(snaps).toBe(0);
    expect(manager.getLastReconcileTelemetry().note).toBe("cooldown");
  });

  it("never up-snaps a grounded post-fall desync (div band refuses, big-div heals)", async () => {
    // Tower-top loop shape: the client fell to the ground (div ~= +2.0) while
    // the server still reports top level — the hysteresis-ring aftermath. An
    // UP-snap here would yank the grounded fighter back onto the tower (the
    // visible teleport jerk); the div band refuses it ("no-stall-div") while
    // the sustained hold heals the SAME desync via the big-div path to the
    // full server pose. Static body (no update): the hold trips at ~0.4 s,
    // and the landing keeps full-pose Y (no rest offset — the big-div heal
    // climbs the server XZ clamp only when a top level matches).
    const manager = await createFighter();
    manager.teleportSelf(5.5, 4.8);
    let midNote = "";
    let healKind = "none";
    let healedAt = -1;
    for (let i = 0; i < 40; i += 1) {
      const result = manager.reconcileSelf(5.5, 3.1, 4.8, FRAME, 1);
      if (i === 10) {
        midNote = manager.getLastReconcileTelemetry().note;
      }
      if (result === "snap") {
        healKind = manager.getLastReconcileTelemetry().snapKind;
        healedAt = i;
        break;
      }
    }
    expect(healedAt).toBeGreaterThanOrEqual(20);
    expect(healKind).toBe("big");
    expect(midNote).toBe("no-stall-div");
    const telemetry = manager.getLastReconcileTelemetry();
    expect(telemetry.upSnapCount).toBe(0);
    expect(telemetry.bigHealCount).toBe(1);
    const after = manager.getAvatarPosition();
    expect(after.x).toBeCloseTo(5.5, 5);
    expect(after.z).toBeCloseTo(4.8, 5);
    expect(after.y).toBeCloseTo(3.1, 5);
  });
});

// Bug round 9: per-top snap rate limit + widened div band + top preference.
// (a) Lip-grind on one top heals exactly once per visit (the live
// 15-snaps-in-8.5s cooldown-cadence loop is structurally impossible); (b) a
// ramp-crest wedge at div ~= 0.204 heals (was dead-zoned "no-stall-div" under
// the 0.2 bound); (c) a grounded post-fall div ~= 2.0 still never up-snaps;
// (d) with two same-level tops the loop and the F3 display prefer the one the
// server strictly stands on, not the first list entry.
describe("self reconciliation round-9 pins (rate limit, crest band, preference)", () => {
  it("heals a lip-grind exactly once per visit (per-top rate limit)", async () => {
    // A genuine wedge ground on the SAME tower top with every gate passing
    // heals once; 60 more grind frames (~1 s, > 3 expired cooldowns) never
    // resnap (note "snap-rate"). One frame outside the expanded footprint
    // (tower hx 1.0 + 0.5 radius = 1.5; x = 3.0 sits 1.8 out) re-arms, and a
    // re-entered grind heals exactly once more.
    const manager = await createFighter();
    manager.debugSetPlayerState({ x: 5.5, y: 2.95, z: 4.8 }, { x: 0, y: 0, z: 0 });
    let snaps = 0;
    let snapHeld = -2;
    let snapEval = -2;
    for (let i = 0; i < 6; i += 1) {
      if (manager.reconcileSelf(5.5, 3.1, 4.8, FRAME, 1) === "snap") {
        snaps += 1;
        // Capture on the firing frame: later cooldown frames reset the
        // per-call eval fields (no top evaluated while cooling down).
        snapHeld = manager.getLastReconcileTelemetry().heldTopIndex;
        snapEval = manager.getLastReconcileTelemetry().evalTopIndex;
      }
    }
    expect(snaps).toBe(1);
    expect(snapHeld).toBeGreaterThanOrEqual(0);
    expect(snapHeld).toBe(snapEval);
    let resnaps = 0;
    for (let i = 0; i < 60; i += 1) {
      manager.debugSetPlayerState({ x: 5.5, y: 2.95, z: 4.8 }, { x: 0, y: 0, z: 0 });
      if (manager.reconcileSelf(5.5, 3.1, 4.8, FRAME, 1) === "snap") {
        resnaps += 1;
      }
    }
    expect(resnaps).toBe(0);
    expect(manager.getLastReconcileTelemetry().note).toBe("snap-rate");
    expect(manager.getLastReconcileTelemetry().upSnapCount).toBe(1);
    // Leave for a single frame: the hold clears even though no other gate
    // changed (serverY 1.1 here matches no top, but the re-arm is purely the
    // client-XZ-vs-footprint comparison).
    manager.debugSetPlayerState({ x: 3.0, y: 1.1, z: 4.8 }, { x: 0, y: 0, z: 0 });
    manager.reconcileSelf(3.0, 1.1, 4.8, FRAME, 1);
    expect(manager.getLastReconcileTelemetry().heldTopIndex).toBe(-1);
    // Re-enter and grind: exactly one more heal, then held again.
    manager.teleportSelf(5.5, 4.8, 2.95);
    let returnSnaps = 0;
    for (let i = 0; i < 10; i += 1) {
      if (manager.reconcileSelf(5.5, 3.1, 4.8, FRAME, 1) === "snap") {
        returnSnaps += 1;
      }
    }
    expect(returnSnaps).toBe(1);
    expect(manager.getLastReconcileTelemetry().upSnapCount).toBe(2);
  });

  it("heals a ramp-crest wedge at div ~= 0.204 (crest band)", async () => {
    // Owner round-8 telemetry: wedged at a ramp-crest lip with div +0.204
    // (slope height on top of the 0.10 rest offset) while grounded, input
    // held, server on the strict top — refused as "no-stall-div" under the
    // 0.2 bound. P2 (x -11.5, z -9.5, topY 2.2 -> level 3.3, the only 3.3
    // top): client dipped 0.204 with both XZ in the footprints.
    const manager = await createFighter();
    manager.debugSetPlayerState({ x: -10.5, y: 3.096, z: -9.5 }, { x: 0, y: 0, z: 0 });
    let snapped = false;
    for (let i = 0; i < 10 && !snapped; i += 1) {
      snapped = manager.reconcileSelf(-10.5, 3.3, -9.5, FRAME, 1) === "snap";
    }
    expect(snapped).toBe(true);
    const telemetry = manager.getLastReconcileTelemetry();
    expect(telemetry.snapKind).toBe("up");
    expect(telemetry.divergence).toBeCloseTo(0.204, 2);
    expect(telemetry.note).toBe("up-snap");
    const after = manager.getAvatarPosition();
    expect(after.x).toBeCloseTo(-10.5, 5);
    expect(after.z).toBeCloseTo(-9.5, 5);
    expect(after.y).toBeCloseTo(3.2, 5);
  });

  it("never up-snaps a grounded post-fall div ~= 2.0 (band upper bound)", async () => {
    // Quick band pin: div 2.0 sits an order of magnitude above the 0.45 upper
    // bound — 10 input-held frames, zero up-snaps, note "no-stall-div" (the
    // sustained big-div heal for the same desync over its 0.4 s hold is
    // pinned separately below).
    const manager = await createFighter();
    manager.teleportSelf(5.5, 4.8);
    for (let i = 0; i < 10; i += 1) {
      const result = manager.reconcileSelf(5.5, 3.1, 4.8, FRAME, 1);
      expect(result).not.toBe("snap");
    }
    const telemetry = manager.getLastReconcileTelemetry();
    expect(telemetry.upSnapCount).toBe(0);
    expect(telemetry.snapKind).toBe("none");
    expect(telemetry.note).toBe("no-stall-div");
  });

  it("prefers the server-strict top over a first-match same-level top", async () => {
    // serverY 3.1 level-matches P3 (5.0, 13.5 — FIRST in list order) and the
    // central tower (4.8, 4.8) alike, but the server XZ stands strictly on
    // the tower. The pre-scan display must name the tower (first-match showed
    // P3 while the server stood elsewhere) and the snap must land on the
    // tower — never yanked across the map to P3.
    const manager = await createFighter();
    manager.debugSetPlayerState({ x: 5.5, y: 2.95, z: 4.8 }, { x: 0, y: 0, z: 0 });
    let snapped = false;
    for (let i = 0; i < 10 && !snapped; i += 1) {
      snapped = manager.reconcileSelf(5.5, 3.1, 4.8, FRAME, 1) === "snap";
    }
    expect(snapped).toBe(true);
    const telemetry = manager.getLastReconcileTelemetry();
    expect(telemetry.blockCenterX).toBeCloseTo(4.8, 5);
    expect(telemetry.blockCenterZ).toBeCloseTo(4.8, 5);
    expect(telemetry.levelTopIndex).toBe(telemetry.evalTopIndex);
    const after = manager.getAvatarPosition();
    expect(after.x).toBeCloseTo(5.5, 5);
    expect(after.z).toBeCloseTo(4.8, 5);
    expect(after.y).toBeCloseTo(3.0, 5);
  });
});

describe("self reconciliation big-div downward heal (bug round 7)", () => {
  it("heals a sustained server-below desync to the full server pose", async () => {
    // The video's t=6.9-14.4s frozen state: server fell to 1.1 while the
    // client stayed at 3.2 (div -2.1, no down-pull existed — 7.5 s stuck).
    // With the hold timer the heal lands ~0.4 s (24 frames) after the gap
    // opens: nothing fires in the first 12 frames, then exactly one big-heal
    // teleports to the FULL server pose (no rest offset — far-snap
    // semantics) and the hold resets so it never refires.
    const manager = await createFighter();
    manager.teleportSelf(4.8, 4.8, 3.0);
    let earlySnaps = 0;
    for (let i = 0; i < 12; i += 1) {
      const result = manager.reconcileSelf(4.8, 1.1, 4.8, FRAME, 0);
      if (result === "snap") {
        earlySnaps += 1;
      }
      manager.update(FRAME, { x: 0, y: 0 }, { dx: 0, dy: 0 });
    }
    expect(earlySnaps).toBe(0);
    let healedAt = -1;
    for (let i = 12; i < 30; i += 1) {
      const result = manager.reconcileSelf(4.8, 1.1, 4.8, FRAME, 0);
      if (result === "snap") {
        healedAt = i;
        break;
      }
      manager.update(FRAME, { x: 0, y: 0 }, { dx: 0, dy: 0 });
    }
    expect(healedAt).toBeGreaterThanOrEqual(12);
    const telemetry = manager.getLastReconcileTelemetry();
    expect(telemetry.snapKind).toBe("big");
    expect(telemetry.bigHealCount).toBe(1);
    expect(telemetry.note).toBe("big-heal");
    const after = manager.getAvatarPosition();
    expect(after.x).toBeCloseTo(4.8, 5);
    expect(after.z).toBeCloseTo(4.8, 5);
    expect(after.y).toBeCloseTo(1.1, 5);
    // Settles: agreement zeroes the hold, so no second heal follows.
    for (let i = 0; i < 30; i += 1) {
      manager.reconcileSelf(4.8, 1.1, 4.8, FRAME, 0);
      manager.update(FRAME, { x: 0, y: 0 }, { dx: 0, dy: 0 });
    }
    expect(manager.getLastReconcileTelemetry().bigHealCount).toBe(1);
  });

  it("never big-heals during a legitimate trampoline flight (airborne gate)", async () => {
    // A trampoline launch opens a huge |div| (server stays 1.1 while the body
    // climbs past 5), but every airborne frame resets the hold timer — apex
    // included (the exit hold outlasts the apex dip by design) — so the
    // flight and the landing never heal, and the counters stay zero.
    const manager = await createFighter();
    manager.debugSetPlayerState({ x: 0, y: 1.1, z: 0 }, { x: 0, y: 13.5, z: 0 });
    let snaps = 0;
    for (let i = 0; i < 120; i += 1) {
      const result = manager.reconcileSelf(0, 1.1, 0, FRAME, 0);
      if (result === "snap") {
        snaps += 1;
      }
      manager.update(FRAME, { x: 0, y: 0 }, { dx: 0, dy: 0 });
    }
    expect(snaps).toBe(0);
    expect(manager.getLastReconcileTelemetry().bigHealCount).toBe(0);
    expect(manager.getLastReconcileTelemetry().upSnapCount).toBe(0);
  });
});
