import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { BADGE_SECONDS, PowerEffectVisuals } from "./PowerEffectVisuals";

describe("power effect visuals", () => {
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

  it("disposes all per-avatar geometry and materials once", () => {
    const rig = new THREE.Group();
    const effects = new PowerEffectVisuals(rig);
    const shield = rig.getObjectByName("bonus-shield") as THREE.Mesh;
    const trail = rig.getObjectByName("run-wind-trail") as THREE.Mesh;
    const badge = rig.getObjectByName("bonus-badge") as THREE.Sprite;
    const resources = [shield.geometry, shield.material as THREE.Material,
      trail.geometry, trail.material as THREE.Material, badge.material];
    const dispose = resources.map((resource) => vi.spyOn(resource, "dispose"));
    effects.dispose();
    effects.dispose();
    expect(rig.children).toHaveLength(0);
    for (const spy of dispose) expect(spy).toHaveBeenCalledTimes(1);
  });
});
