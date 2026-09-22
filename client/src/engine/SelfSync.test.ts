import * as THREE from "three";
import { afterEach, describe, expect, it } from "vitest";
import {
  SELF_RECONCILE_BIG_DIV,
  SELF_RECONCILE_BIG_DIV_HOLD_S,
  SELF_RECONCILE_MIN_M,
  SELF_RECONCILE_SNAP_M,
  SELF_RECONCILE_STALL_INPUT_MIN,
  SELF_RECONCILE_STALL_MIN_DIV,
  SELF_RECONCILE_STALL_MIN_PROGRESS_M,
  SELF_RECONCILE_STALL_WINDOW_S,
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
    // physics, so live input arrives as a parameter from main.ts).
    const manager = await createFighter();
    const before = manager.getLastReconcileTelemetry();
    expect(before.result).toBe("unrun");
    expect(before.upSnapCount).toBe(0);
    expect(before.lastUpSnapAtMs).toBe(0);
    expect(before.bigHealCount).toBe(0);
    expect(before.lastBigHealAtMs).toBe(0);
    manager.debugSetPlayerState({ x: 6.25, y: 2.9, z: 4.8 }, { x: 0, y: 0, z: 0 });
    expect(manager.reconcileSelf(6.25, 3.1, 4.8, FRAME, 1)).toBe("snap");
    const after = manager.getLastReconcileTelemetry();
    expect(after.result).toBe("snap");
    expect(after.snapKind).toBe("up");
    expect(after.serverY).toBeCloseTo(3.1, 5);
    expect(after.localY).toBeCloseTo(2.9, 5);
    expect(after.divergence).toBeCloseTo(0.2, 5);
    expect(after.divOk).toBe(true);
    expect(after.moveMag).toBeCloseTo(1, 5);
    expect(after.inputOk).toBe(true);
    expect(after.stallOk).toBe(true);
    expect(after.levelTopIndex).toBeGreaterThanOrEqual(0);
    expect(after.levelTopY).toBeCloseTo(3.1, 5);
    expect(after.xzOk).toBe(true);
    expect(after.upSnapCount).toBe(1);
    expect(after.lastUpSnapAtMs).toBeGreaterThan(0);
    expect(after.note).toBe("up-snap");
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
describe("self reconciliation stall-snap onto block tops (bug round 7)", () => {
  it("pins the stall/big-div tuning (speed gate deleted per live telemetry)", () => {
    // The round-6c speed gate (1.5) blocked the only live heal window
    // (t=5.2s: div 0.154 with body speed 3.108) while descents it prevented
    // are cosmetic next to a hard wall — removed entirely, no replacement
    // threshold. The stall window (0.25 s / 0.12 m) separates walking
    // (4.5 m/s x 0.25 s ~= 1.1 m >> 0.12) from a lip wedge (net ~0):
    // descents and step-offs progress in XZ, so no speed read is needed.
    expect(SELF_RECONCILE_STALL_MIN_DIV).toBe(0.03);
    expect(SELF_RECONCILE_STALL_INPUT_MIN).toBe(0.5);
    expect(SELF_RECONCILE_STALL_WINDOW_S).toBe(0.25);
    expect(SELF_RECONCILE_STALL_MIN_PROGRESS_M).toBe(0.12);
    expect(SELF_RECONCILE_BIG_DIV).toBe(0.5);
    expect(SELF_RECONCILE_BIG_DIV_HOLD_S).toBe(0.4);
  });

  it("snaps a stalled live wedge with input (the video's t=5.5-6.8s state)", async () => {
    // Round 7 core discriminator: a Rapier-settled lip wedge (10 cm dip =
    // fully wedged per the round-6 probes) with the server on top and the
    // stick held (moveMag 1) snaps on the first eligible frame — the stall
    // window is empty (no travel history = no evidence of motion) — and
    // lands at Rapier rest height (serverY - REST_OFFSET = 3.0) at the
    // server XZ. Asserts within ~0.3 s by firing immediately.
    const manager = await createFighter();
    manager.debugSetPlayerState({ x: 6.25, y: 2.9, z: 4.8 }, { x: 0, y: 0, z: 0 });
    const result = manager.reconcileSelf(6.25, 3.1, 4.8, FRAME, 1);
    expect(result).toBe("snap");
    const after = manager.getAvatarPosition();
    expect(after.x).toBeCloseTo(6.25, 5);
    expect(after.z).toBeCloseTo(4.8, 5);
    expect(after.y).toBeCloseTo(3.0, 5);
    expect(manager.getLastReconcileTelemetry().snapKind).toBe("up");
  });

  it("never snaps the same wedge without input (revert-proof: stall starved)", async () => {
    // The disabled-stall path: identical dip, top match and footprint, but
    // moveMag 0 (no input). No snap may ever fire over 60 frames — this is
    // what "the stall logic disabled" looks like, and it must hold "ok"
    // (deadband XZ) with Y untouched. If a future hang-gate reappears, this
    // test fails first.
    const manager = await createFighter();
    manager.debugSetPlayerState({ x: 6.25, y: 2.9, z: 4.8 }, { x: 0, y: 0, z: 0 });
    for (let i = 0; i < 60; i += 1) {
      const result = manager.reconcileSelf(6.25, 3.1, 4.8, FRAME, 0);
      expect(result).not.toBe("snap");
      manager.update(FRAME, { x: 0, y: 0 }, { dx: 0, dy: 0 });
    }
    const after = manager.getAvatarPosition();
    expect(after.y).toBeLessThan(3.0);
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

  it("snaps a Y-diverged body at a tower ring onto the authoritative top", async () => {
    // Server stands on the (4.8, 4.8) tower top (y 3.1); the local body is
    // at the ground in the east ring — the live diverged state. XZ alone is
    // inside the deadband (0.25), so without the stall-snap this holds "ok"
    // and the wall persists forever. With the stick held (moveMag 1) and an
    // empty window (fresh teleport = no travel history) the snap fires and
    // lands at Rapier rest height (serverY - REST_OFFSET = 3.0).
    const manager = await createFighter();
    manager.teleportSelf(6.25, 4.8);
    const result = manager.reconcileSelf(6.0, 3.1, 4.8, FRAME, 1);
    expect(result).toBe("snap");
    const after = manager.getAvatarPosition();
    expect(after.x).toBeCloseTo(6.0, 5);
    expect(after.z).toBeCloseTo(4.8, 5);
    expect(after.y).toBeCloseTo(3.0, 5);
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
    // The live loop end to end with real Rapier: dipped body in the tower
    // ring (10cm low = fully wedged) + authoritative on-top snapshot + stick
    // held. The snap lifts the body onto the top, then inward input walks it
    // home instead of grinding at the lip. Without the snap the same drive
    // gains ~0.1m in 90 frames (see the pre-fix revert proof).
    const manager = await createFighter();
    manager.debugSetPlayerState({ x: 6.25, y: 2.9, z: 4.8 }, { x: 0, y: 0, z: 0 });
    const snapped = manager.reconcileSelf(6.25, 3.1, 4.8, FRAME, 1);
    expect(snapped).toBe("snap");
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
    // heal window). Climb the P0 edge to the top with a live-shaped server
    // (body XZ + nominal +0.1 healthy offset, moveMag 1 every frame so the
    // stall window is live, as in production), then descend: the first 20
    // frames hold a stuck-at-top serverY (3.7, exact level — worst realistic
    // tick+latency lag, under the 0.4 s big-div hold), then the server
    // follows the 3-frame-lagged body down. The divergence crosses the stall
    // band mid-descent but the body covers meters in XZ, so the window never
    // drains: 0 snaps of any kind, no pops on the way down.
    const manager = await createFighter();
    manager.debugSetPlayerState({ x: 14.65, y: 1.1, z: 2.5 }, { x: 0, y: 0, z: 0 });
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
    let snaps = 0;
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
        snaps += 1;
      }
      manager.update(FRAME, { x: 0, y: -1 }, { dx: 0, dy: 0 });
    }
    expect(snaps).toBe(0);
    expect(manager.getLastReconcileTelemetry().upSnapCount).toBe(0);
    expect(manager.getLastReconcileTelemetry().bigHealCount).toBe(0);
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

  it("snaps are cooldown-spaced and converge home (no bounce loop)", async () => {
    // Cooldown backstop (kept from 6c): heal from a deep dip, then
    // reconcile+push 60 frames with a live-shaped server (XZ tracks the
    // body, stick held). A genuine second heal may still occur while grinding
    // the extreme edge, so this pins BOUNDED converging healing instead of an
    // absolute single snap: at most 2 snaps, spaced by at least the cooldown
    // (18 frames = 0.3 s), and the walk still reaches home.
    const manager = await createFighter();
    manager.debugSetPlayerState({ x: 6.25, y: 2.9, z: 4.8 }, { x: 0, y: 0, z: 0 });
    const snapFrames: number[] = [];
    for (let i = 0; i < 60; i += 1) {
      const current = manager.getAvatarPosition();
      const result = manager.reconcileSelf(current.x, 3.1, current.z, FRAME, 1);
      if (result === "snap") {
        snapFrames.push(i);
      }
      manager.update(FRAME, { x: -1, y: 0 }, { dx: 0, dy: 0 });
    }
    expect(snapFrames.length).toBeLessThanOrEqual(2);
    for (let i = 1; i < snapFrames.length; i += 1) {
      expect(snapFrames[i]! - snapFrames[i - 1]!).toBeGreaterThanOrEqual(18);
    }
    const end = manager.getAvatarPosition();
    expect(end.x).toBeLessThan(5.9);
    expect(end.y).toBeGreaterThan(2.5);
  });

  it("cooldown suppresses an immediate second snap", async () => {
    // Unit-level pin for the cooldown mechanism itself: force two back to
    // back snap-eligible states (re-seeding the dip bypasses physics
    // settling). The first reconcile snaps and arms the 0.3s cooldown; the
    // second, one frame later, must hold instead of re-snapping.
    const manager = await createFighter();
    manager.debugSetPlayerState({ x: 6.25, y: 2.9, z: 4.8 }, { x: 0, y: 0, z: 0 });
    expect(manager.reconcileSelf(6.25, 3.1, 4.8, FRAME, 1)).toBe("snap");
    manager.debugSetPlayerState({ x: 6.25, y: 2.9, z: 4.8 }, { x: 0, y: 0, z: 0 });
    expect(manager.reconcileSelf(6.25, 3.1, 4.8, FRAME, 1)).not.toBe("snap");
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
