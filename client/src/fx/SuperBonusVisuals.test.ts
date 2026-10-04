import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { NetBonusEffectSnapshot, NetPlayerSnapshot } from "../net/protocol";
import { BONUS_BURST_LIFE_S, BONUS_DECAL_OFFSET, MAX_BONUS_VISUALS, SuperBonusVisuals } from "./SuperBonusVisuals";

function effect(overrides: Partial<NetBonusEffectSnapshot> = {}): NetBonusEffectSnapshot {
  return { effectId: "zone", throwId: "throw", ownerId: "owner", kind: "ice", phase: "active", x: 2, y: 4, z: 3, radius: 1.8, createdAt: 1000, expiresAt: 6000, armedAt: 0, triggerAt: 0, vx: 0, vy: 0, vz: 0, ...overrides };
}

function player(overrides: Partial<NetPlayerSnapshot> = {}): NetPlayerSnapshot {
  return { sessionId: "target", nick: "Target", x: 1, y: 5.1, z: 2, rotY: 0.3, hp: 100, score: 0, alive: true, isBot: false, ready: true, spectator: false, superBuff: false, reloadUntil: 0, shieldHp: 0, shieldUntil: 0, speedUntil: 0, chargeUntil: 0, pickupKind: "", pickupAt: 0, pickupSeq: 0, ...overrides };
}

function root(scene: THREE.Scene): THREE.Group {
  const object = scene.getObjectByName("super-bonus-effects");
  if (!(object instanceof THREE.Group)) throw new Error("Missing effects root");
  return object;
}

function activeEffects(scene: THREE.Scene): THREE.Object3D[] {
  return root(scene).children.filter((object) => object.visible && object.name.startsWith("bonus-effect-"));
}

function horizontalRadius(mesh: THREE.Mesh, center: THREE.Vector3): number {
  mesh.updateWorldMatrix(true, false);
  const points = mesh.geometry.getAttribute("position");
  const point = new THREE.Vector3();
  let radius = 0;
  for (let i = 0; i < points.count; i += 1) {
    point.fromBufferAttribute(points, i).applyMatrix4(mesh.matrixWorld);
    radius = Math.max(radius, Math.hypot(point.x - center.x, point.z - center.z));
  }
  return radius;
}

describe("authoritative bonus effects", () => {
  it.each([["herring", 3.6], ["swamp", 3], ["ice", 3.6], ["vacuum", 4], ["soda", 3], ["sheep", 4]] as const)("%s draws its fill and contour at the expanded authoritative radius", (kind, radius) => {
    const scene = new THREE.Scene(); const visuals = new SuperBonusVisuals(scene);
    try {
      const snapshot = effect({ kind, radius }); visuals.sync([snapshot], [], 3000);
      const center = new THREE.Vector3(snapshot.x, snapshot.y, snapshot.z);
      for (const name of ["bonus-zone-fill", "bonus-zone-contour"]) {
        const mesh = scene.getObjectByName(name) as THREE.Mesh;
        expect(horizontalRadius(mesh, center)).toBeCloseTo(radius, 5);
      }
      visuals.update(0.1, 3200);
      expect(horizontalRadius(scene.getObjectByName("bonus-zone-contour") as THREE.Mesh, center)).toBeCloseTo(radius, 5);
    } finally { visuals.dispose(); }
  });

  it.each([["soda", 3], ["sheep", 4]] as const)("%s's pooled explosion ring grows to the authoritative blast radius with its original lifetime", (kind, radius) => {
    const scene = new THREE.Scene(); const visuals = new SuperBonusVisuals(scene);
    try {
      const snapshot = effect({ kind, radius, phase: "warning", triggerAt: 2500 });
      visuals.sync([snapshot], [], 2400); visuals.sync([], [], 2500);
      const burst = root(scene).children.find((object) => object.name === "bonus-explosion" && object.visible)!;
      const ring = burst.children[0] as THREE.Mesh;
      const center = new THREE.Vector3(snapshot.x, snapshot.y, snapshot.z);
      expect(horizontalRadius(ring, center)).toBeCloseTo(0.2, 5);
      visuals.update(BONUS_BURST_LIFE_S / 2, 2660);
      expect(burst.visible).toBe(true);
      expect(horizontalRadius(ring, center)).toBeCloseTo(0.2 + (radius - 0.2) / 2, 5);
      visuals.update(BONUS_BURST_LIFE_S / 2, 2820);
      expect(horizontalRadius(ring, center)).toBeCloseTo(radius, 5);
      expect(burst.visible).toBe(false);
    } finally { visuals.dispose(); }
  });

  it("reconstructs elevated zones on late join and removes them at their server deadline", () => {
    const scene = new THREE.Scene();
    const visuals = new SuperBonusVisuals(scene);
    try {
      visuals.sync([effect()], [], 3000);
      const zone = activeEffects(scene)[0];
      expect(zone?.position.toArray()).toEqual([2, 4, 3]);
      const contour = zone?.getObjectByName("bonus-zone-contour") as THREE.Mesh;
      expect(contour.position.y).toBeCloseTo(BONUS_DECAL_OFFSET + 0.005);
      expect(contour.scale.x).toBe(1.8);
      const material = contour.material as THREE.MeshBasicMaterial;
      expect(material.depthWrite).toBe(false);
      expect(material.opacity).toBeGreaterThan(0.6);
      visuals.update(0.01, 5999);
      expect(activeEffects(scene)).toHaveLength(1);
      visuals.update(0.01, 6000);
      expect(activeEffects(scene)).toHaveLength(0);
      visuals.sync([effect()], [], 7000);
      expect(activeEffects(scene)).toHaveLength(0);
    } finally { visuals.dispose(); }
  });

  it("keeps stinky clouds translucent and vacuum pull lines subtle without lights", () => {
    const scene = new THREE.Scene();
    const visuals = new SuperBonusVisuals(scene);
    try {
      visuals.sync([effect({ kind: "herring" }), effect({ effectId: "pull", kind: "vacuum", radius: 2 })], [], 1200);
      const cloud = scene.getObjectByName("herring-cloud");
      expect(cloud).toBeInstanceOf(THREE.Group);
      const puff = cloud?.children[0] as THREE.Mesh;
      expect((puff.material as THREE.MeshBasicMaterial).opacity).toBeLessThan(0.2);
      expect((puff.material as THREE.MeshBasicMaterial).depthWrite).toBe(false);
      const pull = scene.getObjectByName("vacuum-pull-lines") as THREE.LineSegments;
      const startScale = pull.scale.x;
      const childCount = root(scene).children.length;
      visuals.update(0.1, 1300);
      expect(pull.scale.x).not.toBe(startScale);
      expect(root(scene).children).toHaveLength(childCount);
      let lights = 0;
      scene.traverse((object) => { if (object instanceof THREE.Light) lights += 1; });
      expect(lights).toBe(0);
    } finally { visuals.dispose(); }
  });

  it("shows arming, red warnings, and bursts only for a confirmed timed removal", () => {
    const scene = new THREE.Scene();
    const visuals = new SuperBonusVisuals(scene);
    try {
      const mine = effect({ kind: "soda", phase: "arming", armedAt: 1800 });
      visuals.sync([mine], [], 1100);
      const contour = scene.getObjectByName("bonus-zone-contour");
      expect(contour?.scale.x).toBeLessThan(1.8);
      const warning = effect({ kind: "soda", phase: "warning", triggerAt: 2500 });
      visuals.sync([warning], [], 2000);
      expect(scene.getObjectByName("bonus-warning")?.visible).toBe(true);
      expect(scene.getObjectByName("bottle-cap")?.position.y).toBeGreaterThan(0.5);
      visuals.sync([], [], 2200);
      expect(root(scene).children.filter((object) => object.name === "bonus-explosion" && object.visible)).toHaveLength(0);
      visuals.sync([warning], [], 2400);
      visuals.sync([], [], 2500);
      expect(root(scene).children.filter((object) => object.name === "bonus-explosion" && object.visible)).toHaveLength(1);
      visuals.reset();
      expect(root(scene).children.every((object) => !object.visible)).toBe(true);
      visuals.sync([warning], [], 2400);
      visuals.reset();
      visuals.sync([], [], 2500);
      expect(root(scene).children.every((object) => !object.visible)).toBe(true);
    } finally { visuals.dispose(); }
  });

  it("reconstructs turkey helmets and frozen blocks with countdowns and removes dead players", () => {
    const scene = new THREE.Scene();
    const visuals = new SuperBonusVisuals(scene);
    try {
      const victim = player({ frozenUntil: 2000, turkeyUntil: 3000 });
      visuals.sync([], [victim], 1000);
      const rig = scene.getObjectByName("bonus-player-status");
      expect(rig?.position.toArray()).toEqual([1, 5.1, 2]);
      expect(scene.getObjectByName("bonus-frozen-player")?.visible).toBe(true);
      expect(scene.getObjectByName("bonus-turkey-helmet")?.visible).toBe(true);
      const timer = scene.getObjectByName("bonus-frozen-player")?.getObjectByName("bonus-status-time");
      expect(timer?.scale.x).toBeCloseTo(0.8);
      visuals.update(0.1, 1500);
      expect(timer?.scale.x).toBeCloseTo(0.4);
      visuals.update(0.1, 2000);
      expect(scene.getObjectByName("bonus-frozen-player")?.visible).toBe(false);
      expect(scene.getObjectByName("bonus-turkey-helmet")?.visible).toBe(true);
      visuals.sync([], [player({ ...victim, alive: false })], 2100);
      expect(rig?.visible).toBe(false);
      visuals.sync([], [victim], 2200);
      visuals.update(0.1, 3000);
      expect(rig?.visible).toBe(false);
    } finally { visuals.dispose(); }
  });

  it("caps pooled effects, reuses GPU resources, and cleans the scene on disposal", () => {
    const scene = new THREE.Scene();
    const visuals = new SuperBonusVisuals(scene);
    const many = Array.from({ length: MAX_BONUS_VISUALS + 10 }, (_, index) => effect({ effectId: `zone-${index}` }));
    visuals.sync(many, [], 1200);
    expect(activeEffects(scene)).toHaveLength(MAX_BONUS_VISUALS);
    const first = activeEffects(scene)[0]?.getObjectByName("bonus-zone-contour") as THREE.Mesh;
    const second = activeEffects(scene)[1]?.getObjectByName("bonus-zone-contour") as THREE.Mesh;
    expect(first.geometry).toBe(second.geometry);
    expect(first.material).toBe(second.material);
    let disposedGeometry = 0;
    let disposedMaterial = 0;
    first.geometry.addEventListener("dispose", () => { disposedGeometry += 1; });
    (first.material as THREE.Material).addEventListener("dispose", () => { disposedMaterial += 1; });
    const poolSize = root(scene).children.length;
    visuals.sync([], [], 1300);
    visuals.sync(many.map((value) => ({ ...value, effectId: `new-${value.effectId}` })), [], 1400);
    expect(root(scene).children).toHaveLength(poolSize);
    visuals.dispose();
    visuals.dispose();
    expect(disposedGeometry).toBe(1);
    expect(disposedMaterial).toBe(1);
    expect(scene.children).toHaveLength(0);
  });
});
