import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { BADGE_SECONDS, PowerEffectVisuals } from "./PowerEffectVisuals";

describe("power effect visuals", () => {
  it("loads all badge textures on construction and uploads successful assets before the first pickup", async () => {
    const requests: Array<{ texture: THREE.Texture; loaded?: (texture: THREE.Texture) => void;
      error?: (event: unknown) => void }> = [];
    const load = vi.spyOn(THREE.TextureLoader.prototype, "load").mockImplementation((_url, loaded, _progress, error) => {
      const texture = new THREE.Texture();
      requests.push({ texture, loaded, error });
      return texture;
    });
    vi.stubGlobal("document", { createElementNS: () => ({}) });
    const rig = new THREE.Group();
    const effects = new PowerEffectVisuals(rig);
    const initTexture = vi.fn();
    try {
      expect(load.mock.calls.map(([url]) => url)).toEqual([
        "/icons/bonus-shield.svg", "/icons/bonus-speed.svg", "/icons/bonus-charge.svg",
      ]);
      const preparing = effects.prepareTextures({ initTexture });
      expect(initTexture).not.toHaveBeenCalled();
      for (const request of [requests[0]!, requests[2]!]) {
        request.texture.image = { width: 64, height: 64 };
        request.loaded?.(request.texture);
      }
      requests[1]!.error?.(new Error("failed icon"));
      await preparing;
      expect(initTexture.mock.calls.map(([texture]) => texture))
        .toEqual([requests[0]!.texture, requests[2]!.texture]);
      const badge = rig.getObjectByName("bonus-badge") as THREE.Sprite;
      const version = badge.material.version;
      effects.showPickup("shield");
      effects.showPickup("charge");
      expect(badge.material.map).toBe(requests[2]!.texture);
      expect(badge.material.version).toBe(version);
      expect(load).toHaveBeenCalledTimes(3);
      effects.update(1.49);
      expect(badge.visible).toBe(true);
      effects.update(0.01);
      expect(badge.visible).toBe(false);
    } finally {
      effects.dispose();
      load.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("bounds a stalled icon wait, uploads late assets and cancels preparation on disposal", async () => {
    vi.useFakeTimers();
    const requests: Array<{ texture: THREE.Texture; loaded?: (texture: THREE.Texture) => void }> = [];
    const load = vi.spyOn(THREE.TextureLoader.prototype, "load").mockImplementation((_url, loaded) => {
      const texture = new THREE.Texture();
      requests.push({ texture, loaded });
      return texture;
    });
    vi.stubGlobal("document", { createElementNS: () => ({}) });
    const effects = new PowerEffectVisuals(new THREE.Group());
    const initTexture = vi.fn();
    try {
      const preparing = effects.prepareTextures({ initTexture });
      requests[0]!.texture.image = { width: 64, height: 64 };
      requests[0]!.loaded?.(requests[0]!.texture);
      await vi.advanceTimersByTimeAsync(0);
      expect(initTexture).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1500);
      await preparing;
      expect(initTexture).toHaveBeenCalledTimes(1);
      for (const request of requests.slice(1)) {
        request.texture.image = { width: 64, height: 64 };
        request.loaded?.(request.texture);
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(initTexture).toHaveBeenCalledTimes(3);
      effects.dispose();
      const cancelled = new PowerEffectVisuals(new THREE.Group());
      const pending = cancelled.prepareTextures({ initTexture });
      const pendingTextures = requests.slice(3).map((request) => vi.spyOn(request.texture, "dispose"));
      cancelled.dispose();
      await pending;
      for (const request of requests.slice(3)) {
        request.texture.image = { width: 64, height: 64 };
        request.loaded?.(request.texture);
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(initTexture).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(0);
      for (const disposed of pendingTextures) expect(disposed).toHaveBeenCalledOnce();
    } finally {
      effects.dispose();
      load.mockRestore();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
  it("keeps the shield animated and shows speed wind only for an active running buff", () => {
    const rig = new THREE.Group();
    const effects = new PowerEffectVisuals(rig);
    try {
      const shield = rig.getObjectByName("bonus-shield");
      const wind = rig.getObjectByName("run-wind-trail");
      expect(shield?.visible).toBe(false);
      expect(wind?.visible).toBe(false);
      effects.setActive(true, true);
      effects.update(0.25);
      expect(shield?.visible).toBe(true);
      expect(wind?.visible).toBe(false);
      expect(shield?.scale.x).toBeGreaterThan(1);
      effects.setRunning(0.8);
      expect(wind?.visible).toBe(true);
      effects.setActive(false, false);
      expect(shield?.visible).toBe(false);
      expect(wind?.visible).toBe(false);
    } finally {
      effects.dispose();
    }
    expect(rig.children).toHaveLength(0);
  });

  it("keeps each acquisition badge overhead for one and a half seconds", () => {
    const rig = new THREE.Group();
    const effects = new PowerEffectVisuals(rig);
    try {
      const badge = rig.children.find((child) => child instanceof THREE.Sprite);
      expect(badge?.visible).toBe(false);
      expect(badge?.scale.x).toBeCloseTo(0.36);
      expect(badge?.scale.y).toBeCloseTo(0.36);
      // The 2m-tall capsule ends at rig y=1.0; the badge stays just above
      // the head for the whole announcement instead of drifting off-screen.
      expect((badge?.position.y ?? 0) - (badge?.scale.y ?? 0) / 2).toBeGreaterThan(1);
      expect(badge?.position.y).toBeLessThan(1.8);
      // Camera look-at is rig y=1.2, so the badge's lower edge leaves the
      // crosshair clear even at the close charge zoom.
      expect((badge?.position.y ?? 0) - (badge?.scale.y ?? 0) / 2).toBeGreaterThan(1.2);
      effects.showPickup("shield");
      expect(badge?.visible).toBe(true);
      effects.update(0.5);
      expect(badge?.visible).toBe(true);
      expect(badge?.position.y).toBeCloseTo(1.55);
      effects.update(0.99);
      expect(badge?.visible).toBe(true);
      effects.update(0.01);
      expect(badge?.visible).toBe(false);
      effects.showPickup("speed");
      expect(badge?.visible).toBe(true);
      const speedMap = (badge?.material as THREE.SpriteMaterial).map;
      effects.showPickup("charge");
      expect((badge?.material as THREE.SpriteMaterial).map).not.toBe(speedMap);
      expect(BADGE_SECONDS).toBe(1.5);
    } finally {
      effects.dispose();
    }
  });

  it("hides ordinary running, idle buffs, expiration and reset immediately", () => {
    const rig = new THREE.Group();
    const effects = new PowerEffectVisuals(rig);
    try {
      const trail = rig.getObjectByName("run-wind-trail");
      effects.setRunning(1);
      effects.update(0.25);
      expect(trail?.visible).toBe(false);
      effects.setActive(false, true);
      expect(trail?.visible).toBe(true);
      effects.setRunning(0);
      expect(trail?.visible).toBe(false);
      rig.rotation.y = Math.PI / 2;
      effects.update(0.25);
      expect(trail?.visible).toBe(false);
      effects.setRunning(0.8);
      expect(trail?.visible).toBe(true);
      effects.setActive(false, false);
      expect(trail?.visible).toBe(false);
      effects.setActive(false, true);
      expect(trail?.visible).toBe(true);
      effects.reset();
      expect(trail?.visible).toBe(false);
      effects.setRunning(1);
      expect(trail?.visible).toBe(false);
      effects.setActive(false, true);
      effects.setRunning(Number.NaN);
      expect(trail?.visible).toBe(false);
      effects.setRunning(-1);
      expect(trail?.visible).toBe(false);
    } finally {
      effects.dispose();
    }
  });

  it("uses one soft curved mesh and keeps its wake behind the body through turns", () => {
    const rig = new THREE.Group();
    const effects = new PowerEffectVisuals(rig);
    try {
      const trail = rig.getObjectByName("run-wind-trail") as THREE.Mesh;
      expect(trail.visible).toBe(false);
      expect(rig.getObjectByName("bonus-speed-wind")).toBeUndefined();
      expect(rig.children.filter((child) => child instanceof THREE.LineSegments)).toHaveLength(0);
      effects.setActive(false, true);
      effects.setRunning(0.8);
      expect(trail.visible).toBe(true);
      const positions = trail.geometry.getAttribute("position");
      const colors = trail.geometry.getAttribute("color");
      expect(colors.itemSize).toBe(4);
      // The left ribbon bends outward before curling back, and alpha falls
      // from a readable center to transparent edges and a transparent tail.
      expect(positions.getX(32)).toBeLessThan(positions.getX(2));
      expect(positions.getX(62)).toBeGreaterThan(positions.getX(32));
      expect(colors.getW(30)).toBe(0);
      expect(colors.getW(32)).toBeGreaterThan(0.5);
      expect(colors.getW(34)).toBe(0);
      expect(colors.getW(62)).toBeCloseTo(0);
      expect(trail.geometry.groups).toHaveLength(0);
      expect(Array.isArray(trail.material)).toBe(false);
      expect((trail.material as THREE.MeshBasicMaterial).forceSinglePass).toBe(true);
      for (const angle of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        rig.rotation.y = angle;
        effects.update(0.25);
        rig.updateMatrixWorld(true);
        const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(rig.quaternion);
        for (let i = 0; i < positions.count; i += 1) {
          const vertex = new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(trail.matrixWorld);
          expect(vertex.dot(forward)).toBeLessThan(0);
        }
      }
      expect(trail.rotation.y).toBe(0);
      expect(trail.geometry.getAttribute("position").array).toBe(positions.array);
      expect(trail.geometry.getAttribute("color").array).toBe(colors.array);
    } finally {
      effects.dispose();
    }
  });

  it("orbits one small steady ball around the waist in idle and movement, independently of other buffs", () => {
    const rig = new THREE.Group();
    const effects = new PowerEffectVisuals(rig);
    try {
      const orb = rig.getObjectByName("bonus-charge-orb") as THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>;
      const shield = rig.getObjectByName("bonus-shield");
      const trail = rig.getObjectByName("run-wind-trail");
      const positions = orb.geometry.getAttribute("position").array;
      const intensity = orb.material.emissiveIntensity;
      expect(orb.visible).toBe(false);
      expect(orb.geometry.parameters.radius).toBeGreaterThanOrEqual(0.1);
      expect(orb.geometry.parameters.radius).toBeLessThanOrEqual(0.12);
      expect(orb.geometry.getAttribute("position").count).toBeLessThan(150);
      effects.setActive(true, true, true);
      const initial = orb.position.clone();
      effects.update(0.25);
      expect(orb.visible).toBe(true);
      expect(trail?.visible).toBe(false);
      expect(orb.position.distanceTo(initial)).toBeGreaterThan(0.2);
      // An idle ball makes a moderate turn, without moving vertically or
      // changing brightness. Running and body turns keep the same orbit.
      expect(Math.atan2(orb.position.z, orb.position.x)).toBeGreaterThan(0.3);
      expect(Math.atan2(orb.position.z, orb.position.x)).toBeLessThan(0.5);
      effects.setRunning(1);
      rig.position.set(4, 1.2, -3);
      rig.rotation.y = Math.PI / 2;
      for (let frame = 0; frame < 120; frame += 1) {
        effects.update(1 / 60);
        rig.updateMatrixWorld(true);
        expect(orb.visible).toBe(true);
        expect(orb.position.y).toBe(0);
        const distance = orb.getWorldPosition(new THREE.Vector3()).distanceTo(rig.getWorldPosition(new THREE.Vector3()));
        expect(distance).toBeGreaterThanOrEqual(0.7);
        expect(distance).toBeLessThanOrEqual(0.8);
        expect(orb.material.emissiveIntensity).toBe(intensity);
      }
      expect(shield?.visible).toBe(true);
      expect(trail?.visible).toBe(true);
      expect(orb.geometry.getAttribute("position").array).toBe(positions);
      expect(rig.children.some((child) => child instanceof THREE.Light)).toBe(false);
      // The optional third flag preserves every older two-buff caller and
      // immediately removes charge without disturbing shield or running.
      effects.setActive(true, true);
      expect(orb.visible).toBe(false);
      expect(shield?.visible).toBe(true);
      expect(trail?.visible).toBe(true);
      effects.setActive(false, false, true);
      effects.showPickup("charge");
      effects.reset();
      expect(orb.visible).toBe(false);
      expect(rig.getObjectByName("bonus-badge")?.visible).toBe(false);
      effects.setActive(false, false, true);
      expect(orb.position.y).toBe(0);
      expect(orb.position.z).toBe(0);
    } finally {
      effects.dispose();
    }
  });

  it("disposes all per-avatar geometry and materials once", () => {
    const rig = new THREE.Group();
    const effects = new PowerEffectVisuals(rig);
    const shield = rig.getObjectByName("bonus-shield") as THREE.Mesh;
    const trail = rig.getObjectByName("run-wind-trail") as THREE.Mesh;
    const orb = rig.getObjectByName("bonus-charge-orb") as THREE.Mesh;
    const badge = rig.getObjectByName("bonus-badge") as THREE.Sprite;
    const resources = [shield.geometry, shield.material as THREE.Material,
      trail.geometry, trail.material as THREE.Material,
      orb.geometry, orb.material as THREE.Material, badge.material];
    const dispose = resources.map((resource) => vi.spyOn(resource, "dispose"));
    effects.dispose();
    effects.dispose();
    expect(rig.children).toHaveLength(0);
    for (const spy of dispose) expect(spy).toHaveBeenCalledTimes(1);
  });
});
