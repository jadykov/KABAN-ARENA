import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { ARENA_HALF_SIZE, FIREFLY_COUNT } from "../config";
import { ACCENT_SPARK, HL_CHARTREUSE, NEUTRAL_WHITE } from "../palette";
import {
  FIREFLY_BASES,
  FIREFLY_BLINK,
  FIREFLY_BLINK_GROW,
  FIREFLY_COLORS,
  FIREFLY_OPACITY,
  FIREFLY_QUAD_SIZE,
  FIREFLY_TEXTURE_SIZE,
  FIREFLY_TWINKLE,
  FIREFLY_TWINKLE_GROW,
  FIREFLY_WANDER,
  fireflyStarAlpha,
  Fireflies,
} from "./Fireflies";

function createSwarm(): { scene: THREE.Scene; camera: THREE.PerspectiveCamera; swarm: Fireflies } {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 200);
  const swarm = new Fireflies(scene);
  return { scene, camera, swarm };
}

const TWINKLE_INDEXES = FIREFLY_TWINKLE.map((capable, index) => (capable === true ? index : -1)).filter(
  (index) => index >= 0,
);

function instanceHex(mesh: THREE.InstancedMesh, index: number): number {
  const color = new THREE.Color();
  mesh.getColorAt(index, color);
  return color.getHex();
}

describe("Fireflies star swarm (visual round: tiny 4-point twinkles, starry colors)", () => {
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

  it("shrinks quads to star size (0.24) on a shared 64px texture", () => {
    // Visual round: 0.35 -> 0.24 so the points read as distant stars, never
    // covering fighters. Texture stays one shared 64px procedural canvas
    // (far below the 256px cap, no asset files).
    expect(FIREFLY_QUAD_SIZE).toBe(0.24);
    expect(FIREFLY_TEXTURE_SIZE).toBe(64);
    expect(FIREFLY_TEXTURE_SIZE).toBeLessThanOrEqual(256);
  });

  it("dims the base glow -50% (shared material opacity 0.45, white base)", () => {
    expect(FIREFLY_OPACITY).toBe(0.45);
    const { swarm } = createSwarm();
    try {
      const material = swarm.object.material as THREE.MeshBasicMaterial;
      expect(material.opacity).toBeCloseTo(FIREFLY_OPACITY, 10);
      // White base color: the tint comes from per-instance colors, multiplied
      // with the white star texture.
      expect(material.color.getHex()).toBe(NEUTRAL_WHITE);
      expect(material.blending).toBe(THREE.AdditiveBlending);
      expect(material.depthWrite).toBe(false);
      expect(material.fog).toBe(false);
    } finally {
      swarm.dispose();
    }
  });

  it("tints per-instance star colors: 3 chartreuse twinklers + pale starlight", () => {
    // The swarm reads "starry" rather than "all green": twinkling indices
    // keep the chartreuse highlight, the rest are pale starlight.
    expect(FIREFLY_COLORS).toHaveLength(FIREFLY_COUNT);
    expect(FIREFLY_COLORS).toEqual([
      HL_CHARTREUSE,
      ACCENT_SPARK,
      HL_CHARTREUSE,
      ACCENT_SPARK,
      HL_CHARTREUSE,
      NEUTRAL_WHITE,
    ]);
    const { swarm } = createSwarm();
    try {
      const mesh = swarm.object;
      expect(mesh.instanceColor).not.toBe(null);
      for (let i = 0; i < FIREFLY_COUNT; i += 1) {
        expect(instanceHex(mesh, i)).toBe(FIREFLY_COLORS[i % FIREFLY_COLORS.length]);
      }
      const chartreuse = FIREFLY_COLORS.filter((color) => color === HL_CHARTREUSE);
      expect(chartreuse).toHaveLength(3);
    } finally {
      swarm.dispose();
    }
  });

  it("keeps the historic BLINK names as twinkle aliases (no renamed imports break)", () => {
    expect(FIREFLY_BLINK).toBe(FIREFLY_TWINKLE);
    expect(FIREFLY_BLINK_GROW).toBe(FIREFLY_TWINKLE_GROW);
    expect(FIREFLY_TWINKLE_GROW).toBeGreaterThan(0);
  });

  it("arms a twinkle subset strictly smaller than the swarm (never all at once)", () => {
    // Indices 0/2/4 only: half the swarm, staggered 8/10/12s periods.
    expect(TWINKLE_INDEXES).toEqual([0, 2, 4]);
    expect(TWINKLE_INDEXES.length).toBeGreaterThan(0);
    expect(TWINKLE_INDEXES.length).toBeLessThan(FIREFLY_COUNT);
    expect(FIREFLY_TWINKLE_GROW).toBeGreaterThan(0);
  });

  it("shapes a 4-point star: bright center, arms brighter than diagonals, dark corners", () => {
    // Unit pins on the shared falloff (u/v span [-1, 1] across the quad).
    expect(fireflyStarAlpha(0, 0)).toBe(1);
    expect(fireflyStarAlpha(1, 0)).toBe(0);
    expect(fireflyStarAlpha(1, 1)).toBe(0);
    const arm = fireflyStarAlpha(0.5, 0);
    const diagonal = fireflyStarAlpha(0.5, 0.5);
    expect(arm).toBeGreaterThan(0.3);
    expect(diagonal).toBeLessThan(0.1);
    expect(arm).toBeGreaterThan(diagonal * 3);
    // Symmetry: horizontal and vertical arms match.
    expect(fireflyStarAlpha(0.5, 0)).toBeCloseTo(fireflyStarAlpha(0, 0.5), 10);
    expect(fireflyStarAlpha(0.5, 0.5)).toBeCloseTo(fireflyStarAlpha(-0.5, 0.5), 10);
  });

  it("headless texture carries the star cross (white core, dark corners)", () => {
    const { swarm } = createSwarm();
    try {
      const material = swarm.object.material as THREE.MeshBasicMaterial;
      const texture = material.map;
      // Browser CanvasTexture path exposes no texel buffer — the unit pins
      // above cover it; headless DataTexture path pins the cross here.
      const image = (texture as unknown as { image?: { data?: unknown; width?: unknown } } | null)?.image;
      const data = image?.data;
      if (!(data instanceof Uint8Array)) {
        expect(swarm.object).toBeDefined();
        return;
      }
      const size = 16;
      expect(data.length).toBe(size * size * 4);
      const alphaAt = (x: number, y: number): number => data[(y * size + x) * 4 + 3] ?? 0;
      const redAt = (x: number, y: number): number => data[(y * size + x) * 4] ?? 0;
      // Star is white: RGB 255 everywhere.
      expect(redAt(7, 7)).toBe(0xff);
      expect(redAt(0, 0)).toBe(0xff);
      // Bright core, dark corners.
      expect(alphaAt(7, 7)).toBe(255);
      expect(alphaAt(0, 0)).toBeLessThan(30);
      expect(alphaAt(15, 15)).toBeLessThan(30);
      // Cross arm (mid-right, near the horizontal arm) beats the diagonal.
      const armAlpha = alphaAt(11, 7);
      const diagonalAlpha = alphaAt(11, 11);
      expect(armAlpha).toBeGreaterThan(60);
      expect(diagonalAlpha).toBeLessThan(40);
      expect(armAlpha).toBeGreaterThan(diagonalAlpha * 2);
    } finally {
      swarm.dispose();
    }
  });

  it("ships both behavior classes (wander + hover)", () => {
    const wanderers = FIREFLY_WANDER.filter((wander) => wander === true);
    const hoverers = FIREFLY_WANDER.filter((wander) => wander === false);
    expect(wanderers.length).toBeGreaterThan(0);
    expect(hoverers.length).toBeGreaterThan(0);
    expect(wanderers.length + hoverers.length).toBe(FIREFLY_COUNT);
  });

  it("twinkles subset-only with at most one concurrent pulse over a long sim", () => {
    const { camera, swarm } = createSwarm();
    const mesh = swarm.object;
    try {
      const matrix = new THREE.Matrix4();
      const position = new THREE.Vector3();
      const quaternion = new THREE.Quaternion();
      const scale = new THREE.Vector3();
      const twinkled = new Array<boolean>(FIREFLY_COUNT).fill(false);
      // 130s at 50Hz: every twinkle period (8/10/12s) fires many times.
      for (let step = 0; step < 6500; step += 1) {
        swarm.update(0.02, camera);
        let concurrent = 0;
        for (let i = 0; i < FIREFLY_COUNT; i += 1) {
          mesh.getMatrixAt(i, matrix);
          matrix.decompose(position, quaternion, scale);
          expect(Number.isFinite(position.x)).toBe(true);
          const twinkling = scale.x > FIREFLY_QUAD_SIZE * 1.05;
          if (twinkling) {
            concurrent += 1;
            twinkled[i] = true;
          }
        }
        // First-active-wins cap: never two pulses in the same frame.
        expect(concurrent).toBeLessThanOrEqual(1);
      }
      // Every armed index pulsed at least once; unarmed ones never did.
      for (let i = 0; i < FIREFLY_COUNT; i += 1) {
        if (TWINKLE_INDEXES.includes(i)) {
          expect(twinkled[i]).toBe(true);
        } else {
          expect(twinkled[i]).toBe(false);
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
      const colors = mesh.instanceColor;
      const geometry = mesh.geometry;
      const material = mesh.material;
      for (let i = 0; i < 100; i += 1) {
        swarm.update(1 / 60, camera);
      }
      // Same attribute object, same backing buffer, same geo/mat: the hot
      // loop never reallocates instance storage (scalar math + scratch only).
      expect(mesh.instanceMatrix).toBe(attribute);
      expect(mesh.instanceMatrix.array).toBe(array);
      expect(mesh.instanceColor).toBe(colors);
      expect(mesh.geometry).toBe(geometry);
      expect(mesh.material).toBe(material);
    } finally {
      swarm.dispose();
    }
  });
});
