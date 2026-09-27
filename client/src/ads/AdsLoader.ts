import * as THREE from "three";
import {
  ADS_PUBLIC_BASE_PATH,
  BANNER_HEIGHT_M,
  BANNER_TEXTURE_HEIGHT,
  BANNER_TEXTURE_WIDTH,
  BANNER_WIDTH_M,
  PLATFORM_FIGURES,
  SHOPFRONT_COUNT,
  SHOP_SIGN_HEIGHT_M,
  SHOP_SIGN_OPACITY,
  SHOP_SIGN_TEXTURE_HEIGHT,
  SHOP_SIGN_TEXTURE_WIDTH,
  SHOP_SIGN_WIDTH_M,
  WALL_HEIGHT,
  type PlatformFigureDef,
} from "../config";
import {
  ACCENT_AD_BANNER,
  ACCENT_AD_FENCE,
  ACCENT_STRIP,
  BASE_AD_CANVAS,
  BASE_AD_FRAME,
  BASE_CAP,
  BASE_PLATFORM,
  BASE_RAMP,
  NEUTRAL_WHITE,
} from "../palette";

type ShopBrand = "magnit" | "pyaterochka" | "krasnoe-beloe";

const SHOP_BRANDS: ReadonlyArray<{ id: ShopBrand; label: string; assetSlot: number; imageAspect: number }> = [
  { id: "krasnoe-beloe", label: "Красное & Белое", assetSlot: 2, imageAspect: 600 / 337 },
  { id: "krasnoe-beloe", label: "Красное & Белое", assetSlot: 2, imageAspect: 600 / 337 },
  { id: "magnit", label: "Магнит", assetSlot: 3, imageAspect: 1200 / 630 },
  { id: "pyaterochka", label: "Пятёрочка", assetSlot: 1, imageAspect: 1754 / 557 },
];

export interface ShopfrontTransform {
  brand: ShopBrand;
  label: string;
  assetSlot: number;
  platformIndex: number;
  x: number;
  z: number;
  rotationY: number;
  topY: number;
  facadeWidth: number;
  signWidth: number;
  signHeight: number;
}

function signDimensions(facadeWidth: number, topY: number, imageAspect: number): { width: number; height: number } {
  const maxWidth = Math.min(SHOP_SIGN_WIDTH_M, facadeWidth * 0.72);
  const maxHeight = SHOP_SIGN_HEIGHT_M * (topY / 3);
  const width = Math.min(maxWidth, maxHeight * imageAspect);
  return { width, height: width / imageAspect };
}

// Brands belong to the four existing platform records. Moving a platform in
// the editor moves its shop with it. A ramp runs along one axis; the shop uses
// the inward-facing side on the other axis, leaving the ramp and landing clear.
export function getShopfrontTransforms(
  platforms: readonly PlatformFigureDef[] = PLATFORM_FIGURES,
): ShopfrontTransform[] {
  return platforms
    .slice(0, SHOPFRONT_COUNT)
    .map((platform, platformIndex) => {
      const brand = SHOP_BRANDS[platformIndex];
      if (brand === undefined) throw new Error("Missing shop brand");
      const rampAlongZ = platform.rampSide.endsWith("z");
      const inward = rampAlongZ
        ? (platform.x > 0 ? -1 : 1)
        : (platform.z > 0 ? -1 : 1);
      const faceWidth = rampAlongZ ? platform.hz * 2 : platform.hx * 2;
      const facadeWidth = Math.min(2.45, faceWidth * 0.8);
      const sign = signDimensions(facadeWidth, platform.topY, brand.imageAspect);
      return {
        brand: brand.id,
        label: brand.label,
        assetSlot: brand.assetSlot,
        platformIndex,
        x: rampAlongZ ? platform.x + inward * (platform.hx + 0.015) : platform.x,
        z: rampAlongZ ? platform.z : platform.z + inward * (platform.hz + 0.015),
        rotationY: rampAlongZ ? inward * Math.PI / 2 : (inward > 0 ? 0 : Math.PI),
        topY: platform.topY,
        facadeWidth,
        signWidth: sign.width,
        signHeight: sign.height,
      };
    });
}

// A replacement PNG takes priority over the owner's softened JPEG. If both
// are absent, draw a brand-specific canvas sign; generic fence SVGs are gone.
export function resolveShopSignUrls(assetSlot: number, basePath: string = ADS_PUBLIC_BASE_PATH): string[] {
  return [
    `${basePath}/fence-${assetSlot}.png`,
    `${basePath}/fence-${assetSlot}.jpg`,
  ];
}

export function resolveBannerUrls(basePath: string = ADS_PUBLIC_BASE_PATH): string[] {
  return [
    `${basePath}/banner.png`,
    `${basePath}/banner.jpg`,
    `${basePath}/banner.svg`,
  ];
}

export function createPlaceholderTexture(
  label: string,
  width: number,
  height: number,
  accent: string,
): THREE.CanvasTexture {
  if (typeof document === "undefined") {
    throw new Error("createPlaceholderTexture requires DOM canvas");
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context === null) {
    throw new Error("2d canvas context unavailable");
  }
  context.fillStyle = BASE_AD_CANVAS;
  context.fillRect(0, 0, width, height);
  context.strokeStyle = accent;
  context.lineWidth = Math.max(2, Math.floor(width / 128));
  context.strokeRect(8, 8, width - 16, height - 16);
  context.fillStyle = accent;
  context.font = `bold ${Math.floor(height / 5)}px sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label, width / 2, height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// Visual dressing only: four shopfronts on platform sides and the existing
// center banner. No perimeter ad meshes and no added physics colliders.
export class AdsManager {
  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly actors: THREE.Object3D[] = [];
  private readonly shopSigns: Array<{
    material: THREE.MeshBasicMaterial;
    transform: ShopfrontTransform;
    sign: THREE.Mesh;
    frame: THREE.Mesh;
  }> = [];
  private bannerMaterial: THREE.MeshBasicMaterial | null = null;
  private generation = 0;
  private loaded = false;

  public buildVisuals(scene: THREE.Scene): void {
    const plane = new THREE.PlaneGeometry(1, 1);
    const box = new THREE.BoxGeometry(1, 1, 1);
    const facade = new THREE.MeshStandardMaterial({ color: BASE_PLATFORM, roughness: 0.94 });
    const glazing = new THREE.MeshStandardMaterial({
      color: BASE_AD_FRAME,
      emissive: ACCENT_STRIP,
      emissiveIntensity: 0.12,
      roughness: 0.34,
      metalness: 0.08,
    });
    const trim = new THREE.MeshStandardMaterial({ color: BASE_CAP, roughness: 0.72 });
    const canopy = new THREE.MeshStandardMaterial({ color: BASE_RAMP, roughness: 0.82 });
    const accent = new THREE.MeshStandardMaterial({ color: ACCENT_STRIP, roughness: 0.82 });
    this.disposables.push(plane, box, facade, glazing, trim, canopy, accent);

    // The four shops share five static materials. Store their world matrices
    // once, then render each material in one batch; the live sign and its
    // frame stay as individual meshes so image aspect changes still apply.
    const staticMatrices = {
      facade: [] as THREE.Matrix4[],
      glazing: [] as THREE.Matrix4[],
      trim: [] as THREE.Matrix4[],
      canopy: [] as THREE.Matrix4[],
      accent: [] as THREE.Matrix4[],
    };
    type StaticKind = keyof typeof staticMatrices;
    const localPosition = new THREE.Vector3();
    const localScale = new THREE.Vector3();
    const localMatrix = new THREE.Matrix4();
    const noRotation = new THREE.Quaternion();
    const addStatic = (
      kind: StaticKind, root: THREE.Group,
      x: number, y: number, z: number, width: number, height: number, depth: number,
    ): void => {
      root.updateMatrix();
      localPosition.set(x, y, z);
      localScale.set(width, height, depth);
      localMatrix.compose(localPosition, noRotation, localScale);
      staticMatrices[kind].push(new THREE.Matrix4().multiplyMatrices(root.matrix, localMatrix));
    };

    const panel = (
      root: THREE.Group, name: string, material: THREE.Material,
      x: number, y: number, z: number, width: number, height: number,
    ): THREE.Mesh => {
      const mesh = new THREE.Mesh(plane, material);
      mesh.name = name;
      mesh.position.set(x, y, z);
      mesh.scale.set(width, height, 1);
      root.add(mesh);
      return mesh;
    };
    const detail = (
      root: THREE.Group, name: string, material: THREE.Material,
      x: number, y: number, z: number, width: number, height: number, depth: number,
    ): THREE.Mesh => {
      const mesh = new THREE.Mesh(box, material);
      mesh.name = name;
      mesh.position.set(x, y, z);
      mesh.scale.set(width, height, depth);
      root.add(mesh);
      return mesh;
    };

    for (const transform of getShopfrontTransforms()) {
      const shop = new THREE.Group();
      shop.name = `shopfront:${transform.platformIndex}:${transform.brand}`;
      shop.position.set(transform.x, 0, transform.z);
      shop.rotation.y = transform.rotationY;
      const w = transform.facadeWidth;
      const sy = transform.topY / 3;
      const doorWidth = w * 0.34;
      const windowWidth = w * 0.25;
      const windowX = w * 0.31;

      // Flush facade panel; the existing platform remains the solid wall.
      addStatic("facade", shop, 0, 1.45 * sy, 0.025, w, 2.72 * sy, 1);
      addStatic("glazing", shop, 0, 0.87 * sy, 0.045, doorWidth, 1.48 * sy, 1);
      addStatic("glazing", shop, -windowX, 0.93 * sy, 0.047, windowWidth, 1.22 * sy, 1);
      addStatic("glazing", shop, windowX, 0.93 * sy, 0.047, windowWidth, 1.22 * sy, 1);
      addStatic("trim", shop, -doorWidth / 2, 0.87 * sy, 0.06, 0.035, 1.5 * sy, 0.025);
      addStatic("trim", shop, doorWidth / 2, 0.87 * sy, 0.06, 0.035, 1.5 * sy, 0.025);
      addStatic("trim", shop, doorWidth * 0.32, 0.82 * sy, 0.07, 0.035, 0.12 * sy, 0.025);
      addStatic("trim", shop, 0, 0.10 * sy, 0.07, w * 0.92, 0.045 * sy, 0.10);

      // Compact projecting canopy with a muted red front edge. It ends well
      // before the adjacent ramp face; every piece remains visual-only.
      addStatic("canopy", shop, 0, 1.99 * sy, 0.21, w * 1.03, 0.10 * sy, 0.42);
      addStatic("accent", shop, 0, 1.93 * sy, 0.425, w * 1.03, 0.045 * sy, 0.035);

      const signMaterial = new THREE.MeshBasicMaterial({
        color: NEUTRAL_WHITE,
        transparent: true,
        opacity: SHOP_SIGN_OPACITY,
        depthWrite: false,
      });
      this.disposables.push(signMaterial);
      const frame = detail(shop, "sign-frame", trim, 0, 2.50 * sy, 0.075,
        transform.signWidth + 0.10, transform.signHeight + 0.08 * sy, 0.045);
      const sign = panel(shop, "sign", signMaterial, 0, 2.50 * sy, 0.105,
        transform.signWidth, transform.signHeight);
      this.shopSigns.push({ material: signMaterial, transform, sign, frame });

      scene.add(shop);
      this.actors.push(shop);
    }

    const batches: ReadonlyArray<{
      kind: StaticKind; geometry: THREE.BufferGeometry; material: THREE.Material;
    }> = [
      { kind: "facade", geometry: plane, material: facade },
      { kind: "glazing", geometry: plane, material: glazing },
      { kind: "trim", geometry: box, material: trim },
      { kind: "canopy", geometry: box, material: canopy },
      { kind: "accent", geometry: box, material: accent },
    ];
    for (const { kind, geometry, material } of batches) {
      const matrices = staticMatrices[kind];
      const batch = new THREE.InstancedMesh(geometry, material, matrices.length);
      batch.name = `shop-static:${kind}`;
      matrices.forEach((matrix, index) => batch.setMatrixAt(index, matrix));
      batch.instanceMatrix.needsUpdate = true;
      batch.computeBoundingSphere();
      scene.add(batch);
      this.actors.push(batch);
      this.disposables.push(batch);
    }

    // Keep the central KABAN ARENA banner and slim hanging rig.
    const bannerGeometry = new THREE.PlaneGeometry(BANNER_WIDTH_M, BANNER_HEIGHT_M);
    const bannerMat = new THREE.MeshBasicMaterial({ color: NEUTRAL_WHITE, side: THREE.DoubleSide });
    this.disposables.push(bannerGeometry, bannerMat);
    this.bannerMaterial = bannerMat;
    const banner = new THREE.Mesh(bannerGeometry, bannerMat);
    banner.name = "arena-banner";
    banner.position.set(0, WALL_HEIGHT + 1.2, 0);
    scene.add(banner);
    this.actors.push(banner);

    const barGeometry = new THREE.BoxGeometry(BANNER_WIDTH_M + 0.3, 0.08, 0.08);
    const barMaterial = new THREE.MeshStandardMaterial({ color: BASE_AD_FRAME, roughness: 0.9 });
    this.disposables.push(barGeometry, barMaterial);
    const bar = new THREE.Mesh(barGeometry, barMaterial);
    bar.name = "arena-banner-rig";
    bar.position.set(0, WALL_HEIGHT + 1.75, 0);
    scene.add(bar);
    this.actors.push(bar);
  }

  public get isLoaded(): boolean {
    return this.loaded;
  }

  public get shopfrontCount(): number {
    return this.shopSigns.length;
  }

  public async load(basePath: string = ADS_PUBLIC_BASE_PATH): Promise<void> {
    const loader = new THREE.TextureLoader();
    const generation = this.generation;
    const shopTextures = new Map<number, THREE.Texture | null>();
    for (const { material, transform, sign, frame } of this.shopSigns) {
      let texture = shopTextures.get(transform.assetSlot) ?? null;
      if (!shopTextures.has(transform.assetSlot)) {
        texture = await AdsManager.loadFirstAvailable(
          loader,
          resolveShopSignUrls(transform.assetSlot, basePath),
          transform.label,
          SHOP_SIGN_TEXTURE_WIDTH,
          SHOP_SIGN_TEXTURE_HEIGHT,
          ACCENT_AD_FENCE,
        );
        if (generation !== this.generation) {
          texture?.dispose();
          return;
        }
        shopTextures.set(transform.assetSlot, texture);
        if (texture !== null) this.disposables.push(texture);
      }
      if (texture !== null) {
        material.map = texture;
        material.needsUpdate = true;
        const image = texture.image as { width?: unknown; height?: unknown } | undefined;
        const width = image?.width;
        const height = image?.height;
        if (typeof width === "number" && Number.isFinite(width) && width > 0
          && typeof height === "number" && Number.isFinite(height) && height > 0) {
          const size = signDimensions(transform.facadeWidth, transform.topY, width / height);
          sign.scale.set(size.width, size.height, 1);
          frame.scale.set(size.width + 0.10, size.height + 0.08 * (transform.topY / 3), 0.045);
        }
      }
    }
    if (this.bannerMaterial !== null) {
      const bannerTexture = await AdsManager.loadFirstAvailable(
        loader,
        resolveBannerUrls(basePath),
        "KABAN ARENA",
        BANNER_TEXTURE_WIDTH,
        BANNER_TEXTURE_HEIGHT,
        ACCENT_AD_BANNER,
      );
      if (generation !== this.generation) {
        bannerTexture?.dispose();
        return;
      }
      if (bannerTexture !== null) {
        this.disposables.push(bannerTexture);
        this.bannerMaterial.map = bannerTexture;
        this.bannerMaterial.needsUpdate = true;
      }
    }
    this.loaded = true;
  }

  private static async loadFirstAvailable(
    loader: THREE.TextureLoader,
    urls: string[],
    label: string,
    width: number,
    height: number,
    accent: string,
  ): Promise<THREE.Texture | null> {
    for (const url of urls) {
      try {
        const texture = await loader.loadAsync(url);
        texture.colorSpace = THREE.SRGBColorSpace;
        return texture;
      } catch {
        continue;
      }
    }
    try {
      return createPlaceholderTexture(label, width, height, accent);
    } catch {
      return null;
    }
  }

  public dispose(scene: THREE.Scene): void {
    this.generation += 1;
    for (const actor of this.actors) {
      scene.remove(actor);
    }
    this.actors.length = 0;
    this.shopSigns.length = 0;
    this.bannerMaterial = null;
    for (const tracked of this.disposables) {
      tracked.dispose();
    }
    this.disposables.length = 0;
    this.loaded = false;
  }
}
