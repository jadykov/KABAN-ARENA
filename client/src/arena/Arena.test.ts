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
  it("keeps floor and surface textures shared without increasing floor geometry", () => {
    const scene = new THREE.Scene();
    const builder = new ArenaBuilder();
    builder.buildVisuals(scene);
    const floor = scene.getObjectByName("arena-floor") as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
    const ice = scene.getObjectByName("ice-zones") as THREE.InstancedMesh;
    const pads = scene.getObjectByName("trampoline-pads") as THREE.InstancedMesh;
    const edges = scene.getObjectByName("obstacle-top-edges") as THREE.InstancedMesh;
    const blocks = scene.getObjectByName("arena-obstacles") as THREE.InstancedMesh;
    const platforms = scene.getObjectByName("platform-volumes") as THREE.InstancedMesh;
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
      expect(floor.geometry.getIndex()!.count).toBe(6);
      expect(floor.material.map!.repeat.toArray()).toEqual([1, 1]);
      expect(textures.every((texture) => texture.colorSpace === THREE.SRGBColorSpace)).toBe(true);
      const floorPixels = floor.material.map!.image.data as Uint8Array;
      const floorPixel = (x: number, y: number): string =>
        Array.from(floorPixels.subarray((y * 256 + x) * 4, (y * 256 + x) * 4 + 3)).join(",");
      expect(new Set([16, 24, 32, 40, 48, 56, 64, 72, 80, 88]
        .map((y) => floorPixel(1, y))).size).toBeGreaterThan(2);
      expect(floorPixel(60, 60)).not.toBe(floorPixel(188, 60));
      expect(edges.count).toBe(getObstacleLayout().length * 4);
      // Beveled render meshes soften corners without touching the box/rotated
      // box colliders checked below. Shared instancing keeps draw calls flat.
      for (const mesh of [blocks, platforms, edges]) {
        const normals = mesh.geometry.getAttribute("normal");
        expect(normals.count).toBeGreaterThan(24);
        expect(Array.from({ length: normals.count }, (_, i) => i).some((i) =>
          Math.abs(normals.getX(i)) > 0.1 && Math.abs(normals.getY(i)) > 0.1)).toBe(true);
      }
      expect(plinths.count).toBe(4);
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
      expect(bubbles.count).toBe(getSwampZones().length * 7);
      expect(material.map).toBeInstanceOf(THREE.DataTexture);
      expect(material.map?.magFilter).toBe(THREE.LinearFilter);
      expect(material.map?.minFilter).toBe(THREE.LinearMipmapLinearFilter);
      expect((material.map?.image as { width: number }).width).toBe(128);
      const swampPixels = (material.map?.image as { data: Uint8Array }).data;
      const alphaAt = (x: number, y: number): number => swampPixels[(y * 128 + x) * 4 + 3] ?? 0;
      expect(alphaAt(64, 64)).toBeGreaterThan(200);
      expect(alphaAt(0, 0)).toBe(0);
      expect(alphaAt(125, 64)).toBeGreaterThan(0);
      expect(alphaAt(125, 64)).toBeLessThan(alphaAt(64, 64));
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

describe("open ladders, quiet paving, flowers, and trampoline evening light", () => {
  it("uses two timber rails and open cross rungs inside every unchanged ramp volume", () => {
    const scene = new THREE.Scene();
    const builder = new ArenaBuilder();
    builder.buildVisuals(scene);
    try {
      const ladders = scene.getObjectByName("ramp-wooden-ladders") as THREE.InstancedMesh;
      expect(ladders).toBeInstanceOf(THREE.InstancedMesh);
      expect(scene.getObjectByName("ramp-slabs")).toBeUndefined();
      expect(scene.getObjectByName("ramp-surface-marks")).toBeUndefined();
      expect(ladders.geometry).toBeInstanceOf(THREE.BoxGeometry);
      const timber = ladders.material as THREE.MeshStandardMaterial;
      expect(timber.map).toBeInstanceOf(THREE.DataTexture);
      expect(timber.roughness).toBeGreaterThan(0.9);
      const matrix = new THREE.Matrix4();
      const local = new THREE.Matrix4();
      const position = new THREE.Vector3();
      const scale = new THREE.Vector3();
      const rotation = new THREE.Quaternion();
      let matchedBeams = 0;
      for (const ramp of getRamps()) {
        const rampRotation = new THREE.Quaternion().setFromAxisAngle(
          ramp.axis === "x" ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1), ramp.angle,
        );
        const inverse = new THREE.Matrix4().compose(
          new THREE.Vector3(ramp.x, ramp.y, ramp.z), rampRotation, new THREE.Vector3(1, 1, 1),
        ).invert();
        const beams: Array<{ along: number; across: number; length: number; width: number; y: number; height: number }> = [];
        for (let i = 0; i < ladders.count; i += 1) {
          ladders.getMatrixAt(i, matrix);
          local.multiplyMatrices(inverse, matrix).decompose(position, rotation, scale);
          const along = ramp.axis === "x" ? position.z : position.x;
          const across = ramp.axis === "x" ? position.x : position.z;
          if (Math.abs(position.y) > ramp.halfThick || Math.abs(along) > ramp.halfLength + 0.001
            || Math.abs(across) > ramp.halfWidth) continue;
          expect(Math.abs(rotation.w)).toBeCloseTo(1, 5);
          beams.push({
            along, across, length: ramp.axis === "x" ? scale.z : scale.x,
            width: ramp.axis === "x" ? scale.x : scale.z, y: position.y, height: scale.y,
          });
        }
        const rails = beams.filter((beam) => beam.length > ramp.halfLength);
        const rungs = beams.filter((beam) => beam.length < 0.3).sort((a, b) => a.along - b.along);
        expect(rails).toHaveLength(2);
        expect(rungs.length).toBeGreaterThan(12);
        expect(rungs.length).toBeLessThan(28);
        for (const rail of rails) {
          expect(rail.length).toBeCloseTo(ramp.halfLength * 2, 5);
          expect(Math.abs(rail.across) + rail.width / 2).toBeCloseTo(ramp.halfWidth, 5);
          expect(rail.height).toBeCloseTo(ramp.halfThick * 2, 5);
        }
        for (const [index, rung] of rungs.entries()) {
          expect(rung.width).toBeCloseTo(ramp.halfWidth * 2 - rails[0]!.width * 2, 5);
          expect(Math.abs(rung.across)).toBeLessThan(0.00001);
          expect(Math.abs(rung.along) + rung.length / 2).toBeLessThanOrEqual(ramp.halfLength + 0.00001);
          expect(rung.y + rung.height / 2).toBeCloseTo(ramp.halfThick, 5);
          const next = rungs[index + 1];
          if (next !== undefined) {
            const opening = next.along - rung.along - (next.length + rung.length) / 2;
            expect(opening).toBeGreaterThan(0.35);
            expect(opening).toBeLessThan(0.65);
          }
        }
        // More than 65% of the interior length is visibly open between rungs.
        expect(rungs.reduce((sum, rung) => sum + rung.length, 0) / (ramp.halfLength * 2)).toBeLessThan(0.35);
        matchedBeams += beams.length;
      }
      expect(matchedBeams).toBe(ladders.count);
    } finally {
      builder.dispose(scene);
    }
  });

  it("has a unique soft paving map with restrained local contrast and no repeating tile stamps", () => {
    const scene = new THREE.Scene();
    const builder = new ArenaBuilder();
    builder.buildVisuals(scene);
    try {
      const floor = scene.getObjectByName("arena-floor") as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
      const texture = floor.material.map!;
      const pixels = texture.image.data as Uint8Array;
      expect(texture.repeat.toArray()).toEqual([1, 1]);
      expect(texture.wrapS).toBe(THREE.ClampToEdgeWrapping);
      expect(texture.magFilter).toBe(THREE.LinearFilter);
      expect(texture.image.width).toBe(256);
      const minima = [255, 255, 255];
      const maxima = [0, 0, 0];
      let maxLocalContrast = 0;
      let repeatedPixels = 0;
      for (let y = 0; y < 256; y += 1) {
        for (let x = 0; x < 256; x += 1) {
          const pixel = (y * 256 + x) * 4;
          let repeats = true;
          for (let channel = 0; channel < 3; channel += 1) {
            const value = pixels[pixel + channel]!;
            minima[channel] = Math.min(minima[channel]!, value);
            maxima[channel] = Math.max(maxima[channel]!, value);
            if (x < 255) maxLocalContrast = Math.max(maxLocalContrast, Math.abs(value - pixels[pixel + 4 + channel]!));
            if (y < 255) maxLocalContrast = Math.max(maxLocalContrast, Math.abs(value - pixels[pixel + 256 * 4 + channel]!));
            if (x < 128 && value !== pixels[pixel + 128 * 4 + channel]) repeats = false;
          }
          if (x < 128 && repeats) repeatedPixels += 1;
        }
      }
      for (let channel = 0; channel < 3; channel += 1) {
        expect(maxima[channel]! - minima[channel]!).toBeLessThan(25);
        expect(maxima[channel]! - minima[channel]!).toBeGreaterThan(8);
      }
      expect(maxLocalContrast).toBeLessThan(12);
      expect(repeatedPixels / (128 * 256)).toBeLessThan(0.2);
    } finally {
      builder.dispose(scene);
    }
  });

  it("places low flower beds only on saved covers 4–7 and leaves most of each roof clear", () => {
    const scene = new THREE.Scene();
    const builder = new ArenaBuilder();
    builder.buildVisuals(scene);
    try {
      const beds = scene.getObjectByName("side-flower-beds") as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
      const blossoms = scene.getObjectByName("side-flower-blossoms") as THREE.InstancedMesh;
      expect(beds).toBeInstanceOf(THREE.Mesh);
      expect(beds).not.toBeInstanceOf(THREE.InstancedMesh);
      expect(scene.getObjectByName("side-flower-greenery")).toBeUndefined();
      expect(beds.material.vertexColors).toBe(true);
      expect(beds.material.color.getHex()).toBe(0xffffff);
      expect(beds.material.roughness).toBe(1);
      expect(blossoms.count).toBe(20);
      const bedPositions = beds.geometry.getAttribute("position");
      const bedColors = beds.geometry.getAttribute("color");
      const bedNormals = beds.geometry.getAttribute("normal");
      expect(bedPositions.count / 3).toBe(752);
      const soilColor = new THREE.Color(0x75644d);
      const greeneryColor = new THREE.Color(0x71844b);
      const matrix = new THREE.Matrix4();
      const position = new THREE.Vector3();
      const scale = new THREE.Vector3();
      const rotation = new THREE.Quaternion();
      for (const [index, cover] of getObstacleLayout().slice(4, 8).entries()) {
        const soilBounds = new THREE.Box3();
        const greeneryBounds = new THREE.Box3();
        let soilVertices = 0;
        let greeneryVertices = 0;
        for (let vertex = 0; vertex < bedPositions.count; vertex += 1) {
          position.fromBufferAttribute(bedPositions, vertex);
          if (Math.abs(position.x - cover.x) > cover.hx || Math.abs(position.z - cover.z) > cover.hz) continue;
          const color = new THREE.Color().fromBufferAttribute(bedColors, vertex);
          if (Math.abs(color.r - soilColor.r) < 0.00001) {
            expect(color.g).toBeCloseTo(soilColor.g, 6);
            expect(color.b).toBeCloseTo(soilColor.b, 6);
            soilBounds.expandByPoint(position);
            soilVertices += 1;
          } else {
            expect(color.r).toBeCloseTo(greeneryColor.r, 6);
            expect(color.g).toBeCloseTo(greeneryColor.g, 6);
            expect(color.b).toBeCloseTo(greeneryColor.b, 6);
            greeneryBounds.expandByPoint(position);
            greeneryVertices += 1;
          }
          expect(new THREE.Vector3().fromBufferAttribute(bedNormals, vertex).length()).toBeCloseTo(1, 5);
        }
        expect(soilVertices).toBe(324);
        expect(greeneryVertices).toBe(240);
        const bedSize = soilBounds.getSize(new THREE.Vector3());
        const bedCenter = soilBounds.getCenter(new THREE.Vector3());
        expect(bedCenter.x).toBeCloseTo(cover.x, 5);
        expect(soilBounds.min.y).toBeCloseTo(cover.hy * 2, 5);
        expect(soilBounds.max.y).toBeCloseTo(cover.hy * 2 + 0.05, 5);
        expect(Math.abs(bedCenter.z - cover.z) + bedSize.z / 2).toBeLessThan(cover.hz);
        expect(bedSize.x * bedSize.z / (cover.hx * cover.hz * 4)).toBeLessThan(0.15);
        expect(Math.abs(bedCenter.z - cover.z)).toBeGreaterThan(cover.hz * 0.5);
        expect(greeneryBounds.min.y).toBeCloseTo(cover.hy * 2 + 0.05, 5);
        expect(greeneryBounds.max.y).toBeLessThan(cover.hy * 2 + 0.3);
        for (let flower = index * 5; flower < index * 5 + 5; flower += 1) {
          blossoms.getMatrixAt(flower, matrix);
          matrix.decompose(position, rotation, scale);
          expect(Math.abs(position.x - cover.x) + 0.1 * scale.x).toBeLessThan(cover.hx);
          expect(Math.abs(position.z - cover.z) + 0.1 * scale.z).toBeLessThan(cover.hz);
          expect(position.y).toBeGreaterThan(cover.hy * 2);
          expect(position.y + 0.025 * scale.y).toBeLessThan(cover.hy * 2 + 0.3);
        }
      }
      const { boxes, rotated, physics } = createRecordingPhysics();
      builder.buildColliders(physics);
      expect(boxes).toHaveLength(16);
      expect(rotated).toHaveLength(4);
    } finally {
      builder.dispose(scene);
    }
  });

  it("fades rims and local spill together, clamps phases, and supports a late visual build", () => {
    const scene = new THREE.Scene();
    const builder = new ArenaBuilder();
    builder.setEveningLighting(0.4);
    builder.buildVisuals(scene);
    try {
      const effects = [
        { mesh: scene.getObjectByName("trampoline-night-rims") as THREE.InstancedMesh, opacity: 0.92, count: 2 },
        { mesh: scene.getObjectByName("trampoline-ground-spill") as THREE.InstancedMesh, opacity: 0.14, count: 2 },
        { mesh: scene.getObjectByName("trampoline-block-spill") as THREE.InstancedMesh, opacity: 0.16, count: 4 },
      ];
      for (const effect of effects) {
        expect(effect.mesh.count).toBe(effect.count);
        expect(effect.mesh.visible).toBe(true);
        const material = effect.mesh.material as THREE.MeshBasicMaterial;
        expect(material.opacity).toBeCloseTo(effect.opacity * 0.4, 8);
        expect(material.depthWrite).toBe(false);
        expect(material.toneMapped).toBe(false);
        expect(effect.mesh.castShadow).toBe(false);
      }
      const groundMaterial = effects[1]!.mesh.material as THREE.MeshBasicMaterial;
      const faceMaterial = effects[2]!.mesh.material as THREE.MeshBasicMaterial;
      expect(groundMaterial.map).toBe(faceMaterial.map);
      const glowPixels = groundMaterial.map!.image.data as Uint8Array;
      expect(glowPixels[3]).toBe(0);
      expect(glowPixels[(32 * 64 + 32) * 4 + 3]).toBeGreaterThan(250);
      for (const [input, expected] of [[-1, 0], [0.25, 0.25], [2, 1], [NaN, 0], [Infinity, 0], [-Infinity, 0]]) {
        builder.setEveningLighting(input!);
        for (const effect of effects) {
          expect((effect.mesh.material as THREE.MeshBasicMaterial).opacity).toBeCloseTo(effect.opacity * expected!, 8);
          expect(effect.mesh.visible).toBe(expected! > 0);
        }
      }
      const lights: THREE.Light[] = [];
      scene.traverse((object) => { if (object instanceof THREE.Light) lights.push(object); });
      expect(lights).toHaveLength(0);
    } finally {
      builder.dispose(scene);
    }
  });

  it("keeps the nighttime spill on the ground and on the four inward center faces", () => {
    const scene = new THREE.Scene();
    const builder = new ArenaBuilder();
    builder.buildVisuals(scene);
    try {
      const rims = scene.getObjectByName("trampoline-night-rims") as THREE.InstancedMesh;
      const ground = scene.getObjectByName("trampoline-ground-spill") as THREE.InstancedMesh;
      const faces = scene.getObjectByName("trampoline-block-spill") as THREE.InstancedMesh;
      expect(rims.geometry).toBeInstanceOf(THREE.RingGeometry);
      const matrix = new THREE.Matrix4();
      const position = new THREE.Vector3();
      const normal = new THREE.Vector3();
      for (const [index, pad] of getTrampolines().entries()) {
        for (const mesh of [rims, ground]) {
          mesh.getMatrixAt(index, matrix);
          position.setFromMatrixPosition(matrix);
          normal.set(0, 0, 1).transformDirection(matrix);
          expect(position.x).toBeCloseTo(pad.x, 5);
          expect(position.z).toBeCloseTo(pad.z, 5);
          expect(normal.y).toBeCloseTo(1, 5);
        }
        expect(position.y).toBeGreaterThan(0);
        expect(position.y).toBeLessThan(0.04);
      }
      for (const [index, block] of getObstacleLayout().slice(0, 4).entries()) {
        faces.getMatrixAt(index, matrix);
        position.setFromMatrixPosition(matrix);
        normal.set(0, 0, 1).transformDirection(matrix);
        expect(position.x).toBeCloseTo(block.x - Math.sign(block.x) * (block.hx + 0.006), 5);
        expect(position.z).toBeCloseTo(block.z, 5);
        expect(position.y).toBeCloseTo(block.hy, 5);
        const closest = [...getTrampolines()].sort((a, b) =>
          Math.hypot(a.x - position.x, a.z - position.z) - Math.hypot(b.x - position.x, b.z - position.z))[0]!;
        const towardsPad = new THREE.Vector3(closest.x - position.x, 0, closest.z - position.z).normalize();
        expect(normal.dot(towardsPad)).toBeGreaterThan(0.99);
        const vertices = faces.geometry.getAttribute("position");
        for (let vertex = 0; vertex < vertices.count; vertex += 1) {
          const point = new THREE.Vector3().fromBufferAttribute(vertices, vertex).applyMatrix4(matrix);
          expect(point.y).toBeGreaterThan(0);
          expect(point.y).toBeLessThan(block.hy * 2);
          expect(Math.abs(point.z - block.z)).toBeLessThan(block.hz);
        }
      }
    } finally {
      builder.dispose(scene);
    }
  });

  it("bounds the decoration geometry and releases every new resource and evening handle", () => {
    const scene = new THREE.Scene();
    const builder = new ArenaBuilder();
    builder.setEveningLighting(1);
    builder.buildVisuals(scene);
    const names = ["ramp-wooden-ladders", "side-flower-beds", "side-flower-blossoms",
      "trampoline-night-rims", "trampoline-ground-spill", "trampoline-block-spill"];
    const meshes = names.map((name) => scene.getObjectByName(name) as THREE.Mesh);
    const resources = new Set<{ dispose(): void }>();
    let triangles = 0;
    for (const mesh of meshes) {
      if (mesh instanceof THREE.InstancedMesh) resources.add(mesh);
      resources.add(mesh.geometry);
      const material = mesh.material as THREE.MeshBasicMaterial | THREE.MeshStandardMaterial;
      resources.add(material);
      if (material.map !== null) resources.add(material.map);
      triangles += (mesh.geometry.getIndex()?.count ?? mesh.geometry.getAttribute("position").count) / 3
        * (mesh instanceof THREE.InstancedMesh ? mesh.count : 1);
    }
    // Six batches replace two old ramp batches: +1 daytime / +4 nighttime
    // draw calls, with a small triangle budget and just two 64px maps.
    expect(meshes).toHaveLength(6);
    expect(triangles).toBeLessThan(2800);
    const spies = [...resources].map((resource) => vi.spyOn(resource, "dispose"));
    const oldRimMaterial = meshes[3]!.material as THREE.MeshBasicMaterial;
    builder.dispose(scene);
    expect(scene.children).toHaveLength(0);
    for (const spy of spies) expect(spy).toHaveBeenCalledOnce();
    builder.setEveningLighting(0.5);
    expect(oldRimMaterial.opacity).toBe(0.92);
    builder.buildVisuals(scene);
    const rebuilt = scene.getObjectByName("trampoline-night-rims") as THREE.InstancedMesh;
    expect(rebuilt).not.toBe(meshes[3]);
    expect((rebuilt.material as THREE.MeshBasicMaterial).opacity).toBeCloseTo(0.46, 8);
    builder.dispose(scene);
    builder.buildVisuals(scene);
    for (const name of names.slice(3)) {
      const mesh = scene.getObjectByName(name) as THREE.InstancedMesh;
      expect(mesh.visible).toBe(false);
      expect((mesh.material as THREE.MeshBasicMaterial).opacity).toBe(0);
    }
    builder.dispose(scene);
    builder.dispose(scene);
    expect(scene.children).toHaveLength(0);
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
    for (const [index, box] of rotated.entries()) {
      const ramp = ramps[index]!;
      expect(box.x).toBe(ramp.x);
      expect(box.y).toBe(ramp.y);
      expect(box.z).toBe(ramp.z);
      expect(box.hy).toBe(ramp.halfThick);
      expect(box.hx).toBe(ramp.axis === "x" ? ramp.halfWidth : ramp.halfLength);
      expect(box.hz).toBe(ramp.axis === "x" ? ramp.halfLength : ramp.halfWidth);
      const expectedRotation = new THREE.Quaternion().setFromAxisAngle(
        ramp.axis === "x" ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1), ramp.angle,
      );
      expect(new THREE.Quaternion(box.rotation.x, box.rotation.y, box.rotation.z, box.rotation.w)
        .dot(expectedRotation)).toBeCloseTo(1, 10);
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
