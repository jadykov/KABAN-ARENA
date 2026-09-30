import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ADS_PUBLIC_BASE_PATH,
  PLATFORM_FIGURES,
  SHOPFRONT_COUNT,
  SHOP_SIGN_OPACITY,
  SHOP_SIGN_WIDTH_M,
} from "../config";
import { ACCENT_AD_FENCE } from "../palette";
import {
  AdsManager,
  createPlaceholderTexture,
  getShopfrontTransforms,
  resolveShopSignUrls,
} from "./AdsLoader";

afterEach(() => vi.restoreAllMocks());

type ShopPart = {
  position: THREE.Vector3;
  scale: THREE.Vector3;
  normal: THREE.Vector3;
  bounds: THREE.Box3;
  color: number;
};

// Inspect rendered transforms and vertices, including rotated side panels.
// No fixture metadata is needed to check the walls or traversal clearance.
function shopParts(scene: THREE.Scene, shopIndex: number, kind: string): ShopPart[] {
  const transform = getShopfrontTransforms()[shopIndex]!;
  const shop = scene.getObjectByName(`shopfront:${shopIndex}:${transform.brand}`)!;
  const platform = PLATFORM_FIGURES[shopIndex]!;
  const width = 2 * (platform.rampSide.endsWith("z") ? platform.hz : platform.hx);
  const depth = 2 * (platform.rampSide.endsWith("z") ? platform.hx : platform.hz);
  shop.updateMatrixWorld(true);
  const inverse = shop.matrixWorld.clone().invert();
  const batch = scene.getObjectByName(`shop-static:${kind}`) as THREE.InstancedMesh;
  const vertices = batch.geometry.getAttribute("position");
  const result: ShopPart[] = [];
  for (let index = 0; index < batch.count; index += 1) {
    const matrix = new THREE.Matrix4();
    batch.getMatrixAt(index, matrix);
    matrix.premultiply(inverse);
    const position = new THREE.Vector3().setFromMatrixPosition(matrix);
    if (Math.abs(position.x) > width / 2 + 0.6 || position.z < -depth - 0.4 || position.z > 1) continue;
    const bounds = new THREE.Box3();
    for (let vertex = 0; vertex < vertices.count; vertex += 1) {
      bounds.expandByPoint(new THREE.Vector3().fromBufferAttribute(vertices, vertex).applyMatrix4(matrix));
    }
    const color = new THREE.Color();
    batch.getColorAt(index, color);
    result.push({
      position,
      scale: new THREE.Vector3().setFromMatrixScale(matrix),
      normal: new THREE.Vector3(0, 0, 1).transformDirection(matrix),
      bounds,
      color: color.getHex(),
    });
  }
  return result;
}

describe("shopfront layout", () => {
  it("keeps both Krasnoe & Beloe shops diagonal and binds brands to platform records", () => {
    const shops = getShopfrontTransforms();
    expect(shops).toHaveLength(SHOPFRONT_COUNT);
    expect(shops.map((shop) => [shop.platformIndex, shop.brand, shop.assetSlot])).toEqual([
      [0, "krasnoe-beloe", 2],
      [1, "krasnoe-beloe", 2],
      [2, "magnit", 3],
      [3, "pyaterochka", 1],
    ]);
    expect(Math.sign(PLATFORM_FIGURES[0]!.x)).toBe(-Math.sign(PLATFORM_FIGURES[1]!.x));
    expect(Math.sign(PLATFORM_FIGURES[0]!.z)).toBe(-Math.sign(PLATFORM_FIGURES[1]!.z));
    [600 / 337, 600 / 337, 1200 / 630, 1754 / 557].forEach((aspect, index) => {
      expect(shops[index]!.signWidth / shops[index]!.signHeight).toBeCloseTo(aspect, 6);
    });
  });

  it("puts each facade on a center-facing side perpendicular to its ramp", () => {
    const shops = getShopfrontTransforms();
    for (const shop of shops) {
      const platform = PLATFORM_FIGURES[shop.platformIndex]!;
      const normal = new THREE.Vector3(0, 0, 1).applyAxisAngle(
        new THREE.Vector3(0, 1, 0), shop.rotationY,
      );
      const rampRunsOnZ = platform.rampSide.endsWith("z");
      const rampAxis = rampRunsOnZ ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
      expect(Math.abs(normal.dot(rampAxis))).toBeLessThan(1e-10);
      expect(normal.dot(new THREE.Vector3(-shop.x, 0, -shop.z))).toBeGreaterThan(0);
      if (rampRunsOnZ) {
        expect(Math.abs(shop.x - platform.x)).toBeCloseTo(platform.hx + 0.015, 6);
        expect(shop.z).toBe(platform.z);
      } else {
        expect(shop.x).toBe(platform.x);
        expect(Math.abs(shop.z - platform.z)).toBeCloseTo(platform.hz + 0.015, 6);
      }
      expect(shop.facadeWidth).toBeLessThan(rampRunsOnZ ? platform.hz * 2 : platform.hx * 2);
      expect(shop.signWidth).toBeLessThanOrEqual(SHOP_SIGN_WIDTH_M);
    }
  });

  it("follows editor changes to positions, sizes, heights, and ramp sides", () => {
    const changed = PLATFORM_FIGURES.map((platform) => ({ ...platform }));
    changed[2] = { ...changed[2]!, x: -9, z: -7, hx: 2, topY: 2.5, rampSide: "+z" };
    const shops = getShopfrontTransforms(changed);
    expect(shops.map((shop) => shop.brand)).toEqual([
      "krasnoe-beloe", "krasnoe-beloe", "magnit", "pyaterochka",
    ]);
    expect(shops[2]!.x).toBeCloseTo(-6.985, 6);
    expect(shops[2]!.z).toBe(-7);
    expect(shops[2]!.rotationY).toBeCloseTo(Math.PI / 2, 6);
    expect(shops[2]!.topY).toBe(2.5);
    expect(shops[2]!.signWidth).toBeLessThanOrEqual(SHOP_SIGN_WIDTH_M);
    expect(shops[2]!.signWidth / shops[2]!.signHeight).toBeCloseTo(1200 / 630, 6);
  });

  it("prefers replacement PNGs over JPEGs, with a branded canvas fallback", () => {
    expect(resolveShopSignUrls(3)).toEqual([
      `${ADS_PUBLIC_BASE_PATH}/fence-3.png`,
      `${ADS_PUBLIC_BASE_PATH}/fence-3.jpg`,
    ]);
    // Headless Node has no canvas; browsers generate a brand-labelled sign.
    expect(() => createPlaceholderTexture("Магнит", 512, 256, ACCENT_AD_FENCE)).toThrow();
  });
});

describe("AdsManager shop visuals and lifecycle", () => {
  it("wraps four recognizable modern shops in cladding and keeps the seven static batches", () => {
    const scene = new THREE.Scene();
    const ads = new AdsManager();
    ads.buildVisuals(scene);
    try {
      expect(ads.shopfrontCount).toBe(4);
      expect(scene.children).toHaveLength(11);
      const batches = scene.children.filter((child): child is THREE.InstancedMesh => child instanceof THREE.InstancedMesh);
      expect(batches.map((batch) => batch.name)).toEqual([
        "shop-static:facade", "shop-static:glazing", "shop-static:trim",
        "shop-static:canopy", "shop-static:accent", "shop-static:lamp", "shop-static:glow",
      ]);
      expect(batches.find((batch) => batch.name === "shop-static:facade")!.count).toBe(16);
      expect(batches.find((batch) => batch.name === "shop-static:glazing")!.count).toBe(20);
      expect(batches.find((batch) => batch.name === "shop-static:lamp")!.count).toBe(9);
      expect(batches.find((batch) => batch.name === "shop-static:glow")!.count).toBe(22);
      expect(batches.find((batch) => batch.name === "shop-static:glow")!.visible).toBe(false);
      expect(batches.reduce((count, batch) => count + batch.count, 0)).toBeLessThan(400);
      for (const kind of ["trim", "canopy", "accent", "lamp"]) {
        expect(batches.find((batch) => batch.name === `shop-static:${kind}`)!.geometry).toBeInstanceOf(RoundedBoxGeometry);
      }
      let renderableCount = 0;
      let triangleCount = 0;
      scene.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        renderableCount += 1;
        triangleCount += (child.geometry.index?.count ?? child.geometry.getAttribute("position").count)
          / 3 * (child instanceof THREE.InstancedMesh ? child.count : 1);
      });
      expect(renderableCount).toBe(15); // seven batches + eight sign parts
      expect(triangleCount).toBeLessThan(28_000);
      expect(scene.children.some((child) => child instanceof THREE.Light)).toBe(false);
      expect(scene.getObjectByName("arena-banner")).toBeUndefined();
      expect(scene.getObjectByName("arena-banner-rig")).toBeUndefined();
      expect(batches.every((batch) => batch.boundingSphere !== null)).toBe(true);

      const wallColors: number[] = [];
      const canopyShapes: string[] = [];
      getShopfrontTransforms().forEach((transform, index) => {
        const shop = scene.getObjectByName(`shopfront:${index}:${transform.brand}`)!;
        const platform = PLATFORM_FIGURES[index]!;
        const wallWidth = 2 * (platform.rampSide.endsWith("z") ? platform.hz : platform.hx);
        const wallDepth = 2 * (platform.rampSide.endsWith("z") ? platform.hx : platform.hz);
        expect(shop.position.x).toBeCloseTo(transform.x, 6);
        expect(shop.position.z).toBeCloseTo(transform.z, 6);
        expect(shop.rotation.y).toBeCloseTo(transform.rotationY, 6);
        expect(shop.children).toHaveLength(2);
        const sign = shop.getObjectByName("sign") as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
        expect(sign.scale.x).toBeCloseTo(transform.signWidth, 6);
        expect(sign.scale.y).toBeCloseTo(transform.signHeight, 6);
        expect(sign.material.opacity).toBe(SHOP_SIGN_OPACITY);
        expect(sign.material.depthWrite).toBe(false);

        const panels = shopParts(scene, index, "facade");
        expect(panels).toHaveLength(4);
        expect(new Set(panels.map(({ color }) => color)).size).toBe(1);
        wallColors.push(panels[0]!.color);
        for (const normal of [new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1),
          new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 0, 0)]) {
          const panel = panels.find((part) => part.normal.dot(normal) > 0.999)!;
          expect(panel).toBeDefined();
          expect(panel.bounds.min.y).toBeCloseTo(0.02 * transform.topY / 3, 5);
          expect(panel.bounds.max.y).toBeCloseTo(2.96 * transform.topY / 3, 5);
          expect(panel.scale.x).toBeCloseTo(normal.x === 0 ? wallWidth : wallDepth, 5);
          // Every face has the same broad brand band, including both sides
          // and the service back, rather than a front-only miniature facade.
          const red = [0xbe3039, 0xb9323c, 0xc02f3c, 0xc54247][index]!;
          expect(shopParts(scene, index, "accent").some((part) =>
            part.normal.dot(normal) > 0.999 && part.scale.x > panel.scale.x - 0.1
            && part.position.y > transform.topY * 0.65 && part.color === red)).toBe(true);
        }
        const glazing = shopParts(scene, index, "glazing");
        const frontGlazing = glazing.filter(({ position }) => position.z > 0);
        expect(frontGlazing).toHaveLength(3);
        expect(frontGlazing.every(({ scale }) => scale.y > 1.4 * transform.topY / 3)).toBe(true);
        const sideGlazing = glazing.filter(({ normal }) => Math.abs(normal.x) > 0.999);
        expect(sideGlazing).toHaveLength(2); // a broad display and a small corner louver
        expect(sideGlazing.some(({ scale }) => scale.x > wallDepth * 0.55 && scale.y > 1.2 * transform.topY / 3)).toBe(true);
        const beamX = [1.07, 1.04, 1.07, 1.07][index]! * transform.facadeWidth / 2.4;
        const beams = shopParts(scene, index, "trim").filter(({ position, scale }) =>
          position.z > 0 && scale.y > 2.4 * transform.topY / 3
          && Math.abs(Math.abs(position.x) - beamX) < 1e-5);
        expect(beams).toHaveLength(2);
        expect(beams[0]!.position.x).toBeCloseTo(-beams[1]!.position.x, 5);
        expect(beams[0]!.scale.distanceTo(beams[1]!.scale)).toBeLessThan(1e-6);
        expect(beams.every(({ normal }) => normal.z > 0.999)).toBe(true);
        const canopy = shopParts(scene, index, "canopy").filter(({ position }) => position.z > 0);
        canopyShapes.push(canopy.map(({ position, scale }) =>
          [position.y.toFixed(2), position.z.toFixed(2), scale.x.toFixed(2), scale.z.toFixed(2)].join(":"))
          .join("|"));
      });
      expect(new Set(wallColors).size).toBe(4);
      expect(new Set(canopyShapes).size).toBe(4);
      // The K&B pair has silver/light and charcoal/red identities while
      // keeping the same existing brand sign and diagonal placement.
      expect(wallColors[0]).toBe(0xe0ded7);
      expect(wallColors[1]).toBe(0xb9c1c4);
      expect(shopParts(scene, 3, "trim").some(({ color }) => color === 0x367d47)).toBe(true);
    } finally {
      ads.dispose(scene);
      expect(scene.children).toHaveLength(0);
    }
  });

  it("uses metal service fixtures and replaces Magnit's wooden cross-window", () => {
    const scene = new THREE.Scene();
    const ads = new AdsManager();
    ads.buildVisuals(scene);
    try {
      getShopfrontTransforms().forEach((transform, index) => {
        const platform = PLATFORM_FIGURES[index]!;
        const depth = 2 * (platform.rampSide.endsWith("z") ? platform.hx : platform.hz);
        const rear = shopParts(scene, index, "trim").filter(({ position }) => position.z < -depth - 0.04);
        expect(rear.some(({ scale }) => scale.x > 0.6 * transform.facadeWidth / 2.4
          && scale.y > 1.55 * transform.topY / 3)).toBe(true);
        expect(shopParts(scene, index, "glazing").every(({ position }) => position.z > -depth)).toBe(true);
      });
      const magnit = getShopfrontTransforms()[2]!;
      const unit = magnit.facadeWidth / 2.4;
      const sy = magnit.topY / 3;
      const rear = shopParts(scene, 2, "trim").filter(({ position }) => position.z < -3.04);
      const serviceDoor = rear.find(({ position, scale }) =>
        Math.abs(position.x - 0.57 * unit) < 1e-5 && scale.y > 1.7 * sy)!;
      expect(serviceDoor).toBeDefined();
      expect(serviceDoor.color).toBe(0xa0aeb4);
      expect(serviceDoor.scale.x).toBeCloseTo(0.70 * unit, 5);
      const vent = rear.find(({ position, scale }) =>
        Math.abs(position.x + 0.58 * unit) < 1e-5 && scale.x > 0.7 * unit)!;
      expect(vent.scale.y).toBeCloseTo(0.34 * sy, 5);
      expect(rear.some(({ position, scale }) =>
        Math.abs(position.x + 0.58 * unit) < 1e-5 && scale.y > 0.4 * sy)).toBe(false);
      const condenser = shopParts(scene, 1, "canopy").find(({ position }) => position.z < -3)!;
      expect(condenser.scale.z).toBeCloseTo(0.17, 5);
      expect(shopParts(scene, 1, "accent").filter(({ position, scale }) =>
        position.z < -3.20 && position.x < 0 && scale.x > 0.35 && scale.y < 0.04)).toHaveLength(3);
    } finally {
      ads.dispose(scene);
    }
  });

  it("keeps opaque decor below the deck, shallow on the sides and clear of ramp landings", () => {
    const scene = new THREE.Scene();
    const ads = new AdsManager();
    ads.buildVisuals(scene);
    try {
      getShopfrontTransforms().forEach((transform, index) => {
        const platform = PLATFORM_FIGURES[index]!;
        const width = 2 * (platform.rampSide.endsWith("z") ? platform.hz : platform.hx);
        const rampNormal = new THREE.Vector3(
          platform.rampSide.endsWith("x") ? (platform.rampSide.startsWith("+") ? 1 : -1) : 0, 0,
          platform.rampSide.endsWith("z") ? (platform.rampSide.startsWith("+") ? 1 : -1) : 0,
        ).applyAxisAngle(new THREE.Vector3(0, 1, 0), -transform.rotationY);
        for (const kind of ["facade", "glazing", "trim", "canopy", "accent", "lamp"]) {
          for (const part of shopParts(scene, index, kind)) {
            expect(part.bounds.min.y).toBeGreaterThan(0);
            expect(part.bounds.max.y).toBeLessThan(transform.topY - 0.025);
            expect(part.bounds.max.z).toBeLessThan(0.48); // existing porch approach
            expect(part.bounds.max.x).toBeLessThan(width / 2 + 0.065);
            expect(part.bounds.min.x).toBeGreaterThan(-width / 2 - 0.065);
            if (Math.abs(part.normal.x) > 0.999 && part.normal.dot(rampNormal) > 0.999 && kind !== "facade") {
              expect(part.bounds.max.y).toBeLessThan(transform.topY - 0.30);
              if (kind === "glazing") {
                // The corner vent does not spill into the two-meter slope.
                expect(Math.min(Math.abs(part.bounds.min.z + 1.515), Math.abs(part.bounds.max.z + 1.515)))
                  .toBeGreaterThan(platform.rampWidth / 2);
              }
            }
          }
        }
      });
    } finally {
      ads.dispose(scene);
    }
  });

  it("adds 20% to Stage 11 porch intensity, keeps fade linear, and resets after disposal", () => {
    const scene = new THREE.Scene();
    const ads = new AdsManager();
    ads.setPorchLighting(0.4); // SceneManager may set progress before visuals exist.
    ads.buildVisuals(scene);
    const lamp = scene.getObjectByName("shop-static:lamp") as THREE.InstancedMesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
    const glow = scene.getObjectByName("shop-static:glow") as THREE.InstancedMesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
    expect(lamp.material.emissiveIntensity).toBeCloseTo(0.96 * 1.15 * 1.20, 6);
    expect(glow.material.opacity).toBeCloseTo(0.208 * 1.15 * 1.20, 6);
    expect(glow.visible).toBe(true);

    ads.setPorchLighting(4);
    expect(lamp.material.emissiveIntensity / (2.4 * 1.15)).toBeCloseTo(1.20, 6);
    expect(glow.material.opacity / (0.52 * 1.15)).toBeCloseTo(1.20, 6);
    expect(lamp.material.color.getHex()).toBe(0xffe9bb);
    expect(lamp.material.emissive.r).toBeGreaterThan(lamp.material.emissive.g);
    expect(lamp.material.emissive.g).toBeGreaterThan(lamp.material.emissive.b);
    expect(glow.material.color.r).toBeGreaterThan(glow.material.color.g);
    expect(glow.material.color.g).toBeGreaterThan(glow.material.color.b);
    ads.setPorchLighting(0.5);
    expect(lamp.material.emissiveIntensity).toBeCloseTo(2.4 * 1.15 * 1.20 / 2, 6);
    expect(glow.material.opacity).toBeCloseTo(0.52 * 1.15 * 1.20 / 2, 6);
    ads.setPorchLighting(Number.POSITIVE_INFINITY);
    expect(lamp.material.emissiveIntensity).toBeCloseTo(2.4 * 1.15 * 1.20, 6);
    ads.setPorchLighting(-3);
    expect(lamp.material.emissiveIntensity).toBe(0);
    expect(lamp.material.color.getHex()).toBe(0x574936);
    expect(glow.material.opacity).toBe(0);
    expect(glow.visible).toBe(false);
    ads.setPorchLighting(Number.NaN);
    expect(lamp.material.emissiveIntensity).toBe(0);

    const glowTexture = glow.material.map!;
    const textureDispose = vi.spyOn(glowTexture, "dispose");
    const materialDispose = vi.spyOn(glow.material, "dispose");
    const lampDispose = vi.spyOn(lamp.material, "dispose");
    const batchDispose = vi.spyOn(glow, "dispose");
    ads.setPorchLighting(1);
    ads.dispose(scene);
    expect(textureDispose).toHaveBeenCalledTimes(1);
    expect(materialDispose).toHaveBeenCalledTimes(1);
    expect(lampDispose).toHaveBeenCalledTimes(1);
    expect(batchDispose).toHaveBeenCalledTimes(1);
    expect(scene.children).toHaveLength(0);
    ads.buildVisuals(scene);
    expect((scene.getObjectByName("shop-static:glow") as THREE.InstancedMesh).visible).toBe(false);
    expect((scene.getObjectByName("shop-static:lamp") as typeof lamp).material.emissiveIntensity).toBe(0);
    ads.dispose(scene);
  });

  it("keeps Stage 11 reach and makes every porch source visible in the same glow batch", () => {
    const scene = new THREE.Scene();
    const ads = new AdsManager();
    ads.buildVisuals(scene);
    try {
      const glow = scene.getObjectByName("shop-static:glow") as THREE.InstancedMesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
      expect(scene.children.filter((child) => child.name === "shop-static:glow")).toHaveLength(1);
      expect(glow.count).toBe(22); // seven cores/halos, four door washes, four floor spills
      expect(glow.material.forceSinglePass).toBe(true);
      expect(glow.material.depthWrite).toBe(false);
      expect(glow.material.blending).toBe(THREE.AdditiveBlending);
      expect(glow.geometry.groups).toHaveLength(0);
      const lights: THREE.Light[] = [];
      scene.traverse((child) => { if (child instanceof THREE.Light) lights.push(child); });
      expect(lights).toHaveLength(0);
      ads.setPorchLighting(1);
      scene.updateMatrixWorld(true);

      getShopfrontTransforms().forEach((shop, index) => {
        const unit = shop.facadeWidth / 2.4;
        const sy = shop.topY / 3;
        const doorX = [0.19, 0, 0.17, 0][index]! * unit;
        const porchY = [1.83, 1.86, 1.84, 1.88][index]!;
        const haloXs = [[0.19], [-0.43, 0.43], [-0.48, 0.48], [-0.46, 0.46]][index]!;
        const root = new THREE.Matrix4().compose(
          new THREE.Vector3(shop.x, 0, shop.z),
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), shop.rotationY),
          new THREE.Vector3(1, 1, 1),
        );
        const inverse = root.clone().invert();
        const parts: Array<{ matrix: THREE.Matrix4; position: THREE.Vector3; scale: THREE.Vector3 }> = [];
        for (let instance = 0; instance < glow.count; instance += 1) {
          const matrix = new THREE.Matrix4();
          glow.getMatrixAt(instance, matrix);
          const local = inverse.clone().multiply(matrix);
          const position = new THREE.Vector3().setFromMatrixPosition(local);
          if (Math.abs(position.x) < 1 && position.z > 0 && position.z < 1) {
            parts.push({ matrix: local, position, scale: new THREE.Vector3().setFromMatrixScale(local) });
          }
        }
        expect(parts).toHaveLength(haloXs.length * 2 + 2);
        for (const lightX of haloXs) {
          const halo = parts.find(({ position }) => Math.abs(position.z - 0.48) < 1e-5
            && Math.abs(position.x - lightX * unit) < 1e-5)!;
          expect(halo.position.y).toBeCloseTo((porchY - 0.20) * sy, 5);
          expect(halo.scale.x / (0.67 * unit)).toBeCloseTo(1.15, 5);
          expect(halo.scale.y / (0.69 * sy)).toBeCloseTo(1.15, 5);
          const core = parts.find(({ position }) => Math.abs(position.z - 0.482) < 1e-5
            && Math.abs(position.x - lightX * unit) < 1e-5)!;
          expect(core.position.y).toBeCloseTo(porchY * sy, 5);
          // The added bright core stays inside the existing halo's footprint,
          // and is just in front of the fixture's emitting face at z=0.47.
          expect(core.scale.x).toBeLessThan(halo.scale.x);
          expect(core.position.y + core.scale.y / 2).toBeLessThan(halo.position.y + halo.scale.y / 2);
          expect(core.position.y - core.scale.y / 2).toBeGreaterThan(halo.position.y - halo.scale.y / 2);
          expect(core.position.z).toBeGreaterThan(0.47);
          const target = core.position.clone().applyMatrix4(root);
          for (const side of [-0.25, 0, 0.25]) {
            const camera = new THREE.Vector3(lightX * unit + side, 1.45 * sy, 3).applyMatrix4(root);
            const ray = new THREE.Raycaster(camera, target.clone().sub(camera).normalize());
            const hit = ray.intersectObjects(scene.children, true)[0]!;
            expect(hit.object).toBe(glow); // emitting core is clear of awnings and opaque fixtures
            expect(hit.point.distanceTo(target)).toBeLessThan(1e-4);
          }
        }
        const wash = parts.find(({ position }) => Math.abs(position.z - 0.13) < 1e-5)!;
        expect(wash.position.x).toBeCloseTo(doorX, 5);
        expect(wash.position.y).toBeCloseTo(0.99 * sy, 5);
        expect(wash.scale.x / (1.02 * unit)).toBeCloseTo(1.15, 5);
        expect(wash.scale.y / (1.50 * sy)).toBeCloseTo(1.15, 5);

        const floor = parts.find(({ position }) => position.y < 0.02)!;
        expect(floor.position.x).toBeCloseTo(doorX, 5);
        expect(floor.position.y).toBeGreaterThan(0);
        expect(floor.scale.x / (1.70 * unit)).toBeCloseTo(1.15, 5);
        expect(floor.scale.y / 2.10).toBeCloseTo(1.15, 5);
        const normal = new THREE.Vector3(0, 0, 1).transformDirection(floor.matrix);
        expect(normal.y).toBeCloseTo(1, 5);
        // Actual transformed plane vertices lie on the floor and extend over
        // two meters outside the facade, rather than enlarging only a wall halo.
        const corners = [new THREE.Vector3(-0.5, -0.5, 0), new THREE.Vector3(0.5, 0.5, 0)]
          .map((corner) => corner.applyMatrix4(floor.matrix));
        expect(corners.every((corner) => Math.abs(corner.y - 0.018) < 1e-5)).toBe(true);
        expect(Math.abs(corners[0]!.x - corners[1]!.x)).toBeCloseTo(1.70 * unit * 1.15, 5);
        expect(Math.abs(corners[0]!.z - corners[1]!.z)).toBeCloseTo(2.10 * 1.15, 5);
        expect(Math.max(corners[0]!.z, corners[1]!.z)).toBeGreaterThan(2);
      });
    } finally {
      ads.dispose(scene);
    }
  });

  it("fades warm light monotonically from its core to transparent radial edges", () => {
    const scene = new THREE.Scene();
    const ads = new AdsManager();
    ads.buildVisuals(scene);
    try {
      const glow = scene.getObjectByName("shop-static:glow") as THREE.InstancedMesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
      const texture = glow.material.map as THREE.DataTexture;
      const { data, width, height } = texture.image;
      expect(width).toBe(32);
      expect(height).toBe(32);
      const alpha = (x: number, y: number): number => data[(y * width + x) * 4 + 3]!;
      const center = width / 2;
      expect(alpha(center, center)).toBeGreaterThan(200);
      expect(alpha(center + 8, center)).toBeGreaterThan(0);
      expect(alpha(center + 8, center)).toBeLessThan(100);
      for (let offset = 1; offset < width / 2; offset += 1) {
        expect(alpha(center + offset, center)).toBeLessThanOrEqual(alpha(center + offset - 1, center));
        expect(alpha(center, center + offset)).toBeLessThanOrEqual(alpha(center, center + offset - 1));
        expect(alpha(center + offset, center + offset)).toBeLessThanOrEqual(alpha(center + offset - 1, center + offset - 1));
      }
      for (let edge = 0; edge < width; edge += 1) {
        expect(alpha(edge, 0)).toBe(0);
        expect(alpha(edge, height - 1)).toBe(0);
        expect(alpha(0, edge)).toBe(0);
        expect(alpha(width - 1, edge)).toBe(0);
      }
      expect(texture.magFilter).toBe(THREE.LinearFilter);
      expect(texture.minFilter).toBe(THREE.LinearFilter);
      expect(texture.generateMipmaps).toBe(false);
    } finally {
      ads.dispose(scene);
    }
  });

  it("shares repeated brand texture and disposes all resources", async () => {
    const textures: THREE.Texture[] = [];
    const disposed: Array<ReturnType<typeof vi.spyOn>> = [];
    const load = vi.spyOn(THREE.TextureLoader.prototype, "loadAsync").mockImplementation(async (url) => {
      const image = String(url).includes("fence-2")
        ? { width: 800, height: 200 } // Owner replacement PNG has a new 4:1 ratio.
        : { width: 1200, height: 630 };
      const texture = Object.assign(new THREE.Texture(), { image });
      textures.push(texture);
      disposed.push(vi.spyOn(texture, "dispose"));
      return texture;
    });
    const scene = new THREE.Scene();
    const ads = new AdsManager();
    ads.buildVisuals(scene);
    await ads.load("/static");
    expect(ads.isLoaded).toBe(true);
    expect(load.mock.calls.map(([url]) => url)).toEqual([
      "/static/fence-2.png", "/static/fence-3.png", "/static/fence-1.png",
    ]);
    const signMeshes = scene.children
      .filter((child) => child.name.startsWith("shopfront:"))
      .map((shop) => shop.getObjectByName("sign") as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>);
    expect(signMeshes[0]!.material.map).toBe(textures[0]);
    expect(signMeshes[1]!.material.map).toBe(textures[0]);
    expect(signMeshes[2]!.material.map).toBe(textures[1]);
    expect(signMeshes[3]!.material.map).toBe(textures[2]);
    expect(signMeshes[0]!.scale.x / signMeshes[0]!.scale.y).toBeCloseTo(4, 6);
    expect(signMeshes[1]!.scale.x / signMeshes[1]!.scale.y).toBeCloseTo(4, 6);
    expect(signMeshes[0]!.scale.x).toBeLessThanOrEqual(SHOP_SIGN_WIDTH_M);
    const frame = scene.children[0]!.getObjectByName("sign-frame") as THREE.Mesh;
    expect(frame.scale.x).toBeCloseTo(signMeshes[0]!.scale.x + 0.10, 6);
    expect(frame.scale.y).toBeGreaterThan(signMeshes[0]!.scale.y);
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const maps = new Set<THREE.Texture>();
    scene.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      geometries.add(child.geometry);
      for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
        materials.add(material);
        if (material instanceof THREE.MeshBasicMaterial && material.map !== null) maps.add(material.map);
      }
    });
    expect(geometries.size).toBe(2); // shared plane and rounded box
    expect(materials.size).toBe(15); // seven batch materials and eight sign materials
    expect(maps.size).toBe(4); // one glow texture and three shared brand textures
    const geometryDisposers = [...geometries].map((geometry) => vi.spyOn(geometry, "dispose"));
    const materialDisposers = [...materials].map((material) => vi.spyOn(material, "dispose"));
    const mapDisposers = [...maps].map((texture) => vi.spyOn(texture, "dispose"));
    const batchDisposers = scene.children
      .filter((child): child is THREE.InstancedMesh => child instanceof THREE.InstancedMesh)
      .map((batch) => vi.spyOn(batch, "dispose"));
    ads.dispose(scene);
    expect(ads.isLoaded).toBe(false);
    expect(ads.shopfrontCount).toBe(0);
    expect(scene.children).toHaveLength(0);
    for (const spy of geometryDisposers) expect(spy).toHaveBeenCalledTimes(1);
    for (const spy of materialDisposers) expect(spy).toHaveBeenCalledTimes(1);
    for (const spy of mapDisposers) expect(spy).toHaveBeenCalledTimes(1);
    for (const spy of batchDisposers) expect(spy).toHaveBeenCalledTimes(1);
    for (const spy of disposed) expect(spy).toHaveBeenCalledTimes(1);
  });

  it("resolves missing pictures without throwing and cancels a late load on dispose", async () => {
    const missing = vi.spyOn(THREE.TextureLoader.prototype, "loadAsync").mockRejectedValue(new Error("missing"));
    const scene = new THREE.Scene();
    const ads = new AdsManager();
    ads.buildVisuals(scene);
    await expect(ads.load("/missing")).resolves.toBeUndefined();
    expect(ads.isLoaded).toBe(true);
    expect(missing).toHaveBeenCalledTimes(6); // three brands x two formats
    ads.dispose(scene);
    expect(scene.children).toHaveLength(0);
    expect(ads.isLoaded).toBe(false);

    let resolveLoad: ((texture: THREE.Texture) => void) | undefined;
    missing.mockRestore();
    vi.spyOn(THREE.TextureLoader.prototype, "loadAsync").mockImplementation(() =>
      new Promise<THREE.Texture>((resolve) => { resolveLoad = resolve; }));
    const second = new AdsManager();
    second.buildVisuals(scene);
    const pending = second.load("/slow");
    second.dispose(scene);
    const lateTexture = new THREE.Texture();
    const lateDispose = vi.spyOn(lateTexture, "dispose");
    resolveLoad?.(lateTexture);
    await pending;
    expect(second.isLoaded).toBe(false);
    expect(lateDispose).toHaveBeenCalledTimes(1);
    expect(scene.children).toHaveLength(0);
  });
});
