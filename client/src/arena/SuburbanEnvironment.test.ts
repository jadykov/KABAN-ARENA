import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { ARENA_HALF_SIZE } from "../config";
import { SuburbanEnvironment } from "./SuburbanEnvironment";

function instanceBounds(mesh: THREE.InstancedMesh): THREE.Box3[] {
  mesh.geometry.computeBoundingBox();
  const matrix = new THREE.Matrix4();
  return Array.from({ length: mesh.count }, (_, index) => {
    mesh.getMatrixAt(index, matrix);
    return mesh.geometry.boundingBox!.clone().applyMatrix4(matrix);
  });
}

describe("SuburbanEnvironment", () => {
  it("grounds the arena outside its boundary while leaving its playable floor unobscured", () => {
    const scene = new THREE.Scene();
    const environment = new SuburbanEnvironment();
    environment.build(scene);
    const ground = scene.getObjectByName("suburban-ground")!;
    scene.updateMatrixWorld(true);
    const ray = new THREE.Raycaster(new THREE.Vector3(0, 15, 0), new THREE.Vector3(0, -1, 0));
    expect(ray.intersectObject(ground)).toHaveLength(0);
    for (const [x, z] of [[ARENA_HALF_SIZE + 1, 0], [0, -ARENA_HALF_SIZE - 1],
      [-ARENA_HALF_SIZE - 1, 0], [0, ARENA_HALF_SIZE + 1]]) {
      ray.set(new THREE.Vector3(x!, 15, z!), new THREE.Vector3(0, -1, 0));
      const hits = ray.intersectObject(ground);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.point.y).toBeCloseTo(-0.05);
    }
    const buildings = scene.getObjectByName("suburban-houses-and-trunks") as THREE.InstancedMesh;
    const trees = scene.getObjectByName("suburban-trees") as THREE.InstancedMesh;
    for (const box of [...instanceBounds(buildings), ...instanceBounds(trees)]) {
      expect(box.max.x < -ARENA_HALF_SIZE || box.min.x > ARENA_HALF_SIZE
        || box.max.z < -ARENA_HALF_SIZE || box.min.z > ARENA_HALF_SIZE).toBe(true);
    }
    environment.dispose(scene);
  });

  it("uses five finite world-space batches without lights, shadows or camera following", () => {
    const scene = new THREE.Scene();
    const environment = new SuburbanEnvironment();
    environment.build(scene);
    environment.build(scene);
    expect(scene.children).toHaveLength(1);
    const group = scene.getObjectByName("suburban-environment")!;
    expect(group.children).toHaveLength(5);
    let triangles = 0;
    group.traverse((child) => {
      expect(child instanceof THREE.Light).toBe(false);
      if (!(child instanceof THREE.Mesh)) return;
      expect(child.castShadow).toBe(false);
      const geometry = child.geometry;
      const count = geometry.index?.count ?? geometry.getAttribute("position").count;
      triangles += count / 3 * (child instanceof THREE.InstancedMesh ? child.count : 1);
      const positions = geometry.getAttribute("position");
      expect(Array.from(positions.array).every(Number.isFinite)).toBe(true);
    });
    expect(triangles).toBeLessThan(4000);
    environment.dispose(scene);
  });

  it("keeps recognizable houses or trees in horizontal views from the center and corners on desktop and portrait cameras", () => {
    const scene = new THREE.Scene();
    const environment = new SuburbanEnvironment();
    environment.build(scene);
    const houses = instanceBounds(scene.getObjectByName("suburban-houses-and-trunks") as THREE.InstancedMesh);
    const trees = instanceBounds(scene.getObjectByName("suburban-trees") as THREE.InstancedMesh);
    const boxes = [...houses, ...trees];
    const frustum = new THREE.Frustum();
    const view = new THREE.Matrix4();
    for (const aspect of [16 / 9, 9 / 16]) {
      const camera = new THREE.PerspectiveCamera(75, aspect, 0.1, 200);
      for (const [x, y, z] of [[0, 4, 0], [-17, 7, -17], [17, 7, 17], [-17, 4, 17], [17, 4, -17]]) {
        camera.position.set(x!, y!, z!);
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          camera.lookAt(x! + dx! * 30, y! - 4, z! + dz! * 30);
          camera.updateMatrixWorld(true);
          frustum.setFromProjectionMatrix(view.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
          expect(boxes.some((box) => frustum.intersectsBox(box))).toBe(true);
        }
      }
    }
    environment.dispose(scene);
  });

  it("restores server-timed evening windows on late build, clamps input and releases all shared resources", () => {
    const scene = new THREE.Scene();
    const environment = new SuburbanEnvironment();
    environment.setEveningLighting(0.5);
    environment.build(scene);
    const glow = scene.getObjectByName("suburban-window-glow") as THREE.InstancedMesh;
    const material = glow.material as THREE.MeshBasicMaterial;
    expect(glow.visible).toBe(true);
    expect(material.opacity).toBeCloseTo(0.18);
    environment.setEveningLighting(2);
    expect(material.opacity).toBeCloseTo(0.36);
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, 0]) {
      environment.setEveningLighting(value);
      expect(glow.visible).toBe(false);
      expect(material.opacity).toBe(0);
    }
    const resources = new Set<{ dispose(): void }>();
    scene.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        resources.add(child.geometry);
        (Array.isArray(child.material) ? child.material : [child.material]).forEach((value) => resources.add(value));
        if (child instanceof THREE.InstancedMesh) resources.add(child);
      }
    });
    const spies = [...resources].map((resource) => vi.spyOn(resource, "dispose"));
    environment.dispose(scene);
    expect(scene.children).toHaveLength(0);
    spies.forEach((spy) => expect(spy).toHaveBeenCalledTimes(1));
    environment.dispose(scene);
    spies.forEach((spy) => expect(spy).toHaveBeenCalledTimes(1));
    environment.build(scene);
    expect((scene.getObjectByName("suburban-window-glow") as THREE.Mesh).visible).toBe(false);
    environment.dispose(scene);
  });
});
