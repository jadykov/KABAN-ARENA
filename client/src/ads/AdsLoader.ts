import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
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
  { wall: 0xe0ded7, frame: 0xbd333b, trim: 0x69747a, roof: 0xd1d7d8, accent: 0xbe3039, glass: 0x78949e, door: 0x6a8791, metal: 0xa3afb4, base: 0x727c81 },
  { wall: 0xb9c1c4, frame: 0xd9dfdf, trim: 0x38454c, roof: 0x3e4b52, accent: 0xb9323c, glass: 0x536f7b, door: 0x617f8a, metal: 0x929fa6, base: 0x46555d },
  { wall: 0xd6dbdc, frame: 0xbdc8cc, trim: 0x566970, roof: 0xb92c39, accent: 0xc02f3c, glass: 0x77969f, door: 0x66858f, metal: 0xa0aeb4, base: 0x717d83 },
  { wall: 0xe2e7e0, frame: 0x367d47, trim: 0xc0cecb, roof: 0x42814e, accent: 0xc54247, glass: 0x819fa4, door: 0x729099, metal: 0xa1b0b2, base: 0x7b8889 },
] as const;

// Keep the accepted reach while adding another 20% to Stage 11's brightness.
const PORCH_LIGHT_INTENSITY_GAIN = 1.15 * 1.20;
const PORCH_LIGHT_REACH_GAIN = 1.15;

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
    // A single low-segment bevel softens awnings, beams and fixtures without
    // adding materials or changing the platform colliders.
    const box = new RoundedBoxGeometry(1, 1, 1, 1, 0.045);
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
      forceSinglePass: true,
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
    const localEuler = new THREE.Euler();
    const addStatic = (
      kind: StaticKind, root: THREE.Group,
      x: number, y: number, z: number, width: number, height: number, depth: number,
      color: number, tiltZ = 0, tiltX = 0, tiltY = 0,
    ): void => {
      root.updateMatrix();
      localPosition.set(x, y, z);
      localScale.set(width, height, depth);
      localRotation.setFromEuler(localEuler.set(tiltX, tiltY, tiltZ));
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
      const platform = PLATFORM_FIGURES[transform.platformIndex];
      if (platform === undefined) throw new Error("Missing shop platform");
      const wallDepth = 2 * (platform.rampSide.endsWith("z") ? platform.hx : platform.hz);
      const wallWidth = 2 * (platform.rampSide.endsWith("z") ? platform.hz : platform.hx);
      const rearFaceZ = -wallDepth - 0.04;
      const add = (
        kind: StaticKind, x: number, y: number, z: number,
        width: number, height: number, depth: number, color: number,
      ): void => addStatic(
        kind, shop, x * unit, y * sy, z,
        width * unit, height * sy, depth, color,
      );
      const back = (
        kind: "trim" | "canopy" | "accent",
        x: number, y: number, width: number, height: number, depth: number,
        color: number, layer = 0,
      ): void => add(kind, x, y, rearFaceZ - depth / 2 - layer, width, height, depth, color);
      const pairedBeams = (
        x: number, y: number, z: number, width: number, height: number,
        depth: number, color: number,
      ): void => {
        for (const side of [-1, 1]) add("trim", side * x, y, z, width, height, depth, color);
      };
      const pane = (
        x: number, y: number, width: number, height: number,
        glassColor: number, frameColor: number = style.frame,
      ): void => {
        add("glazing", x, y, 0.055, width, height, 1, glassColor);
        add("trim", x - width / 2, y, 0.075, 0.045, height + 0.045, 0.035, frameColor);
        add("trim", x + width / 2, y, 0.075, 0.045, height + 0.045, 0.035, frameColor);
        add("trim", x, y + height / 2, 0.075, width + 0.045, 0.045, 0.035, frameColor);
        add("trim", x, y - height / 2, 0.075, width + 0.045, 0.045, 0.035, frameColor);
      };

      // Dress the existing platform walls rather than placing a separate hut
      // on the deck. Full-width cladding and a continuous branded fascia
      // cover all four faces; the top and its original collider stay clear.
      type WallFace = "front" | "rear" | "left" | "right";
      const faces: readonly WallFace[] = ["front", "rear", "left", "right"];
      const rampDirection = new THREE.Vector3(
        platform.rampSide.endsWith("x") ? (platform.rampSide.startsWith("+") ? 1 : -1) : 0,
        0,
        platform.rampSide.endsWith("z") ? (platform.rampSide.startsWith("+") ? 1 : -1) : 0,
      ).applyAxisAngle(new THREE.Vector3(0, 1, 0), -transform.rotationY);
      const rampFace: WallFace = rampDirection.x > 0 ? "right" : "left";
      const facePart = (
        kind: StaticKind, face: WallFace, across: number, y: number,
        width: number, height: number, depth: number, color: number, layer = 0,
      ): void => {
        const side = face === "left" || face === "right";
        const angle = face === "front" ? 0 : face === "rear" ? Math.PI
          : face === "left" ? -Math.PI / 2 : Math.PI / 2;
        // Side fixtures use at most 4 cm of relief. On the ramp side they
        // stay below the landing and away from the ramp's central width.
        const planePart = kind === "facade" || kind === "glazing";
        const relief = planePart ? layer : layer + depth / 2;
        const local = new THREE.Vector3(across, y * sy, relief)
          .applyAxisAngle(new THREE.Vector3(0, 1, 0), angle);
        local.x += side ? (face === "left" ? -1 : 1) * (wallWidth / 2 + 0.012) : 0;
        local.z += face === "front" ? 0.025 : face === "rear" ? rearFaceZ : -wallDepth / 2 - 0.015;
        addStatic(kind, shop, local.x, local.y, local.z,
          width, height * sy, depth, color, 0, 0, angle);
      };
      for (const face of faces) {
        const side = face === "left" || face === "right";
        const faceWidth = side ? wallDepth : wallWidth;
        facePart("facade", face, 0, 1.49, faceWidth, 2.94, 1, style.wall);
        facePart("accent", face, 0, 0.16, faceWidth - 0.04, 0.23, 0.018, style.base);
        // The landing-side fascia remains below the ramp slab. Only the
        // flush wall skin continues higher; no cornice crosses the deck.
        const bandY = face === rampFace ? 2.42 : 2.55;
        const bandHeight = face === rampFace ? 0.52 : 0.78;
        const bandColor = transform.platformIndex === 0 ? style.roof
          : transform.platformIndex === 1 ? style.trim : style.accent;
        facePart("accent", face, 0, bandY, faceWidth - 0.025, bandHeight, 0.018, bandColor, 0.003);
        if (transform.platformIndex <= 1) {
          facePart("accent", face, 0, bandY - bandHeight / 2 + 0.075,
            faceWidth - 0.025, 0.15, 0.018, style.accent, 0.024);
        }
        if (transform.platformIndex === 3) {
          facePart("trim", face, 0, bandY - bandHeight / 2 - 0.045,
            faceWidth - 0.025, 0.075, 0.022, style.frame, 0.003);
        }
        // Few broad panel joints read as retail cladding at game scale.
        // They stop beneath the brand band instead of making a fine grid.
        for (const joint of [-0.30, 0.30]) {
          facePart("trim", face, joint * faceWidth, 1.25,
            0.014, 1.82, 0.012, style.metal, 0.001);
        }
      }

      // A long side display has aluminium framing. The other side is the
      // ramp landing: only wall panels and a shallow corner louver appear
      // there, outside the slope width and below its walking surface.
      for (const face of ["left", "right"] as const) {
        if (face === rampFace) {
          const cornerWidth = (wallDepth - platform.rampWidth) / 2;
          if (cornerWidth > 0.30) {
            const across = wallDepth / 2 - cornerWidth / 2;
            facePart("glazing", face, across, 1.86, cornerWidth * 0.72, 0.29, 1, style.trim, 0.016);
            for (const y of [1.77, 1.86, 1.95]) {
              facePart("trim", face, across, y, cornerWidth * 0.65, 0.025, 0.012, style.metal, 0.019);
            }
          }
          continue;
        }
        const displayWidth = wallDepth * 0.59;
        facePart("glazing", face, 0, 1.24, displayWidth, 1.32, 1, style.glass, 0.016);
        for (const across of [-displayWidth / 2, 0, displayWidth / 2]) {
          facePart("trim", face, across, 1.24, 0.035, 1.36, 0.016, style.frame, 0.021);
        }
        for (const y of [0.58, 1.90]) {
          facePart("trim", face, 0, y, displayWidth + 0.035, 0.035, 0.016, style.frame, 0.021);
        }
        facePart("accent", face, 0, 0.73, displayWidth - 0.045, 0.19, 0.012, style.accent, 0.024);
      }

      let doorX = 0;
      let porchY = 1.84;
      let porchLights: readonly number[] = [];
      let signX = 0;
      let signY = 2.5;

      switch (transform.platformIndex) {
        case 0: {
          // White K&B: silver entrance hood, red jambs and broad glazing.
          doorX = 0.19;
          porchY = 1.83;
          porchLights = [0.19];
          signY = 2.48;
          pane(-0.66, 1.09, 0.77, 1.48, style.glass);
          pane(doorX, 0.91, 0.62, 1.61, style.door, style.metal);
          pane(0.85, 1.09, 0.31, 1.48, style.glass);
          add("accent", -0.66, 0.63, 0.103, 0.71, 0.19, 0.018, style.accent);
          add("accent", 0.41, 0.88, 0.105, 0.035, 0.18, 0.035, style.metal);
          add("canopy", 0, 2.04, 0.22, 2.43, 0.10, 0.42, style.roof);
          add("accent", 0, 1.98, 0.443, 2.38, 0.085, 0.025, style.accent);
          pairedBeams(1.07, 1.42, 0.073, 0.10, 2.48, 0.08, style.frame);
          break;
        }
        case 1: {
          // Charcoal K&B: red side piers, double glass doors and slim hood.
          porchY = 1.86;
          porchLights = [-0.43, 0.43];
          signX = 0.08;
          pane(-0.73, 1.08, 0.35, 1.42, style.glass);
          pane(0, 0.91, 0.82, 1.64, style.door);
          pane(0.73, 1.08, 0.35, 1.42, style.glass);
          add("trim", 0, 0.91, 0.092, 0.04, 1.62, 0.035, style.frame);
          for (const handleX of [-0.14, 0.14]) {
            add("accent", handleX, 0.82, 0.105, 0.035, 0.18, 0.035, style.metal);
          }
          add("canopy", 0, 2.09, 0.18, 2.34, 0.09, 0.35, style.roof);
          add("accent", 0, 2.03, 0.37, 2.30, 0.055, 0.04, style.accent);
          pairedBeams(1.04, 1.42, 0.105, 0.13, 2.62, 0.07, style.accent);
          break;
        }
        case 2: {
          // Magnit: light composite panels, red fascia, aluminium entrance.
          doorX = 0.17;
          porchY = 1.84;
          porchLights = [-0.48, 0.48];
          signX = 0.05;
          pane(-0.63, 1.10, 0.68, 1.48, style.glass);
          pane(doorX, 0.91, 0.63, 1.61, style.door);
          pane(0.87, 1.10, 0.25, 1.48, style.glass);
          add("accent", -0.63, 0.65, 0.103, 0.61, 0.19, 0.018, style.accent);
          add("trim", 0.39, 0.82, 0.105, 0.035, 0.18, 0.035, style.metal);
          add("canopy", 0, 2.05, 0.23, 2.40, 0.09, 0.40, style.roof);
          add("accent", 0, 1.99, 0.44, 2.38, 0.035, 0.03, style.accent);
          pairedBeams(1.07, 1.40, 0.092, 0.15, 2.62, 0.07, style.frame);
          for (const armX of [-0.59, 0.59]) {
            add("trim", armX, 2.91, 0.14, 0.045, 0.11, 0.08, style.trim);
            add("lamp", armX, 2.87, 0.21, 0.21, 0.035, 0.07, 0xffe4ad);
          }
          break;
        }
        case 3: {
          // Pyaterochka: red header and green portal frame, pale panel walls.
          porchY = 1.88;
          porchLights = [-0.46, 0.46];
          signY = 2.56;
          pane(-0.78, 1.08, 0.43, 1.46, style.glass, style.metal);
          pane(0, 0.91, 0.80, 1.66, style.door, style.metal);
          pane(0.78, 1.08, 0.43, 1.46, style.glass, style.metal);
          add("trim", 0, 0.91, 0.092, 0.045, 1.64, 0.035, style.metal);
          for (const handleX of [-0.15, 0.15]) {
            add("accent", handleX, 0.83, 0.105, 0.035, 0.18, 0.035, style.metal);
          }
          for (const bayX of [-0.78, 0.78]) {
            add("accent", bayX, 0.64, 0.103, 0.37, 0.22, 0.018, style.frame);
          }
          add("canopy", 0, 2.13, 0.23, 2.44, 0.11, 0.43, style.roof);
          add("accent", 0, 2.07, 0.46, 2.40, 0.05, 0.03, style.accent);
          pairedBeams(1.07, 1.48, 0.08, 0.10, 2.55, 0.07, style.frame);
          add("canopy", 0, 2.88, 0.06, 2.42, 0.075, 0.12, style.accent);
          break;
        }
      }

      const serviceDoor = (x: number, y: number, width: number, height: number): void => {
        back("trim", x, y, width, height, 0.04, style.metal);
        for (const edgeX of [x - width / 2 - 0.025, x + width / 2 + 0.025]) {
          back("trim", edgeX, y, 0.04, height + 0.05, 0.035, style.trim, 0.025);
        }
        back("trim", x, y + height / 2 + 0.025, width + 0.09, 0.045, 0.035, style.trim, 0.025);
        back("accent", x - width / 2 + 0.12, y + 0.04, 0.12, 0.035, 0.03, style.trim, 0.06);
      };
      const rearVent = (x: number, y: number, width: number): void => {
        back("trim", x, y, width, 0.34, 0.04, style.trim);
        for (const offset of [-0.10, 0, 0.10]) {
          back("accent", x, y + offset, width - 0.08, 0.03, 0.02, style.metal, 0.045);
        }
      };
      // Plain metal doors and broad louvers replace the wooden door and
      // crossed cottage window. These fixtures remain on the rear wall.
      switch (transform.platformIndex) {
        case 0:
          serviceDoor(0.53, 0.91, 0.68, 1.70);
          rearVent(-0.64, 1.78, 0.73);
          break;
        case 1:
          back("trim", 0.55, 1.05, 0.76, 1.60, 0.045, style.metal);
          for (const shutterY of [0.58, 0.90, 1.22, 1.54]) {
            back("accent", 0.55, shutterY, 0.72, 0.025, 0.025, style.trim, 0.045);
          }
          back("canopy", -0.58, 1.89, 0.66, 0.54, 0.17, style.metal);
          back("trim", -0.58, 1.89, 0.53, 0.39, 0.025, style.trim, 0.18);
          for (const ventY of [1.78, 1.89, 2.00]) {
            back("accent", -0.58, ventY, 0.42, 0.025, 0.02, style.frame, 0.215);
          }
          break;
        case 2:
          serviceDoor(0.57, 0.94, 0.70, 1.76);
          rearVent(-0.58, 1.74, 0.78);
          break;
        case 3:
          serviceDoor(-0.49, 0.93, 0.67, 1.72);
          rearVent(0.52, 1.60, 0.72);
          back("trim", 1.00, 0.70, 0.035, 1.20, 0.035, style.metal);
          break;
      }

      for (const lightX of porchLights) {
        add("trim", lightX, porchY + 0.075, 0.32, 0.055, 0.13, 0.10, style.trim);
        add("lamp", lightX, porchY, 0.425, 0.21, 0.045, 0.09, 0xffe9bf);
        // A compact source-centered core reads as a lit fixture rather than
        // only a patch on the wall. It fits inside the existing halo and uses
        // that same additive batch, texture and smooth activation.
        add("glow", lightX, porchY, 0.482, 0.31, 0.18, 1, 0xffffff);
        add("glow", lightX, porchY - 0.20, 0.48,
          0.67 * PORCH_LIGHT_REACH_GAIN, 0.69 * PORCH_LIGHT_REACH_GAIN, 1, 0xffffff);
      }
      // A faint warm wash on the entrance suggests light falling from the
      // fixture without a real light source or any additional shadows.
      add("glow", doorX, 0.99, 0.13,
        1.02 * PORCH_LIGHT_REACH_GAIN, 1.50 * PORCH_LIGHT_REACH_GAIN, 1, 0x827465);
      // The old halos only sat vertically against each entrance. A quiet
      // floor spill now carries their warm reach into the walkable approach;
      // it shares their radial fade, material and single instanced draw.
      addStatic("glow", shop, doorX * unit, 0.018, 0.85,
        1.70 * unit * PORCH_LIGHT_REACH_GAIN, 2.10 * PORCH_LIGHT_REACH_GAIN, 1,
        0x8d7759, 0, -Math.PI / 2);

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
      this.porchLampMaterial.emissiveIntensity = value * 2.4 * PORCH_LIGHT_INTENSITY_GAIN;
    }
    if (this.porchGlowMaterial !== null) this.porchGlowMaterial.opacity = value * 0.52 * PORCH_LIGHT_INTENSITY_GAIN;
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
