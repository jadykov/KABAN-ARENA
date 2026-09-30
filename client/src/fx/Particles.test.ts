import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  HIT_FLASH_DURATION_S,
  PARTICLE_LIFETIME_S,
  PARTICLE_POOL_SIZE,
  SHAKE_MAX_OFFSET,
} from "../config";
import { CameraShake, HitFlash } from "./CameraShake";
import { ParticlePool } from "./Particles";

describe("ParticlePool fixed pool (QD4-A)", () => {
  it("starts empty and spawns bursts", () => {
    const pool = new ParticlePool(16);
    try {
      expect(pool.aliveCount).toBe(0);
      pool.spawn(0, 1, 0, 5, new THREE.Color(0xff5533));
      expect(pool.aliveCount).toBe(5);
    } finally {
      pool.dispose();
    }
  });

  it("reuses slots ring-buffer style and never grows past capacity", () => {
    const pool = new ParticlePool(16);
    try {
      pool.spawn(0, 1, 0, 10, new THREE.Color(0xff5533));
      pool.spawn(1, 1, 1, 10, new THREE.Color(0x22eeff));
      pool.spawn(2, 1, 2, 10, new THREE.Color(0x44ff66));
      expect(pool.aliveCount).toBeLessThanOrEqual(16);
      expect(pool.aliveCount).toBeGreaterThan(0);
      pool.update(1 / 60);
      expect(pool.aliveCount).toBeLessThanOrEqual(16);
    } finally {
      pool.dispose();
    }
  });

  it("expires particles after the pooled lifetime", () => {
    const pool = new ParticlePool(8);
    try {
      expect(PARTICLE_POOL_SIZE).toBe(128);
      pool.spawn(0, 1, 0, 8, new THREE.Color(0xff5533));
      expect(pool.aliveCount).toBe(8);
      pool.update(PARTICLE_LIFETIME_S + 0.1);
      expect(pool.aliveCount).toBe(0);
    } finally {
      pool.dispose();
    }
  });

  it("ignores non-positive deltas and clears on demand", () => {
    const pool = new ParticlePool(8);
    try {
      pool.spawn(0, 1, 0, 4, new THREE.Color(0xff5533));
      pool.update(0);
      pool.update(-1);
      expect(pool.aliveCount).toBe(4);
      pool.clear();
      expect(pool.aliveCount).toBe(0);
    } finally {
      pool.dispose();
    }
  });

  it("skips uploads and rendering while idle, then restores bursts after expiry and clear", () => {
    const pool = new ParticlePool(4);
    const positions = pool.object.geometry.getAttribute("position") as THREE.BufferAttribute;
    try {
      const initialVersion = positions.version;
      expect(pool.object.visible).toBe(false);
      for (let i = 0; i < 120; i += 1) pool.update(1 / 60);
      pool.clear();
      expect(positions.version).toBe(initialVersion);
      pool.spawn(4, 1, 0, 2, new THREE.Color(0xff5533), 0, 0, 0.1);
      pool.spawn(5, 1, 0, 2, new THREE.Color(0x22eeff), 0, 0, 1);
      // Overwrite one live ring slot; it must remain one inventory entry.
      pool.spawn(6, 1, 0, 1, new THREE.Color(0x44ff66), 0, 0, 2);
      expect(pool.aliveCount).toBe(4);
      expect(pool.object.visible).toBe(true);
      pool.update(0.2);
      expect(pool.aliveCount).toBe(3);
      pool.update(0.9);
      expect(pool.aliveCount).toBe(1);
      expect(positions.getX(0)).toBe(6);
      pool.update(1);
      expect(pool.aliveCount).toBe(0);
      expect(pool.object.visible).toBe(false);
      const expiredVersion = positions.version;
      pool.update(10);
      expect(positions.version).toBe(expiredVersion);
      pool.spawn(7, 2, 0, 2, new THREE.Color(0xff5533));
      pool.clear();
      pool.spawn(8, 2, 0, 1, new THREE.Color(0xff5533));
      expect(pool.aliveCount).toBe(1);
      expect(pool.object.visible).toBe(true);
      expect(positions.getX(0)).toBe(8);
      pool.update(Number.NaN);
      expect(pool.aliveCount).toBe(1);
      expect(Number.isFinite(positions.getY(0))).toBe(true);
    } finally {
      pool.dispose();
    }
  });
});

describe("CameraShake light trauma shake (QD4-A)", () => {
  it("rests at zero and stays inside the max offset", () => {
    const shake = new CameraShake();
    expect(shake.update(1 / 60)).toEqual({ x: 0, y: 0, z: 0 });
    shake.add(0.5);
    const offset = shake.update(1 / 60);
    expect(Math.abs(offset.x)).toBeLessThanOrEqual(SHAKE_MAX_OFFSET);
    expect(Math.abs(offset.y)).toBeLessThanOrEqual(SHAKE_MAX_OFFSET);
    expect(Math.abs(offset.z)).toBeLessThanOrEqual(SHAKE_MAX_OFFSET);
    expect(offset).not.toEqual({ x: 0, y: 0, z: 0 });
  });

  it("integrates the real frame delta (no fixed step)", () => {
    // One 0.1s step must equal one hundred 0.001s steps — a hardcoded
    // 1/60 inside the scene would break this equality.
    const single = new CameraShake();
    single.add(1);
    const oneShot = single.update(0.1);
    const stepped = new CameraShake();
    stepped.add(1);
    let incremental = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 100; i += 1) {
      incremental = stepped.update(0.001);
    }
    expect(incremental.x).toBeCloseTo(oneShot.x, 10);
    expect(incremental.y).toBeCloseTo(oneShot.y, 10);
    expect(incremental.z).toBeCloseTo(oneShot.z, 10);
  });

  it("decays to zero and resets", () => {
    const shake = new CameraShake();
    shake.add(1);
    const rested = shake.update(10);
    // Exact zeros are not guaranteed (signed -0 from trig * 0 strength),
    // so assert vanishing magnitude instead of structural equality.
    expect(Math.abs(rested.x)).toBeLessThan(1e-12);
    expect(Math.abs(rested.y)).toBeLessThan(1e-12);
    expect(Math.abs(rested.z)).toBeLessThan(1e-12);
    shake.add(1);
    shake.reset();
    const cleared = shake.update(1 / 60);
    expect(Math.abs(cleared.x)).toBeLessThan(1e-12);
    expect(Math.abs(cleared.y)).toBeLessThan(1e-12);
    expect(Math.abs(cleared.z)).toBeLessThan(1e-12);
  });
});

describe("HitFlash avatar flash (QD4-A)", () => {
  it("spikes then fades over the flash duration", () => {
    const flash = new HitFlash();
    const material = { emissiveIntensity: 0 };
    expect(flash.update(1 / 60, material)).toBe(false);
    flash.trigger();
    expect(flash.update(0, material)).toBe(true);
    expect(material.emissiveIntensity).toBeCloseTo(2.5);
    expect(flash.update(HIT_FLASH_DURATION_S, material)).toBe(false);
    expect(material.emissiveIntensity).toBe(0);
    flash.reset();
  });
});
