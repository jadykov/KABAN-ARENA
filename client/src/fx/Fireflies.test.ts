import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { ARENA_HALF_SIZE, FIREFLY_COUNT } from "../config";
import {
  FIREFLY_BASES,
  FIREFLY_BLINK,
  FIREFLY_BLINK_GROW,
  FIREFLY_OPACITY,
  FIREFLY_QUAD_SIZE,
  FIREFLY_WANDER,
  Fireflies,
} from "./Fireflies";

function createSwarm(): { scene: THREE.Scene; camera: THREE.PerspectiveCamera; swarm: Fireflies } {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 200);
  const swarm = new Fireflies(scene);
  return { scene, camera, swarm };
}

const BLINK_INDEXES = FIREFLY_BLINK.map((capable, index) => (capable === true ? index : -1)).filter(
  (index) => index >= 0,
);

describe("Fireflies ambient swarm (4d.3 feedback: 6, dimmed, blink, wander/hover)", () => {
  it("holds 6 quads in ONE InstancedMesh and disposes cleanly", () => {
    expect(FIREFLY_COUNT).toBe(6);
    const { scene, swarm } = createSwarm();
    try {
      expect(swarm.object).toBeInstanceOf(THREE.InstancedMesh);
      expect(swarm.object.count).toBe(FIREFLY_COUNT);
      expect(swarm.object.geometry instanceof THREE.PlaneGeometry).toBe(true);
      expect(scene.children).toContain(swarm.object);
    } finally {
      swarm.dispose();
    }
    expect(scene.children).not.toContain(swarm.object);
  });

  it("dims the base glow -50% (shared material opacity 0.45)", () => {
    expect(FIREFLY_OPACITY).toBe(0.45);
    const { swarm } = createSwarm();
    try {
      const material = swarm.object.material as THREE.MeshBasicMaterial;
      expect(material.opacity).toBeCloseTo(FIREFLY_OPACITY, 10);
      expect(material.color.getHex()).toBe(0xb8e04a);
    } finally {
      swarm.dispose();
    }
  });

  it("arms a blink subset strictly smaller than the swarm (never all at once)", () => {
    // Indices 0/2/4 only: half the swarm, staggered 8/10/12s periods.
    expect(BLINK_INDEXES).toEqual([0, 2, 4]);
    expect(BLINK_INDEXES.length).toBeGreaterThan(0);
    expect(BLINK_INDEXES.length).toBeLessThan(FIREFLY_COUNT);
    expect(FIREFLY_BLINK_GROW).toBeGreaterThan(0);
  });

  it("ships both behavior classes (wander + hover)", () => {
    const wanderers = FIREFLY_WANDER.filter((wander) => wander === true);
    const hoverers = FIREFLY_WANDER.filter((wander) => wander === false);
    expect(wanderers.length).toBeGreaterThan(0);
    expect(hoverers.length).toBeGreaterThan(0);
    expect(wanderers.length + hoverers.length).toBe(FIREFLY_COUNT);
  });

  it("blinks subset-only with at most one concurrent pulse over a long sim", () => {
    const { camera, swarm } = createSwarm();
    const mesh = swarm.object;
    try {
      const matrix = new THREE.Matrix4();
      const position = new THREE.Vector3();
      const quaternion = new THREE.Quaternion();
      const scale = new THREE.Vector3();
      const blinked = new Array<boolean>(FIREFLY_COUNT).fill(false);
      // 130s at 50Hz: every blink period (8/10/12s) fires many times.
      for (let step = 0; step < 6500; step += 1) {
        swarm.update(0.02, camera);
        let concurrent = 0;
        for (let i = 0; i < FIREFLY_COUNT; i += 1) {
          mesh.getMatrixAt(i, matrix);
          matrix.decompose(position, quaternion, scale);
          expect(Number.isFinite(position.x)).toBe(true);
          const blinking = scale.x > FIREFLY_QUAD_SIZE * 1.05;
          if (blinking) {
            concurrent += 1;
            blinked[i] = true;
          }
        }
        // First-active-wins cap: never two pulses in the same frame.
        expect(concurrent).toBeLessThanOrEqual(1);
      }
      // Every armed index pulsed at least once; unarmed ones never did.
      for (let i = 0; i < FIREFLY_COUNT; i += 1) {
        if (BLINK_INDEXES.includes(i)) {
          expect(blinked[i]).toBe(true);
        } else {
          expect(blinked[i]).toBe(false);
        }
      }
    } finally {
      swarm.dispose();
    }
  });

  it("wanders travel while hoverers stay home (displacement bounds)", () => {
    const { camera, swarm } = createSwarm();
    const mesh = swarm.object;
    try {
      const matrix = new THREE.Matrix4();
      const position = new THREE.Vector3();
      const quaternion = new THREE.Quaternion();
      const scale = new THREE.Vector3();
      // Seed matrices once (update needs dt > 0 to write).
      swarm.update(0.0001, camera);
      const maxDrift = new Float32Array(FIREFLY_COUNT);
      for (let step = 0; step < 6500; step += 1) {
        swarm.update(0.02, camera);
        for (let i = 0; i < FIREFLY_COUNT; i += 1) {
          mesh.getMatrixAt(i, matrix);
          matrix.decompose(position, quaternion, scale);
          // Displacement from the HOME base (not the first sample: hover
          // amplitude 0.4/axis reads up to ~0.57 from home, wanderers roam
          // 2.2/1.8 — clean separation, no overlap).
          const home = FIREFLY_BASES[i % FIREFLY_BASES.length] ?? [0, 0, 0];
          const drift = Math.hypot(position.x - home[0], position.z - home[2]);
          if (drift > (maxDrift[i] ?? 0)) {
            maxDrift[i] = drift;
          }
          // Always inside the arena, always above head height.
          expect(Math.abs(position.x)).toBeLessThan(ARENA_HALF_SIZE);
          expect(Math.abs(position.z)).toBeLessThan(ARENA_HALF_SIZE);
          expect(position.y).toBeGreaterThan(2.0);
          expect(position.y).toBeLessThan(3.7);
        }
      }
      for (let i = 0; i < FIREFLY_COUNT; i += 1) {
        if (FIREFLY_WANDER[i] === true) {
          expect(maxDrift[i] ?? 0).toBeGreaterThan(1.5);
        } else {
          expect(maxDrift[i] ?? 99).toBeLessThan(0.6);
        }
      }
    } finally {
      swarm.dispose();
    }
  });

  it("reuses instance buffers across updates (structural zero-alloc check)", () => {
    const { camera, swarm } = createSwarm();
    try {
      const mesh = swarm.object;
      const attribute = mesh.instanceMatrix;
      const array = attribute.array;
      const geometry = mesh.geometry;
      const material = mesh.material;
      for (let i = 0; i < 100; i += 1) {
        swarm.update(1 / 60, camera);
      }
      // Same attribute object, same backing buffer, same geo/mat: the hot
      // loop never reallocates instance storage (scalar math + scratch only).
      expect(mesh.instanceMatrix).toBe(attribute);
      expect(mesh.instanceMatrix.array).toBe(array);
      expect(mesh.geometry).toBe(geometry);
      expect(mesh.material).toBe(material);
    } finally {
      swarm.dispose();
    }
  });
});
