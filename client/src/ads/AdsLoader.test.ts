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
  it("builds four miniature facades and no perimeter wall ads", () => {
    const scene = new THREE.Scene();
    const ads = new AdsManager();
    ads.buildVisuals(scene);
    try {
      expect(ads.shopfrontCount).toBe(4);
      expect(scene.children).toHaveLength(11); // four signs/groups and seven batches
      const batches = scene.children.filter((child): child is THREE.InstancedMesh => child instanceof THREE.InstancedMesh);
      expect(batches.map((batch) => batch.name)).toEqual([
        "shop-static:facade",
        "shop-static:glazing",
        "shop-static:trim",
        "shop-static:canopy",
        "shop-static:accent",
        "shop-static:lamp",
        "shop-static:glow",
      ]);
      expect(batches.find((batch) => batch.name === "shop-static:facade")?.count).toBe(4);
      expect(batches.find((batch) => batch.name === "shop-static:glazing")!.count).toBeGreaterThan(12);
      expect(batches.find((batch) => batch.name === "shop-static:trim")!.count).toBeGreaterThan(50);
      expect(batches.find((batch) => batch.name === "shop-static:lamp")!.count).toBeGreaterThanOrEqual(7);
      expect(batches.find((batch) => batch.name === "shop-static:glow")!.visible).toBe(false);
      for (const kind of ["trim", "canopy", "accent", "lamp"]) {
        expect(batches.find((batch) => batch.name === `shop-static:${kind}`)?.geometry).toBeInstanceOf(RoundedBoxGeometry);
      }
      let renderableCount = 0;
      scene.traverse((child) => { if (child instanceof THREE.Mesh) renderableCount += 1; });
      expect(renderableCount).toBe(15); // seven batches + eight sign parts
      expect(scene.children.some((child) => child instanceof THREE.Light)).toBe(false);
      expect(scene.getObjectByName("arena-banner")).toBeUndefined();
      expect(scene.getObjectByName("arena-banner-rig")).toBeUndefined();
      const shops = scene.children.filter((child) => child.name.startsWith("shopfront:"));
      expect(shops.map((shop) => shop.name)).toEqual([
        "shopfront:0:krasnoe-beloe",
        "shopfront:1:krasnoe-beloe",
        "shopfront:2:magnit",
        "shopfront:3:pyaterochka",
      ]);
      shops.forEach((shop, index) => {
        const transform = getShopfrontTransforms()[index]!;
        expect(shop.position.x).toBeCloseTo(transform.x, 6);
        expect(shop.position.z).toBeCloseTo(transform.z, 6);
        expect(shop.rotation.y).toBeCloseTo(transform.rotationY, 6);
        expect(shop.children).toHaveLength(2); // sign and adjustable frame
        const sign = shop.getObjectByName("sign") as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
        expect(sign.scale.x).toBeLessThanOrEqual(SHOP_SIGN_WIDTH_M);
        expect(sign.scale.x).toBeCloseTo(transform.signWidth, 6);
        expect(sign.scale.y).toBeCloseTo(transform.signHeight, 6);
        expect(sign.material.opacity).toBe(SHOP_SIGN_OPACITY);
        expect(sign.material.depthWrite).toBe(false);
      });

      const checkInstance = (
        kind: string, index: number, shopIndex: number,
        local: [number, number, number], size: [number, number, number],
      ): void => {
        const batch = scene.getObjectByName(`shop-static:${kind}`) as THREE.InstancedMesh;
        const matrix = new THREE.Matrix4();
        const position = new THREE.Vector3();
        const rotation = new THREE.Quaternion();
        const scale = new THREE.Vector3();
        batch.getMatrixAt(index, matrix);
        matrix.decompose(position, rotation, scale);
        const shop = getShopfrontTransforms()[shopIndex]!;
        const expectedPosition = new THREE.Vector3(...local)
          .applyAxisAngle(new THREE.Vector3(0, 1, 0), shop.rotationY)
          .add(new THREE.Vector3(shop.x, 0, shop.z));
        const expectedRotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), shop.rotationY);
        expect(position.distanceTo(expectedPosition)).toBeLessThan(1e-5);
        expect(Math.abs(rotation.dot(expectedRotation))).toBeCloseTo(1, 5);
        expect(scale.distanceTo(new THREE.Vector3(...size))).toBeLessThan(1e-5);
      };
      getShopfrontTransforms().forEach((shop, index) => {
        const sy = shop.topY / 3;
        const w = shop.facadeWidth;
        checkInstance("facade", index, index, [0, 1.45 * sy, 0.025], [w, 2.72 * sy, 1]);
      });

      const facadeBatch = scene.getObjectByName("shop-static:facade") as THREE.InstancedMesh;
      const facadeColors = Array.from({ length: 4 }, (_, index) => {
        const color = new THREE.Color();
        facadeBatch.getColorAt(index, color);
        return color.getHex();
      });
      expect(new Set(facadeColors).size).toBe(4);

      const getLocalParts = (kind: string, shopIndex: number, face: "front" | "rear" = "front"): Array<{ position: THREE.Vector3; scale: THREE.Vector3; rotation: THREE.Quaternion }> => {
        const batch = scene.getObjectByName(`shop-static:${kind}`) as THREE.InstancedMesh;
        const shop = shops[shopIndex]!;
        const platform = PLATFORM_FIGURES[shopIndex]!;
        const rearZ = -2 * (platform.rampSide.endsWith("z") ? platform.hx : platform.hz) + 0.005;
        shop.updateMatrixWorld(true);
        const inverse = shop.matrixWorld.clone().invert();
        const parts = [];
        for (let index = 0; index < batch.count; index += 1) {
          const matrix = new THREE.Matrix4();
          batch.getMatrixAt(index, matrix);
          const local = inverse.clone().multiply(matrix);
          const position = new THREE.Vector3();
          const rotation = new THREE.Quaternion();
          const scale = new THREE.Vector3();
          local.decompose(position, rotation, scale);
          if (Math.abs(position.x) < 1.5 && Math.abs(position.z - (face === "rear" ? rearZ : 0)) < 0.65) {
            parts.push({ position, scale, rotation });
          }
        }
        return parts;
      };
      const canopyShapes = shops.map((_, index) => getLocalParts("canopy", index)
        .map(({ position, scale }) => [position.y.toFixed(2), position.z.toFixed(2), scale.x.toFixed(2)].join(":"))
        .join("|"));
      expect(new Set(canopyShapes).size).toBe(4);
      [1.07, 1.04, 1.07, 1.07].forEach((beamX, index) => {
        const transform = getShopfrontTransforms()[index]!;
        const beams = getLocalParts("trim", index).filter(({ position, scale }) =>
          scale.y > 2.4 * transform.topY / 3
          && Math.abs(Math.abs(position.x) - beamX * transform.facadeWidth / 2.4) < 0.005);
        expect(beams).toHaveLength(2);
        expect(beams[0]!.position.x).toBeCloseTo(-beams[1]!.position.x, 6);
        expect(beams[0]!.position.y).toBeCloseTo(beams[1]!.position.y, 6);
        expect(beams[0]!.position.z).toBeCloseTo(beams[1]!.position.z, 6);
        expect(beams[0]!.scale.distanceTo(beams[1]!.scale)).toBeLessThan(1e-6);
        expect(beams.every(({ rotation }) => Math.abs(rotation.z) < 1e-6)).toBe(true);
      });
      expect(getLocalParts("accent", 0).length).toBeGreaterThan(getLocalParts("accent", 1).length);
      // Rear fixtures sit against the wall opposite the storefront, including
      // an exit door, condenser, high window and a separate vented hatch.
      shops.forEach((_, index) => {
        const transform = getShopfrontTransforms()[index]!;
        const platform = PLATFORM_FIGURES[index]!;
        const rearWallZ = -2 * (platform.rampSide.endsWith("z") ? platform.hx : platform.hz) + 0.015;
        expect(getLocalParts("trim", index, "rear").length).toBeGreaterThan(3);
        expect(getLocalParts("accent", index, "rear").length).toBeGreaterThan(0);
        for (const kind of ["trim", "canopy", "accent"]) {
          for (const { position, scale } of getLocalParts(kind, index, "rear")) {
            expect(Math.abs(position.x) + scale.x / 2).toBeLessThan(transform.facadeWidth / 2);
            expect(position.y + scale.y / 2).toBeLessThan(transform.topY);
            expect(position.z + scale.z / 2).toBeLessThan(rearWallZ);
          }
        }
      });
      const condenser = getLocalParts("canopy", 1, "rear").find(({ scale }) => scale.z > 0.15);
      expect(condenser).toBeDefined();
      const condenserSlats = getLocalParts("accent", 1, "rear").filter(({ position, scale }) =>
        position.x < 0 && scale.x > 0.35 && scale.x < 0.5 && scale.y < 0.05);
      expect(condenserSlats).toHaveLength(3);
      expect(condenserSlats.every(({ position, scale }) =>
        position.z - scale.z / 2 < condenser!.position.z - condenser!.scale.z / 2)).toBe(true);
      expect(getLocalParts("trim", 2, "rear").some(({ position, scale }) =>
        position.x < 0 && scale.y > 0.5 && scale.y < 0.7)).toBe(true);
      expect(batches.every((batch) => batch.boundingSphere !== null)).toBe(true);
    } finally {
      ads.dispose(scene);
      expect(scene.children).toHaveLength(0);
    }
  });

  it("fades porch fixtures and entrance glow, clamps input, and resets after disposal", () => {
    const scene = new THREE.Scene();
    const ads = new AdsManager();
    ads.setPorchLighting(0.4); // SceneManager may set progress before visuals exist.
    ads.buildVisuals(scene);
    const lamp = scene.getObjectByName("shop-static:lamp") as THREE.InstancedMesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
    const glow = scene.getObjectByName("shop-static:glow") as THREE.InstancedMesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
    expect(lamp.material.emissiveIntensity).toBeCloseTo(0.96, 6);
    expect(glow.material.opacity).toBeCloseTo(0.208, 6);
    expect(glow.visible).toBe(true);

    ads.setPorchLighting(4);
    expect(lamp.material.emissiveIntensity).toBeCloseTo(2.4, 6);
    expect(glow.material.opacity).toBeCloseTo(0.52, 6);
    ads.setPorchLighting(-3);
    expect(lamp.material.emissiveIntensity).toBe(0);
    expect(glow.material.opacity).toBe(0);
    expect(glow.visible).toBe(false);
    ads.setPorchLighting(Number.NaN);
    expect(lamp.material.emissiveIntensity).toBe(0);

    const glowTexture = glow.material.map!;
    const textureDispose = vi.spyOn(glowTexture, "dispose");
    ads.setPorchLighting(1);
    ads.dispose(scene);
    expect(textureDispose).toHaveBeenCalledTimes(1);
    expect(scene.children).toHaveLength(0);
    ads.buildVisuals(scene);
    expect((scene.getObjectByName("shop-static:glow") as THREE.InstancedMesh).visible).toBe(false);
    ads.dispose(scene);
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
    const signGeometry = (scene.children[0]!.getObjectByName("sign") as THREE.Mesh).geometry;
    const geometryDispose = vi.spyOn(signGeometry, "dispose");
    const batchDisposers = scene.children
      .filter((child): child is THREE.InstancedMesh => child instanceof THREE.InstancedMesh)
      .map((batch) => vi.spyOn(batch, "dispose"));
    ads.dispose(scene);
    expect(ads.isLoaded).toBe(false);
    expect(ads.shopfrontCount).toBe(0);
    expect(scene.children).toHaveLength(0);
    expect(geometryDispose).toHaveBeenCalledTimes(1);
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
