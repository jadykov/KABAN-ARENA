import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  ARENA_HALF_SIZE,
  ICE_FRICTION,
  OBSTACLE_COUNT,
  PLATFORM_CAP_DROP,
  PLATFORM_FIGURES,
  PLAYER_FRICTION,
  RAMP_SLOPE_DEG,
  SPAWN_COUNT,
} from "../config";
import type { PhysicsWorld } from "../physics/World";
import {
  ArenaBuilder,
  getFrictionAt,
  getObstacleLayout,
  getPlatforms,
  getRamps,
  getSlipperyZones,
  getSpawnPoints,
  getTrampolines,
  isOnSlippery,
} from "./Arena";

interface RecordedBox {
  hx: number;
  hy: number;
  hz: number;
  x: number;
  y: number;
  z: number;
}

interface RecordedRotatedBox extends RecordedBox {
  rotation: { x: number; y: number; z: number; w: number };
}

function createRecordingPhysics(): {
  boxes: RecordedBox[];
  rotated: RecordedRotatedBox[];
  physics: PhysicsWorld;
} {
  const boxes: RecordedBox[] = [];
  const rotated: RecordedRotatedBox[] = [];
  const fake = {
    addStaticBox(hx: number, hy: number, hz: number, x: number, y: number, z: number): void {
      boxes.push({ hx, hy, hz, x, y, z });
    },
    addStaticRotatedBox(
      hx: number,
      hy: number,
      hz: number,
      x: number,
      y: number,
      z: number,
      rotation: { x: number; y: number; z: number; w: number },
    ): void {
      rotated.push({ hx, hy, hz, x, y, z, rotation });
    },
  };
  return { boxes, rotated, physics: fake as unknown as PhysicsWorld };
}

describe("arena obstacle layout (QD5-A)", () => {
  it("has 8 low symmetric blocks", () => {
    const specs = getObstacleLayout();
    expect(specs).toHaveLength(OBSTACLE_COUNT);
    expect(OBSTACLE_COUNT).toBe(8);
    for (const spec of specs) {
      // Low blocks: the phone camera always sees over them.
      expect(spec.hy * 2).toBeLessThanOrEqual(1.0);
      // Mirror-symmetric on both axes and under 180-degree rotation.
      const mirrors = [
        specs.some((o) => o.x === -spec.x && o.z === spec.z),
        specs.some((o) => o.x === spec.x && o.z === -spec.z),
        specs.some((o) => o.x === -spec.x && o.z === -spec.z),
      ];
      expect(mirrors).toEqual([true, true, true]);
    }
  });

  it("places 4 distinct corner spawns inside the arena", () => {
    const spawns = getSpawnPoints();
    expect(spawns).toHaveLength(SPAWN_COUNT);
    const keys = new Set(spawns.map((s) => `${s.x},${s.z}`));
    expect(keys.size).toBe(spawns.length);
    for (const spawn of spawns) {
      expect(Math.abs(spawn.x)).toBeLessThan(ARENA_HALF_SIZE);
      expect(Math.abs(spawn.z)).toBeLessThan(ARENA_HALF_SIZE);
    }
  });
});

describe("slippery zones and trampolines", () => {
  it("keeps ice friction inside the QT3-A 0.05-0.1 band", () => {
    expect(ICE_FRICTION).toBeGreaterThanOrEqual(0.05);
    expect(ICE_FRICTION).toBeLessThanOrEqual(0.1);
    const zones = getSlipperyZones();
    expect(zones).toHaveLength(2);
    expect(isOnSlippery(zones[0]?.x ?? 0, zones[0]?.z ?? 0)).toBe(true);
    expect(isOnSlippery(0, 0)).toBe(false);
    expect(getFrictionAt(zones[1]?.x ?? 0, zones[1]?.z ?? 0)).toBe(ICE_FRICTION);
    expect(getFrictionAt(0, 0)).toBe(PLAYER_FRICTION);
  });

  it("puts two trampolines on the center lane, clear of obstacles", () => {
    const pads = getTrampolines();
    expect(pads).toHaveLength(2);
    for (const pad of pads) {
      expect(pad.x).toBe(0);
    }
    expect(pads[0]?.z).toBe(-(pads[1]?.z ?? 0));
    for (const pad of pads) {
      for (const block of getObstacleLayout()) {
        const clearX = Math.abs(pad.x - block.x) > block.hx + pad.radius;
        const clearZ = Math.abs(pad.z - block.z) > block.hz + pad.radius;
        expect(clearX || clearZ).toBe(true);
      }
    }
  });
});

describe("collider-visual match", () => {
  it("builds 4 wall + 8 obstacle + 4 platform colliders plus 4 ramp slabs", () => {
    const { boxes, rotated, physics } = createRecordingPhysics();
    new ArenaBuilder().buildColliders(physics);
    // 4 walls + 8 obstacle blocks + 4 platform tops = 16 axis-aligned boxes.
    expect(getPlatforms()).toHaveLength(4);
    expect(PLATFORM_FIGURES).toHaveLength(4);
    expect(boxes).toHaveLength(4 + OBSTACLE_COUNT + 4);
    // 4 walk-up ramp slabs as rotated boxes (exactly one per figure).
    expect(rotated).toHaveLength(4);
    expect(getRamps()).toHaveLength(4);
    for (const spec of getObstacleLayout()) {
      const match = boxes.find(
        (box) =>
          box.x === spec.x &&
          box.z === spec.z &&
          box.hx === spec.hx &&
          box.hy === spec.hy &&
          box.hz === spec.hz,
      );
      expect(match).toBeDefined();
      // Obstacle colliders rest on the floor exactly like the visuals.
      expect(match?.y).toBe(spec.hy);
    }
    for (const platform of getPlatforms()) {
      const match = boxes.find((box) => box.x === platform.x && box.z === platform.z);
      expect(match).toBeDefined();
      expect(match?.y).toBeCloseTo(platform.topY / 2, 10);
    }
  });

  it("ramps are gentle walk-up slabs with valid rotations", () => {
    const ramps = getRamps();
    expect(ramps).toHaveLength(4);
    expect(RAMP_SLOPE_DEG).toBeGreaterThanOrEqual(13);
    expect(RAMP_SLOPE_DEG).toBeLessThanOrEqual(15);
    for (const ramp of ramps) {
      // Slope matches RAMP_SLOPE_DEG (~13-15 deg) so the capsule walks up.
      const slopeDeg = (Math.abs(ramp.angle) * 180) / Math.PI;
      expect(slopeDeg).toBeCloseTo(RAMP_SLOPE_DEG, 0);
      expect(slopeDeg).toBeGreaterThan(5);
      expect(slopeDeg).toBeLessThan(25);
      expect(ramp.halfThick).toBeGreaterThan(0);
      expect(ramp.halfLength).toBeGreaterThan(1);
    }
    const { rotated, physics } = createRecordingPhysics();
    new ArenaBuilder().buildColliders(physics);
    for (const box of rotated) {
      const norm = Math.hypot(box.rotation.x, box.rotation.y, box.rotation.z, box.rotation.w);
      expect(norm).toBeCloseTo(1, 3);
    }
  });

  it("keeps every collider inside the arena bounds (walls included)", () => {
    const { boxes, rotated, physics } = createRecordingPhysics();
    new ArenaBuilder().buildColliders(physics);
    const limit = ARENA_HALF_SIZE + 1;
    for (const box of [...boxes, ...rotated]) {
      expect(Math.abs(box.x)).toBeLessThanOrEqual(limit + Math.max(box.hx, box.hz));
      expect(Math.abs(box.z)).toBeLessThanOrEqual(limit + Math.max(box.hx, box.hz));
    }
  });

  it("keeps trampoline pads trigger-only (no physical pad collider)", () => {
    // Design decision: pads auto-launch by proximity (see Arena
    // buildColliders), so no static box may sit under a pad — the capsule
    // must pass over it freely. This test pins that decision.
    const { boxes, physics } = createRecordingPhysics();
    new ArenaBuilder().buildColliders(physics);
    for (const pad of getTrampolines()) {
      const intruders = boxes.filter(
        (box) => Math.hypot(box.x - pad.x, box.z - pad.z) < pad.radius + 1,
      );
      expect(intruders).toHaveLength(0);
    }
  });

  it("keeps platform cap tops strictly below body tops (no z-fighting)", () => {
    // Stage 4d.2: cap plates drop 5mm below the figure top so the two top
    // faces are never coplanar (classic z-fight). Caps are the only
    // individual box meshes with height 0.1 (ramps use 0.2 slabs).
    expect(PLATFORM_CAP_DROP).toBe(0.005);
    const scene = new THREE.Scene();
    const builder = new ArenaBuilder();
    builder.buildVisuals(scene);
    try {
      const platforms = getPlatforms();
      const caps: THREE.Mesh[] = [];
      scene.traverse((child: THREE.Object3D) => {
        if (child instanceof THREE.Mesh && !(child instanceof THREE.InstancedMesh)) {
          const geometry = child.geometry;
          if (geometry instanceof THREE.BoxGeometry && geometry.parameters.height === 0.1) {
            caps.push(child);
          }
        }
      });
      expect(caps).toHaveLength(platforms.length);
      for (const platform of platforms) {
        const cap = caps.find(
          (mesh) => mesh.position.x === platform.x && mesh.position.z === platform.z,
        );
        expect(cap).toBeDefined();
        if (cap === undefined) {
          continue;
        }
        const geometry = cap.geometry;
        if (!(geometry instanceof THREE.BoxGeometry)) {
          throw new Error("cap mesh lost its box geometry");
        }
        const capTop = cap.position.y + geometry.parameters.height / 2;
        expect(capTop).toBeLessThan(platform.topY);
        expect(platform.topY - capTop).toBeCloseTo(PLATFORM_CAP_DROP, 10);
      }
    } finally {
      builder.dispose(scene);
    }
  });

  it("adds and removes arena visuals from the scene", () => {
    const scene = new THREE.Scene();
    const builder = new ArenaBuilder();
    builder.buildVisuals(scene);
    expect(scene.children.length).toBeGreaterThan(0);
    builder.dispose(scene);
    expect(scene.children).toHaveLength(0);
  });

  it("gives each figure exactly one ramp side", () => {
    const ramps = getRamps();
    const platforms = getPlatforms();
    expect(platforms).toHaveLength(4);
    expect(ramps).toHaveLength(platforms.length);
    const sides = PLATFORM_FIGURES.map((figure) => figure.rampSide);
    expect(new Set(sides).size).toBeGreaterThanOrEqual(3);
    for (const figure of PLATFORM_FIGURES) {
      expect(["+x", "-x", "+z", "-z"]).toContain(figure.rampSide);
    }
  });

  it("keeps the center empty for SUPER drops", () => {
    for (const platform of getPlatforms()) {
      const coversCenter =
        Math.abs(platform.x) <= platform.hx && Math.abs(platform.z) <= platform.hz;
      expect(coversCenter).toBe(false);
    }
    for (const block of getObstacleLayout()) {
      const coversCenter =
        Math.abs(block.x) <= block.hx && Math.abs(block.z) <= block.hz;
      expect(coversCenter).toBe(false);
    }
  });
});
