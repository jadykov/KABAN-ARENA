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

function instanceParts(mesh: THREE.InstancedMesh): Array<{ position: THREE.Vector3; scale: THREE.Vector3; color: THREE.Color; matrix: THREE.Matrix4 }> {
  return Array.from({ length: mesh.count }, (_, index) => {
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const color = new THREE.Color();
    mesh.getMatrixAt(index, matrix);
    matrix.decompose(position, new THREE.Quaternion(), scale);
    mesh.getColorAt(index, color);
    return { position, scale, color, matrix };
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
    const roofs = scene.getObjectByName("suburban-roofs") as THREE.Mesh;
    const vertices = roofs.geometry.getAttribute("position");
    for (let index = 0; index < vertices.count; index += 3) {
      const box = new THREE.Box3().setFromPoints([0, 1, 2]
        .map((offset) => new THREE.Vector3().fromBufferAttribute(vertices, index + offset)));
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

  it("varies actual house proportions, roof silhouettes, window rhythms and entry positions", () => {
    const scene = new THREE.Scene();
    const environment = new SuburbanEnvironment();
    environment.build(scene);
    const building = scene.getObjectByName("suburban-houses-and-trunks") as THREE.InstancedMesh;
    const parts = instanceParts(building);
    const bodies = parts.filter(({ scale }) => scale.x > 6 && scale.y > 3.4 && scale.z > 5);
    expect(bodies).toHaveLength(8);
    expect(new Set(bodies.map(({ scale }) => scale.y.toFixed(1))).size).toBeGreaterThanOrEqual(6);
    expect(new Set(bodies.map(({ color }) => color.getHex())).size).toBeGreaterThanOrEqual(6);

    const roofs = scene.getObjectByName("suburban-roofs") as THREE.Mesh;
    const roofPositions = roofs.geometry.getAttribute("position");
    const silhouettes = new Set<string>();
    const rhythms = new Set<string>();
    const entries: number[] = [];
    for (const body of bodies) {
      const inverse = body.matrix.clone().invert();
      const panes = parts.filter(({ color }) => color.getHex() === 0x465d63)
        .map((part) => ({ ...part, local: part.position.clone().applyMatrix4(inverse) }))
        .filter(({ local }) => Math.abs(local.x) < 0.5 && Math.abs(local.z - 0.5) < 0.04);
      expect(panes.length).toBeGreaterThan(0);
      rhythms.add(panes.map(({ local, scale }) => `${local.x.toFixed(2)}:${local.y.toFixed(2)}:${scale.x.toFixed(1)}`).join("|"));
      const door = parts.filter(({ color }) => color.getHex() === 0x68746e)
        .map(({ position }) => position.clone().applyMatrix4(inverse))
        .find((local) => Math.abs(local.x) < 0.5 && Math.abs(local.z - 0.5) < 0.04)!;
      expect(door).toBeDefined();
      entries.push(door.x);
      expect(panes.every(({ local, scale }) => Math.abs(local.x - door.x) * body.scale.x > (scale.x + 1.05) / 2
        || Math.abs(local.y - door.y) * body.scale.y > 2)).toBe(true);

      // Read the actual merged roof vertices in each building's local space:
      // gables, hipped ridges and single-slope slabs have distinct ridge profiles.
      const roofVertices: THREE.Vector3[] = [];
      for (let index = 0; index < roofPositions.count; index++) {
        const vertex = new THREE.Vector3().fromBufferAttribute(roofPositions, index).applyMatrix4(inverse);
        if (Math.abs(vertex.x) < 0.56 && Math.abs(vertex.z) < 0.56 && vertex.y >= 0.49) roofVertices.push(vertex);
      }
      expect(roofVertices.length).toBeGreaterThan(0);
      const max = Math.max(...roofVertices.map((vertex) => vertex.y));
      const ridge = roofVertices.filter((vertex) => Math.abs(vertex.y - max) < 0.001);
      silhouettes.add(ridge.map((vertex) => `${vertex.x.toFixed(1)},${vertex.z.toFixed(1)}`).sort().filter((point, index, all) => point !== all[index - 1]).join("|"));
    }
    expect(silhouettes.size).toBeGreaterThanOrEqual(3);
    expect(rhythms.size).toBeGreaterThanOrEqual(6);
    expect(entries.some((x) => x < -0.25)).toBe(true);
    expect(entries.some((x) => x > 0.25)).toBe(true);
    expect(parts.filter(({ scale }) => scale.x > 2 && scale.x < 4 && scale.y > 2.4 && scale.z > 4)).toHaveLength(2);
    environment.dispose(scene);
  });

  it("lights a sparse set of warm panes while retaining dark windows and real frame detail", () => {
    const scene = new THREE.Scene();
    const environment = new SuburbanEnvironment();
    environment.build(scene);
    const parts = instanceParts(scene.getObjectByName("suburban-houses-and-trunks") as THREE.InstancedMesh);
    const panes = parts.filter(({ color }) => color.getHex() === 0x465d63);
    const glow = scene.getObjectByName("suburban-window-glow") as THREE.InstancedMesh;
    const litPanes = instanceParts(glow);
    const material = glow.material as THREE.MeshBasicMaterial;
    expect(glow.visible).toBe(false);
    expect(glow.count).toBeGreaterThanOrEqual(8);
    expect(glow.count).toBeLessThan(panes.length / 2);
    expect(material.toneMapped).toBe(false);
    expect(material.fog).toBe(true);
    expect(material.color.r).toBeGreaterThan(material.color.g);
    expect(material.color.g).toBeGreaterThan(material.color.b);
    for (const lit of litPanes) {
      const pane = panes.find(({ position }) => position.distanceTo(lit.position) < 0.03);
      expect(pane).toBeDefined();
      expect(lit.scale.x).toBeCloseTo(pane!.scale.x);
      expect(lit.scale.y).toBeCloseTo(pane!.scale.y);
      expect(lit.scale.z).toBeLessThan(pane!.scale.z);
    }
    expect(new Set(litPanes.map(({ color }) => color.getHex())).size).toBeGreaterThan(1);
    environment.setEveningLighting(1);
    expect(glow.visible).toBe(true);
    expect(material.opacity).toBeCloseTo(0.68);
    expect(material.opacity).toBeLessThan(0.75);
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
    expect(material.opacity).toBeCloseTo(0.34);
    environment.setEveningLighting(2);
    expect(material.opacity).toBeCloseTo(0.68);
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
