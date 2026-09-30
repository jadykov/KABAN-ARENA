import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import {
  ARENA_HALF_SIZE,
  ICE_FRICTION,
  ICE_RADIUS,
  MOVE_SPEED,
  OBSTACLE_COUNT,
  PHYSICS_GRAVITY_Y,
  PLATFORM_FIGURES,
  PLAYER_FRICTION,
  PLAYER_LINEAR_DAMPING,
  RAMP_SLOPE_DEG,
  SPAWN_COUNT,
  SWAMP_RADIUS,
  TRAMPOLINE_IMPULSE,
  TRAMPOLINE_PAD_DIM,
  WALL_FADE_OPACITY,
  WALL_GLASS_OPACITY,
  WALL_HEIGHT,
  WALL_VISUAL_HEIGHT,
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
import { HL_CHARTREUSE } from "../palette";

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
    const platforms = scene.getObjectByName("platform-volumes") as THREE.InstancedMesh;
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
      const normals = platforms.geometry.getAttribute("normal");
      expect(normals.count).toBeGreaterThan(24);
      expect(Array.from({ length: normals.count }, (_, i) => i).some((i) =>
        Math.abs(normals.getX(i)) > 0.1 && Math.abs(normals.getY(i)) > 0.1)).toBe(true);
      expect(scene.getObjectByName("arena-obstacles")).toBeUndefined();
      expect(scene.getObjectByName("obstacle-top-edges")).toBeUndefined();
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

  it("keeps ice pale and softly translucent at its edge without glowing or hard color sectors", () => {
    const scene = new THREE.Scene();
    const builder = new ArenaBuilder();
    builder.buildVisuals(scene);
    try {
      const ice = scene.getObjectByName("ice-zones") as THREE.InstancedMesh;
      const material = ice.material as THREE.MeshStandardMaterial;
      expect(material.emissive.getHex()).toBe(0);
      expect(material.roughness).toBeGreaterThanOrEqual(0.3);
      expect(material.roughness).toBeLessThanOrEqual(0.38);
      expect(material.depthWrite).toBe(false);
      const texture = material.map as THREE.DataTexture;
      const { width, height, data } = texture.image;
      const pixels = data as Uint8Array;
      const interiorColors = new Set<string>();
      let largestStep = 0;
      for (let y = 1; y < height - 1; y += 1) {
        for (let x = 1; x < width - 1; x += 1) {
          if (Math.hypot((x + 0.5) / width * 2 - 1, (y + 0.5) / height * 2 - 1) > 0.8) continue;
          const pixel = (y * width + x) * 4;
          const [r, g, b, alpha] = pixels.subarray(pixel, pixel + 4);
          expect(alpha).toBe(255);
          expect(r).toBeGreaterThan(110);
          expect(g).toBeGreaterThan(r!);
          expect(b).toBeGreaterThanOrEqual(g!);
          expect(b! - r!).toBeGreaterThan(40);
          expect(b! - r!).toBeLessThan(90);
          interiorColors.add(`${r},${g},${b}`);
          for (const neighbor of [pixel - 4, pixel - width * 4]) {
            for (let channel = 0; channel < 3; channel++) {
              largestStep = Math.max(largestStep, Math.abs(pixels[pixel + channel]! - pixels[neighbor + channel]!));
            }
          }
        }
      }
      expect(interiorColors.size).toBeGreaterThan(100);
      expect(largestStep).toBeLessThan(35);
      const alphaAt = (radius: number, angle: number): number => {
        const x = Math.min(width - 1, Math.floor((Math.cos(angle) * radius + 1) * width / 2));
        const y = Math.min(height - 1, Math.floor((Math.sin(angle) * radius + 1) * height / 2));
        return pixels[(y * width + x) * 4 + 3]!;
      };
      for (let sample = 0; sample < 24; sample++) {
        const angle = sample * Math.PI / 12;
        expect(alphaAt(0.85, angle)).toBe(255);
        expect(alphaAt(0.995, angle)).toBeLessThan(40);
      }
      const meanAlpha = (radius: number): number => Array.from({ length: 24 }, (_, sample) =>
        alphaAt(radius, sample * Math.PI / 12)).reduce((sum, alpha) => sum + alpha, 0) / 24;
      expect(meanAlpha(0.94)).toBeGreaterThan(180);
      expect(meanAlpha(0.965)).toBeGreaterThan(20);
      expect(meanAlpha(0.965)).toBeLessThan(180);
      expect(ice.count).toBe(getIceZones().length);
      expect(scene.children.some((child) => child instanceof THREE.Light)).toBe(false);
    } finally {
      builder.dispose(scene);
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

  it("paces swamp uploads while retaining the same motion, including reduced quality before build", () => {
    const fullScene = new THREE.Scene();
    const reducedScene = new THREE.Scene();
    const full = new ArenaBuilder();
    const reduced = new ArenaBuilder();
    reduced.setAmbientHz(15);
    full.buildVisuals(fullScene);
    reduced.buildVisuals(reducedScene);
    const fullBubbles = fullScene.getObjectByName("swamp-bubbles") as THREE.InstancedMesh;
    const reducedBubbles = reducedScene.getObjectByName("swamp-bubbles") as THREE.InstancedMesh;
    try {
      const first = Array.from(reducedBubbles.instanceMatrix.array);
      expect(first).toEqual(Array.from(fullBubbles.instanceMatrix.array));
      expect(reducedBubbles.instanceMatrix.usage).toBe(THREE.DynamicDrawUsage);
      const initialVersion = reducedBubbles.instanceMatrix.version;
      for (let frame = 0; frame < 60; frame += 1) {
        full.update(1 / 60);
        reduced.update(1 / 60);
      }
      expect(reducedBubbles.instanceMatrix.version - initialVersion).toBe(15);
      expect(Array.from(reducedBubbles.instanceMatrix.array))
        .toEqual(Array.from(fullBubbles.instanceMatrix.array));
      reducedBubbles.visible = false;
      const hiddenVersion = reducedBubbles.instanceMatrix.version;
      reduced.update(1);
      expect(reducedBubbles.instanceMatrix.version).toBe(hiddenVersion);
      reducedBubbles.visible = true;
      reduced.setAmbientHz(60);
      reduced.update(1 / 60);
      expect(reducedBubbles.instanceMatrix.version).toBe(hiddenVersion + 1);
      reduced.dispose(reducedScene);
      reduced.buildVisuals(reducedScene);
      const rebuilt = reducedScene.getObjectByName("swamp-bubbles") as THREE.InstancedMesh;
      expect(Array.from(rebuilt.instanceMatrix.array)).toEqual(first);
    } finally {
      full.dispose(fullScene);
      reduced.dispose(reducedScene);
    }
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

  it("turns all four low covers into full planters with flush soil and planting across the footprint", () => {
    const scene = new THREE.Scene();
    const builder = new ArenaBuilder();
    builder.buildVisuals(scene);
    try {
      const beds = scene.getObjectByName("side-flower-beds") as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
      const blossoms = scene.getObjectByName("side-flower-blossoms") as THREE.InstancedMesh;
      expect(beds).toBeInstanceOf(THREE.Mesh);
      expect(beds.material.vertexColors).toBe(true);
      expect(beds.material.roughness).toBe(1);
      expect(blossoms.count).toBe(80);
      const blossomVertices = blossoms.geometry.getAttribute("position");
      const positions = beds.geometry.getAttribute("position");
      const colors = beds.geometry.getAttribute("color");
      const soilColor = new THREE.Color(0x695b45);
      const stemColor = new THREE.Color(0x71844b);
      const point = new THREE.Vector3();
      const matrix = new THREE.Matrix4();
      const raycaster = new THREE.Raycaster();
      scene.updateMatrixWorld(true);
      for (const [index, cover] of getObstacleLayout().slice(4, 8).entries()) {
        const soilBounds = new THREE.Box3();
        const borderBounds = new THREE.Box3();
        for (let vertex = 0; vertex < positions.count; vertex += 1) {
          point.fromBufferAttribute(positions, vertex);
          if (Math.abs(point.x - cover.x) > cover.hx + 0.00001
            || Math.abs(point.z - cover.z) > cover.hz + 0.00001) continue;
          const color = new THREE.Color().fromBufferAttribute(colors, vertex);
          if ((color.r - soilColor.r) ** 2 + (color.g - soilColor.g) ** 2 + (color.b - soilColor.b) ** 2 < 1e-10) soilBounds.expandByPoint(point);
          else if ((color.r - stemColor.r) ** 2 + (color.g - stemColor.g) ** 2 + (color.b - stemColor.b) ** 2 >= 1e-10) borderBounds.expandByPoint(point);
          expect(point.y).toBeGreaterThanOrEqual(-0.00001);
          expect(point.y).toBeLessThan(cover.hy * 2 + 0.3);
        }
        const soilSize = soilBounds.getSize(new THREE.Vector3());
        expect(soilSize.x * soilSize.z / (cover.hx * cover.hz * 4)).toBeGreaterThan(0.8);
        expect(soilBounds.min.y).toBeCloseTo(0, 5);
        expect(soilBounds.max.y).toBeCloseTo(cover.hy * 2, 5);
        expect(borderBounds.min.toArray()).toEqual([cover.x - cover.hx, 0, cover.z - cover.hz]);
        expect(borderBounds.max.toArray()).toEqual([cover.x + cover.hx, cover.hy * 2, cover.z + cover.hz]);
        const flowerBounds = new THREE.Box3();
        for (let flower = index * 20; flower < index * 20 + 20; flower += 1) {
          blossoms.getMatrixAt(flower, matrix);
          point.setFromMatrixPosition(matrix);
          flowerBounds.expandByPoint(point);
          expect(Math.abs(point.x - cover.x)).toBeLessThan(cover.hx - 0.12);
          expect(Math.abs(point.z - cover.z)).toBeLessThan(cover.hz - 0.12);
          expect(point.y).toBeGreaterThan(cover.hy * 2);
          expect(point.y).toBeLessThan(cover.hy * 2 + 0.3);
          const budBounds = new THREE.Box3().setFromPoints(Array.from({ length: blossomVertices.count }, (_, vertex) =>
            new THREE.Vector3().fromBufferAttribute(blossomVertices, vertex).applyMatrix4(matrix)));
          expect(budBounds.min.x).toBeGreaterThan(cover.x - cover.hx);
          expect(budBounds.max.x).toBeLessThan(cover.x + cover.hx);
          expect(budBounds.min.z).toBeGreaterThan(cover.z - cover.hz);
          expect(budBounds.max.z).toBeLessThan(cover.z + cover.hz);
          expect(budBounds.max.y).toBeLessThan(cover.hy * 2 + 0.3);
          const budSize = budBounds.getSize(new THREE.Vector3());
          expect(Math.max(budSize.x, budSize.z)).toBeGreaterThan(0.18);
          expect(Math.max(budSize.x, budSize.z)).toBeLessThan(0.3);
        }
        const flowerSize = flowerBounds.getSize(new THREE.Vector3());
        expect(flowerSize.x).toBeGreaterThan(cover.hx * 1.3);
        expect(flowerSize.z).toBeGreaterThan(cover.hz * 1.3);
        // The soil is a broad continuous surface at the collider's old top.
        for (const x of [-0.55, 0, 0.55]) {
          for (const z of [-0.55, 0, 0.55]) {
            raycaster.set(new THREE.Vector3(cover.x + x, cover.hy * 2 + 0.001, cover.z + z), new THREE.Vector3(0, -1, 0));
            const hit = raycaster.intersectObject(beds)[0];
            expect(hit).toBeDefined();
            expect(hit!.point.y).toBeCloseTo(cover.hy * 2, 5);
          }
        }
      }
      for (let vertex = 0; vertex < positions.count; vertex++) {
        const color = new THREE.Color().fromBufferAttribute(colors, vertex);
        if ((color.r - stemColor.r) ** 2 + (color.g - stemColor.g) ** 2 + (color.b - stemColor.b) ** 2 > 1e-10) continue;
        point.fromBufferAttribute(positions, vertex);
        const bed = getObstacleLayout().slice(4, 8)
          .find((cover) => Math.abs(point.x - cover.x) <= cover.hx && Math.abs(point.z - cover.z) <= cover.hz);
        expect(bed).toBeDefined();
        expect(point.y).toBeLessThan(bed!.hy * 2 + 0.3);
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
        { mesh: scene.getObjectByName("trampoline-ground-spill") as THREE.InstancedMesh, opacity: 0.14 * 1.3, count: 2 },
        { mesh: scene.getObjectByName("trampoline-block-spill") as THREE.InstancedMesh, opacity: 0.16 * 1.3, count: 4 },
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
    // Whole planters use the same two batches as their previous strips;
    // more low planting still fits a modest triangle budget.
    expect(meshes).toHaveLength(6);
    expect(triangles).toBeLessThan(5000);
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

describe("shop storage and sports enclosure", () => {
  it("builds four distinct palletized covers within their old volumes with continuous landing tops", () => {
    const scene = new THREE.Scene();
    const builder = new ArenaBuilder();
    builder.buildVisuals(scene);
    try {
      const timber = scene.getObjectByName("storage-timber") as THREE.Mesh;
      const cartons = scene.getObjectByName("storage-packaging") as THREE.Mesh;
      expect(timber).toBeInstanceOf(THREE.Mesh);
      expect(cartons).toBeInstanceOf(THREE.Mesh);
      expect(timber).not.toBeInstanceOf(THREE.InstancedMesh);
      expect((timber.material as THREE.MeshStandardMaterial).map).toBeInstanceOf(THREE.DataTexture);
      const counts: string[] = [];
      const point = new THREE.Vector3();
      const raycaster = new THREE.Raycaster();
      scene.updateMatrixWorld(true);
      for (const cover of getObstacleLayout().slice(0, 4)) {
        const bounds = new THREE.Box3();
        const coverCounts: number[] = [];
        for (const mesh of [timber, cartons]) {
          const positions = mesh.geometry.getAttribute("position");
          let vertices = 0;
          for (let vertex = 0; vertex < positions.count; vertex += 1) {
            point.fromBufferAttribute(positions, vertex);
            if (Math.abs(point.x - cover.x) > cover.hx + 0.00001
              || Math.abs(point.z - cover.z) > cover.hz + 0.00001) continue;
            vertices += 1;
            bounds.expandByPoint(point);
            expect(point.y).toBeGreaterThanOrEqual(-0.00001);
            expect(point.y).toBeLessThanOrEqual(cover.hy * 2 + 0.00001);
          }
          coverCounts.push(vertices);
        }
        counts.push(coverCounts.join(","));
        expect(bounds.min.x).toBeCloseTo(cover.x - cover.hx, 5);
        expect(bounds.max.x).toBeCloseTo(cover.x + cover.hx, 5);
        expect(Math.abs(bounds.min.z - (cover.z - cover.hz))).toBeLessThan(0.02);
        expect(Math.abs(bounds.max.z - (cover.z + cover.hz))).toBeLessThan(0.02);
        expect(bounds.max.y).toBeCloseTo(cover.hy * 2, 5);
        for (const x of [-0.7, -0.23, 0.23, 0.7]) {
          for (const z of [-0.7, -0.23, 0.23, 0.7]) {
            raycaster.set(new THREE.Vector3(cover.x + x, cover.hy * 2 + 0.5, cover.z + z), new THREE.Vector3(0, -1, 0));
            const hit = raycaster.intersectObjects([timber, cartons])[0];
            expect(hit).toBeDefined();
            expect(hit!.point.y).toBeCloseTo(cover.hy * 2, 5);
          }
        }
      }
      expect(new Set(counts).size).toBe(4);
      const material = cartons.material as THREE.MeshStandardMaterial;
      expect(material.vertexColors).toBe(true);
      expect(material.roughness).toBe(1);
      expect(material.transparent).toBe(false);
    } finally {
      builder.dispose(scene);
    }
  });

  it("keeps crate bands and carton tape, labels and print visibly in front of their backing", () => {
    const scene = new THREE.Scene();
    const builder = new ArenaBuilder();
    builder.buildVisuals(scene);
    try {
      const timber = scene.getObjectByName("storage-timber") as THREE.Mesh;
      const packaging = scene.getObjectByName("storage-packaging") as THREE.Mesh;
      const covers = getObstacleLayout();
      scene.updateMatrixWorld(true);
      const raycaster = new THREE.Raycaster();
      const assertVisibleTint = (mesh: THREE.Mesh, origin: THREE.Vector3, direction: THREE.Vector3,
        tint: number, backingLimit: number, axis: "x" | "y" | "z", sign: number): void => {
        raycaster.set(origin, direction);
        const hit = raycaster.intersectObject(mesh)[0];
        expect(hit).toBeDefined();
        const color = new THREE.Color().fromBufferAttribute(mesh.geometry.getAttribute("color"), hit!.face!.a);
        const expected = new THREE.Color(tint);
        expect(color.r).toBeCloseTo(expected.r, 6);
        expect(color.g).toBeCloseTo(expected.g, 6);
        expect(color.b).toBeCloseTo(expected.b, 6);
        expect(sign * hit!.point[axis]).toBeGreaterThan(sign * backingLimit + 0.0005);
      };
      const wooden = covers[0]!;
      for (const sign of [-1, 1]) {
        // Horizontal plank seams and vertical corner straps on both Z faces.
        const zBacking = wooden.z + sign * (1 - 0.022);
        assertVisibleTint(timber, new THREE.Vector3(wooden.x - 0.505, 0.22 + 0.89 / 4, wooden.z + sign * 2),
          new THREE.Vector3(0, 0, -sign), 0x74603f, zBacking, "z", sign);
        assertVisibleTint(timber, new THREE.Vector3(wooden.x - 0.505 + 0.4575, 0.665, wooden.z + sign * 2),
          new THREE.Vector3(0, 0, -sign), 0xa48760, zBacking, "z", sign);
        // The matching side plank seams on both X faces.
        assertVisibleTint(timber, new THREE.Vector3(wooden.x + sign * 2, 0.22 + 0.89 / 4, wooden.z),
          new THREE.Vector3(-sign, 0, 0), 0x74603f, wooden.x + sign * (1 - 0.022), "x", sign);
        // The center of the diagonal brace must hit its timber, not backing.
        assertVisibleTint(timber, new THREE.Vector3(wooden.x - 0.505, 0.665, wooden.z + sign * 2),
          new THREE.Vector3(0, 0, -sign), 0xa48760, zBacking, "z", sign);
      }
      // The lid joint is a real visible strip between flush planks.
      assertVisibleTint(timber, new THREE.Vector3(wooden.x - 0.505, 3, wooden.z - 1.922 / 2 + 1.922 / 5),
        new THREE.Vector3(0, -1, 0), 0x74603f, 1.995, "y", 1);
      const mixed = covers[1]!;
      for (const sign of [-1, 1]) {
        const zBacking = mixed.z + sign * (1 - 0.009);
        // Front/back packaging tape, paper labels, and the printed label line.
        assertVisibleTint(packaging, new THREE.Vector3(mixed.x - 0.505, 1.44, mixed.z + sign * 2),
          new THREE.Vector3(0, 0, -sign), 0xd2b78b, zBacking, "z", sign);
        assertVisibleTint(packaging, new THREE.Vector3(mixed.x - 0.505 - 0.99 * 0.23,
          0.88 + 1.12 * 0.70, mixed.z + sign * 2), new THREE.Vector3(0, 0, -sign),
          0xd8d5bf, zBacking, "z", sign);
        assertVisibleTint(packaging, new THREE.Vector3(mixed.x - 0.505 - 0.99 * 0.23,
          0.88 + 1.12 * 0.62, mixed.z + sign * 2), new THREE.Vector3(0, 0, -sign),
          0x605546, mixed.z + sign * (1 - 0.002), "z", sign);
      }
      // A visible layer joint crosses the carton body instead of leaving two
      // identical-colored boxes touching as one uninterrupted brown face.
      const stacked = covers[3]!;
      raycaster.set(new THREE.Vector3(stacked.x - 0.505 + 0.25, 1.116, stacked.z + 2), new THREE.Vector3(0, 0, -1));
      raycaster.far = 4;
      expect(raycaster.intersectObject(packaging)).toHaveLength(0);
    } finally {
      builder.dispose(scene);
    }
  });

  it("uses open diamond wires on a tall post frame and keeps the low boards opaque during camera fades", () => {
    const scene = new THREE.Scene();
    const builder = new ArenaBuilder();
    builder.setWallOpacity(WALL_FADE_OPACITY);
    builder.buildVisuals(scene);
    try {
      const net = scene.getObjectByName("sports-fence-diamond-net") as THREE.LineSegments;
      const frame = scene.getObjectByName("sports-fence-frame") as THREE.Mesh;
      const boards = scene.getObjectByName("sports-fence-boards") as THREE.Mesh;
      expect(net).toBeInstanceOf(THREE.LineSegments);
      const positions = net.geometry.getAttribute("position");
      expect(positions.count).toBeLessThan(1300);
      const sides = new Set<string>();
      const bottomCrossings: number[] = [];
      for (let vertex = 0; vertex < positions.count; vertex += 2) {
        const a = new THREE.Vector3().fromBufferAttribute(positions, vertex);
        const b = new THREE.Vector3().fromBufferAttribute(positions, vertex + 1);
        const delta = b.clone().sub(a);
        expect(Math.abs(delta.y)).toBeCloseTo(Math.hypot(delta.x, delta.z), 4);
        expect(a.y).toBeGreaterThan(0.6);
        expect(a.y).toBeLessThan(WALL_VISUAL_HEIGHT);
        sides.add(Math.abs(delta.x) > 0.001 ? `z:${a.z}` : `x:${a.x}`);
        if (Math.abs(delta.x) > 0.001 && a.z < -ARENA_HALF_SIZE && delta.x * delta.y > 0
          && Math.abs(a.y - 0.66) < 0.00001) bottomCrossings.push(a.x);
      }
      expect(sides.size).toBe(4);
      bottomCrossings.sort((a, b) => a - b);
      expect(bottomCrossings.length).toBeGreaterThan(60);
      for (let index = 1; index < bottomCrossings.length; index++) {
        expect(bottomCrossings[index]! - bottomCrossings[index - 1]!).toBeCloseTo(0.5, 5);
      }
      boards.geometry.computeBoundingBox();
      frame.geometry.computeBoundingBox();
      expect(boards.geometry.boundingBox!.max.y).toBeCloseTo(0.6, 5);
      expect(frame.geometry.boundingBox!.max.y).toBeCloseTo(WALL_VISUAL_HEIGHT, 5);
      for (const input of [WALL_FADE_OPACITY, WALL_GLASS_OPACITY, -1, 2, NaN]) {
        builder.setWallOpacity(input);
        const expected = builder.getWallOpacity() / WALL_GLASS_OPACITY;
        for (const object of [net, frame]) {
          const material = object.material as THREE.Material;
          expect(material.opacity).toBeCloseTo(expected, 8);
          expect(material.transparent).toBe(expected < 1);
          expect(material.depthWrite).toBe(expected === 1);
        }
        expect((boards.material as THREE.Material).opacity).toBe(1);
        expect((boards.material as THREE.Material).transparent).toBe(false);
        expect((boards.material as THREE.Material).depthWrite).toBe(true);
      }
      const { boxes, physics } = createRecordingPhysics();
      builder.buildColliders(physics);
      expect(boxes.slice(0, 4).every((box) => box.hy * 2 === WALL_HEIGHT)).toBe(true);
      expect(WALL_HEIGHT).toBe(1.5);
      expect(WALL_VISUAL_HEIGHT).toBe(3.5);
      scene.updateMatrixWorld(true);
      const raycaster = new THREE.Raycaster(new THREE.Vector3(0, 0.3, -ARENA_HALF_SIZE - 2), new THREE.Vector3(0, 0, 1));
      expect(raycaster.intersectObject(boards).length).toBeGreaterThan(0);
    } finally {
      builder.dispose(scene);
    }
  });

  it("raises rim radiance and both spill strengths by 30% with a wider ground pool and no lights", () => {
    const scene = new THREE.Scene();
    const builder = new ArenaBuilder();
    builder.buildVisuals(scene);
    try {
      const rims = scene.getObjectByName("trampoline-night-rims") as THREE.InstancedMesh;
      const ground = scene.getObjectByName("trampoline-ground-spill") as THREE.InstancedMesh;
      const faces = scene.getObjectByName("trampoline-block-spill") as THREE.InstancedMesh;
      const rimMaterial = rims.material as THREE.MeshBasicMaterial;
      const oldColor = new THREE.Color(HL_CHARTREUSE);
      expect(rimMaterial.color.r / oldColor.r).toBeCloseTo(1.3, 8);
      expect(rimMaterial.color.g / oldColor.g).toBeCloseTo(1.3, 8);
      expect(rimMaterial.color.b / oldColor.b).toBeCloseTo(1.3, 8);
      expect(rimMaterial.blending).toBe(THREE.AdditiveBlending);
      expect(rims.visible).toBe(false);
      builder.setEveningLighting(1);
      expect(rimMaterial.opacity).toBe(0.92);
      expect((ground.material as THREE.MeshBasicMaterial).opacity / 0.14).toBeCloseTo(1.3, 8);
      expect((faces.material as THREE.MeshBasicMaterial).opacity / 0.16).toBeCloseTo(1.3, 8);
      const matrix = new THREE.Matrix4();
      const scale = new THREE.Vector3();
      ground.getMatrixAt(0, matrix);
      scale.setFromMatrixScale(matrix);
      expect(scale.x).toBeGreaterThan(4.6);
      expect(scale.x).toBeCloseTo(5.05, 5);
      builder.setEveningLighting(0);
      expect([rims, ground, faces].every((mesh) => !mesh.visible)).toBe(true);
      expect(scene.children.some((child) => child instanceof THREE.Light)).toBe(false);
    } finally {
      builder.dispose(scene);
    }
  });

  it("batches the new surfaces and disposes all their geometry, materials, texture and camera handles", () => {
    const scene = new THREE.Scene();
    const builder = new ArenaBuilder();
    builder.buildVisuals(scene);
    const names = ["storage-timber", "storage-packaging", "side-flower-beds", "side-flower-blossoms",
      "sports-fence-boards", "sports-fence-frame", "sports-fence-diamond-net", "platform-volumes", "shop-roof-flashings"];
    const resources = new Set<{ dispose(): void }>();
    let triangles = 0;
    for (const name of names) {
      const object = scene.getObjectByName(name) as THREE.Mesh | THREE.LineSegments;
      expect(object).toBeDefined();
      resources.add(object.geometry);
      const material = object.material as THREE.MeshStandardMaterial;
      resources.add(material);
      if (material.map) resources.add(material.map);
      if (object instanceof THREE.InstancedMesh) resources.add(object);
      if (!(object instanceof THREE.LineSegments)) {
        triangles += (object.geometry.getIndex()?.count ?? object.geometry.getAttribute("position").count) / 3
          * (object instanceof THREE.InstancedMesh ? object.count : 1);
      }
    }
    // Nine batches replace twelve old surface batches (four hidden caps removed).
    expect(names).toHaveLength(9);
    expect(triangles).toBeLessThan(13500);
    const oldFrameMaterial = (scene.getObjectByName("sports-fence-frame") as THREE.Mesh).material as THREE.Material;
    const spies = [...resources].map((resource) => vi.spyOn(resource, "dispose"));
    builder.dispose(scene);
    for (const spy of spies) expect(spy).toHaveBeenCalledOnce();
    expect(scene.children).toHaveLength(0);
    builder.setWallOpacity(WALL_FADE_OPACITY);
    expect(oldFrameMaterial.opacity).toBe(1);
    builder.buildVisuals(scene);
    const newFrameMaterial = (scene.getObjectByName("sports-fence-frame") as THREE.Mesh).material as THREE.Material;
    expect(newFrameMaterial).not.toBe(oldFrameMaterial);
    expect(newFrameMaterial.opacity).toBeCloseTo(0.5, 8);
    builder.dispose(scene);
    builder.dispose(scene);
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

  it("gives all four shops neutral flat roofs and flush flashing without raised obstructions", () => {
    const scene = new THREE.Scene();
    const builder = new ArenaBuilder();
    builder.buildVisuals(scene);
    try {
      const roofs = scene.getObjectByName("platform-volumes") as THREE.InstancedMesh;
      const flashing = scene.getObjectByName("shop-roof-flashings") as THREE.Mesh;
      expect(roofs.count).toBe(getPlatforms().length);
      const material = roofs.material as THREE.MeshStandardMaterial;
      expect(material.map).toBeInstanceOf(THREE.DataTexture);
      expect(material.roughness).toBeGreaterThan(0.9);
      const normals = roofs.geometry.getAttribute("normal");
      const colors = roofs.geometry.getAttribute("color");
      for (let vertex = 0; vertex < normals.count; vertex += 1) {
        if (normals.getY(vertex) < 0.99) continue;
        const color = new THREE.Color().fromBufferAttribute(colors, vertex);
        expect(Math.max(color.r, color.g, color.b) / Math.min(color.r, color.g, color.b)).toBeLessThan(1.2);
      }
      const positions = flashing.geometry.getAttribute("position");
      scene.updateMatrixWorld(true);
      const raycaster = new THREE.Raycaster();
      for (const platform of getPlatforms()) {
        for (let vertex = 0; vertex < positions.count; vertex += 1) {
          const x = positions.getX(vertex);
          const z = positions.getZ(vertex);
          if (Math.abs(x - platform.x) > platform.hx || Math.abs(z - platform.z) > platform.hz) continue;
          expect(positions.getY(vertex)).toBeLessThanOrEqual(platform.topY + 0.00001);
          expect(positions.getY(vertex)).toBeGreaterThanOrEqual(platform.topY - 0.031);
        }
        for (const dx of [-0.9, 0, 0.9]) {
          for (const dz of [-0.9, 0, 0.9]) {
            raycaster.set(new THREE.Vector3(platform.x + dx, platform.topY + 1, platform.z + dz), new THREE.Vector3(0, -1, 0));
            const hit = raycaster.intersectObjects([roofs, flashing])[0];
            expect(hit).toBeDefined();
            expect(hit!.point.y).toBeCloseTo(platform.topY, 5);
          }
        }
      }
      expect(scene.children.filter((child) => child instanceof THREE.Mesh && child.geometry instanceof THREE.BoxGeometry
        && child.geometry.parameters.height === 0.1)).toHaveLength(0);
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
