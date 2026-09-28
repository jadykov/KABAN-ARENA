import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { PowerEffectVisuals } from "./PowerEffectVisuals";

describe("power effect visuals", () => {
  it("shows a steady animated shield and wind only while their effects are active", () => {
    const rig = new THREE.Group();
    const effects = new PowerEffectVisuals(rig);
    try {
      const shield = rig.children.find((child) => child instanceof THREE.Mesh);
      const wind = rig.children.find((child) => child instanceof THREE.LineSegments);
      expect(shield?.visible).toBe(false);
      expect(wind?.visible).toBe(false);
      effects.setActive(true, true);
      effects.update(0.25);
      expect(shield?.visible).toBe(true);
      expect(wind?.visible).toBe(true);
      expect(shield?.scale.x).toBeGreaterThan(1);
      effects.setActive(false, false);
      expect(shield?.visible).toBe(false);
      expect(wind?.visible).toBe(false);
    } finally {
      effects.dispose();
    }
    expect(rig.children).toHaveLength(0);
  });

  it("keeps an acquisition badge overhead for one second", () => {
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
      effects.update(0.51);
      expect(badge?.visible).toBe(false);
      effects.showPickup("speed");
      expect(badge?.visible).toBe(true);
    } finally {
      effects.dispose();
    }
  });
});
