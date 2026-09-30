import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HIT_FLASH_DURATION_S } from "../config";
import { ACCENT_HIT_FLASH } from "../palette";
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
    shieldHp: 0,
    shieldUntil: 0,
    speedUntil: 0,
    chargeUntil: 0,
    pickupKind: "",
    pickupAt: 0,
    pickupSeq: 0,
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

describe("RemoteAvatars transparent compact nicknames", () => {
  function labelOf(group: THREE.Object3D): THREE.Sprite {
    const label = group.children.find((child) => child instanceof THREE.Sprite);
    if (!(label instanceof THREE.Sprite)) throw new Error("nickname sprite missing");
    return label;
  }

  it("paints only outlined white text on a transparent canvas and scales players/bots to exactly 80%", () => {
    const contexts: Array<{
      font: string; textAlign: string; textBaseline: string; fillStyle: string;
      strokeStyle: string; lineWidth: number; lineJoin: string;
      fillText: ReturnType<typeof vi.fn>; strokeText: ReturnType<typeof vi.fn>; fillRect: ReturnType<typeof vi.fn>;
    }> = [];
    const fakeDocument = {
      createElement: (): unknown => {
        const canvas = {
          width: 0, height: 0,
          getContext: (): unknown => {
            // Exercise the real nickname painter; unrelated face canvases
            // keep their normal headless fallback instead of a fake painter.
            if (canvas.width !== 256 || canvas.height !== 64) return null;
            const context = {
              font: "", textAlign: "", textBaseline: "", fillStyle: "", strokeStyle: "", lineWidth: 0, lineJoin: "",
              fillText: vi.fn(), strokeText: vi.fn(), fillRect: vi.fn(),
            };
            contexts.push(context);
            return context;
          },
        };
        return canvas;
      },
    };
    (globalThis as unknown as Record<string, unknown>)["document"] = fakeDocument;
    const scene = new THREE.Scene();
    const avatars = new RemoteAvatars(scene);
    try {
      avatars.sync([
        makeSnapshot({ sessionId: "human", nick: "Игрок", isBot: false }),
        makeSnapshot({ sessionId: "bot", nick: "Борис", isBot: true }),
      ], null, FRAME);
      expect(contexts).toHaveLength(2);
      for (const [index, nick] of ["Игрок", "Борис"].entries()) {
        const group = scene.children[index];
        const context = contexts[index];
        if (group === undefined || context === undefined) throw new Error("nickname entry missing");
        const label = labelOf(group);
        expect(label.scale.x / 2.2).toBeCloseTo(0.8, 12);
        expect(label.scale.y / 0.55).toBeCloseTo(0.8, 12);
        expect(label.scale.z).toBe(1);
        expect(label.position.y).toBe(2.3);
        expect(label.material.transparent).toBe(true);
        expect(label.material.depthTest).toBe(false);
        expect(label.material.map).toBeInstanceOf(THREE.CanvasTexture);
        expect(context.font).toBe("bold 32px system-ui, sans-serif");
        expect(context.fillStyle).toBe("#ffffff");
        expect(context.fillRect).not.toHaveBeenCalled();
        expect(context.fillText).toHaveBeenCalledTimes(1);
        expect(context.fillText).toHaveBeenCalledWith(nick, 128, 34);
        expect(context.strokeText).toHaveBeenCalledTimes(1);
        expect(context.strokeText).toHaveBeenCalledWith(nick, 128, 34);
        expect(context.lineWidth).toBeLessThanOrEqual(2);
        expect(context.textAlign).toBe("center");
        expect(context.textBaseline).toBe("middle");
      }
    } finally {
      avatars.dispose();
    }
  });

  it("reuses labels through death/respawn and disposes each map/material on spectator, room reset, and teardown", () => {
    const scene = new THREE.Scene();
    const avatars = new RemoteAvatars(scene);
    const players = [makeSnapshot({ sessionId: "human", isBot: false }), makeSnapshot({ sessionId: "bot", isBot: true })];
    const disposed = new Map<object, number>();
    const tracked: object[] = [];
    const track = (label: THREE.Sprite): void => {
      const resources = [label.material, label.material.map];
      for (const resource of resources) {
        if (resource === null) throw new Error("nickname texture missing");
        tracked.push(resource);
        resource.addEventListener("dispose", () => { disposed.set(resource, (disposed.get(resource) ?? 0) + 1); });
      }
    };
    try {
      avatars.sync(players, null, FRAME);
      const labels = scene.children.map(labelOf);
      labels.forEach(track);
      avatars.sync(players.map((player) => ({ ...player, alive: false })), null, FRAME);
      expect(labels.every((label) => !label.visible)).toBe(true);
      expect(disposed.size).toBe(0);
      avatars.sync(players, null, FRAME);
      expect(scene.children.map(labelOf)).toEqual(labels);
      expect(labels.every((label) => label.visible)).toBe(true);
      avatars.sync(players.map((player) => ({ ...player, spectator: player.sessionId === "human" })), null, FRAME);
      expect(scene.children).toHaveLength(1);
      expect(disposed.size).toBe(2);
      avatars.sync([], null, FRAME);
      expect(scene.children).toHaveLength(0);
      expect(disposed.size).toBe(4);
      avatars.sync(players, null, FRAME);
      scene.children.map(labelOf).forEach(track);
      avatars.dispose();
      avatars.dispose();
      expect(scene.children).toHaveLength(0);
      expect(tracked.map((resource) => disposed.get(resource))).toEqual(Array<number>(8).fill(1));
    } finally {
      avatars.dispose();
    }
  });
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

describe("RemoteAvatars replicated bonuses", () => {
  it("shows a timed shield and pickup badge without speed wind on an idle buffed avatar", () => {
    const scene = new THREE.Scene();
    const avatars = new RemoteAvatars(scene);
    try {
      avatars.sync([makeSnapshot({
        sessionId: "r1", shieldHp: 25, shieldUntil: 11_000, speedUntil: 6_000,
      })], null, FRAME, 1_000);
      const rig = rigOf(scene);
      const shield = rig.getObjectByName("bonus-shield");
      const wind = rig.getObjectByName("run-wind-trail");
      const badge = rig.getObjectByName("bonus-badge");
      expect(shield?.visible).toBe(true);
      expect(wind?.visible).toBe(false);
      avatars.showBonusPickup("r1", "shield");
      expect(badge?.visible).toBe(true);
      avatars.sync([makeSnapshot({ sessionId: "r1", shieldHp: 0, shieldUntil: 0, speedUntil: 0 })], null, 1.51, 12_000);
      expect(shield?.visible).toBe(false);
      expect(wind?.visible).toBe(false);
      expect(badge?.visible).toBe(false);
    } finally {
      avatars.dispose();
    }
  });

  it("shows a moving remote's wake only with a speed buff and hides on expiry or death", () => {
    const scene = new THREE.Scene();
    const avatars = new RemoteAvatars(scene);
    try {
      avatars.sync([makeSnapshot({ sessionId: "r1" })], null, FRAME, 1_000);
      const trail = rigOf(scene).getObjectByName("run-wind-trail");
      expect(trail?.visible).toBe(false);
      avatars.sync([makeSnapshot({ sessionId: "r1", z: 2 })], null, FRAME, 1_000);
      expect(trail?.visible).toBe(false);
      avatars.sync([makeSnapshot({ sessionId: "r1", z: 3, speedUntil: 6_000 })], null, FRAME, 1_000);
      expect(trail?.visible).toBe(true);
      avatars.sync([makeSnapshot({ sessionId: "r1", z: 4, speedUntil: 6_000 })], null, FRAME, 6_000);
      expect(trail?.visible).toBe(false);
      avatars.sync([makeSnapshot({ sessionId: "r1", z: 5, speedUntil: 12_000 })], null, FRAME, 6_000);
      expect(trail?.visible).toBe(true);
      avatars.sync([makeSnapshot({ sessionId: "r1", z: 5, speedUntil: 12_000, alive: false })], null, FRAME, 6_000);
      expect(trail?.visible).toBe(false);
    } finally {
      avatars.dispose();
    }
  });

  it("suppresses a buffed remote wake while airborne and restores it after landing", () => {
    const scene = new THREE.Scene();
    const avatars = new RemoteAvatars(scene);
    try {
      let x = 0;
      let y = 1.1;
      avatars.sync([makeSnapshot({ sessionId: "r1", speedUntil: 10_000 })], null, FRAME, 1_000);
      const trail = rigOf(scene).getObjectByName("run-wind-trail");
      for (let i = 0; i < 30; i += 1) {
        x += 0.1;
        avatars.sync([makeSnapshot({ sessionId: "r1", x, y, speedUntil: 10_000 })], null, FRAME, 1_000);
      }
      expect(trail?.visible).toBe(true);
      for (let i = 0; i < 60; i += 1) {
        x += 0.1;
        y += 0.15;
        avatars.sync([makeSnapshot({ sessionId: "r1", x, y, speedUntil: 10_000 })], null, FRAME, 1_000);
      }
      expect(rigOf(scene).rotation.x).toBeGreaterThan(0.05);
      expect(trail?.visible).toBe(false);
      for (let i = 0; i < 120; i += 1) {
        x += 0.1;
        avatars.sync([makeSnapshot({ sessionId: "r1", x, y: 1.1, speedUntil: 10_000 })], null, FRAME, 1_000);
      }
      expect(trail?.visible).toBe(true);
      for (let i = 0; i < 120; i += 1) {
        avatars.sync([makeSnapshot({ sessionId: "r1", x, y: 1.1, speedUntil: 10_000 })], null, FRAME, 1_000);
      }
      expect(trail?.visible).toBe(false);
    } finally {
      avatars.dispose();
    }
  });

  it("removes an active speed wake when a fighter spectates or the room resets", () => {
    const scene = new THREE.Scene();
    const avatars = new RemoteAvatars(scene);
    try {
      const snapshot = makeSnapshot({ sessionId: "r1", speedUntil: 10_000 });
      avatars.sync([snapshot], null, FRAME, 1_000);
      avatars.sync([{ ...snapshot, x: 1 }], null, FRAME, 1_000);
      expect(rigOf(scene).getObjectByName("run-wind-trail")?.visible).toBe(true);
      avatars.sync([{ ...snapshot, spectator: true }], null, FRAME, 1_000);
      expect(scene.children).toHaveLength(0);
      avatars.sync([snapshot], null, FRAME, 1_000);
      avatars.sync([{ ...snapshot, x: 1 }], null, FRAME, 1_000);
      expect(rigOf(scene).getObjectByName("run-wind-trail")?.visible).toBe(true);
      avatars.sync([], null, FRAME, 1_000);
      expect(scene.children).toHaveLength(0);
    } finally {
      avatars.dispose();
    }
  });
});

// Stage 4d.4: remote victim hit-flash — flashVictim spikes THAT remote's body
// emissive (ACCENT_HIT_FLASH, 2.5 -> 0 over 0.18s via its own HitFlash,
// ticked in sync), visible to all viewers. Non-victims stay dark, unknown
// ids are a no-op.
describe("RemoteAvatars victim hit-flash (flashVictim routing)", () => {
  function bodyMaterialOf(scene: THREE.Scene, index: number): THREE.MeshStandardMaterial {
    const group = scene.children[index];
    if (!(group instanceof THREE.Group)) {
      throw new Error("remote entry group missing from scene");
    }
    const rig = group.children[0];
    if (!(rig instanceof THREE.Group)) {
      throw new Error("remote rig missing from entry group");
    }
    const body = rig.children[0];
    if (!(body instanceof THREE.Mesh)) {
      throw new Error("remote body missing from rig");
    }
    return body.material as THREE.MeshStandardMaterial;
  }

  function twoRemotes(): NetPlayerSnapshot[] {
    return [makeSnapshot({ sessionId: "r1" }), makeSnapshot({ sessionId: "r2", x: 3 })];
  }

  it("rests at emissiveIntensity 0 with the hit-flash emissive color", () => {
    const scene = new THREE.Scene();
    const avatars = new RemoteAvatars(scene);
    try {
      avatars.sync(twoRemotes(), null, FRAME);
      for (const index of [0, 1]) {
        const material = bodyMaterialOf(scene, index);
        expect(material.emissive.getHex()).toBe(ACCENT_HIT_FLASH);
        expect(material.emissiveIntensity).toBe(0);
      }
    } finally {
      avatars.dispose();
    }
  });

  it("flashVictim spikes only that remote, fading over ~0.18s", () => {
    expect(HIT_FLASH_DURATION_S).toBe(0.18);
    const scene = new THREE.Scene();
    const avatars = new RemoteAvatars(scene);
    try {
      avatars.sync(twoRemotes(), null, FRAME);
      avatars.flashVictim("r1");
      avatars.sync(twoRemotes(), null, FRAME);
      // One frame ticked: spiked high, still fading (2.5 * remaining share).
      expect(bodyMaterialOf(scene, 0).emissiveIntensity).toBeGreaterThan(1);
      // Non-victim remotes stay dark.
      expect(bodyMaterialOf(scene, 1).emissiveIntensity).toBe(0);
      // Past the flash duration every entry is dark again.
      const frames = Math.ceil(HIT_FLASH_DURATION_S / FRAME) + 5;
      for (let i = 0; i < frames; i += 1) {
        avatars.sync(twoRemotes(), null, FRAME);
      }
      expect(bodyMaterialOf(scene, 0).emissiveIntensity).toBe(0);
      expect(bodyMaterialOf(scene, 1).emissiveIntensity).toBe(0);
    } finally {
      avatars.dispose();
    }
  });

  it("unknown ids are a no-op (leave/reset races never throw)", () => {
    const scene = new THREE.Scene();
    const avatars = new RemoteAvatars(scene);
    try {
      avatars.sync(twoRemotes(), null, FRAME);
      expect((): void => {
        avatars.flashVictim("ghost");
      }).not.toThrow();
      avatars.sync(twoRemotes(), null, FRAME);
      expect(bodyMaterialOf(scene, 0).emissiveIntensity).toBe(0);
      expect(bodyMaterialOf(scene, 1).emissiveIntensity).toBe(0);
    } finally {
      avatars.dispose();
    }
  });
});
