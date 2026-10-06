import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArenaBuilder } from "../arena/Arena";
import { ARENA_HALF_SIZE, WALL_THICKNESS, WALL_VISUAL_HEIGHT } from "../config";
import { ARENA_LAYOUT } from "../layout";
import { ShopWildlife } from "./ShopWildlife";
import { getBirdSurfaces, getRatRoutes, isRatSegmentClear, isWildlifeGroundClear } from "./WildlifeLayout";

type Participant = Parameters<ShopWildlife["update"]>[3][number];
const wildlife: ShopWildlife[] = [];

function create(random: () => number = () => 0): ShopWildlife {
  const result = new ShopWildlife(random);
  wildlife.push(result);
  return result;
}
function seeded(seed: number): () => number {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
}
function batch(result: ShopWildlife, name = "shop-birds"): THREE.InstancedMesh {
  return result.object.getObjectByName(name) as THREE.InstancedMesh;
}
function position(mesh: THREE.InstancedMesh, index = 0): THREE.Vector3 {
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(index, matrix);
  return new THREE.Vector3().setFromMatrixPosition(matrix);
}
function participant(x: number, z: number, overrides: Partial<Participant> = {}): Participant {
  return { sessionId: "remote", x, y: 1.1, z, alive: true, spectator: false, ...overrides };
}
function advance(result: ShopWildlife, duration: number, elapsed = 0, players: readonly Participant[] = []): void {
  const steps = Math.ceil(duration * 20);
  for (let step = 0; step < steps; step += 1) result.update(0.05, elapsed + step * 0.05, true, players, null, null);
}
function landed(random = 0): { result: ShopWildlife; birds: THREE.InstancedMesh; elapsed: number } {
  const result = create(() => random);
  const elapsed = 10 + random * 10 + 3.5;
  advance(result, elapsed);
  return { result, birds: batch(result), elapsed };
}
afterEach(() => { for (const result of wildlife.splice(0)) result.dispose(); });

describe("varied daytime flocks around the arena", () => {
  it.each([
    { random: 0, count: 1, height: 0.025 },
    { random: 0.5, count: 2, height: 3.025 },
    { random: 0.8, count: 3, height: 2.025 },
  ])("arrives after 10–20 seconds with $count birds and lands safely", ({ random, count, height }) => {
    const result = create(() => random);
    const birds = batch(result);
    for (let step = 0; step < 100; step += 1) result.update(0.1, 0, false, [], null, null);
    expect(birds.visible).toBe(false);
    const first = 10 + random * 10;
    advance(result, first - 0.1);
    expect(birds.count).toBe(0);
    advance(result, 3.5, first - 0.1);
    expect(birds.count).toBe(count);
    expect(batch(result, "shop-bird-wings").count).toBe(count * 2);
    for (let index = 0; index < count; index += 1) expect(position(birds, index).y).toBeCloseTo(height, 5);
  });

  it("supports ground, all shop roofs, all four cargo tops, and the actual upper fence rail", () => {
    const surfaces = getBirdSurfaces();
    expect(new Set(surfaces.map((surface) => surface.kind))).toEqual(new Set(["ground", "fence", "roof", "cargo"]));
    expect(surfaces.filter((surface) => surface.kind === "roof")).toHaveLength(4);
    expect(surfaces.filter((surface) => surface.kind === "cargo")).toHaveLength(4);
    for (const surface of surfaces.filter((entry) => entry.kind === "cargo")) {
      expect(ARENA_LAYOUT.obstacles.some((box) => box.x === surface.x && box.z === surface.z && box.topY === 2)).toBe(true);
    }
    const { birds } = landed(0.3);
    const rail = ARENA_HALF_SIZE + WALL_THICKNESS / 2;
    expect(birds.count).toBe(1);
    const body = new THREE.Matrix4();
    birds.getMatrixAt(0, body);
    const root = position(birds);
    expect(root.y).toBeCloseTo(WALL_VISUAL_HEIGHT + 0.025, 5);
    for (const side of [-1, 1]) {
      const foot = new THREE.Vector3(side * 0.04, 0.013, 0.04).applyMatrix4(body);
      const onX = Math.abs(Math.abs(foot.x) - rail) < 0.01;
      const onZ = Math.abs(Math.abs(foot.z) - rail) < 0.01;
      expect(onX || onZ).toBe(true);
    }
  });

  it("lets independent groups overlap while retaining six birds and at most three locations", () => {
    let foundThreePlaces = false;
    let foundSix = false;
    const counts = new Set<number>();
    for (let seed = 1; seed <= 20; seed += 1) {
      const result = create(seeded(seed));
      const birds = batch(result);
      for (let step = 0; step < 1450; step += 1) {
        result.update(0.05, step * 0.05, true, [], null, null);
        expect(birds.count).toBeLessThanOrEqual(6);
        if (birds.count === 6) foundSix = true;
        counts.add(birds.count);
        const places: THREE.Vector3[] = [];
        for (let index = 0; index < birds.count; index += 1) {
          const point = position(birds, index);
          if (![0.025, 2.025, 3.025, 3.525].some((y) => Math.abs(point.y - y) < 1e-5)) continue;
          if (!places.some((other) => Math.hypot(point.x - other.x, point.z - other.z) < 2)) places.push(point);
        }
        if (places.length >= 3) foundThreePlaces = true;
      }
    }
    expect(counts).toEqual(new Set([0, 1, 2, 3, 4, 5, 6]));
    expect(foundSix).toBe(true);
    expect(foundThreePlaces).toBe(true);
  });

  it("varies actual perches and keeps all settled body footprints off forbidden surfaces", () => {
    const kinds = new Set<string>();
    const positions = new Set<string>();
    let checked = 0;
    for (let seed = 30; seed < 45; seed += 1) {
      const result = create(seeded(seed));
      const birds = batch(result);
      for (let step = 0; step < 700; step += 1) {
        result.update(0.1, step * 0.1, true, [], null, null);
        for (let index = 0; index < birds.count; index += 1) {
          const point = position(birds, index);
          const surface = getBirdSurfaces().find((candidate) => Math.abs(point.y - candidate.y - 0.025) < 1e-5
            && Math.abs(point.x - candidate.x) < Math.max(candidate.hx, 0.05) + 0.1
            && Math.abs(point.z - candidate.z) < Math.max(candidate.hz, 0.05) + 0.1);
          if (surface === undefined) continue;
          kinds.add(surface.kind);
          positions.add(`${point.x.toFixed(2)},${point.z.toFixed(2)}`);
          checked += 1;
          if (surface.kind === "ground") expect(isWildlifeGroundClear(point.x, point.z)).toBe(true);
          if (surface.kind === "roof" || surface.kind === "cargo") {
            expect(Math.abs(point.x - surface.x)).toBeLessThanOrEqual(surface.hx - 0.31);
            expect(Math.abs(point.z - surface.z)).toBeLessThanOrEqual(surface.hz - 0.31);
          }
          for (const spawn of ARENA_LAYOUT.spawns) expect(Math.hypot(point.x - spawn.x, point.z - spawn.z)).toBeGreaterThan(1.22);
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect(positions.size).toBeGreaterThan(35);
    expect(kinds).toEqual(new Set(["ground", "fence", "roof", "cargo"]));
  });

  it("visits every roof/cargo/fence side and supports both complete feet on real cargo lids", () => {
    const builder = new ArenaBuilder();
    const scene = new THREE.Scene();
    builder.buildVisuals(scene);
    scene.updateMatrixWorld(true);
    const storage = [scene.getObjectByName("storage-timber")!, scene.getObjectByName("storage-packaging")!];
    const surfaces = getBirdSurfaces();
    const roofIds = new Set<string>();
    const cargoIds = new Set<string>();
    const fenceSides = new Set<string>();
    const checkedCargo = new Set<string>();
    const ray = new THREE.Raycaster();
    const down = new THREE.Vector3(0, -1, 0);
    let footChecks = 0;
    try {
      // These are actual gaps found by the independent browser tester.
      for (const gap of [new THREE.Vector3(-4.770489, 2.2, -4.735946), new THREE.Vector3(-4.595896, 2.2, 4.793002)]) {
        ray.set(gap, down);
        expect(ray.intersectObjects(storage, false)[0]!.point.y).toBeLessThan(1.9);
      }
      for (let seed = 1; seed <= 64; seed += 1) {
        const result = create(seeded(seed * 7919));
        const birds = batch(result);
        for (let step = 0; step < 240; step += 1) {
          result.update(0.1, step * 0.1, true, [], null, null);
          for (let index = 0; index < birds.count; index += 1) {
            const point = position(birds, index);
            const surface = surfaces.find((candidate) => Math.abs(point.y - candidate.y - 0.025) < 1e-5
              && Math.abs(point.x - candidate.x) < Math.max(candidate.hx, 0.05) + 0.1
              && Math.abs(point.z - candidate.z) < Math.max(candidate.hz, 0.05) + 0.1);
            if (surface === undefined) continue;
            if (surface.kind === "roof") roofIds.add(`${surface.x}:${surface.z}`);
            if (surface.kind === "fence") fenceSides.add(surface.hx === 0 ? `x:${Math.sign(surface.x)}` : `z:${Math.sign(surface.z)}`);
            if (surface.kind !== "cargo") continue;
            cargoIds.add(`${surface.x}:${surface.z}`);
            const key = `${seed}:${point.x.toFixed(3)}:${point.z.toFixed(3)}`;
            if (checkedCargo.has(key)) continue;
            checkedCargo.add(key);
            const matrix = new THREE.Matrix4();
            birds.getMatrixAt(index, matrix);
            for (const side of [-1, 1]) {
              // Include corners as well as centres, verifying the whole foot.
              for (const corner of [[0, 0], [-0.03, -0.0375], [-0.03, 0.0375], [0.03, -0.0375], [0.03, 0.0375]]) {
                const foot = new THREE.Vector3(side * 0.04 + corner[0]!, 0.013, 0.04 + corner[1]!).applyMatrix4(matrix);
                ray.set(new THREE.Vector3(foot.x, surface.y + 0.2, foot.z), down);
                const hit = ray.intersectObjects(storage, false)[0];
                expect(hit).toBeDefined();
                expect(hit!.point.y).toBeCloseTo(surface.y, 4);
                footChecks += 1;
              }
            }
          }
        }
      }
      expect(roofIds.size).toBe(4);
      expect(cargoIds.size).toBe(4);
      expect(fenceSides.size).toBe(4);
      expect(footChecks).toBeGreaterThan(100);
    } finally {
      builder.dispose(scene);
    }
  });

  it.each([{ alive: false, spectator: false }, { alive: true, spectator: true }])(
    "ignores ineligible visitors %o and flees from a live remote/bot", (flags) => {
      const { result, birds, elapsed } = landed();
      const point = position(birds);
      result.update(0.1, elapsed, true, [participant(point.x, point.z, flags)], null, null);
      expect(position(birds).y).toBeCloseTo(point.y, 5);
      result.update(0.4, elapsed + 0.1, true, [participant(point.x, point.z, { sessionId: "bot-2" })], null, null);
      expect(position(birds).y).toBeGreaterThan(point.y + 0.5);
    });

  it("scares at 3 metres and uses predicted local movement only for a living fighter", () => {
    const { result, birds, elapsed } = landed();
    const point = position(birds);
    result.update(0.05, elapsed, true, [participant(point.x - 3.2, point.z)], null, null);
    expect(position(birds).y).toBeCloseTo(point.y, 5);
    const self = participant(100, 100, { sessionId: "self", alive: false });
    result.update(0.1, elapsed + 0.05, true, [self], "self", point);
    expect(position(birds).y).toBeCloseTo(point.y, 5);
    result.update(0.3, elapsed + 0.15, true, [{ ...self, alive: true }], "self", point);
    expect(position(birds).y).toBeGreaterThan(point.y + 0.5);
  });

  it("clears even the tallest fence before any frightened bird spreads sideways", () => {
    for (const random of [0, 0.3, 0.5, 0.8]) {
      const { result, birds, elapsed } = landed(random);
      const point = position(birds);
      let lateralFlight = false;
      for (let step = 0; step < 35; step += 1) {
        result.update(0.05, elapsed + step * 0.05, true,
          step === 0 ? [participant(point.x, point.z)] : [], null, null);
        const lifted = position(birds);
        const horizontal = Math.hypot(lifted.x - point.x, lifted.z - point.z);
        if (horizontal > 0.001) {
          lateralFlight = true;
          expect(lifted.y).toBeGreaterThan(WALL_VISUAL_HEIGHT + 0.4);
        }
        if (step === 1) {
          expect(horizontal).toBeLessThan(0.001);
          expect(lifted.y).toBeGreaterThan(point.y + 1);
        }
      }
      expect(lateralFlight).toBe(true);
    }
  });

  it("avoids landing near live fighters, but ignores dead/spectator spawn positions", () => {
    const occupied = getBirdSurfaces().map((surface, index) => participant(surface.x, surface.z, { sessionId: `bot-${index}` }));
    const result = create();
    advance(result, 20, 0, occupied);
    expect(batch(result).count).toBe(0);
    advance(result, 10, 20, occupied.map((player) => ({ ...player, alive: false })));
    expect(batch(result).count).toBeGreaterThan(0);
  });

  it("folds every wing above the supporting surface, including low cargo and ground", () => {
    for (const random of [0, 0.3, 0.5, 0.8]) {
      const { result, birds } = landed(random);
      const wings = batch(result, "shop-bird-wings");
      const vertices = wings.geometry.getAttribute("position");
      for (let bird = 0; bird < birds.count; bird += 1) {
        const floor = position(birds, bird).y - 0.025;
        for (const wing of [bird * 2, bird * 2 + 1]) {
          const matrix = new THREE.Matrix4();
          wings.getMatrixAt(wing, matrix);
          for (let vertex = 0; vertex < vertices.count; vertex += 1) {
            expect(new THREE.Vector3().fromBufferAttribute(vertices, vertex).applyMatrix4(matrix).y).toBeGreaterThan(floor + 0.02);
          }
        }
      }
    }
  });

  it("flies away at dusk and is completely hidden at night, including late snapshots", () => {
    const { result, birds, elapsed } = landed();
    result.update(0.2, 75, true, [], null, null);
    expect(position(birds).y).toBeGreaterThan(0.5);
    advance(result, 10, 75.2);
    expect(birds.count).toBe(0);
    result.reset();
    advance(result, elapsed);
    result.update(0.05, 90, true, [], null, null);
    expect(birds.count).toBe(0);
    advance(result, 30, 90.05);
    expect(birds.count).toBe(0);
  });
});

describe("autonomous nocturnal journeys between stores", () => {
  it("precomputes diverse safe routes between every pair of real shop fronts", () => {
    const routes = getRatRoutes();
    expect(routes).toHaveLength(36);
    expect(new Set(routes.map((route) => `${route.source}:${route.destination}`)).size).toBe(12);
    for (const route of routes) {
      expect(route.source).not.toBe(route.destination);
      expect(route.length).toBeGreaterThan(15);
      expect(route.distances.at(-1)).toBe(route.length);
      for (let index = 1; index < route.points.length; index += 1) expect(isRatSegmentClear(route.points[index - 1]!, route.points[index]!)).toBe(true);
    }
  });

  it.each([{ random: 0, count: 1 }, { random: 0.5, count: 2 }])(
    "runs $count rats after night starts without a nearby player", ({ random, count }) => {
      const result = create(() => random);
      const rats = batch(result, "shop-rats");
      advance(result, 10, 79.9);
      expect(rats.count).toBe(0);
      advance(result, 1 + random * 3 + 2, 90);
      expect(rats.count).toBe(count);
      const start = position(rats);
      advance(result, 3, 94 + random * 3);
      expect(position(rats).distanceTo(start)).toBeGreaterThan(5);
      expect(position(rats).y).toBeLessThan(0.05);
    });

  it("covers the arena between stores with varying pairs, routes, and quiet intervals", () => {
    const result = create(seeded(123));
    const rats = batch(result, "shop-rats");
    const episodes: Array<{ at: number; start: THREE.Vector3 }> = [];
    const counts = new Set<number>();
    let previous = 0;
    let traveledFar = false;
    for (let step = 0; step < 1700; step += 1) {
      result.update(0.05, 90 + step * 0.05, true, [], null, null);
      expect(rats.count).toBeLessThanOrEqual(2);
      counts.add(rats.count);
      if (rats.count > 0 && previous === 0) episodes.push({ at: step * 0.05, start: position(rats) });
      for (let index = 0; index < rats.count; index += 1) {
        const point = position(rats, index);
        expect(isWildlifeGroundClear(point.x, point.z, 0.45)).toBe(true);
        if (episodes.length > 0 && point.distanceTo(episodes.at(-1)!.start) > 12) traveledFar = true;
      }
      previous = rats.count;
    }
    expect(episodes.length).toBeGreaterThanOrEqual(3);
    expect(counts).toEqual(new Set([0, 1, 2]));
    expect(traveledFar).toBe(true);
    expect(new Set(episodes.map((episode) => `${episode.start.x.toFixed(1)}:${episode.start.z.toFixed(1)}`)).size).toBeGreaterThan(1);
    const intervals = episodes.slice(1).map((episode, index) => Math.round((episode.at - episodes[index]!.at) * 10));
    expect(new Set(intervals).size).toBeGreaterThan(1);
  });

  it("uses separate journeys for a pair and stays clear of every solid/ramp/pad/spawn all along them", () => {
    const result = create(() => 0.5);
    const rats = batch(result, "shop-rats");
    let pair = false;
    for (let step = 0; step < 450; step += 1) {
      result.update(0.05, 90 + step * 0.05, true, [], null, null);
      for (let index = 0; index < rats.count; index += 1) {
        const point = position(rats, index);
        expect(isWildlifeGroundClear(point.x, point.z, 0.45)).toBe(true);
      }
      if (rats.count === 2) {
        pair = true;
        expect(position(rats, 0).distanceTo(position(rats, 1))).toBeGreaterThan(0.2);
      }
    }
    expect(pair).toBe(true);
  });
});

describe("bounded geometry and round lifecycle", () => {
  it("keeps three shared-material batches, bounded buffers, positive scales, and no extra lights/shadows", () => {
    const result = create(seeded(99));
    const meshes = result.object.children as THREE.InstancedMesh[];
    const geometry = meshes.map((mesh) => mesh.geometry);
    expect(meshes).toHaveLength(3);
    expect(new Set(meshes.map((mesh) => mesh.material)).size).toBe(1);
    expect(meshes.map((mesh) => mesh.instanceMatrix.count)).toEqual([6, 12, 2]);
    for (const mesh of meshes) {
      expect(mesh).toBeInstanceOf(THREE.InstancedMesh);
      expect(mesh.castShadow || mesh.receiveShadow).toBe(false);
      expect(mesh.geometry.getAttribute("color").count).toBe(mesh.geometry.getAttribute("position").count);
    }
    for (let round = 0; round < 5; round += 1) {
      result.reset();
      advance(result, 70);
      advance(result, 30, 90);
      for (const mesh of meshes) {
        for (let index = 0; index < mesh.count; index += 1) {
          const matrix = new THREE.Matrix4();
          mesh.getMatrixAt(index, matrix);
          expect(matrix.determinant()).toBeGreaterThan(0);
        }
      }
      expect(result.object.children).toEqual(meshes);
      expect(meshes.map((mesh) => mesh.geometry)).toEqual(geometry);
    }
  });

  it("clears every group on round end, reset, and elapsed rewind and resumes fresh timing", () => {
    const { result, birds } = landed();
    result.update(0.1, 180, false, [], null, null);
    expect(birds.count).toBe(0);
    advance(result, 5);
    expect(birds.count).toBe(0);
    advance(result, 9, 5);
    expect(birds.count).toBe(1);
    result.update(0.1, 0, true, [], null, null);
    expect(birds.count).toBe(0);
    advance(result, 3, 90);
    expect(batch(result, "shop-rats").count).toBe(1);
    result.reset();
    expect(batch(result, "shop-rats").count).toBe(0);
    advance(result, 0.5, 90);
    expect(batch(result, "shop-rats").count).toBe(0);
  });

  it("disposes every owned geometry/material/instance buffer once and cannot animate afterward", () => {
    const result = create();
    const scene = new THREE.Scene();
    scene.add(result.object);
    const meshes = result.object.children as THREE.InstancedMesh[];
    const spies = meshes.flatMap((mesh) => [vi.spyOn(mesh.geometry, "dispose"), vi.spyOn(mesh, "dispose")]);
    spies.push(vi.spyOn(meshes[0]!.material as THREE.Material, "dispose"));
    advance(result, 20);
    result.dispose();
    result.dispose();
    advance(result, 30);
    expect(scene.children).toHaveLength(0);
    expect(result.object.children).toHaveLength(0);
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
  });
});
