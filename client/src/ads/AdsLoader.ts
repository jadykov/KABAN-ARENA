import * as THREE from "three";
import {
  ADS_PUBLIC_BASE_PATH,
  ARENA_HALF_SIZE,
  BANNER_HEIGHT_M,
  BANNER_TEXTURE_HEIGHT,
  BANNER_TEXTURE_WIDTH,
  BANNER_WIDTH_M,
  FENCE_SLOT_COUNT,
  FENCE_TEXTURE_HEIGHT,
  FENCE_TEXTURE_WIDTH,
  WALL_HEIGHT,
} from "../config";

// Re-exported for playtest checklists: fence slot count must match QA1-A.
export const EXPECTED_FENCE_SLOTS = FENCE_SLOT_COUNT;

export interface FenceSlotTransform {
  x: number;
  y: number;
  z: number;
  rotationY: number;
}

// Six fence slots (QA1-A), football-championship style on the inner walls:
// two on north, two on south, one east, one west. 2x1m pictures (512x256).
export function getFenceSlotTransforms(): FenceSlotTransform[] {
  const half = ARENA_HALF_SIZE;
  const face = half - 0.06;
  const y = 1.2;
  return [
    { x: -5, y, z: -face, rotationY: 0 },
    { x: 5, y, z: -face, rotationY: 0 },
    { x: -5, y, z: face, rotationY: Math.PI },
    { x: 5, y, z: face, rotationY: Math.PI },
    { x: face, y, z: 0, rotationY: -Math.PI / 2 },
    { x: -face, y, z: 0, rotationY: Math.PI / 2 },
  ];
}

// Candidate static URLs per slot, in preference order: owner files first
// (png/jpg dropped into client/assets/ads, synced to public/ads + restart),
// committed SVG placeholder last (QA2-A/QA4-A, static per slot QA5-A).
export function resolveFenceUrls(slotIndex: number, basePath: string = ADS_PUBLIC_BASE_PATH): string[] {
  const slot = slotIndex + 1;
  return [
    `${basePath}/fence-${slot}.png`,
    `${basePath}/fence-${slot}.jpg`,
    `${basePath}/fence-${slot}.svg`,
  ];
}

export function resolveBannerUrls(basePath: string = ADS_PUBLIC_BASE_PATH): string[] {
  return [
    `${basePath}/banner.png`,
    `${basePath}/banner.jpg`,
    `${basePath}/banner.svg`,
  ];
}

// Canvas-generated fallback so fence + banner always render a picture even
// when the owner has not dropped files yet (repo stays free of binaries).
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
  context.fillStyle = "#0d1420";
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

// Loads fence + banner pictures into the arena without breaking the perf
// budget: 6 small planes + 1 banner plane, shared loader, textures capped
// at 512px wide (QT1-A). load() never throws — every slot ends with either
// the owner file or a generated placeholder.
export class AdsManager {
  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly actors: THREE.Object3D[] = [];
  private readonly fenceMaterials: THREE.MeshBasicMaterial[] = [];
  private bannerMaterial: THREE.MeshBasicMaterial | null = null;
  private loaded = false;

  public buildFrames(scene: THREE.Scene): void {
    // Dark back frames for all fence slots in one InstancedMesh.
    const frameGeometry = new THREE.BoxGeometry(2.2, 1.2, 0.06);
    const frameMaterial = new THREE.MeshStandardMaterial({ color: 0x0d1119, roughness: 0.9 });
    this.disposables.push(frameGeometry, frameMaterial);
    const slots = getFenceSlotTransforms();
    const frames = new THREE.InstancedMesh(frameGeometry, frameMaterial, slots.length);
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    slots.forEach((slot, index) => {
      quaternion.setFromAxisAngle(up, slot.rotationY);
      matrix.compose(
        new THREE.Vector3(slot.x, slot.y, slot.z),
        quaternion,
        new THREE.Vector3(1, 1, 1),
      );
      frames.setMatrixAt(index, matrix);
    });
    frames.instanceMatrix.needsUpdate = true;
    scene.add(frames);
    this.actors.push(frames);

    // Picture planes (unlit MeshBasicMaterial: readable on phones in
    // sunlight without spending lights; 6 draw calls, inside budget).
    const pictureGeometry = new THREE.PlaneGeometry(2, 1);
    this.disposables.push(pictureGeometry);
    for (const slot of slots) {
      const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
      this.disposables.push(material);
      this.fenceMaterials.push(material);
      const picture = new THREE.Mesh(pictureGeometry, material);
      picture.position.set(slot.x, slot.y, slot.z);
      picture.rotation.y = slot.rotationY;
      // Nudge off the frame face to avoid z-fighting.
      picture.translateZ(0.035);
      scene.add(picture);
      this.actors.push(picture);
    }

    // Hanging banner 4x1m at the arena center (QA3-A), double-sided.
    const bannerGeometry = new THREE.PlaneGeometry(BANNER_WIDTH_M, BANNER_HEIGHT_M);
    this.disposables.push(bannerGeometry);
    const bannerMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
    this.disposables.push(bannerMat);
    this.bannerMaterial = bannerMat;
    const banner = new THREE.Mesh(bannerGeometry, bannerMat);
    banner.position.set(0, WALL_HEIGHT + 1.2, 0);
    scene.add(banner);
    this.actors.push(banner);

    // Slim rig bar above the banner suggesting the hang.
    const barGeometry = new THREE.BoxGeometry(BANNER_WIDTH_M + 0.3, 0.08, 0.08);
    const barMaterial = new THREE.MeshStandardMaterial({ color: 0x0d1119, roughness: 0.9 });
    this.disposables.push(barGeometry, barMaterial);
    const bar = new THREE.Mesh(barGeometry, barMaterial);
    bar.position.set(0, WALL_HEIGHT + 1.75, 0);
    scene.add(bar);
    this.actors.push(bar);
  }

  public get isLoaded(): boolean {
    return this.loaded;
  }

  public get fenceCount(): number {
    return this.fenceMaterials.length;
  }

  public async load(basePath: string = ADS_PUBLIC_BASE_PATH): Promise<void> {
    const loader = new THREE.TextureLoader();
    const slots = getFenceSlotTransforms();
    for (let i = 0; i < slots.length && i < this.fenceMaterials.length; i += 1) {
      const material = this.fenceMaterials[i];
      if (material === undefined) {
        continue;
      }
      const texture = await AdsManager.loadFirstAvailable(
        loader,
        resolveFenceUrls(i, basePath),
        `AD ${i + 1}`,
        FENCE_TEXTURE_WIDTH,
        FENCE_TEXTURE_HEIGHT,
        "#22eeff",
      );
      if (texture !== null) {
        this.disposables.push(texture);
        material.map = texture;
        material.needsUpdate = true;
      }
    }
    if (this.bannerMaterial !== null) {
      const bannerTexture = await AdsManager.loadFirstAvailable(
        loader,
        resolveBannerUrls(basePath),
        "KABAN ARENA",
        BANNER_TEXTURE_WIDTH,
        BANNER_TEXTURE_HEIGHT,
        "#ff44cc",
      );
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
    for (const actor of this.actors) {
      scene.remove(actor);
    }
    this.actors.length = 0;
    this.fenceMaterials.length = 0;
    this.bannerMaterial = null;
    for (const tracked of this.disposables) {
      tracked.dispose();
    }
    this.disposables.length = 0;
    this.loaded = false;
  }
}
