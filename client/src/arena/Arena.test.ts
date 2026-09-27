import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import {
  ARENA_HALF_SIZE,
  ICE_FRICTION,
  ICE_RADIUS,
  MOVE_SPEED,
  OBSTACLE_COUNT,
  PHYSICS_GRAVITY_Y,
  PLATFORM_CAP_DROP,
  PLATFORM_FIGURES,
  PLAYER_FRICTION,
  PLAYER_LINEAR_DAMPING,
  RAMP_SLOPE_DEG,
  SPAWN_COUNT,
  SWAMP_RADIUS,
  TRAMPOLINE_IMPULSE,
  TRAMPOLINE_PAD_DIM,
} from "../config";
import type { PhysicsWorld } from "../physics/World";
import {
  ArenaBuilder,
  getFrictionAt,
  getIceZones,
  getObstacleLayout,
  getPlatforms,
  getRamps,
  getSwampZones,
  getSpawnPoints,
  getTrampolines,
  isInsideZone,
  isOnIce,
  isOnSwamp,
} from "./Arena";
import { ARENA_LAYOUT } from "../layout";

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

describe("arena obstacle layout", () => {
  it("keeps the central jump towers tall and the movable outer cover low", () => {
    const specs = getObstacleLayout();
    expect(specs).toHaveLength(OBSTACLE_COUNT);
    // The owner moved the four outer blocks in the editor. Only the central
    // tower quartet remains symmetric and tall enough for bounce landings.
    const central = specs.filter((s) => Math.abs(s.x) === 4.8 && Math.abs(s.z) === 4.8);
    expect(central).toHaveLength(4);
    for (const spec of central) {
      expect(spec.hy).toBe(1.0);
      expect(spec.hy * 2).toBe(2.0);
    }
    // The outer cover can move independently and stays low enough to see over.
    const outer = specs.filter((s) => !(Math.abs(s.x) === 4.8 && Math.abs(s.z) === 4.8));
    expect(outer).toHaveLength(4);
    for (const spec of outer) {
      expect(spec.hy * 2).toBeLessThanOrEqual(1.0);
    }
  });

  it("uses each saved obstacle's position, footprint, and top height", () => {
    const specs = getObstacleLayout();
    expect(specs).toHaveLength(ARENA_LAYOUT.obstacles.length);
    const centers = new Set<string>();
    for (const [index, saved] of ARENA_LAYOUT.obstacles.entries()) {
      const spec = specs[index];
      expect(spec).toEqual({
        x: saved.x, z: saved.z, hx: saved.hx, hz: saved.hz, hy: saved.topY / 2,
      });
      centers.add(`${saved.x},${saved.z}`);
      expect(Math.abs(saved.x) + saved.hx).toBeLessThanOrEqual(ARENA_HALF_SIZE);
      expect(Math.abs(saved.z) + saved.hz).toBeLessThanOrEqual(ARENA_HALF_SIZE);
    }
    expect(centers.size).toBe(specs.length);
  });

  it("leaves the central towers ramp-free (trampoline-only reachability)", () => {
    // Ramps serve ONLY the 4 platform figures (exactly one ramp side each);
    // no ramp slab may sit on/against a central tower, or fighters could
    // walk up instead of bouncing. Pin by horizontal clearance: every ramp
    // center stays well clear of every central tower center (ramps hug
    // their platforms far out, towers sit at +-4.8).
    const towers = getObstacleLayout().filter((s) => Math.abs(s.x) === 4.8 && Math.abs(s.z) === 4.8);
    expect(towers).toHaveLength(4);
    const ramps = getRamps();
    expect(ramps).toHaveLength(4);
    for (const tower of towers) {
      for (const ramp of ramps) {
        expect(Math.hypot(ramp.x - tower.x, ramp.z - tower.z)).toBeGreaterThan(4);
      }
    }
  });

  it("a trampoline bounce lands on the doubled top (damped reach proof, impulse 13.5)", () => {
    // Owner directive 2026-09-20 (+12.5% for easier tower landings): impulse
    // 12 -> 13.5, deliberately above the old QT3-A 8-12 band. The DAMPED
    // model below matches the shipped integration (exponential velocity
    // decay at PLAYER_LINEAR_DAMPING).
    // Damped vertical: y(t) = y0 + (A/d)(1-e^-dt) - (g/d)t, A = v0 + g/d.
    // Launch body-center y is worst-case 1.0 (resting capsule center; the
    // trigger band fires below TRAMPOLINE_TRIGGER_Y 1.7). Landing on the
    // 2.0m tower top needs center >= 2.0 + 1.0 (capsule half-height 0.5 +
    // radius 0.5) = 3.0. Horizontal cruise holds at MOVE_SPEED (input
    // steering at 24/s outruns the 2.5/s damping, so cruise speed survives
    // the flight): pad (0,4.2) to tower footprint edge ~= 3.8m ~= 0.84s.
    expect(TRAMPOLINE_IMPULSE).toBe(13.5);
    expect(TRAMPOLINE_IMPULSE).toBeGreaterThanOrEqual(8);
    const g = Math.abs(PHYSICS_GRAVITY_Y);
    const d = PLAYER_LINEAR_DAMPING;
    const dampedY = (v0: number, t: number): number => {
      const a = v0 + g / d;
      return 1.0 + (a / d) * (1 - Math.exp(-d * t)) - ((g / d) * t);
    };
    const dampedApexY = (v0: number): number => {
      const a = v0 + g / d;
      const tStar = -Math.log((g / d) / a) / d;
      return dampedY(v0, tStar);
    };
    const arriveT = 3.8 / MOVE_SPEED;
    expect(arriveT).toBeLessThan(0.9);
    const requiredCenterY = 2.0 + 1.0;
    // Arrival over the footprint clears 3.0 with comfortable margin (3.81m
    // vs the 3.5 bar, i.e. +0.8 over required).
    expect(dampedY(TRAMPOLINE_IMPULSE, arriveT)).toBeGreaterThan(requiredCenterY + 0.5);
    // 12 only reaches 3.28m — below the same bar: the buff was needed for
    // comfortable (not marginal) landings.
    expect(dampedY(12, arriveT)).toBeLessThan(requiredCenterY + 0.5);
    // Apex clears with margin (4.06m vs the 3.8 bar).
    expect(dampedApexY(TRAMPOLINE_IMPULSE)).toBeGreaterThan(requiredCenterY + 0.8);
  });

  it("dims trampoline pads -20% via the named multiplier (palette untouched)", () => {
    // 4d.3 feedback: pads read too hot. Emissive is 0.9 x TRAMPOLINE_PAD_DIM
    // (chartreuse color itself unchanged — palette constants never edited).
    expect(TRAMPOLINE_PAD_DIM).toBe(0.8);
    const scene = new THREE.Scene();
    const builder = new ArenaBuilder();
    builder.buildVisuals(scene);
    try {
      // Pads are the only InstancedMesh on the 0.85-top cylinder (bases use
      // a 1.0-top cylinder).
      const pads: THREE.InstancedMesh[] = [];
      scene.traverse((child: THREE.Object3D) => {
        if (child instanceof THREE.InstancedMesh) {
          const geometry = child.geometry;
          if (
            geometry instanceof THREE.CylinderGeometry
            && geometry.parameters.radiusTop === 0.85
          ) {
            pads.push(child);
          }
        }
      });
      expect(pads).toHaveLength(1);
      const pad = pads[0];
      if (pad === undefined) {
        return;
      }
      const material = pad.material as THREE.MeshStandardMaterial;
      expect(material.emissiveIntensity).toBeCloseTo(0.9 * TRAMPOLINE_PAD_DIM, 10);
      expect(material.emissiveIntensity).toBeCloseTo(0.72, 10);
    } finally {
      builder.dispose(scene);
    }
  });

  it("shows all six distinct server spawns inside the arena", () => {
    const spawns = getSpawnPoints();
    expect(spawns).toHaveLength(SPAWN_COUNT);
    expect(spawns).toHaveLength(6);
    const keys = new Set(spawns.map((s) => `${s.x},${s.z}`));
    expect(keys.size).toBe(spawns.length);
    for (const spawn of spawns) {
      expect(Math.abs(spawn.x)).toBeLessThan(ARENA_HALF_SIZE);
      expect(Math.abs(spawn.z)).toBeLessThan(ARENA_HALF_SIZE);
    }
  });
});

describe("swamp, ice, and trampolines", () => {
  it("keeps the new surface detail on shared textures and three instanced batches", () => {
    const scene = new THREE.Scene();
    const builder = new ArenaBuilder();
    builder.buildVisuals(scene);
    const floor = scene.getObjectByName("arena-floor") as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
    const ice = scene.getObjectByName("ice-zones") as THREE.InstancedMesh;
    const pads = scene.getObjectByName("trampoline-pads") as THREE.InstancedMesh;
    const edges = scene.getObjectByName("obstacle-top-edges") as THREE.InstancedMesh;
    const marks = scene.getObjectByName("ramp-surface-marks") as THREE.InstancedMesh;
    const slabs = scene.getObjectByName("ramp-slabs") as THREE.InstancedMesh;
    const plinths = scene.getObjectByName("wall-plinths") as THREE.InstancedMesh;
    const textures = [
      floor.material.map!,
      (ice.material as THREE.MeshStandardMaterial).map!,
      (pads.material as THREE.MeshStandardMaterial).map!,
    ];
    const disposalSpies = textures.map((texture) => vi.spyOn(texture, "dispose"));
    try {
      expect(floor.geometry.parameters.width).toBe(ARENA_HALF_SIZE * 2);
      expect(floor.material.color.getHex()).toBe(0xffffff);
      expect(floor.material.map!.repeat.toArray()).toEqual([6, 6]);
      expect(textures.every((texture) => texture.colorSpace === THREE.SRGBColorSpace)).toBe(true);
      expect(edges.count).toBe(getObstacleLayout().length * 4);
      expect(marks.count).toBe(getRamps().length * 4);
      expect(slabs.count).toBe(getRamps().length);
      expect(plinths.count).toBe(4);
      const matrix = new THREE.Matrix4();
      const position = new THREE.Vector3();
      const rotation = new THREE.Quaternion();
      const scale = new THREE.Vector3();
      for (const [index, ramp] of getRamps().entries()) {
        slabs.getMatrixAt(index, matrix);
        matrix.decompose(position, rotation, scale);
        expect(position.x).toBeCloseTo(ramp.x, 5);
        expect(position.y).toBeCloseTo(ramp.y, 5);
        expect(position.z).toBeCloseTo(ramp.z, 5);
        expect(scale.x).toBeCloseTo((ramp.axis === "x" ? ramp.halfWidth : ramp.halfLength) * 2, 6);
        expect(scale.y).toBeCloseTo(ramp.halfThick * 2, 6);
        expect(scale.z).toBeCloseTo((ramp.axis === "x" ? ramp.halfLength : ramp.halfWidth) * 2, 6);
        const expected = new THREE.Quaternion().setFromAxisAngle(
          ramp.axis === "x" ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1),
          ramp.angle,
        );
        expect(Math.abs(rotation.dot(expected))).toBeCloseTo(1, 6);
      }
      expect(scene.children.filter((child) => child instanceof THREE.Light)).toHaveLength(0);
    } finally {
      builder.dispose(scene);
      expect(disposalSpies.every((spy) => spy.mock.calls.length === 1)).toBe(true);
      expect(scene.children).toHaveLength(0);
    }
  });

  it("uses the saved zone sizes and detects their centers and edges", () => {
    const swamp = getSwampZones();
    const ice = getIceZones();
    expect(swamp).toEqual(ARENA_LAYOUT.swampZones);
    expect(ice).toEqual(ARENA_LAYOUT.iceZones);
    expect(SWAMP_RADIUS).toBe(swamp[0]?.radius ?? 0);
    expect(ICE_RADIUS).toBe(ice[0]?.radius ?? 0);
    for (const zone of swamp) {
      expect(isOnSwamp(zone.x, zone.z)).toBe(true);
      expect(isOnSwamp(zone.x + zone.radius - 0.001, zone.z)).toBe(true);
      expect(isInsideZone(zone.x + zone.radius + 0.001, zone.z, zone)).toBe(false);
      expect(isOnIce(zone.x, zone.z)).toBe(false);
    }
    for (const zone of ice) {
      expect(isOnIce(zone.x, zone.z)).toBe(true);
      expect(isOnIce(zone.x + zone.radius - 0.001, zone.z)).toBe(true);
      expect(isInsideZone(zone.x + zone.radius + 0.001, zone.z, zone)).toBe(false);
      expect(isOnSwamp(zone.x, zone.z)).toBe(false);
    }
  });

  it("keeps ice friction low and swamp friction ordinary", () => {
    expect(ICE_FRICTION).toBeGreaterThanOrEqual(0.05);
    expect(ICE_FRICTION).toBeLessThanOrEqual(0.1);
    const ice = getIceZones();
    const swamp = getSwampZones();
    for (const zone of ice) {
      expect(getFrictionAt(zone.x, zone.z)).toBe(ICE_FRICTION);
    }
    for (const zone of swamp) {
      expect(getFrictionAt(zone.x, zone.z)).toBe(PLAYER_FRICTION);
    }
    const clearSpawn = getSpawnPoints().find((spawn) => !isOnIce(spawn.x, spawn.z));
    expect(clearSpawn).toBeDefined();
    if (clearSpawn !== undefined) {
      expect(getFrictionAt(clearSpawn.x, clearSpawn.z)).toBe(PLAYER_FRICTION);
    }
  });

  it("animates the same small bubble batch and disposes its texture", () => {
    const scene = new THREE.Scene();
    const builder = new ArenaBuilder();
    builder.buildVisuals(scene);
    const ice = scene.getObjectByName("ice-zones") as THREE.InstancedMesh;
    const swamp = scene.getObjectByName("swamp-zones") as THREE.InstancedMesh;
    const bubbles = scene.getObjectByName("swamp-bubbles") as THREE.InstancedMesh;
    const material = swamp.material as THREE.MeshBasicMaterial;
    const iceDispose = vi.spyOn(ice, "dispose");
    const swampDispose = vi.spyOn(swamp, "dispose");
    const bubbleDispose = vi.spyOn(bubbles, "dispose");
    const textureDispose = vi.spyOn(material.map!, "dispose");
    try {
      expect(ice.count).toBe(getIceZones().length);
      expect(swamp.count).toBe(getSwampZones().length);
      expect(bubbles.count).toBe(getSwampZones().length * 10);
      expect(material.map).toBeInstanceOf(THREE.DataTexture);
      expect(material.map?.magFilter).toBe(THREE.NearestFilter);
      const before = new THREE.Matrix4();
      const after = new THREE.Matrix4();
      bubbles.getMatrixAt(0, before);
      builder.update(0.25);
      bubbles.getMatrixAt(0, after);
      expect(after.elements).not.toEqual(before.elements);
    } finally {
      builder.dispose(scene);
    }
    expect(scene.children).toHaveLength(0);
    expect(iceDispose).toHaveBeenCalledOnce();
    expect(swampDispose).toHaveBeenCalledOnce();
    expect(bubbleDispose).toHaveBeenCalledOnce();
    expect(textureDispose).toHaveBeenCalledOnce();
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
