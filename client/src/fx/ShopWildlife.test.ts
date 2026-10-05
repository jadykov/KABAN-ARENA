import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getShopfrontTransforms } from "../ads/AdsLoader";
import { getObstacleLayout, getPlatforms, getRamps } from "../arena/Arena";
import { ShopWildlife } from "./ShopWildlife";

type Participant = Parameters<ShopWildlife["update"]>[3][number];
const wildlife: ShopWildlife[] = [];
const shops = getPlatforms();
const fronts = getShopfrontTransforms();

function create(random: () => number = () => 0): ShopWildlife {
  const result = new ShopWildlife(random);
  wildlife.push(result);
  return result;
}

function batch(result: ShopWildlife, name: string): THREE.InstancedMesh {
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
  for (let step = 0; step < steps; step += 1) {
    result.update(0.05, elapsed + step * 0.05, true, players, null, null);
  }
}

function perch(result: ShopWildlife): THREE.InstancedMesh {
  advance(result, 14);
  const birds = batch(result, "shop-birds");
  expect(birds.count).toBeGreaterThanOrEqual(2);
  expect(position(birds).y).toBeCloseTo(3.025, 5);
  return birds;
}

afterEach(() => {
  for (const result of wildlife.splice(0)) result.dispose();
});

describe("rare daytime visits on the arena shop roofs", () => {
  it("stays absent outside a playing round, then arrives after 10–20 seconds and lands on a real roof", () => {
    const result = create(() => 0.5);
    const birds = batch(result, "shop-birds");
    for (let step = 0; step < 500; step += 1) result.update(0.1, 0, false, [], null, null);
    expect(birds.visible).toBe(false);
    advance(result, 14.8);
    expect(birds.count).toBe(0);
    advance(result, 0.4, 14.8);
    expect(birds.count).toBe(3);
    expect(position(birds).y).toBeGreaterThan(6);
    expect(batch(result, "shop-bird-wings").count).toBe(6);
    advance(result, 4, 15.2);
    const wings = batch(result, "shop-bird-wings");
    const wingVertices = wings.geometry.getAttribute("position");
    for (let index = 0; index < birds.count; index += 1) {
      const point = position(birds, index);
      const roof = shops.find((shop) => Math.abs(point.x - shop.x) < shop.hx && Math.abs(point.z - shop.z) < shop.hz);
      expect(roof).toBeDefined();
      expect(point.y).toBeCloseTo(roof!.topY + 0.025, 5);
      for (const wingIndex of [index * 2, index * 2 + 1]) {
        const matrix = new THREE.Matrix4();
        wings.getMatrixAt(wingIndex, matrix);
        for (let vertex = 0; vertex < wingVertices.count; vertex += 1) {
          const tip = new THREE.Vector3().fromBufferAttribute(wingVertices, vertex).applyMatrix4(matrix);
          expect(tip.y).toBeGreaterThan(roof!.topY + 0.02);
        }
      }
    }
    const settled = position(birds);
    advance(result, 2, 19.2);
    expect(position(birds).distanceTo(settled)).toBeLessThan(0.00001);
  });

  it("uses one group globally and gives each completed visit at least a 20-second quiet interval", () => {
    const result = create();
    const birds = batch(result, "shop-birds");
    let lastGone = Number.NEGATIVE_INFINITY;
    let previousCount = 0;
    let arrivals = 0;
    for (let step = 0; step < 1500; step += 1) {
      const elapsed = step * 0.05;
      result.update(0.05, elapsed, true, [], null, null);
      expect(birds.count).toBeLessThanOrEqual(3);
      expect(batch(result, "shop-rats").count).toBe(0);
      if (birds.count > 0 && previousCount === 0) {
        arrivals += 1;
        expect(elapsed - lastGone).toBeGreaterThanOrEqual(19.95);
      }
      if (birds.count === 0 && previousCount > 0) lastGone = elapsed;
      previousCount = birds.count;
    }
    expect(arrivals).toBe(2);
  });

  it("does not land a group on any roof already occupied or approached by a live fighter", () => {
    const result = create();
    const players = shops.map((shop, index) => participant(shop.x, shop.z, { sessionId: `fighter-${index}` }));
    advance(result, 20, 0, players);
    expect(batch(result, "shop-birds").count).toBe(0);
    advance(result, 8, 20);
    expect(batch(result, "shop-birds").count).toBe(2);
  });

  it.each([
    { alive: false, spectator: false },
    { alive: true, spectator: true },
  ])("ignores an ineligible visitor (%o), but flees from a live remote/bot at the roof", (flags) => {
    const result = create();
    const birds = perch(result);
    const landed = position(birds);
    advance(result, 0.2, 14, [participant(landed.x, landed.z, flags)]);
    expect(position(birds).y).toBeCloseTo(landed.y, 5);
    advance(result, 0.4, 14.2, [participant(landed.x, landed.z, { sessionId: "bot-2" })]);
    expect(position(birds).y).toBeGreaterThan(landed.y + 0.5);
    expect(Math.hypot(position(birds).x - landed.x, position(birds).z - landed.z)).toBeGreaterThan(0.5);
    advance(result, 3, 14.6);
    expect(birds.count).toBe(0);
  });

  it("uses the predicted local position for prompt flight, while requiring the local fighter to be alive", () => {
    const result = create();
    const birds = perch(result);
    const landed = position(birds);
    const self = participant(100, 100, { sessionId: "self", alive: false });
    result.update(0.1, 14, true, [self], "self", landed);
    expect(position(birds).y).toBeCloseTo(landed.y, 5);
    result.update(0.2, 14.1, true, [{ ...self, alive: true }], "self", landed);
    expect(position(birds).y).toBeGreaterThan(landed.y + 0.3);
  });

  it("uses a 3-metre horizontal scare radius and scatters in distinct directions", () => {
    const result = create();
    const birds = perch(result);
    const landed = position(birds);
    result.update(0.05, 14, true, [participant(landed.x - 3.2, landed.z)], null, null);
    expect(position(birds).y).toBeCloseTo(landed.y, 5);
    result.update(0.4, 14.05, true, [participant(landed.x - 2.9, landed.z)], null, null);
    expect(position(birds).x).toBeGreaterThan(landed.x + 0.5);
    const first = position(birds, 0);
    const second = position(birds, 1);
    expect(first.distanceTo(second)).toBeGreaterThan(0.7);
  });

  it("ends roof visits at dusk and keeps birds absent throughout night, including a skipped dusk snapshot", () => {
    const result = create();
    const birds = perch(result);
    result.update(0.2, 75, true, [], null, null);
    expect(position(birds).y).toBeGreaterThan(3.3);
    advance(result, 6, 75.2);
    expect(birds.count).toBe(0);
    advance(result, 40, 81.2);
    expect(birds.count).toBe(0);

    result.reset();
    perch(result);
    result.update(0.05, 90, true, [], null, null);
    expect(birds.count).toBe(0);
  });
});

describe("occasional nocturnal rats on approach", () => {
  it("starts at the actual night boundary before shop lamps switch on, and limits a group to 1–2 rats", () => {
    const result = create(() => 0.5);
    const rats = batch(result, "shop-rats");
    const front = fronts[0]!;
    const visitor = participant(front.x, front.z);
    advance(result, 2, 87.8, [visitor]);
    expect(rats.count).toBe(0);
    advance(result, 0.4, 90, [visitor]);
    expect(rats.count).toBe(2);
    expect(position(rats).y).toBeLessThan(0.08);
    expect(position(rats, 0).distanceTo(position(rats, 1))).toBeGreaterThan(0.2);
    advance(result, 3, 90.4, [visitor]);
    expect(rats.count).toBe(0);
    advance(result, 40, 93.4, [visitor]);
    expect(rats.count).toBe(0);
  });

  it("uses a 3.5m approach radius and requires leaving the 5m rearm radius before another run", () => {
    const result = create();
    const rats = batch(result, "shop-rats");
    const front = fronts[0]!;
    const nx = Math.sin(front.rotationY);
    const nz = Math.cos(front.rotationY);
    const visitorAt = (distance: number): Participant[] => [participant(front.x + nx * distance, front.z + nz * distance)];
    advance(result, 0.1, 90, visitorAt(3.6));
    expect(rats.count).toBe(0);
    advance(result, 0.2, 90.1, visitorAt(3.5));
    expect(rats.count).toBe(1);
    advance(result, 30, 90.3, visitorAt(3.5));
    expect(rats.count).toBe(0);
    advance(result, 0.2, 120.3, visitorAt(4.9));
    advance(result, 0.2, 120.5, visitorAt(3));
    expect(rats.count).toBe(0);
    advance(result, 0.2, 120.7, visitorAt(5.1));
    advance(result, 0.2, 120.9, visitorAt(3));
    expect(rats.count).toBe(1);
  });

  it("enforces one global cooldown across shops and consumes failed/random approach opportunities", () => {
    let roll = 0.95;
    const result = create(() => roll);
    const rats = batch(result, "shop-rats");
    const first = fronts[0]!;
    const second = fronts[1]!;
    advance(result, 0.1, 90, [participant(first.x, first.z)]);
    expect(rats.count).toBe(0);
    roll = 0;
    advance(result, 0.2, 90.1);
    advance(result, 0.2, 90.3, [participant(second.x, second.z)]);
    expect(rats.count).toBe(0);
    advance(result, 30, 90.5);
    advance(result, 0.2, 120.5, [participant(second.x, second.z)]);
    expect(rats.count).toBe(1);
    advance(result, 2, 120.7);
    advance(result, 0.2, 122.7, [participant(first.x, first.z)]);
    expect(rats.count).toBe(0);
    advance(result, 30, 122.9, [participant(first.x, first.z)]);
    expect(rats.count).toBe(0);
  });

  it.each([
    { alive: false, spectator: false },
    { alive: true, spectator: true },
  ])("ignores dead/spectator approach (%o)", (flags) => {
    const result = create();
    const front = fronts[0]!;
    advance(result, 2, 90, [participant(front.x, front.z, flags)]);
    expect(batch(result, "shop-rats").count).toBe(0);
    advance(result, 0.2, 92, [participant(front.x, front.z)]);
    expect(batch(result, "shop-rats").count).toBe(1);
  });

  it("keeps every current facade sprint outside shop/obstacle/ramp volumes and inside the arena", () => {
    for (const front of fronts) {
      const result = create();
      const rats = batch(result, "shop-rats");
      const visitor = participant(front.x, front.z);
      let observed = 0;
      for (let step = 0; step < 40; step += 1) {
        result.update(0.04, 90 + step * 0.04, true, [visitor], null, null);
        if (rats.count === 0) continue;
        observed += 1;
        const point = position(rats);
        expect(Math.abs(point.x)).toBeLessThan(17);
        expect(Math.abs(point.z)).toBeLessThan(17);
        for (const block of [...shops, ...getObstacleLayout()]) {
          const inside = Math.abs(point.x - block.x) < block.hx + 0.1 && Math.abs(point.z - block.z) < block.hz + 0.1;
          expect(inside).toBe(false);
        }
        for (const ramp of getRamps()) {
          const hx = ramp.axis === "x" ? ramp.halfWidth : ramp.halfLength;
          const hz = ramp.axis === "x" ? ramp.halfLength : ramp.halfWidth;
          expect(Math.abs(point.x - ramp.x) < hx + 0.1 && Math.abs(point.z - ramp.z) < hz + 0.1).toBe(false);
        }
      }
      expect(observed).toBeGreaterThan(20);
    }
  });
});

describe("pooled geometry and lifecycle", () => {
  it("uses three shared-material batches, bounded capacity, positive instance scales, and no shadows/lights", () => {
    const result = create(() => 0.5);
    const meshes = result.object.children as THREE.InstancedMesh[];
    const originalGeometry = meshes.map((mesh) => mesh.geometry);
    expect(meshes).toHaveLength(3);
    expect(new Set(meshes.map((mesh) => mesh.material)).size).toBe(1);
    for (const mesh of meshes) {
      expect(mesh).toBeInstanceOf(THREE.InstancedMesh);
      expect(mesh.castShadow).toBe(false);
      expect(mesh.receiveShadow).toBe(false);
      expect(mesh.geometry.getAttribute("color").count).toBe(mesh.geometry.getAttribute("position").count);
    }
    advance(result, 20);
    expect(meshes.filter((mesh) => mesh.visible)).toHaveLength(2);
    const wings = batch(result, "shop-bird-wings");
    for (let index = 0; index < wings.count; index += 1) {
      const matrix = new THREE.Matrix4();
      wings.getMatrixAt(index, matrix);
      expect(matrix.determinant()).toBeGreaterThan(0);
    }
    advance(result, 70, 20);
    const front = fronts[0]!;
    advance(result, 0.4, 90, [participant(front.x, front.z)]);
    expect(meshes.filter((mesh) => mesh.visible)).toHaveLength(1);
    expect(result.object.children).toEqual(meshes);
    expect(meshes.map((mesh) => mesh.geometry)).toEqual(originalGeometry);
  });

  it("clears groups on round end/reset and elapsed rewind, and resets rat approach rearming", () => {
    const result = create();
    const birds = perch(result);
    result.update(0.1, 180, false, [], null, null);
    expect(birds.count).toBe(0);
    advance(result, 5);
    expect(birds.count).toBe(0);
    advance(result, 9, 5);
    expect(birds.count).toBe(2);
    result.update(0.1, 0, true, [], null, null);
    expect(birds.count).toBe(0);
    const front = fronts[0]!;
    advance(result, 0.2, 90, [participant(front.x, front.z)]);
    expect(batch(result, "shop-rats").count).toBe(1);
    result.reset();
    expect(batch(result, "shop-rats").count).toBe(0);
    advance(result, 0.2, 90, [participant(front.x, front.z)]);
    expect(batch(result, "shop-rats").count).toBe(1);
  });

  it("disposes each owned geometry/material and instance buffer once, detaches, and cannot animate afterward", () => {
    const result = create();
    const scene = new THREE.Scene();
    scene.add(result.object);
    const meshes = result.object.children as THREE.InstancedMesh[];
    const geometrySpies = meshes.map((mesh) => vi.spyOn(mesh.geometry, "dispose"));
    const instanceSpies = meshes.map((mesh) => vi.spyOn(mesh, "dispose"));
    const materialSpy = vi.spyOn(meshes[0]!.material as THREE.Material, "dispose");
    perch(result);
    result.dispose();
    result.dispose();
    expect(scene.children).toHaveLength(0);
    expect(result.object.children).toHaveLength(0);
    advance(result, 30);
    for (const spy of [...geometrySpies, ...instanceSpies, materialSpy]) expect(spy).toHaveBeenCalledTimes(1);
  });
});
