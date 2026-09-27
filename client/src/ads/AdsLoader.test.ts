import * as THREE from "three";
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
  resolveBannerUrls,
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
    expect(resolveBannerUrls()).toEqual([
      `${ADS_PUBLIC_BASE_PATH}/banner.png`,
      `${ADS_PUBLIC_BASE_PATH}/banner.jpg`,
      `${ADS_PUBLIC_BASE_PATH}/banner.svg`,
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
      expect(scene.children).toHaveLength(11); // four groups, five batches, banner, rig
      const batches = scene.children.filter((child): child is THREE.InstancedMesh => child instanceof THREE.InstancedMesh);
      expect(batches.map((batch) => [batch.name, batch.count])).toEqual([
        ["shop-static:facade", 4],
        ["shop-static:glazing", 12],
        ["shop-static:trim", 16],
        ["shop-static:canopy", 4],
        ["shop-static:accent", 4],
      ]);
      let renderableCount = 0;
      scene.traverse((child) => { if (child instanceof THREE.Mesh) renderableCount += 1; });
      expect(renderableCount).toBe(15); // five batches + eight sign parts + banner and rig
      expect(scene.getObjectByName("arena-banner")).toBeDefined();
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
        checkInstance("glazing", index * 3, index, [0, 0.87 * sy, 0.045], [w * 0.34, 1.48 * sy, 1]);
      });
      const shop = getShopfrontTransforms()[2]!;
      const sy = shop.topY / 3;
      checkInstance("trim", 2 * 4 + 2, 2, [shop.facadeWidth * 0.34 * 0.32, 0.82 * sy, 0.07], [0.035, 0.12 * sy, 0.025]);
      checkInstance("canopy", 2, 2, [0, 1.99 * sy, 0.21], [shop.facadeWidth * 1.03, 0.10 * sy, 0.42]);
      checkInstance("accent", 2, 2, [0, 1.93 * sy, 0.425], [shop.facadeWidth * 1.03, 0.045 * sy, 0.035]);
      expect(batches.every((batch) => batch.boundingSphere !== null)).toBe(true);
    } finally {
      ads.dispose(scene);
      expect(scene.children).toHaveLength(0);
    }
  });

  it("shares repeated brand texture, loads banner, and disposes all resources", async () => {
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
      "/static/fence-2.png", "/static/fence-3.png", "/static/fence-1.png", "/static/banner.png",
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
    expect(missing).toHaveBeenCalledTimes(9); // three brands x two formats, banner x three
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
