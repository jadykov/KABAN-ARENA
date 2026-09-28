import * as THREE from "three";
import {
  ADS_PUBLIC_BASE_PATH,
  PLATFORM_FIGURES,
  SHOPFRONT_COUNT,
  SHOP_SIGN_HEIGHT_M,
  SHOP_SIGN_OPACITY,
  SHOP_SIGN_TEXTURE_HEIGHT,
  SHOP_SIGN_TEXTURE_WIDTH,
  SHOP_SIGN_WIDTH_M,
  type PlatformFigureDef,
} from "../config";
import {
  ACCENT_AD_FENCE,
  BASE_AD_CANVAS,
  BASE_AD_FRAME,
  NEUTRAL_WHITE,
} from "../palette";

type ShopBrand = "magnit" | "pyaterochka" | "krasnoe-beloe";

// One palette and composition per platform, including separate identities for
// the two Krasnoe & Beloe outlets. Per-instance colors keep the extra detail
// in the same few draw calls as the original facades.
const SHOP_STYLES = [
  { wall: 0xb8b9a1, frame: 0x744747, trim: 0xd5caaa, roof: 0x883f43, accent: 0xbf6257, glass: 0x79999b, door: 0x394747 },
  { wall: 0x3d6253, frame: 0x8aa393, trim: 0x29443d, roof: 0x53685a, accent: 0xa94849, glass: 0x4a6770, door: 0x718079 },
  { wall: 0x50734e, frame: 0xa89b75, trim: 0x3d5941, roof: 0x718056, accent: 0xd3a35e, glass: 0x8baaa5, door: 0x493f39 },
  { wall: 0xa8c5aa, frame: 0x4f805e, trim: 0xd5dfbd, roof: 0x61946c, accent: 0xc76759, glass: 0x8cb3bb, door: 0x3b7068 },
] as const;

function createPorchGlowTexture(): THREE.DataTexture {
  const size = 32;
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x + 0.5 - size / 2) / (size / 2);
      const dy = (y + 0.5 - size / 2) / (size / 2);
      const radius = Math.min(1, Math.hypot(dx, dy));
      const alpha = Math.round(255 * (1 - radius) ** 2);
      const offset = (y * size + x) * 4;
      pixels[offset] = 255;
      pixels[offset + 1] = 244;
      pixels[offset + 2] = 205;
      pixels[offset + 3] = alpha;
    }
  }
  const texture = new THREE.DataTexture(pixels, size, size, THREE.RGBAFormat);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

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

// Visual dressing only: four shopfronts on platform sides. No center or
// perimeter ad meshes and no added physics colliders.
export class AdsManager {
  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly actors: THREE.Object3D[] = [];
  private readonly shopSigns: Array<{
    material: THREE.MeshBasicMaterial;
    transform: ShopfrontTransform;
    sign: THREE.Mesh;
    frame: THREE.Mesh;
  }> = [];
  private generation = 0;
  private loaded = false;
  private porchLightingStrength = 0;
  private readonly porchLampOffColor = new THREE.Color(0x574936);
  private readonly porchLampOnColor = new THREE.Color(0xffe9bb);
  private porchLampMaterial: THREE.MeshStandardMaterial | null = null;
  private porchGlowMaterial: THREE.MeshBasicMaterial | null = null;
  private porchGlowBatch: THREE.InstancedMesh | null = null;

  public buildVisuals(scene: THREE.Scene): void {
    const plane = new THREE.PlaneGeometry(1, 1);
    const box = new THREE.BoxGeometry(1, 1, 1);
    const facade = new THREE.MeshStandardMaterial({ color: NEUTRAL_WHITE, roughness: 0.94 });
    const glazing = new THREE.MeshStandardMaterial({
      color: NEUTRAL_WHITE,
      emissive: BASE_AD_FRAME,
      emissiveIntensity: 0.10,
      roughness: 0.34,
      metalness: 0.08,
    });
    const trim = new THREE.MeshStandardMaterial({ color: NEUTRAL_WHITE, roughness: 0.72 });
    const canopy = new THREE.MeshStandardMaterial({ color: NEUTRAL_WHITE, roughness: 0.82 });
    const accent = new THREE.MeshStandardMaterial({ color: NEUTRAL_WHITE, roughness: 0.82 });
    const lamp = new THREE.MeshStandardMaterial({
      color: 0x574936,
      emissive: 0xffdfa3,
      emissiveIntensity: 0,
      roughness: 0.45,
    });
    const glowTexture = createPorchGlowTexture();
    const glow = new THREE.MeshBasicMaterial({
      color: 0xffdeb0,
      map: glowTexture,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.porchLampMaterial = lamp;
    this.porchGlowMaterial = glow;
    this.disposables.push(plane, box, facade, glazing, trim, canopy, accent, lamp, glowTexture, glow);

    // Colored instances add the four distinct compositions without a draw
    // call per window, mullion, shelf, roof piece, or lamp. The sign and its
    // adjustable frame stay individual so replacement image ratios still fit.
    type StaticPart = { matrix: THREE.Matrix4; color: number };
    const staticParts = {
      facade: [] as StaticPart[],
      glazing: [] as StaticPart[],
      trim: [] as StaticPart[],
      canopy: [] as StaticPart[],
      accent: [] as StaticPart[],
      lamp: [] as StaticPart[],
      glow: [] as StaticPart[],
    };
    type StaticKind = keyof typeof staticParts;
    const localPosition = new THREE.Vector3();
    const localScale = new THREE.Vector3();
    const localMatrix = new THREE.Matrix4();
    const localRotation = new THREE.Quaternion();
    const zAxis = new THREE.Vector3(0, 0, 1);
    const addStatic = (
      kind: StaticKind, root: THREE.Group,
      x: number, y: number, z: number, width: number, height: number, depth: number,
      color: number, tiltZ = 0,
    ): void => {
      root.updateMatrix();
      localPosition.set(x, y, z);
      localScale.set(width, height, depth);
      localRotation.setFromAxisAngle(zAxis, tiltZ);
      localMatrix.compose(localPosition, localRotation, localScale);
      staticParts[kind].push({
        matrix: new THREE.Matrix4().multiplyMatrices(root.matrix, localMatrix),
        color,
      });
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
      const unit = w / 2.4;
      const style = SHOP_STYLES[transform.platformIndex];
      if (style === undefined) throw new Error("Missing shop style");
      const add = (
        kind: StaticKind, x: number, y: number, z: number,
        width: number, height: number, depth: number, color: number, tiltZ = 0,
      ): void => addStatic(
        kind, shop, x * unit, y * sy, z,
        width * unit, height * sy, depth, color, tiltZ,
      );
      const pane = (
        x: number, y: number, width: number, height: number,
        glassColor: number, frameColor = style.frame,
      ): void => {
        add("glazing", x, y, 0.055, width, height, 1, glassColor);
        add("trim", x - width / 2, y, 0.075, 0.045, height + 0.045, 0.035, frameColor);
        add("trim", x + width / 2, y, 0.075, 0.045, height + 0.045, 0.035, frameColor);
        add("trim", x, y + height / 2, 0.075, width + 0.045, 0.045, 0.035, frameColor);
        add("trim", x, y - height / 2, 0.075, width + 0.045, 0.045, 0.035, frameColor);
      };

      // The solid platform remains the wall and collider. Every shop detail
      // sits on its inward-facing side, clear of the perpendicular ramp.
      add("facade", 0, 1.45, 0.025, 2.4, 2.72, 1, style.wall);
      add("trim", 0, 0.10, 0.08, 2.25, 0.09, 0.11, style.trim);
      let doorX = 0;
      let porchY = 1.84;
      let porchLights: readonly number[] = [];
      let signX = 0;
      let signY = 2.5;

      switch (transform.platformIndex) {
        case 0: {
          // Light corner grocer: striped awning, filled display window and a
          // wall-mounted planter. The off-center entrance keeps it informal.
          doorX = 0.19;
          porchY = 1.83;
          porchLights = [0.19];
          signY = 2.48;
          pane(-0.66, 1.02, 0.77, 1.27, style.glass);
          pane(doorX, 0.91, 0.62, 1.61, style.door);
          pane(0.85, 1.02, 0.31, 1.27, style.glass);
          add("trim", -0.66, 0.84, 0.095, 0.74, 0.035, 0.035, style.frame);
          add("trim", -0.66, 1.19, 0.095, 0.74, 0.035, 0.035, style.frame);
          add("accent", -0.85, 0.96, 0.105, 0.15, 0.18, 0.035, 0xc96453);
          add("accent", -0.58, 0.96, 0.105, 0.13, 0.14, 0.035, 0xdfb77a);
          add("accent", -0.76, 1.34, 0.105, 0.20, 0.13, 0.035, 0x8caa70);
          add("accent", 0.41, 0.88, 0.098, 0.035, 0.14, 0.035, 0xd8c6a7);
          add("canopy", 0, 2.04, 0.22, 2.43, 0.11, 0.42, style.roof);
          for (let i = -2; i <= 2; i += 1) {
            add("accent", i * 0.48, 1.98, 0.443, 0.24, 0.065, 0.025,
              i % 2 === 0 ? style.accent : 0xe0cba9);
          }
          add("trim", -1.07, 1.42, 0.073, 0.10, 2.48, 0.08, style.frame);
          add("trim", 1.07, 1.42, 0.073, 0.10, 2.48, 0.08, style.frame);
          add("canopy", -0.75, 0.30, 0.11, 0.48, 0.17, 0.13, 0x9a7858);
          for (const leafX of [-0.87, -0.74, -0.61]) {
            add("accent", leafX, 0.49, 0.13, 0.055, 0.24, 0.025, 0x5a8058,
              leafX < -0.75 ? -0.3 : 0.3);
          }
          break;
        }
        case 1: {
          // A compact depot: sloping side ribs, louvered windows, double
          // utility doors and a narrow metal hood distinguish the other K&B.
          doorX = 0;
          porchY = 1.86;
          porchLights = [-0.43, 0.43];
          signX = 0.08;
          pane(-0.73, 1.00, 0.35, 1.26, style.glass);
          pane(0, 0.91, 0.82, 1.64, style.door);
          pane(0.73, 1.00, 0.35, 1.26, style.glass);
          add("trim", 0, 0.91, 0.092, 0.04, 1.62, 0.035, style.trim);
          add("accent", -0.14, 0.82, 0.105, 0.035, 0.16, 0.035, 0xd5d0b9);
          add("accent", 0.14, 0.82, 0.105, 0.035, 0.16, 0.035, 0xd5d0b9);
          for (const ventX of [-0.73, 0.73]) {
            for (const ventY of [0.72, 0.91, 1.10, 1.29]) {
              add("trim", ventX, ventY, 0.095, 0.30, 0.045, 0.035, style.trim);
            }
          }
          add("canopy", 0, 2.09, 0.18, 2.34, 0.09, 0.35, style.roof);
          add("accent", 0, 2.03, 0.37, 2.30, 0.055, 0.04, style.accent);
          add("trim", -1.04, 1.42, 0.105, 0.19, 2.62, 0.10, style.trim, -0.10);
          add("trim", 1.04, 1.42, 0.105, 0.19, 2.62, 0.10, style.trim, 0.10);
          add("trim", 0, 2.87, 0.073, 2.18, 0.065, 0.07, style.frame);
          for (const ventX of [-0.92, 0.92]) {
            add("glazing", ventX, 2.73, 0.068, 0.23, 0.15, 1, 0x253e3c);
            for (const ventY of [2.69, 2.74, 2.79]) {
              add("accent", ventX, ventY, 0.083, 0.19, 0.017, 0.022, 0x9aac99);
            }
          }
          add("canopy", 0.83, 0.29, 0.10, 0.34, 0.24, 0.12, 0x586d5b);
          add("accent", 0.83, 0.37, 0.18, 0.25, 0.035, 0.025, style.accent);
          break;
        }
        case 2: {
          // Magnit borrows the reference's olive wedge, shelves, planter and
          // little over-sign arms. Its front edge is a warm thin blade.
          doorX = 0.17;
          porchY = 1.84;
          porchLights = [-0.48, 0.49];
          signX = 0.05;
          pane(-0.63, 1.01, 0.68, 1.28, style.glass);
          pane(doorX, 0.91, 0.63, 1.61, style.door);
          pane(0.87, 1.00, 0.25, 1.26, style.glass);
          add("trim", -0.63, 0.78, 0.095, 0.64, 0.035, 0.035, style.frame);
          add("trim", -0.63, 1.16, 0.095, 0.64, 0.035, 0.035, style.frame);
          add("accent", -0.82, 0.93, 0.105, 0.15, 0.14, 0.035, 0xcc7657);
          add("accent", -0.53, 0.93, 0.105, 0.17, 0.14, 0.035, 0xd9bb76);
          add("accent", -0.68, 1.34, 0.105, 0.16, 0.17, 0.035, 0x8cba80);
          add("trim", 0.39, 0.82, 0.102, 0.035, 0.13, 0.035, style.frame);
          add("canopy", 0, 2.05, 0.23, 2.40, 0.09, 0.40, style.roof);
          add("accent", 0, 1.99, 0.44, 2.38, 0.035, 0.03, style.accent);
          add("trim", -1.07, 1.40, 0.092, 0.16, 2.62, 0.09, style.trim, -0.09);
          add("trim", 1.08, 1.40, 0.092, 0.12, 2.62, 0.09, style.trim);
          for (const armX of [-0.55, 0.62]) {
            add("trim", armX, 2.91, 0.14, 0.045, 0.11, 0.08, style.frame);
            add("lamp", armX + 0.05, 2.87, 0.21, 0.21, 0.035, 0.07, 0xffe4ad);
          }
          add("canopy", -0.75, 0.30, 0.11, 0.44, 0.17, 0.13, 0x9c7857);
          for (const leafX of [-0.84, -0.72, -0.61]) {
            add("accent", leafX, 0.47, 0.13, 0.048, 0.23, 0.025, 0x5f8b5b,
              leafX < -0.72 ? -0.24 : 0.24);
          }
          break;
        }
        case 3: {
          // The pale pavilion gets a stepped crown, three glazed bays,
          // twin doors and green vertical rhythm instead of a wedge.
          doorX = 0;
          porchY = 1.88;
          porchLights = [-0.46, 0.46];
          signY = 2.56;
          pane(-0.78, 1.01, 0.43, 1.32, style.glass);
          pane(0, 0.91, 0.80, 1.66, style.door);
          pane(0.78, 1.01, 0.43, 1.32, style.glass);
          add("trim", 0, 0.91, 0.092, 0.045, 1.64, 0.035, style.frame);
          add("accent", -0.15, 0.83, 0.102, 0.035, 0.15, 0.035, style.trim);
          add("accent", 0.15, 0.83, 0.102, 0.035, 0.15, 0.035, style.trim);
          for (const bayX of [-0.78, 0.78]) {
            add("trim", bayX, 0.85, 0.095, 0.40, 0.035, 0.035, style.frame);
            add("accent", bayX - 0.10, 0.99, 0.105, 0.10, 0.16, 0.025, 0x83a45e);
            add("accent", bayX + 0.10, 0.99, 0.105, 0.10, 0.16, 0.025, 0xd3a166);
          }
          add("canopy", 0, 2.13, 0.23, 2.44, 0.11, 0.43, style.roof);
          add("accent", 0, 2.07, 0.46, 2.40, 0.05, 0.03, style.accent);
          add("trim", -1.07, 1.48, 0.08, 0.075, 2.55, 0.08, style.frame);
          add("trim", 1.07, 1.48, 0.08, 0.075, 2.55, 0.08, style.frame);
          add("canopy", 0, 2.88, 0.06, 2.42, 0.10, 0.15, style.trim);
          add("canopy", 0, 2.96, 0.06, 1.65, 0.045, 0.16, style.roof);
          for (const ribX of [-0.84, -0.56, 0.56, 0.84]) {
            add("accent", ribX, 2.09, 0.47, 0.035, 0.15, 0.04, style.frame);
          }
          break;
        }
      }

      for (const lightX of porchLights) {
        add("trim", lightX, porchY + 0.075, 0.32, 0.055, 0.13, 0.10, style.trim);
        add("lamp", lightX, porchY, 0.425, 0.21, 0.045, 0.09, 0xffe9bf);
        add("glow", lightX, porchY - 0.20, 0.48, 0.67, 0.69, 1, 0xffffff);
      }
      // A faint warm wash on the entrance suggests light falling from the
      // fixture without a real light source or any additional shadows.
      add("glow", doorX, 0.99, 0.13, 1.02, 1.50, 1, 0x827465);

      const signMaterial = new THREE.MeshBasicMaterial({
        color: NEUTRAL_WHITE,
        transparent: true,
        opacity: SHOP_SIGN_OPACITY,
        depthWrite: false,
      });
      const signFrameMaterial = new THREE.MeshStandardMaterial({ color: style.frame, roughness: 0.72 });
      this.disposables.push(signMaterial, signFrameMaterial);
      const frame = detail(shop, "sign-frame", signFrameMaterial, signX * unit, signY * sy, 0.075,
        transform.signWidth + 0.10, transform.signHeight + 0.08 * sy, 0.045);
      const sign = panel(shop, "sign", signMaterial, signX * unit, signY * sy, 0.105,
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
      { kind: "lamp", geometry: box, material: lamp },
      { kind: "glow", geometry: plane, material: glow },
    ];
    for (const { kind, geometry, material } of batches) {
      const parts = staticParts[kind];
      const batch = new THREE.InstancedMesh(geometry, material, parts.length);
      batch.name = `shop-static:${kind}`;
      parts.forEach(({ matrix, color }, index) => {
        batch.setMatrixAt(index, matrix);
        batch.setColorAt(index, new THREE.Color(color));
      });
      batch.instanceMatrix.needsUpdate = true;
      if (batch.instanceColor !== null) batch.instanceColor.needsUpdate = true;
      batch.computeBoundingSphere();
      scene.add(batch);
      this.actors.push(batch);
      this.disposables.push(batch);
      if (kind === "glow") this.porchGlowBatch = batch;
    }
    this.setPorchLighting(this.porchLightingStrength);
  }

  public setPorchLighting(strength: number): void {
    this.porchLightingStrength = Number.isNaN(strength)
      ? 0 : THREE.MathUtils.clamp(strength, 0, 1);
    const value = this.porchLightingStrength;
    if (this.porchLampMaterial !== null) {
      this.porchLampMaterial.color.copy(this.porchLampOffColor).lerp(this.porchLampOnColor, value);
      this.porchLampMaterial.emissiveIntensity = value * 2.4;
    }
    if (this.porchGlowMaterial !== null) this.porchGlowMaterial.opacity = value * 0.52;
    if (this.porchGlowBatch !== null) this.porchGlowBatch.visible = value > 0.001;
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
    for (const tracked of this.disposables) {
      tracked.dispose();
    }
    this.disposables.length = 0;
    this.loaded = false;
    this.porchLampMaterial = null;
    this.porchGlowMaterial = null;
    this.porchGlowBatch = null;
    this.porchLightingStrength = 0;
  }
}
