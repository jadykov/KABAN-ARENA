import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  BALL_MUZZLE_OFFSET,
  BALL_TORSO_OFFSET,
  HANDBALL_OFFSET_X,
  HANDBALL_OFFSET_Y,
  HANDBALL_OFFSET_Z,
  HANDBALL_RADIUS,
  LOCAL_AVATAR_COLOR,
  RELOAD_MS,
  SELF_SPAWN_Y,
} from "../config";
import {
  applyClothing,
  attachAvatarVisuals,
  attachFace,
  attachHandBall,
  createHopState,
  FACE_DECAL_ARC,
  FACE_DECAL_HEIGHT,
  FACE_DECAL_Y,
  FACE_VARIANT_COUNT,
  faceVariantForSession,
  PANTS_PALETTE,
  pantsColorForSession,
  resetHopState,
  resetHopVisual,
  seedHopState,
  updateHopVisual,
} from "./AvatarVisuals";

const PLAYER_COLOR = 0x22d3ee;

function ballMeshOf(handle: { group: THREE.Group }): THREE.Mesh {
  const mesh = handle.group.children[0];
  if (!(mesh instanceof THREE.Mesh)) {
    throw new Error("hand-ball group holds no ball mesh");
  }
  return mesh;
}

// 4d.1: the avatar holds a round ball in its RIGHT hand (no cannon barrel).
// The body faces local +Z, so anatomical right is local −X: attach sits at
// (x −0.55, y 0.5, z 0.1), tinted in the owner's fighter color, with no
// barrel/breech geometry anywhere.
describe("HandBall attach (right hand, chest height, player color)", () => {
  it("sits at the hand offset with a player-tinted sphere, no barrel parts", () => {
    const parent = new THREE.Group();
    const handle = attachHandBall(parent, PLAYER_COLOR);
    try {
      expect(handle.group.position.x).toBeCloseTo(HANDBALL_OFFSET_X, 10);
      expect(handle.group.position.y).toBeCloseTo(HANDBALL_OFFSET_Y, 10);
      expect(handle.group.position.z).toBeCloseTo(HANDBALL_OFFSET_Z, 10);
      // Anatomical right hand at local −X (body faces +Z).
      expect(handle.group.position.x).toBeLessThan(0);

      const ball = ballMeshOf(handle);
      expect(ball.geometry).toBeInstanceOf(THREE.SphereGeometry);
      expect((ball.geometry as THREE.SphereGeometry).parameters.radius).toBeCloseTo(HANDBALL_RADIUS, 5);
      const material = ball.material as THREE.MeshStandardMaterial;
      expect(material.color.getHex()).toBe(PLAYER_COLOR);
      expect(ball.castShadow).toBe(false);

      // No cannon leftovers: neither cylinder barrels nor breech boxes.
      for (const child of handle.group.children) {
        if (!(child instanceof THREE.Mesh)) {
          continue;
        }
        expect(child.geometry).not.toBeInstanceOf(THREE.CylinderGeometry);
        if (child.geometry instanceof THREE.BoxGeometry) {
          throw new Error("hand-ball group must not contain box (breech) geometry");
        }
      }
      expect(parent.children).toContain(handle.group);
    } finally {
      handle.dispose();
    }
  });

  it("uses the local avatar color for the local fighter", () => {
    const parent = new THREE.Group();
    const handle = attachHandBall(parent, LOCAL_AVATAR_COLOR);
    try {
      const material = ballMeshOf(handle).material as THREE.MeshStandardMaterial;
      expect(material.color.getHex()).toBe(LOCAL_AVATAR_COLOR);
    } finally {
      handle.dispose();
    }
  });

  it("keeps charge glow independent per fighter (per-handle material)", () => {
    const parent = new THREE.Group();
    const first = attachHandBall(parent, PLAYER_COLOR);
    const second = attachHandBall(parent, PLAYER_COLOR);
    try {
      expect(ballMeshOf(first).material).not.toBe(ballMeshOf(second).material);
    } finally {
      first.dispose();
      second.dispose();
    }
  });
});

// Faces: big schematic Mii-style stroke decals (one of 7 variants per
// session id) on a large curved patch covering the upper front — expression
// readable at a glance, no 3D bits, no buried parts.
describe("Face decal (big schematic per-player variants)", () => {
  function childMeshes(face: THREE.Group): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const child of face.children) {
      if (!(child instanceof THREE.Mesh)) {
        throw new Error("face child is not a mesh");
      }
      out.push(child);
    }
    return out;
  }

  function decalMeshOf(face: THREE.Group): THREE.Mesh {
    const decal = childMeshes(face).find((mesh) => mesh.geometry instanceof THREE.CylinderGeometry);
    if (decal === undefined) {
      throw new Error("face decal missing");
    }
    return decal;
  }

  function detachFace(face: THREE.Group): void {
    if (face.parent !== null) {
      face.parent.remove(face);
    }
  }

  it("mounts one big transparent decal clearing the capsule surface", () => {
    // Owner playtest v3: significantly bigger (~3.3x original area, roughly
    // a third of the body), upper front (center y ≈ +0.1, top at the seam).
    expect(FACE_DECAL_HEIGHT).toBeCloseTo(0.8, 5);
    expect(FACE_DECAL_ARC).toBeCloseTo(1.7, 5);
    expect(FACE_DECAL_Y).toBeCloseTo(0.1, 5);
    const parent = new THREE.Group();
    const face = attachFace(parent, "some-session");
    try {
      // Exactly one mesh: decal only, no accent bits (dropped for clarity).
      expect(childMeshes(face)).toHaveLength(1);
      const decal = decalMeshOf(face);
      expect(decal.geometry).toBeInstanceOf(THREE.CylinderGeometry);
      expect(decal.position.y).toBeCloseTo(0.1, 5);
      expect(decal.castShadow).toBe(false);
      const material = decal.material as THREE.MeshBasicMaterial;
      expect(material.transparent).toBe(true);
      expect(material.map).not.toBe(null);
      // World-space vertex scan: every decal vertex rides proud of the 0.5
      // shell (8mm proud by construction), so nothing is ever buried.
      parent.updateMatrixWorld(true);
      const scratch = new THREE.Vector3();
      const positions = decal.geometry.getAttribute("position");
      let minRadial = Number.POSITIVE_INFINITY;
      for (let i = 0; i < positions.count; i += 1) {
        scratch.fromBufferAttribute(positions, i);
        decal.localToWorld(scratch);
        const radial = Math.hypot(scratch.x, scratch.z);
        if (radial < minRadial) {
          minRadial = radial;
        }
      }
      expect(minRadial).toBeGreaterThan(0.502);
      expect(parent.children).toContain(face);
    } finally {
      detachFace(face);
    }
  });

  // Clarity round: accents dropped entirely — every variant is decal-only
  // (big bold strokes need no 3D bits, and every avatar stays at minimum
  // draw calls). Any session id must yield exactly the decal mesh.
  it("every variant is decal-only (no accent meshes anywhere)", () => {
    const ids = [
      "red", "green", "blue", "hank", "iris", "jo", "kim", "leo",
      "mia", "ned", "olga", "pete", "quinn", "ruth", "zd", "zf",
      "alpha", "bravo", "charlie", "delta",
    ];
    const seen = new Set<number>();
    for (const id of ids) {
      seen.add(faceVariantForSession(id));
      const holder = new THREE.Group();
      const face = attachFace(holder, id);
      try {
        const meshes = childMeshes(face);
        expect(meshes).toHaveLength(1);
        expect(meshes[0]?.geometry).toBeInstanceOf(THREE.CylinderGeometry);
      } finally {
        detachFace(face);
      }
    }
    // Sanity: the sweep actually covers all 7 variants.
    expect(seen.size).toBe(FACE_VARIANT_COUNT);
  });

  it("picks variants deterministically per session id with real diversity", () => {
    expect(FACE_VARIANT_COUNT).toBe(7);
    expect(faceVariantForSession("")).toBe(0);
    expect(faceVariantForSession("player-1")).toBe(faceVariantForSession("player-1"));
    const ids = [
      "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf",
      "hotel", "india", "juliet", "kilo", "lima", "mike", "november",
    ];
    const seen = new Set(ids.map((id) => faceVariantForSession(id)));
    for (const variant of seen) {
      expect(variant).toBeGreaterThanOrEqual(0);
      expect(variant).toBeLessThan(FACE_VARIANT_COUNT);
    }
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });

  it("setFaceSource re-assigns the cached variant material deterministically", () => {
    const parent = new THREE.Group();
    const visuals = attachAvatarVisuals(parent, PLAYER_COLOR, "id-alpha");
    try {
      const first = (visuals.face.children[0] as THREE.Mesh).material;
      visuals.setFaceSource("id-beta");
      const second = (visuals.face.children[0] as THREE.Mesh).material;
      visuals.setFaceSource("id-alpha");
      const back = (visuals.face.children[0] as THREE.Mesh).material;
      // Round-trip returns the exact cached object (no duplicates allocated).
      expect(back).toBe(first);
      const variantA = faceVariantForSession("id-alpha");
      const variantB = faceVariantForSession("id-beta");
      if (variantA === variantB) {
        expect(second).toBe(first);
      } else {
        expect(second).not.toBe(first);
      }
    } finally {
      visuals.dispose();
    }
  });

  it("defaults to variant 0 pre-join and shares cached materials", () => {
    const parent = new THREE.Group();
    const a = attachAvatarVisuals(parent, PLAYER_COLOR);
    const b = attachAvatarVisuals(parent, PLAYER_COLOR, "");
    try {
      const matA = (a.face.children[0] as THREE.Mesh).material;
      const matB = (b.face.children[0] as THREE.Mesh).material;
      expect(matA).toBe(matB);
    } finally {
      a.dispose();
      b.dispose();
    }
  });
});

// Two-tone clothing: shirt on top / pants below baked as vertex colors (one
// draw call, white base, emissive flash path untouched). Pants vary per
// player by session hash; shirt is always the identity color.
describe("applyClothing (two-tone shirt/pants via vertex colors)", () => {
  it("bakes a soft shirt/pants split with a white vertex-colored base", () => {
    const geo = new THREE.CapsuleGeometry(0.5, 1.0, 4, 8);
    const mat = new THREE.MeshStandardMaterial({ color: 0xff9f43 });
    const body = new THREE.Mesh(geo, mat);
    try {
      applyClothing(body, 0xff0000, 0x0000ff);
      const std = body.material as THREE.MeshStandardMaterial;
      expect(std.color.getHex()).toBe(0xffffff);
      expect(std.vertexColors).toBe(true);
      const pos = geo.getAttribute("position") as THREE.BufferAttribute;
      const col = geo.getAttribute("color");
      if (!(col instanceof THREE.BufferAttribute)) {
        throw new Error("clothing color attribute missing");
      }
      let top = 0;
      let bottom = 0;
      for (let i = 1; i < pos.count; i += 1) {
        if (pos.getY(i) > pos.getY(top)) {
          top = i;
        }
        if (pos.getY(i) < pos.getY(bottom)) {
          bottom = i;
        }
      }
      // Poles sit far outside the ±0.05 blend band: pure shirt / pure pants.
      expect(col.getX(top)).toBeCloseTo(1, 2);
      expect(col.getY(top)).toBeCloseTo(0, 2);
      expect(col.getZ(top)).toBeCloseTo(0, 2);
      expect(col.getX(bottom)).toBeCloseTo(0, 2);
      expect(col.getY(bottom)).toBeCloseTo(0, 2);
      expect(col.getZ(bottom)).toBeCloseTo(1, 2);
      // Re-apply (session lock-in on welcome) reuses the attribute in place.
      applyClothing(body, 0x00ff00, 0x0000ff);
      expect(geo.getAttribute("color")).toBe(col);
      expect(col.getY(top)).toBeCloseTo(1, 2);
    } finally {
      geo.dispose();
      mat.dispose();
    }
  });

  it("pantsColorForSession is deterministic, in-palette, and diverse", () => {
    expect(pantsColorForSession("sess-1")).toBe(pantsColorForSession("sess-1"));
    const ids = [
      "p1", "p2", "p3", "p4", "p5", "p6",
      "p7", "p8", "p9", "p10", "p11", "p12",
    ];
    const seen = new Set(ids.map((id) => pantsColorForSession(id)));
    for (const color of seen) {
      expect(PANTS_PALETTE).toContain(color);
    }
    expect(seen.size).toBeGreaterThanOrEqual(3);
  });
});

// South Park hop: speed-eased bounce (lift + squash/stretch + rock) written
// onto a rig child — transform-only, no allocations, exact identity at rest.
describe("updateHopVisual (South Park speed hop, transform-only)", () => {
  it("rests at exact identity with zero speed", () => {
    const rig = new THREE.Group();
    const state = createHopState();
    for (let i = 0; i < 30; i += 1) {
      updateHopVisual(rig, 0, 0, state, 1 / 60);
    }
    expect(rig.position.y).toBe(0);
    expect(rig.scale.x).toBe(1);
    expect(rig.scale.y).toBe(1);
    expect(rig.scale.z).toBe(1);
    expect(rig.rotation.x).toBe(0);
    expect(state.amount).toBe(0);
  });

  it("bounces with squash/stretch at full speed and settles after stopping", () => {
    const rig = new THREE.Group();
    const state = createHopState();
    let maxY = 0;
    let minScaleY = 1;
    for (let i = 0; i < 120; i += 1) {
      updateHopVisual(rig, 0, 1, state, 1 / 60);
      if (rig.position.y > maxY) {
        maxY = rig.position.y;
      }
      if (rig.scale.y < minScaleY) {
        minScaleY = rig.scale.y;
      }
    }
    // Lift peaks near 0.13 and contact squashes well below 1.
    expect(maxY).toBeGreaterThan(0.05);
    expect(minScaleY).toBeLessThan(0.95);
    expect(state.amount).toBeGreaterThan(0.9);
    // Stop: eases back to EXACT identity (no residuals for respawn paths).
    for (let i = 0; i < 120; i += 1) {
      updateHopVisual(rig, 0, 0, state, 1 / 60);
    }
    expect(rig.position.y).toBe(0);
    expect(rig.scale.x).toBe(1);
    expect(rig.scale.y).toBe(1);
    expect(rig.scale.z).toBe(1);
    expect(rig.rotation.x).toBe(0);
    expect(state.amount).toBe(0);
  });

  it("ignores non-positive dt and non-finite speed, adds no objects", () => {
    const rig = new THREE.Group();
    const state = createHopState();
    updateHopVisual(rig, 0, 1, state, 0);
    updateHopVisual(rig, 0, 1, state, -1);
    expect(state.amount).toBe(0);
    expect(rig.position.y).toBe(0);
    updateHopVisual(rig, 0, Number.NaN, state, 1 / 60);
    expect(state.amount).toBe(0);
    // Absurd speed clamps instead of exploding the transform.
    updateHopVisual(rig, 0, 99, state, 1 / 60);
    expect(state.amount).toBeLessThanOrEqual(1);
    expect(rig.children).toHaveLength(0);
    resetHopState(state);
    resetHopVisual(rig, 0.2);
    expect(state.amount).toBe(0);
    expect(rig.position.y).toBe(0.2);
  });

  it("same seed produces identical hop transform sequences", () => {
    const runSequence = (seed: string): number[] => {
      const rig = new THREE.Group();
      const state = createHopState(seed);
      const samples: number[] = [];
      for (let i = 0; i < 300; i += 1) {
        updateHopVisual(rig, 0, 1, state, 1 / 60);
        samples.push(rig.position.x, rig.position.y, rig.rotation.z, rig.rotation.y, rig.scale.y);
      }
      return samples;
    };
    const first = runSequence("wobble-sess-7");
    const second = runSequence("wobble-sess-7");
    expect(first).toEqual(second);
    // Sanity: the sequence is not trivially all zeros.
    expect(first.some((value) => value !== 0)).toBe(true);
  });

  it("per-hop chaos actually varies across consecutive hops", () => {
    const rig = new THREE.Group();
    const state = createHopState("wobble-sess-7");
    const leans = new Set<number>();
    const drifts = new Set<number>();
    const yawWobs = new Set<number>();
    // ~10+ hops at full-speed cadence (2.5-4 Hz over ~4s).
    for (let i = 0; i < 240; i += 1) {
      updateHopVisual(rig, 0, 1, state, 1 / 60);
      leans.add(state.lean);
      drifts.add(state.drift);
      yawWobs.add(state.yawWob);
    }
    expect(leans.size).toBeGreaterThan(1);
    expect(drifts.size).toBeGreaterThan(1);
    expect(yawWobs.size).toBeGreaterThan(1);
  });

  it("hop cadence stays in the 2.5-4 Hz band at full speed", () => {
    const rig = new THREE.Group();
    const state = createHopState("cadence-check");
    // Warm up well past the eased ramp so amount ≈ 1 (max cadence).
    for (let i = 0; i < 120; i += 1) {
      updateHopVisual(rig, 0, 1, state, 1 / 60);
    }
    expect(state.amount).toBeGreaterThan(0.9);
    const startPhase = state.phase;
    for (let i = 0; i < 60; i += 1) {
      updateHopVisual(rig, 0, 1, state, 1 / 60);
    }
    // One |sin| bounce per π radians: hops in that second must be 2.5-4
    // (upper bound with float-dust slack; amount can never exceed 1).
    const hopsPerSecond = (state.phase - startPhase) / Math.PI;
    expect(hopsPerSecond).toBeGreaterThanOrEqual(2.5);
    expect(hopsPerSecond).toBeLessThanOrEqual(4.01);
  });

  it("seedHopState reseeds the chaos stream deterministically", () => {
    const first = createHopState("old-seed");
    const second = createHopState("other-seed");
    seedHopState(second, "old-seed");
    const rigFirst = new THREE.Group();
    const rigSecond = new THREE.Group();
    for (let i = 0; i < 120; i += 1) {
      updateHopVisual(rigFirst, 0, 1, first, 1 / 60);
      updateHopVisual(rigSecond, 0, 1, second, 1 / 60);
    }
    expect(rigSecond.rotation.z).toBe(rigFirst.rotation.z);
    expect(rigSecond.position.x).toBe(rigFirst.position.x);
  });
});

// Throw direction convention is unchanged: avatar facing is +Z, so the
// release flick must snap the held ball forward along local +Z.
describe("HandBall throw flick faces +Z on a neutral parent", () => {
  it("snaps forward (+Z) on release, world-aligned with no parent yaw", () => {
    const parent = new THREE.Group();
    const handle = attachHandBall(parent, PLAYER_COLOR);
    try {
      parent.updateMatrixWorld(true);
      handle.playThrow();
      handle.update(0.08);
      parent.updateMatrixWorld(true);
      // Local forward snap past the rest offset.
      expect(handle.group.position.z).toBeGreaterThan(HANDBALL_OFFSET_Z);
      // On a yaw-neutral parent local +Z is world +Z.
      const world = new THREE.Vector3();
      handle.group.getWorldPosition(world);
      expect(world.z).toBeGreaterThan(HANDBALL_OFFSET_Z - 0.01);
      expect(world.x).toBeCloseTo(HANDBALL_OFFSET_X, 5);
    } finally {
      handle.dispose();
    }
  });
});

// Charge swell + throw/reload state machine (timings mirror the combat FSM:
// quick flick on release, ball gone for the 2.5s reload, pop-back return).
describe("HandBall charge swell + throw/reload cycle", () => {
  it("swells with charge01 (up to ~1.6x) and rests at 1x idle", () => {
    const parent = new THREE.Group();
    const handle = attachHandBall(parent, PLAYER_COLOR);
    try {
      handle.setCharge01(0);
      handle.update(0.016);
      expect(ballMeshOf(handle).scale.x).toBeCloseTo(1, 5);
      handle.setCharge01(1);
      handle.update(0.016);
      // 1 + 0.6 swell, ±5% pulse band.
      expect(ballMeshOf(handle).scale.x).toBeGreaterThan(1.5);
      expect(ballMeshOf(handle).scale.x).toBeLessThan(1.75);
    } finally {
      handle.dispose();
    }
  });

  it("flicks, hides for reload, and is back visible by 2.5s after release", () => {
    expect(RELOAD_MS).toBe(2500);
    const parent = new THREE.Group();
    const handle = attachHandBall(parent, PLAYER_COLOR);
    try {
      handle.setCharge01(1);
      handle.playThrow();
      handle.update(0.016);
      expect(handle.group.visible).toBe(true);
      // Past the ~0.15s flick: the ball is gone (thrown).
      for (let i = 0; i < 20; i += 1) {
        handle.update(0.016);
      }
      expect(handle.group.visible).toBe(false);
      // Step to just under 2.5s total after release: still hidden (the flick
      // and reload clocks run concurrently, no early return).
      for (let i = 0; i < 135; i += 1) {
        handle.update(0.016);
      }
      expect(handle.group.visible).toBe(false);
      // Cross the 2.5s FSM mark: ball back in the same frame window the
      // reload gate opens, so a new charge never meets a hidden ball.
      handle.update(0.016);
      expect(handle.group.visible).toBe(true);
      expect(handle.group.position.y).toBeCloseTo(HANDBALL_OFFSET_Y, 1);
      // Let the 0.25s pop ramp finish: full charge swell is back.
      for (let i = 0; i < 20; i += 1) {
        handle.update(0.016);
      }
      expect(ballMeshOf(handle).scale.x).toBeGreaterThan(1.5);
    } finally {
      handle.dispose();
    }
  });

  it("reset() restores the held pose; non-positive dt is a no-op", () => {
    const parent = new THREE.Group();
    const handle = attachHandBall(parent, PLAYER_COLOR);
    try {
      handle.playThrow();
      handle.update(0.5);
      handle.reset();
      expect(handle.group.visible).toBe(true);
      expect(handle.group.position.x).toBeCloseTo(HANDBALL_OFFSET_X, 10);
      expect(handle.group.position.y).toBeCloseTo(HANDBALL_OFFSET_Y, 10);
      expect(handle.group.position.z).toBeCloseTo(HANDBALL_OFFSET_Z, 10);
      expect(ballMeshOf(handle).scale.x).toBeCloseTo(1, 10);
      // Non-positive steps never advance the state machine.
      handle.update(0);
      handle.update(-1);
      expect(handle.group.visible).toBe(true);
      expect(ballMeshOf(handle).scale.x).toBeCloseTo(1, 10);
    } finally {
      handle.dispose();
    }
  });

  it("adds no scene objects per frame (no per-frame allocations leak)", () => {
    const parent = new THREE.Group();
    const handle = attachHandBall(parent, PLAYER_COLOR);
    try {
      handle.setCharge01(0.9);
      const before = handle.group.children.length;
      for (let i = 0; i < 600; i += 1) {
        handle.update(1 / 60);
      }
      expect(handle.group.children).toHaveLength(before);
      expect(parent.children).toContain(handle.group);
    } finally {
      handle.dispose();
    }
  });
});

// Shared builder: one call attaches ball + face identically for the local
// avatar (SceneManager) and remote bodies (RemoteAvatars); dispose detaches
// both without touching shared module geometries.
describe("attachAvatarVisuals composite", () => {
  it("attaches ball + face and detaches both on dispose", () => {
    const parent = new THREE.Group();
    const visuals = attachAvatarVisuals(parent, PLAYER_COLOR);
    try {
      expect(parent.children).toContain(visuals.ball.group);
      expect(parent.children).toContain(visuals.face);
      expect(visuals.face.children).toHaveLength(1);
      visuals.update(0.016);
      expect(visuals.ball.group.visible).toBe(true);
    } finally {
      visuals.dispose();
    }
    expect(parent.children).not.toContain(visuals.ball.group);
    expect(parent.children).not.toContain(visuals.face);
  });
});

// Muzzle/preview constants stay in sync with the authoritative server
// (server BALL_MUZZLE_OFFSET 0.7 / ground spawn 1.1 + 0.3 = 1.4): hand exit
// just in front of the 0.5m capsule so shots visibly leave the torso.
describe("HandBall muzzle constants mirror the server", () => {
  it("offset is 0.7 with ground spawn 1.4 via torso offset", () => {
    expect(BALL_MUZZLE_OFFSET).toBeCloseTo(0.7, 10);
    expect(BALL_TORSO_OFFSET).toBeCloseTo(0.3, 10);
    expect(SELF_SPAWN_Y + BALL_TORSO_OFFSET).toBeCloseTo(1.4, 10);
  });
});
