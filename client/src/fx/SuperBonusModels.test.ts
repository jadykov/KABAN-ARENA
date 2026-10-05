import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { SUPER_BONUS_KINDS } from "../../../shared/super-bonuses.mjs";
import { SuperBonusModels } from "./SuperBonusModels";

function meshes(group: THREE.Group): THREE.Mesh[] {
  const result: THREE.Mesh[] = [];
  group.traverse((object) => { if (object instanceof THREE.Mesh) result.push(object); });
  return result;
}

describe("shared primitive bonus models", () => {
  it("gives all eleven items distinct compact silhouettes with useful landmarks at night", () => {
    const library = new SuperBonusModels();
    try {
      const signatures = new Set<string>();
      const landmarks = ["fleece", "beak", "ice-brick", "sausage-horseshoe", "jelly-mould", "herring-tin", "mud-package", "thermos", "soda-bottle", "vacuum-nozzle", "grenade-shell"];
      SUPER_BONUS_KINDS.forEach((kind, index) => {
        const group = library.create(kind);
        const pieces = meshes(group);
        expect(group.userData["bonusKind"]).toBe(kind);
        expect(pieces.some((mesh) => mesh.name.includes(landmarks[index] ?? "missing"))).toBe(true);
        expect(pieces.length).toBeLessThanOrEqual(6);
        const bounds = new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3());
        expect(Math.max(bounds.x, bounds.y, bounds.z)).toBeLessThan(1.1);
        expect(Math.max(bounds.x, bounds.y, bounds.z)).toBeGreaterThan(0.45);
        expect(pieces.reduce((count, mesh) => count + mesh.geometry.getAttribute("position").count / 3, 0)).toBeLessThan(2500);
        signatures.add(pieces.map((mesh) => `${mesh.name}:${mesh.geometry.getAttribute("position").count}`).join("|"));
        for (const mesh of pieces) {
          const material = mesh.material as THREE.MeshStandardMaterial;
          expect(material.emissiveIntensity).toBeGreaterThanOrEqual(0.3);
          expect(mesh.castShadow).toBe(false);
          expect(mesh.receiveShadow).toBe(false);
        }
        let lights = 0;
        group.traverse((object) => { if (object instanceof THREE.Light) lights += 1; });
        expect(lights).toBe(0);
      });
      expect(signatures.size).toBe(11);
    } finally {
      library.dispose();
    }
  });

  it("makes the grenade readable from its green shell, metal cap and pin with shared solid materials", () => {
    const library = new SuperBonusModels();
    try {
      const grenade = library.create("grenade");
      const pieces = meshes(grenade);
      expect(pieces).toHaveLength(3);
      const shell = pieces.find((mesh) => mesh.name.includes("grenade-shell"))!;
      expect((shell.material as THREE.MeshStandardMaterial).color.getHex()).toBe(0x7a9859);
      const metal = pieces.find((mesh) => mesh.name.includes("grenade-metal-cap"))!;
      expect(metal.name).toContain("grenade-pin");
      expect(metal.name).toContain("grenade-lever");
      expect((metal.material as THREE.MeshStandardMaterial).metalness).toBeGreaterThan(0);
      for (const mesh of pieces) {
        expect((mesh.material as THREE.MeshStandardMaterial).transparent).toBe(false);
        expect((mesh.material as THREE.MeshStandardMaterial).emissiveIntensity).toBeGreaterThanOrEqual(0.3);
      }
    } finally { library.dispose(); }
  });

  it("shares GPU resources across models and disposes each owned resource once", () => {
    const library = new SuperBonusModels();
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    let geometryDisposals = 0;
    let materialDisposals = 0;
    for (const kind of SUPER_BONUS_KINDS) {
      const first = meshes(library.create(kind));
      const second = meshes(library.create(kind));
      first.forEach((mesh, index) => {
        expect(second[index]?.geometry).toBe(mesh.geometry);
        expect(second[index]?.material).toBe(mesh.material);
        geometries.add(mesh.geometry);
        materials.add(mesh.material as THREE.Material);
      });
    }
    geometries.forEach((geometry) => geometry.addEventListener("dispose", () => { geometryDisposals += 1; }));
    materials.forEach((material) => material.addEventListener("dispose", () => { materialDisposals += 1; }));
    library.dispose();
    library.dispose();
    expect(geometryDisposals).toBe(geometries.size);
    expect(materialDisposals).toBe(materials.size);
  });

  it("animates wings, jelly, warning caps and sheep without changing shared resources", () => {
    const library = new SuperBonusModels();
    try {
      const turkey = library.create("turkey");
      const wing = turkey.getObjectByName("wing-1");
      const original = wing?.rotation.z;
      library.animate(turkey, 0.1);
      expect(wing?.rotation.z).not.toBe(original);
      const jelly = library.create("jelly");
      library.animate(jelly, 0.1);
      expect(jelly.scale.x).not.toBe(jelly.scale.y);
      const soda = library.create("soda");
      library.animate(soda, 0.1, "warning");
      expect(soda.getObjectByName("bottle-cap")?.position.y).toBeGreaterThan(0.5);
      library.animate(soda, 0.1, "armed");
      expect(soda.getObjectByName("bottle-cap")?.position.y).toBe(0.42);
      const sheep = library.create("sheep");
      library.animate(sheep, 0.1, "chase", 3.2);
      expect(sheep.position.y).toBeGreaterThan(0);
      library.animate(sheep, 0.1, "warning", 0);
      expect(sheep.position.y).toBe(0);
    } finally {
      library.dispose();
    }
  });
});
