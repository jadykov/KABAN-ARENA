import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import {
  CAMERA_FOLLOW_DISTANCE, CAMERA_FOLLOW_HEIGHT, CAMERA_LOOK_AT_HEIGHT, CAMERA_REST_PITCH,
} from "../config";
import { SkyAircraft } from "./SkyAircraft";

function parts(aircraft: SkyAircraft): {
  plane: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  trails: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
} {
  return {
    plane: aircraft.object.getObjectByName("sky-airplane") as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>,
    trails: aircraft.object.getObjectByName("airplane-contrails") as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>,
  };
}

function center(aircraft: SkyAircraft, scene: THREE.Scene, camera: THREE.Camera): void {
  camera.updateMatrixWorld(true);
  const { plane } = parts(aircraft);
  plane.onBeforeRender({} as THREE.WebGLRenderer, scene, camera, plane.geometry, plane.material, new THREE.Group());
}

describe("SkyAircraft", () => {
  it("makes two slow occasional daytime passages from authoritative time, independent of earlier frames", () => {
    const aircraft = new SkyAircraft();
    const late = new SkyAircraft();
    try {
      const { plane, trails } = parts(aircraft);
      for (const elapsed of [0, 13.99, 45, 55.99, 87, 89.99, 90, 180]) {
        aircraft.setElapsed(elapsed);
        expect(plane.visible).toBe(false);
        expect(trails.visible).toBe(false);
      }
      aircraft.setElapsed(24);
      expect(plane.visible).toBe(true);
      expect(trails.visible).toBe(true);
      const before = plane.position.clone();
      aircraft.setElapsed(25);
      expect(plane.position.distanceTo(before)).toBeGreaterThan(2.5);
      expect(plane.position.distanceTo(before)).toBeLessThan(3.5);
      expect(plane.position.y).toBe(before.y);
      late.setElapsed(25);
      expect(parts(late).plane.position.toArray()).toEqual(plane.position.toArray());
      expect(parts(late).trails.geometry.getAttribute("position").array)
        .toEqual(trails.geometry.getAttribute("position").array);
      aircraft.setElapsed(66);
      const second = plane.position.clone();
      aircraft.setElapsed(67);
      expect(plane.position.x).toBeLessThan(second.x);
      expect(plane.material.opacity).toBe(1);
    } finally { aircraft.dispose(); late.dispose(); }
  });

  it("shows the airplane silhouette in standard portrait and landscape follow cameras and follows translations", () => {
    const aircraft = new SkyAircraft();
    const scene = new THREE.Scene();
    scene.add(aircraft.object);
    try {
      aircraft.setElapsed(26);
      const { plane } = parts(aircraft);
      for (const aspect of [360 / 780, 1920 / 1080]) {
        const camera = new THREE.PerspectiveCamera(75, aspect, 0.1, 200);
        camera.position.set(0, 1.1 + CAMERA_FOLLOW_HEIGHT + Math.sin(CAMERA_REST_PITCH) * CAMERA_FOLLOW_DISTANCE,
          Math.cos(CAMERA_REST_PITCH) * CAMERA_FOLLOW_DISTANCE);
        camera.lookAt(0, CAMERA_LOOK_AT_HEIGHT, 0);
        center(aircraft, scene, camera);
        const projection = plane.getWorldPosition(new THREE.Vector3()).project(camera);
        expect(Math.abs(projection.x)).toBeLessThan(0.8);
        expect(projection.y).toBeGreaterThan(0.65);
        expect(projection.y).toBeLessThan(0.99);
        expect(projection.z).toBeGreaterThan(-1);
        expect(projection.z).toBeLessThan(1);
        const positions = plane.geometry.getAttribute("position");
        let front = -Infinity;
        let back = Infinity;
        let span = 0;
        for (let i = 0; i < positions.count; i += 1) {
          front = Math.max(front, positions.getX(i));
          back = Math.min(back, positions.getX(i));
          span = Math.max(span, Math.abs(positions.getZ(i)));
          const vertex = new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(plane.matrixWorld).project(camera);
          expect(Math.abs(vertex.x)).toBeLessThan(1);
          expect(vertex.y).toBeLessThan(1);
        }
        expect(front - back).toBeGreaterThan(3);
        expect(span).toBeGreaterThan(2);
        camera.position.add(new THREE.Vector3(14, 5, -11));
        camera.updateMatrixWorld(true);
        center(aircraft, scene, camera);
        const translated = plane.getWorldPosition(new THREE.Vector3()).project(camera);
        expect(translated.distanceTo(projection)).toBeLessThan(1e-12);
        const direction = plane.position.clone();
        camera.rotateY(Math.PI / 2);
        center(aircraft, scene, camera);
        expect(plane.position.equals(direction)).toBe(true);
      }
    } finally { aircraft.dispose(); }
  });

  it("puts both fading trails behind the engines in either flight direction and leaves a short trace after departure", () => {
    const aircraft = new SkyAircraft();
    try {
      const { plane, trails } = parts(aircraft);
      for (const elapsed of [26, 68]) {
        aircraft.setElapsed(elapsed);
        const heading = new THREE.Vector3(1, 0, 0).applyEuler(plane.rotation);
        const positions = trails.geometry.getAttribute("position");
        const ages = trails.geometry.getAttribute("ageFade");
        const firstStream = new THREE.Vector3().fromBufferAttribute(positions, 0);
        const secondStream = new THREE.Vector3().fromBufferAttribute(positions, 18);
        expect(firstStream.distanceTo(secondStream)).toBeCloseTo(1.4, 4);
        for (let i = 0; i < positions.count; i += 1) {
          const relative = new THREE.Vector3().fromBufferAttribute(positions, i).sub(plane.position);
          expect(relative.dot(heading)).toBeLessThan(-0.49);
          expect(ages.getX(i)).toBeGreaterThanOrEqual(0);
          expect(ages.getX(i)).toBeLessThanOrEqual(1);
        }
        expect(ages.getX(0)).toBe(1);
        expect(ages.getX(16)).toBe(0);
      }
      aircraft.setElapsed(39);
      expect(plane.visible).toBe(false);
      expect(trails.visible).toBe(true);
      const earlyFade = trails.geometry.getAttribute("ageFade").getX(0);
      aircraft.setElapsed(44);
      expect(trails.geometry.getAttribute("ageFade").getX(0)).toBeLessThan(earlyFade);
      aircraft.setElapsed(45);
      expect(trails.visible).toBe(false);
      expect(trails.material.side).toBe(THREE.DoubleSide);
      expect(trails.material.forceSinglePass).toBe(true);
      expect(trails.material.fragmentShader).toContain("opacity * vFade * edge");
    } finally { aircraft.dispose(); }
  });

  it("keeps soft trail ribbons visibly wide in pixels at the low follow-camera sky angle", () => {
    const aircraft = new SkyAircraft();
    const scene = new THREE.Scene();
    scene.add(aircraft.object);
    try {
      const { trails } = parts(aircraft);
      expect(trails.material.vertexShader).toContain("cross(tangent, viewPosition.xyz)");
      expect(trails.material.vertexShader).toContain("viewPosition.xyz += side * ribbonOffset");
      for (const [width, height] of [[360, 780], [1280, 720]]) {
        const camera = new THREE.PerspectiveCamera(75, width! / height!, 0.1, 200);
        camera.position.set(0, 1.1 + CAMERA_FOLLOW_HEIGHT + Math.sin(CAMERA_REST_PITCH) * CAMERA_FOLLOW_DISTANCE,
          Math.cos(CAMERA_REST_PITCH) * CAMERA_FOLLOW_DISTANCE);
        camera.lookAt(0, CAMERA_LOOK_AT_HEIGHT, 0);
        for (const elapsed of [26, 68]) {
          aircraft.setElapsed(elapsed);
          center(aircraft, scene, camera);
          const modelView = new THREE.Matrix4().multiplyMatrices(camera.matrixWorldInverse, trails.matrixWorld);
          const positions = trails.geometry.getAttribute("position");
          const offsets = trails.geometry.getAttribute("ribbonOffset");
          const heading = (trails.material.uniforms.heading!.value as THREE.Vector3).clone().transformDirection(modelView);
          // Project the vertices after the same camera-facing displacement as
          // the vertex shader. Flat XZ ribbon projection fails this assertion.
          const project = (index: number): THREE.Vector3 => {
            const vertex = new THREE.Vector3().fromBufferAttribute(positions, index).applyMatrix4(modelView);
            const side = new THREE.Vector3().crossVectors(heading, vertex).normalize();
            return vertex.addScaledVector(side, offsets.getX(index)).applyMatrix4(camera.projectionMatrix);
          };
          for (const stream of [0, 18]) {
            for (const segment of [0, 4, 8]) {
              const first = project(stream + segment * 2);
              const second = project(stream + segment * 2 + 1);
              const pixelWidth = Math.hypot((first.x - second.x) * width! / 2, (first.y - second.y) * height! / 2);
              expect(pixelWidth).toBeGreaterThan(1.3);
              expect(pixelWidth).toBeLessThan(6);
            }
          }
          const frontCenter = new THREE.Vector3().fromBufferAttribute(positions, 0).applyMatrix4(trails.matrixWorld).project(camera);
          const backCenter = new THREE.Vector3().fromBufferAttribute(positions, 16).applyMatrix4(trails.matrixWorld).project(camera);
          expect(Math.abs(frontCenter.x - backCenter.x) * width! / 2).toBeGreaterThan(70);
        }
      }
    } finally { aircraft.dispose(); }
  });

  it("fades with sunset and hides all aircraft and trail output for night, skipped frames and resets", () => {
    const aircraft = new SkyAircraft();
    try {
      const { plane, trails } = parts(aircraft);
      aircraft.setElapsed(75);
      const day = trails.material.uniforms.opacity!.value as number;
      aircraft.setElapsed(79);
      expect(trails.material.uniforms.opacity!.value).toBeGreaterThan(0);
      expect(trails.material.uniforms.opacity!.value).toBeLessThan(day);
      for (const elapsed of [90, 91, 119, 120, 180, 500]) {
        aircraft.setElapsed(26);
        aircraft.setElapsed(elapsed);
        expect(plane.visible).toBe(false);
        expect(plane.material.opacity).toBe(0);
        expect(trails.visible).toBe(false);
        expect(trails.material.uniforms.opacity!.value).toBe(0);
      }
      for (const elapsed of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0]) {
        aircraft.setElapsed(26);
        aircraft.setElapsed(elapsed);
        expect(plane.visible).toBe(false);
        expect(trails.visible).toBe(false);
      }
      aircraft.setElapsed(26);
      aircraft.reset();
      expect(plane.visible).toBe(false);
      expect(trails.visible).toBe(false);
      aircraft.setElapsed(26);
      expect(plane.visible).toBe(true);
    } finally { aircraft.dispose(); }
  });

  it("reuses two meshes without lights, shadows or textures and disposes all four resources once", () => {
    const aircraft = new SkyAircraft();
    const { plane, trails } = parts(aircraft);
    const resources = [plane.geometry, plane.material, trails.geometry, trails.material];
    const disposals = resources.map((resource) => vi.spyOn(resource, "dispose"));
    const position = trails.geometry.getAttribute("position");
    for (let round = 0; round < 40; round += 1) {
      for (const elapsed of [0, 26, 39, 45, 68, 85, 90, 180]) aircraft.setElapsed(elapsed);
      expect(aircraft.object.children).toEqual([plane, trails]);
      expect(trails.geometry.getAttribute("position")).toBe(position);
    }
    for (const mesh of [plane, trails]) {
      expect(mesh.castShadow).toBe(false);
      expect(mesh.receiveShadow).toBe(false);
      expect(mesh.material.fog).toBe(false);
      expect(mesh.material.depthWrite).toBe(false);
    }
    expect(plane.material.map).toBeNull();
    expect(plane.geometry.getAttribute("position").count / 3).toBeLessThan(400);
    expect(trails.geometry.index!.count / 3).toBe(32);
    aircraft.dispose();
    aircraft.dispose();
    aircraft.setElapsed(26);
    expect(aircraft.object.children).toHaveLength(0);
    expect(plane.visible).toBe(false);
    disposals.forEach((spy) => expect(spy).toHaveBeenCalledOnce());
  });
});
