import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { BALL_MUZZLE_OFFSET, BALL_TORSO_OFFSET, MAX_LIVE_BALLS, SELF_SPAWN_Y } from "../config";
import { directionFromYawPitch, muzzleForShot, type NetBallSnapshot } from "../net/protocol";
import {
  BALL_BASALT_COLOR,
  BALL_CAP_COLOR,
  BALL_RADIUS,
  BallsPool,
  MUZZLE_FLASH_LIFE_S,
  SUPER_BALL_COLOR,
  SUPER_CORE_INNER_RADIUS,
  SUPER_CORE_OUTER_RADIUS,
  SUPER_INNER_COLOR,
  SuperCore,
  TRAIL_GOLD_COLOR,
  TRAIL_SUPER_COLOR,
} from "./Balls";

function makeBall(ballId: string, superShot: boolean, color: number = BALL_CAP_COLOR): NetBallSnapshot {
  return { ballId, ownerId: "owner", x: 1, y: 1.4, z: 2, power01: 1, super: superShot, color };
}

function makeBallAt(
  ballId: string,
  x: number,
  y = 1.4,
  z = 0,
  color: number = BALL_CAP_COLOR,
): NetBallSnapshot {
  return { ballId, ownerId: "owner", x, y, z, power01: 1, super: false, color };
}

function ballGroups(scene: THREE.Scene): THREE.Group[] {
  return scene.children.filter((child): child is THREE.Group => child instanceof THREE.Group);
}

function puffSprites(scene: THREE.Scene): THREE.Sprite[] {
  return scene.children.filter((child): child is THREE.Sprite => child instanceof THREE.Sprite);
}

// Throw-polish balls: bigger radius, two-tone cores, no per-ball trails.
describe("BallsPool throw-polish", () => {
  it("uses BALL_RADIUS 0.38 for the shared body geometry", () => {
    expect(BALL_RADIUS).toBe(0.38);
    const scene = new THREE.Scene();
    const pool = new BallsPool(scene);
    try {
      const groups = ballGroups(scene);
      expect(groups).toHaveLength(MAX_LIVE_BALLS);
      for (const group of groups) {
        const body = group.children[0];
        expect(body).toBeInstanceOf(THREE.Mesh);
        const geometry = (body as THREE.Mesh).geometry as THREE.SphereGeometry;
        expect(geometry.parameters.radius).toBeCloseTo(0.38, 5);
      }
    } finally {
      pool.dispose();
    }
  });

  it("builds two-tone cores with pooled trail sprites + 8 puffs", () => {
    const scene = new THREE.Scene();
    const pool = new BallsPool(scene);
    try {
      const groups = ballGroups(scene);
      expect(groups).toHaveLength(MAX_LIVE_BALLS);
      for (const group of groups) {
        expect(group.children).toHaveLength(2);
        for (const child of group.children) {
          expect(child).toBeInstanceOf(THREE.Mesh);
          expect(child).not.toBeInstanceOf(THREE.Sprite);
        }
      }
      // 8 impact puffs + 2 trail sprites per ball slot (gold/purple).
      expect(puffSprites(scene)).toHaveLength(8 + MAX_LIVE_BALLS * 2);
    } finally {
      pool.dispose();
    }
  });

  it("paints basalt+orange normally and purple+white for SUPER, pulsing the inner", () => {
    const scene = new THREE.Scene();
    const pool = new BallsPool(scene);
    try {
      pool.render([makeBall("b1", false)]);
      let groups = ballGroups(scene);
      const normalBody = groups[0]?.children[0] as THREE.Mesh | undefined;
      const normalCap = groups[0]?.children[1] as THREE.Mesh | undefined;
      expect((normalBody?.material as THREE.MeshBasicMaterial).color.getHex()).toBe(BALL_BASALT_COLOR);
      expect((normalCap?.material as THREE.MeshBasicMaterial).color.getHex()).toBe(BALL_CAP_COLOR);

      pool.render([makeBall("b1", false), makeBall("b2", true)]);
      groups = ballGroups(scene);
      const superBody = groups[1]?.children[0] as THREE.Mesh | undefined;
      const superCap = groups[1]?.children[1] as THREE.Mesh | undefined;
      expect((superBody?.material as THREE.MeshBasicMaterial).color.getHex()).toBe(SUPER_BALL_COLOR);
      expect((superCap?.material as THREE.MeshBasicMaterial).color.getHex()).toBe(SUPER_INNER_COLOR);
      const before = superCap?.scale.x ?? 1;
      pool.update(1 / 60);
      const after = superCap?.scale.x ?? 1;
      expect(after).not.toBe(before);
    } finally {
      pool.dispose();
    }
  });
});

// Throw-polish SuperCore: bigger shells + inner pulse, no lights added.
describe("SuperCore throw-polish", () => {
  it("uses outer 1.0 / inner 0.5 shells and pulses the inner", () => {
    expect(SUPER_CORE_OUTER_RADIUS).toBe(1.0);
    expect(SUPER_CORE_INNER_RADIUS).toBe(0.5);
    const scene = new THREE.Scene();
    const core = new SuperCore(scene);
    try {
      core.render({ active: true, x: 0, z: 0, expiresAt: Date.now() + 10000, nextAt: 0 }, Date.now());
      const group = scene.children.find((child): child is THREE.Group => child instanceof THREE.Group);
      expect(group).toBeDefined();
      const meshes = group?.children.filter((child): child is THREE.Mesh => child instanceof THREE.Mesh) ?? [];
      expect(meshes).toHaveLength(2);
      const radii = meshes.map((mesh) => (mesh.geometry as THREE.IcosahedronGeometry).parameters.radius).sort();
      expect(radii[0]).toBeCloseTo(0.5, 5);
      expect(radii[1]).toBeCloseTo(1.0, 5);
      const inner = group?.children.find((child) => child instanceof THREE.Mesh && child.name === "super-core-inner");
      const before = (inner as THREE.Mesh | undefined)?.scale.x ?? 1;
      core.update(1 / 16);
      const after = (inner as THREE.Mesh | undefined)?.scale.x ?? 1;
      expect(after).not.toBe(before);
    } finally {
      core.dispose();
    }
  });
});

// Muzzle-origin sync: pool keyed by ballId, lerp smoothing, instant flash.
describe("BallsPool ballId-stable mapping", () => {
  function visibleXs(scene: THREE.Scene): number[] {
    return ballGroups(scene)
      .filter((group) => group.visible)
      .map((group) => group.position.x)
      .sort((a, b) => a - b);
  }

  it("deleting the middle ball keeps the survivors in place (no teleport)", () => {
    const scene = new THREE.Scene();
    const pool = new BallsPool(scene);
    try {
      pool.render([makeBallAt("a", 0), makeBallAt("b", 10), makeBallAt("c", 20)]);
      expect(visibleXs(scene)).toEqual([0, 10, 20]);
      // Drop the middle id, nudge the survivors: stable slots keep a at 0
      // and c at 20 until update() eases them (no snap into freed slots).
      pool.render([makeBallAt("a", 0.1), makeBallAt("c", 20.1)]);
      expect(visibleXs(scene)).toEqual([0, 20]);
    } finally {
      pool.dispose();
    }
  });

  it("order shifts keep ids (swap never snaps)", () => {
    const scene = new THREE.Scene();
    const pool = new BallsPool(scene);
    try {
      pool.render([makeBallAt("a", 0), makeBallAt("b", 50)]);
      expect(visibleXs(scene)).toEqual([0, 50]);
      // Same ids, swapped wire order: no slot changes, no snaps.
      pool.render([makeBallAt("b", 50.1), makeBallAt("a", 0.1)]);
      expect(visibleXs(scene)).toEqual([0, 50]);
    } finally {
      pool.dispose();
    }
  });

  it("lerps toward the target and snaps beyond 6m", () => {
    const scene = new THREE.Scene();
    const pool = new BallsPool(scene);
    try {
      pool.render([makeBallAt("a", 0)]);
      pool.render([makeBallAt("a", 2)]);
      // Existing ids only move the target: position holds until update().
      expect(visibleXs(scene)).toEqual([0]);
      pool.update(1 / 60);
      const stepped = visibleXs(scene)[0] ?? 0;
      expect(stepped).toBeGreaterThan(0);
      expect(stepped).toBeLessThan(2);
      // Far warp (>6m) snaps immediately instead of sliding across the arena.
      pool.render([makeBallAt("a", 100)]);
      pool.update(1 / 60);
      expect(visibleXs(scene)).toEqual([100]);
    } finally {
      pool.dispose();
    }
  });
});

describe("client muzzle math mirrors the server", () => {
  it("muzzleForShot equals bodyCenter XZ + dir*0.7, y = bodyY + torso offset", () => {
    expect(BALL_MUZZLE_OFFSET).toBeCloseTo(0.7, 10);
    expect(BALL_TORSO_OFFSET).toBeCloseTo(0.3, 10);
    const yaw = 0.7;
    const pitch = 0.3;
    // Ground equivalence: body-center 1.1 + 0.3 == old absolute 1.4.
    const muzzle = muzzleForShot(3, SELF_SPAWN_Y, -4, yaw, pitch);
    const dir = directionFromYawPitch(yaw, pitch);
    expect(muzzle.x).toBeCloseTo(3 + dir.x * BALL_MUZZLE_OFFSET, 10);
    expect(muzzle.z).toBeCloseTo(-4 + dir.z * BALL_MUZZLE_OFFSET, 10);
    expect(muzzle.y).toBeCloseTo(1.4, 10);
    expect(muzzle.y).toBeCloseTo(SELF_SPAWN_Y + BALL_TORSO_OFFSET, 10);
    expect(muzzle.dirX).toBeCloseTo(dir.x, 10);
    expect(muzzle.dirY).toBeCloseTo(dir.y, 10);
    expect(muzzle.dirZ).toBeCloseTo(dir.z, 10);
  });

  it("tracks thrower elevation: spawn y = body y + torso offset", () => {
    const yaw = 0.7;
    const pitch = 0.3;
    // Elevated thrower (platform top 2.6 + body-center 1.1 = 3.7).
    const elevated = muzzleForShot(13.8, 3.7, -8.5, yaw, pitch);
    expect(elevated.y).toBeCloseTo(3.7 + BALL_TORSO_OFFSET, 10);
    expect(elevated.y).toBeCloseTo(4.0, 10);
    // XZ offset logic is elevation-independent.
    const dir = directionFromYawPitch(yaw, pitch);
    expect(elevated.x).toBeCloseTo(13.8 + dir.x * BALL_MUZZLE_OFFSET, 10);
    expect(elevated.z).toBeCloseTo(-8.5 + dir.z * BALL_MUZZLE_OFFSET, 10);
  });
});

describe("BallsPool muzzle flash", () => {
  it("flashMuzzle pops a DOUBLE sprite at the tip, gone after 0.12s", () => {
    const scene = new THREE.Scene();
    const pool = new BallsPool(scene);
    try {
      expect(MUZZLE_FLASH_LIFE_S).toBe(0.12);
      pool.flashMuzzle(1, 1.4, 2, false);
      const lit = puffSprites(scene).filter((sprite) => sprite.visible);
      // Double flash: core + halo at the same tip.
      expect(lit.length).toBeGreaterThanOrEqual(2);
      const placed = lit.filter(
        (sprite) =>
          Math.abs(sprite.position.x - 1) < 1e-9 &&
          Math.abs(sprite.position.y - 1.4) < 1e-9 &&
          Math.abs(sprite.position.z - 2) < 1e-9,
      );
      expect(placed.length).toBeGreaterThanOrEqual(2);
      pool.update(0.2);
      expect(puffSprites(scene).filter((sprite) => sprite.visible)).toHaveLength(0);
    } finally {
      pool.dispose();
    }
  });

  it("shows gold trails for normal balls and purple for SUPER", () => {
    const scene = new THREE.Scene();
    const pool = new BallsPool(scene);
    try {
      // Normal core carries its thrower color: a gold-tinted owner keeps the
      // gold-trail read, SUPER stays purple regardless of owner color.
      pool.render([makeBall("b1", false, TRAIL_GOLD_COLOR), makeBall("b2", true)]);
      pool.update(1 / 60);
      const visible = puffSprites(scene).filter((sprite) => sprite.visible);
      const colors = visible.map((sprite) => (sprite.material as THREE.SpriteMaterial).color.getHex());
      expect(colors).toContain(TRAIL_GOLD_COLOR);
      expect(colors).toContain(TRAIL_SUPER_COLOR);
    } finally {
      pool.dispose();
    }
  });
});
