import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RemoteAvatars } from "./RemoteAvatars";
import type { NetPlayerSnapshot } from "./protocol";

// RemoteAvatars draws nickname sprites on a DOM canvas, but vitest runs in
// node (no jsdom, no installs allowed): getContext returns null so BOTH the
// label painter (null-guarded) and the face-texture maker (DataTexture
// headless fallback in AvatarVisuals) take their real no-DOM paths.
function installDocumentStub(): void {
  const fakeDocument = {
    createElement: (): unknown => ({
      width: 0,
      height: 0,
      getContext: (): unknown => null,
    }),
  };
  (globalThis as unknown as Record<string, unknown>)["document"] = fakeDocument;
}

function makeSnapshot(overrides: Partial<NetPlayerSnapshot> & { sessionId: string }): NetPlayerSnapshot {
  return {
    nick: "Remote",
    x: 0,
    y: 1.1,
    z: 0,
    rotY: 0,
    hp: 100,
    score: 0,
    alive: true,
    isBot: true,
    ready: true,
    spectator: false,
    superBuff: false,
    reloadUntil: 0,
    ...overrides,
  };
}

function rigOf(scene: THREE.Scene): THREE.Group {
  const group = scene.children[0];
  if (!(group instanceof THREE.Group)) {
    throw new Error("remote entry group missing from scene");
  }
  const rig = group.children[0];
  if (!(rig instanceof THREE.Group)) {
    throw new Error("remote rig missing from entry group");
  }
  return rig;
}

const FRAME = 1 / 60;

beforeEach(() => {
  installDocumentStub();
});

afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>)["document"];
});

// NOTE: the server replicates body height every tick (grounded derivation +
// trampoline arcs), so remote flight reads live here; local flight (Rapier
// vy) is covered by the SceneManager airborne tests.
describe("RemoteAvatars airborne glide (climb -> lean, no bounce)", () => {
  it("glides a climbing remote: forward lean, zero bounce lift", () => {
    const scene = new THREE.Scene();
    const avatars = new RemoteAvatars(scene);
    try {
      let y = 1.1;
      for (let i = 0; i < 90; i += 1) {
        y += 0.15;
        avatars.sync([makeSnapshot({ sessionId: "r1", y })], null, FRAME);
      }
      const rig = rigOf(scene);
      // Lean points toward movement (forward pitch), bounce stays flat.
      expect(rig.rotation.x).toBeGreaterThan(0.05);
      expect(rig.position.y).toBe(0);
    } finally {
      avatars.dispose();
    }
  });

  it("level remotes keep hopping; landing after a climb resumes the bounce", () => {
    const scene = new THREE.Scene();
    const avatars = new RemoteAvatars(scene);
    try {
      // Climb first to build glide state.
      let y = 1.1;
      for (let i = 0; i < 60; i += 1) {
        y += 0.15;
        avatars.sync([makeSnapshot({ sessionId: "r1", y })], null, FRAME);
      }
      // Land on flat ground and run forward: bounce lift must return…
      let lifted = false;
      let x = 0;
      for (let i = 0; i < 120; i += 1) {
        x += 0.1;
        avatars.sync([makeSnapshot({ sessionId: "r1", x, y: 1.1 })], null, FRAME);
        const rig = rigOf(scene);
        if (rig.position.y > 0.01) {
          lifted = true;
        }
      }
      expect(lifted).toBe(true);
      // …then standing still settles to (dust-level) identity, proving the
      // glide fully drained: a stuck glide would leave rotation.x at ~0.15,
      // while the eased track leaves only ~1e-11 asymptotic residue (speed01
      // never hits exactly 0 for remotes, unlike the local static body).
      for (let i = 0; i < 120; i += 1) {
        avatars.sync([makeSnapshot({ sessionId: "r1", x, y: 1.1 })], null, FRAME);
      }
      expect(rigOf(scene).rotation.x).toBeCloseTo(0, 6);
      expect(rigOf(scene).position.y).toBeCloseTo(0, 6);
    } finally {
      avatars.dispose();
    }
  });
});

describe("RemoteAvatars livingPositions carries replicated height (bug 2)", () => {
  it("exposes the eased body-center Y for aim-assist targeting", () => {
    const scene = new THREE.Scene();
    const avatars = new RemoteAvatars(scene);
    try {
      // A remote standing on a 2.0m tower (server y = 3.1): after the ease
      // converges, livingPositions must report tower height, not 1.1.
      for (let i = 0; i < 120; i += 1) {
        avatars.sync([makeSnapshot({ sessionId: "r1", x: 4.8, z: 4.8, y: 3.1 })], null, FRAME);
      }
      const positions = avatars.livingPositions(null);
      expect(positions).toHaveLength(1);
      expect(positions[0]?.sessionId).toBe("r1");
      expect(positions[0]?.y ?? 0).toBeGreaterThan(2.5);
      expect(positions[0]?.y ?? 0).toBeCloseTo(3.1, 1);
      // Self is excluded, spectators never list.
      expect(avatars.livingPositions("r1")).toHaveLength(0);
    } finally {
      avatars.dispose();
    }
  });
});
