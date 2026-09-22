import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RemoteAvatars } from "./RemoteAvatars";
import { paletteForSession, type NetPlayerSnapshot } from "./protocol";

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

// Bug round 5: remote deaths pop the shared pixel death burst once at the
// victim's last tracked position (players and bots share this path;
// spectators see it — particles render in the spectate path and the seam
// has no spectating gate).
describe("RemoteAvatars remote death burst (alive→false edge)", () => {
  interface Burst {
    x: number;
    y: number;
    z: number;
    color: number;
  }

  function collectBursts(scene: THREE.Scene): { avatars: RemoteAvatars; bursts: Burst[] } {
    const bursts: Burst[] = [];
    const avatars = new RemoteAvatars(scene, (x, y, z, color): void => {
      bursts.push({ x, y, z, color });
    });
    return { avatars, bursts };
  }

  it("bursts exactly once at the last tracked position with the entry color", () => {
    const scene = new THREE.Scene();
    const { avatars, bursts } = collectBursts(scene);
    try {
      // Settle the track at the alive position over several frames.
      for (let i = 0; i < 10; i += 1) {
        avatars.sync([makeSnapshot({ sessionId: "r1", x: 5, y: 2.5, z: 7 })], null, FRAME);
      }
      expect(bursts).toHaveLength(0);
      // Death snapshot carries junk coords: the burst must use the last
      // TRACKED position (5, 2.5, 7), not the snapshot's.
      avatars.sync([makeSnapshot({ sessionId: "r1", x: 99, y: 99, z: 99, alive: false })], null, FRAME);
      expect(bursts).toHaveLength(1);
      const burst = bursts[0];
      if (burst === undefined) {
        throw new Error("death burst missing");
      }
      expect(burst.x).toBeCloseTo(5, 9);
      expect(burst.y).toBeCloseTo(2.5, 9);
      expect(burst.z).toBeCloseTo(7, 9);
      // Same identity derivation the rig's shirt/hand-ball use.
      expect(burst.color).toBe(paletteForSession("r1"));
      // Staying dead never re-fires.
      avatars.sync([makeSnapshot({ sessionId: "r1", x: 99, y: 99, z: 99, alive: false })], null, FRAME);
      expect(bursts).toHaveLength(1);
    } finally {
      avatars.dispose();
    }
  });

  it("never bursts on first sighting of an already-dead remote", () => {
    const scene = new THREE.Scene();
    const { avatars, bursts } = collectBursts(scene);
    try {
      // Late join / respawn window: first snapshot already dead.
      avatars.sync([makeSnapshot({ sessionId: "r1", alive: false })], null, FRAME);
      expect(bursts).toHaveLength(0);
      // Seen alive, then a real kill: exactly one burst for the edge.
      avatars.sync([makeSnapshot({ sessionId: "r1" })], null, FRAME);
      expect(bursts).toHaveLength(0);
      avatars.sync([makeSnapshot({ sessionId: "r1", alive: false })], null, FRAME);
      expect(bursts).toHaveLength(1);
    } finally {
      avatars.dispose();
    }
  });

  it("respawn cycles re-arm: alive→alive silent, second death bursts again", () => {
    const scene = new THREE.Scene();
    const { avatars, bursts } = collectBursts(scene);
    try {
      for (let i = 0; i < 5; i += 1) {
        avatars.sync([makeSnapshot({ sessionId: "r1", x: i })], null, FRAME);
      }
      expect(bursts).toHaveLength(0);
      avatars.sync([makeSnapshot({ sessionId: "r1", alive: false })], null, FRAME);
      expect(bursts).toHaveLength(1);
      // Respawn: no burst on the false→true edge.
      avatars.sync([makeSnapshot({ sessionId: "r1" })], null, FRAME);
      expect(bursts).toHaveLength(1);
      // Second kill bursts again (exactly 2 total, never a double).
      avatars.sync([makeSnapshot({ sessionId: "r1", alive: false })], null, FRAME);
      expect(bursts).toHaveLength(2);
    } finally {
      avatars.dispose();
    }
  });

  it("ignores self snapshots (no double burst with the local path)", () => {
    const scene = new THREE.Scene();
    const { avatars, bursts } = collectBursts(scene);
    try {
      avatars.sync([makeSnapshot({ sessionId: "self" })], "self", FRAME);
      avatars.sync([makeSnapshot({ sessionId: "self", alive: false })], "self", FRAME);
      expect(bursts).toHaveLength(0);
      expect(avatars.size).toBe(0);
    } finally {
      avatars.dispose();
    }
  });

  it("room leave/reset removes silently and dispose never bursts", () => {
    const scene = new THREE.Scene();
    const { avatars, bursts } = collectBursts(scene);
    try {
      avatars.sync([makeSnapshot({ sessionId: "r1" })], null, FRAME);
      // Vanished from the snapshot (leave): removal, not death.
      avatars.sync([], null, FRAME);
      expect(bursts).toHaveLength(0);
      expect(avatars.size).toBe(0);
      // Re-added alive, then a real kill: exactly one edge burst.
      avatars.sync([makeSnapshot({ sessionId: "r1" })], null, FRAME);
      expect(bursts).toHaveLength(0);
      avatars.sync([makeSnapshot({ sessionId: "r1", alive: false })], null, FRAME);
      expect(bursts).toHaveLength(1);
      avatars.dispose();
      expect(bursts).toHaveLength(1);
      expect(avatars.size).toBe(0);
    } finally {
      avatars.dispose();
    }
  });
});

