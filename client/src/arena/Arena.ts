import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import {
  ARENA_HALF_SIZE,
  ICE_FRICTION,
  PLATFORM_FIGURES,
  PLAYER_FRICTION,
  RAMP_SLAB_THICKNESS,
  RAMP_SLOPE_DEG,
  TRAMPOLINE_PAD_DIM,
  WALL_FADE_OPACITY,
  WALL_GLASS_OPACITY,
  WALL_HEIGHT,
  WALL_THICKNESS,
  WALL_VISUAL_HEIGHT,
} from "../config";
import { ARENA_LAYOUT } from "../layout";
import type { PhysicsWorld } from "../physics/World";
import {
  ACCENT_SWAMP_BUBBLE,
  ACCENT_SWAMP_BUBBLE_LIGHT,
  ACCENT_SWAMP_MUD,
  ACCENT_SWAMP_MUD_EDGE,
  ACCENT_SWAMP_MUD_LIGHT,
  ACCENT_STRIP,
  BASE_FENCE_NET_DAY,
  BASE_FENCE_NET_NIGHT,
  BASE_FLOOR,
  BASE_FLOOR_GROUT,
  BASE_FLOOR_LIGHT,
  BASE_PAD,
  BASE_PAD_RIM,
  BASE_TRAMPOLINE,
  BASE_WALL_PLINTH,
  HL_CHARTREUSE,
  HL_CHARTREUSE_DEEP,
  NEUTRAL_WHITE,
} from "../palette";

export interface ObstacleSpec {
  x: number;
  z: number;
  hx: number;
  hy: number;
  hz: number;
}

export interface PlatformSpec {
  x: number;
  z: number;
  hx: number;
  hz: number;
  topY: number;
}

// Walk-up ramp: thin slab rotated around one horizontal axis. runM is the
// horizontal run, riseM the height gain from the low edge to the platform
// edge; slope stays gentle (~13-15 deg) so the capsule walks up, no jumping.
export interface RampSpec {
  // Center of the slab.
  x: number;
  y: number;
  z: number;
  // Slab half extents (length along the slope, thickness, width).
  halfLength: number;
  halfThick: number;
  halfWidth: number;
  // Rotation axis ("x" = slope runs along Z, "z" = slope runs along X).
  axis: "x" | "z";
  angle: number;
}

export interface ZoneSpec {
  x: number;
  z: number;
  radius: number;
}

export interface SpawnSpec {
  x: number;
  z: number;
}

const FENCE_BOARD_HEIGHT = 0.6;
const FENCE_NET_DAY_COLOR = new THREE.Color(BASE_FENCE_NET_DAY);
const FENCE_NET_NIGHT_COLOR = new THREE.Color(BASE_FENCE_NET_NIGHT);
const TRAMPOLINE_NIGHT_GAIN = 1.3;

// The shared JSON stores topY; Rapier's centered box needs half-height hy.
export function getObstacleLayout(): ObstacleSpec[] {
  return ARENA_LAYOUT.obstacles.map(({ x, z, hx, hz, topY }) => ({ x, z, hx, hz, hy: topY / 2 }));
}

// CS-like asymmetric figures (owner 2A, see config PLATFORM_FIGURES): four
// distinct hills, one per quadrant-ish lane, footprints/heights vary
// (1.8-2.6m, all <= 3m so the phone camera sees over). The center (0,0)
// stays empty for Worms drops (SUPER core spawns there).
export function getPlatforms(): PlatformSpec[] {
  return PLATFORM_FIGURES.map((figure) => ({
    x: figure.x,
    z: figure.z,
    hx: figure.hx,
    hz: figure.hz,
    topY: figure.topY,
  }));
}

// Walk-up ramps: EXACTLY ONE slab per figure, on its rampSide only — the
// other three sides stay sheer walls the capsule cannot climb. Slope is
// RAMP_SLOPE_DEG (run = topY / tan), low edge buried slightly below ground
// so there is no step at either end.
export function getRamps(): RampSpec[] {
  const slopeRad = (RAMP_SLOPE_DEG * Math.PI) / 180;
  return PLATFORM_FIGURES.map((figure) => {
    const run = figure.topY / Math.tan(slopeRad);
    const rise = figure.topY;
    const halfLength = Math.hypot(run, rise) / 2;
    const angle = Math.atan2(rise, run);
    const halfWidth = figure.rampWidth / 2;
    const thick = RAMP_SLAB_THICKNESS / 2;
    // Positive X-rotation lifts the -Z slab end (platform edge when the
    // platform sits south of the ramp); negative lifts +Z. Positive
    // Z-rotation lifts the +X slab end (platform edge when the platform
    // sits east); negative lifts -X. Mirrors the old A/B ramp convention.
    if (figure.rampSide === "+z") {
      return {
        x: figure.x,
        y: rise / 2 - 0.05,
        z: figure.z + figure.hz + run / 2,
        halfLength,
        halfThick: thick,
        halfWidth,
        axis: "x",
        angle,
      };
    }
    if (figure.rampSide === "-z") {
      return {
        x: figure.x,
        y: rise / 2 - 0.05,
        z: figure.z - figure.hz - run / 2,
        halfLength,
        halfThick: thick,
        halfWidth,
        axis: "x",
        angle: -angle,
      };
    }
    if (figure.rampSide === "+x") {
      return {
        x: figure.x + figure.hx + run / 2,
        y: rise / 2 - 0.05,
        z: figure.z,
        halfLength,
        halfThick: thick,
        halfWidth,
        axis: "z",
        angle: -angle,
      };
    }
    return {
      x: figure.x - figure.hx - run / 2,
      y: rise / 2 - 0.05,
      z: figure.z,
      halfLength,
      halfThick: thick,
      halfWidth,
      axis: "z",
      angle,
    };
  });
}

// The previous slow diagonal becomes swamp; the open diagonal holds ice.
// Static arrays avoid allocations in the movement query every frame.
const SWAMP_ZONES: readonly ZoneSpec[] = ARENA_LAYOUT.swampZones;
const ICE_ZONES: readonly ZoneSpec[] = ARENA_LAYOUT.iceZones;

export function getSwampZones(): readonly ZoneSpec[] {
  return SWAMP_ZONES;
}

export function getIceZones(): readonly ZoneSpec[] {
  return ICE_ZONES;
}

// Two auto trampolines on the center lane, clear of obstacles.
// Positions scaled +20% with the map (3.5 -> 4.2).
export function getTrampolines(): readonly ZoneSpec[] {
  return ARENA_LAYOUT.trampolines;
}

// All six authoritative FFA spawns are visible in the client arena.
export function getSpawnPoints(): readonly SpawnSpec[] {
  return ARENA_LAYOUT.spawns;
}

export function isInsideZone(x: number, z: number, zone: ZoneSpec): boolean {
  const dx = x - zone.x;
  const dz = z - zone.z;
  return dx * dx + dz * dz <= zone.radius * zone.radius;
}

export function isOnSwamp(x: number, z: number): boolean {
  for (let i = 0; i < SWAMP_ZONES.length; i += 1) {
    const zone = SWAMP_ZONES[i];
    if (zone !== undefined && isInsideZone(x, z, zone)) return true;
  }
  return false;
}

export function isOnIce(x: number, z: number): boolean {
  for (let i = 0; i < ICE_ZONES.length; i += 1) {
    const zone = ICE_ZONES[i];
    if (zone !== undefined && isInsideZone(x, z, zone)) return true;
  }
  return false;
}

export function getTrampolineAt(x: number, z: number): ZoneSpec | null {
  return getTrampolines().find((zone) => isInsideZone(x, z, zone)) ?? null;
}

// Friction reported for Rapier tuning checks (ice inside QT3-A 0.05-0.1).
export function getFrictionAt(x: number, z: number): number {
  return isOnIce(x, z) ? ICE_FRICTION : PLAYER_FRICTION;
}

// Stylized nocturnal arena. One InstancedMesh per repeated shape (perf budget), Rapier
// static colliders matching every visual that blocks movement. Owns all
// geometries/materials it creates — dispose() releases them.
export class ArenaBuilder {
  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly actors: THREE.Object3D[] = [];
  private readonly fenceMaterials: THREE.Material[] = [];
  private wallOpacity = WALL_GLASS_OPACITY;
  private fenceNetMaterial: THREE.LineBasicMaterial | null = null;
  private fenceNightBlend = 0;
  private swampBubbles: THREE.InstancedMesh | null = null;
  private swampBubbleTime = 0;
  private readonly swampBubbleMatrix = new THREE.Matrix4();
  private readonly swampBubbleScale = new THREE.Vector3();
  private readonly swampBubbleLocations: Array<{ x: number; z: number; phase: number }> = [];
  private eveningAmount = 0;
  private readonly eveningEffects: Array<{
    mesh: THREE.InstancedMesh;
    material: THREE.MeshBasicMaterial;
    opacity: number;
  }> = [];

  public buildVisuals(scene: THREE.Scene): void {
    this.buildFloor(scene);
    this.buildWalls(scene);
    this.buildObstacles(scene);
    this.buildFlowerBeds(scene);
    this.buildPlatforms(scene);
    this.buildIceZones(scene);
    this.buildSwampZones(scene);
    this.buildTrampolines(scene);
    this.buildSpawns(scene);
  }

  public buildColliders(physics: PhysicsWorld): void {
    const half = ARENA_HALF_SIZE;
    const t = WALL_THICKNESS;
    const h = WALL_HEIGHT / 2;
    physics.addStaticBox(half + t, h, t, 0, h, -half - t / 2);
    physics.addStaticBox(half + t, h, t, 0, h, half + t / 2);
    physics.addStaticBox(t, h, half + t, -half - t / 2, h, 0);
    physics.addStaticBox(t, h, half + t, half + t / 2, h, 0);
    for (const spec of getObstacleLayout()) {
      physics.addStaticBox(spec.hx, spec.hy, spec.hz, spec.x, spec.hy, spec.z);
    }
    // Two-level platforms: solid tops the capsule can stand on.
    for (const platform of getPlatforms()) {
      physics.addStaticBox(platform.hx, platform.topY / 2, platform.hz, platform.x, platform.topY / 2, platform.z);
    }
    // Walk-up ramps: rotated slabs so the capsule climbs instead of hopping.
    for (const ramp of getRamps()) {
      const quaternion = new THREE.Quaternion();
      if (ramp.axis === "x") {
        quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), ramp.angle);
      } else {
        quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), ramp.angle);
      }
      if (ramp.axis === "x") {
        physics.addStaticRotatedBox(
          ramp.halfWidth, ramp.halfThick, ramp.halfLength,
          ramp.x, ramp.y, ramp.z, quaternion,
        );
      } else {
        physics.addStaticRotatedBox(
          ramp.halfLength, ramp.halfThick, ramp.halfWidth,
          ramp.x, ramp.y, ramp.z, quaternion,
        );
      }
    }
    // Deliberately no colliders for ice/swamp (surface switch in
    // SceneManager.updatePhysics) or trampoline pads: pads are trigger-only
    // by design (proximity launch in SceneManager at TRAMPOLINE_TRIGGER_Y),
    // so the capsule passes over them freely and never gets stuck on a lip.
  }

  // Preserve SceneManager's existing camera fade API. The wire net is open
  // geometry at rest; only its wires and frame fade near a low camera. The
  // low solid board always remains opaque, like a real sports enclosure.
  public setWallOpacity(opacity: number): void {
    const clamped = Number.isFinite(opacity)
      ? Math.max(WALL_FADE_OPACITY, Math.min(WALL_GLASS_OPACITY, opacity))
      : WALL_GLASS_OPACITY;
    this.wallOpacity = clamped;
    const wireOpacity = clamped / WALL_GLASS_OPACITY;
    for (const material of this.fenceMaterials) {
      const transparent = wireOpacity < 1;
      if (material.transparent !== transparent) {
        material.transparent = transparent;
        material.needsUpdate = true;
      }
      material.opacity = wireOpacity;
      material.depthWrite = !transparent;
    }
  }

  public getWallOpacity(): number {
    return this.wallOpacity;
  }

  // The unlit wire needs its own night tone; camera opacity stays independent.
  // Retain the blend before a late build, without allocating colors per frame.
  public setFenceNightBlend(amount: number): void {
    this.fenceNightBlend = Number.isFinite(amount) ? Math.max(0, Math.min(1, amount)) : 0;
    this.fenceNetMaterial?.color.lerpColors(
      FENCE_NET_DAY_COLOR, FENCE_NET_NIGHT_COLOR, this.fenceNightBlend,
    );
  }

  // The authoritative round's evening phase is supplied by SceneManager.
  // Keep it before a late build as well; updates only touch existing materials.
  public setEveningLighting(amount: number): void {
    this.eveningAmount = Number.isFinite(amount) ? Math.max(0, Math.min(1, amount)) : 0;
    for (const effect of this.eveningEffects) {
      effect.mesh.visible = this.eveningAmount > 0;
      effect.material.opacity = effect.opacity * this.eveningAmount;
    }
  }

  // Called from SceneManager.updateCombat in both play and spectator paths.
  // Only one instance buffer changes; bubbles share one geometry/material.
  public update(deltaSeconds: number): void {
    const bubbles = this.swampBubbles;
    if (bubbles === null || deltaSeconds <= 0) return;
    this.swampBubbleTime += deltaSeconds;
    for (let i = 0; i < this.swampBubbleLocations.length; i += 1) {
      const bubble = this.swampBubbleLocations[i];
      if (bubble === undefined) continue;
      const phase = (this.swampBubbleTime * 0.48 + bubble.phase) % 1;
      const pulse = Math.sin(Math.PI * phase);
      const scale = 0.05 + 0.43 * pulse;
      this.swampBubbleMatrix.makeRotationX(-Math.PI / 2);
      this.swampBubbleScale.set(scale, scale, 1);
      this.swampBubbleMatrix.scale(this.swampBubbleScale);
      this.swampBubbleMatrix.setPosition(bubble.x, 0.04 + 0.012 * pulse, bubble.z);
      bubbles.setMatrixAt(i, this.swampBubbleMatrix);
    }
    bubbles.instanceMatrix.needsUpdate = true;
  }

  public dispose(scene: THREE.Scene): void {
    for (const actor of this.actors) {
      scene.remove(actor);
    }
    this.actors.length = 0;
    this.fenceMaterials.length = 0;
    this.wallOpacity = WALL_GLASS_OPACITY;
    this.fenceNetMaterial = null;
    this.fenceNightBlend = 0;
    this.swampBubbles = null;
    this.swampBubbleTime = 0;
    this.swampBubbleLocations.length = 0;
    this.eveningAmount = 0;
    this.eveningEffects.length = 0;
    for (const tracked of this.disposables) {
      tracked.dispose();
    }
    this.disposables.length = 0;
  }

  private track<T extends { dispose(): void }>(resource: T): T {
    this.disposables.push(resource);
    return resource;
  }

  private place(object: THREE.Object3D, scene: THREE.Scene): void {
    scene.add(object);
    this.actors.push(object);
  }

  private buildFloor(scene: THREE.Scene): void {
    const size = ARENA_HALF_SIZE * 2;
    const geometry = this.track(new THREE.PlaneGeometry(size, size));
    const texture = this.track(createFloorTexture());
    // One unique arena-wide pattern removes the short repeating tile stamp.
    texture.repeat.set(1, 1);
    const material = this.track(
      new THREE.MeshStandardMaterial({ color: NEUTRAL_WHITE, map: texture, roughness: 0.94, metalness: 0 }),
    );
    const floor = new THREE.Mesh(geometry, material);
    floor.name = "arena-floor";
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.place(floor, scene);
  }

  private buildWalls(scene: THREE.Scene): void {
    const half = ARENA_HALF_SIZE;
    const t = WALL_THICKNESS;
    const length = (half + t) * 2;
    const transforms = [
      { x: 0, z: -half - t / 2, turn: 0 },
      { x: 0, z: half + t / 2, turn: 0 },
      { x: -half - t / 2, z: 0, turn: Math.PI / 2 },
      { x: half + t / 2, z: 0, turn: Math.PI / 2 },
    ];
    const box = new THREE.BoxGeometry(1, 1, 1);
    const boardParts = emptyColoredParts();
    const frameParts = emptyColoredParts();
    const transform = new THREE.Matrix4();
    const local = new THREE.Matrix4();
    const matrix = new THREE.Matrix4();
    const boardColor = new THREE.Color(0xc2c4b2);
    const baseColor = new THREE.Color(BASE_WALL_PLINTH);
    const frameColor = new THREE.Color(0x71847b);
    const netPositions: number[] = [];
    const point = new THREE.Vector3();
    const spacing = 0.5;
    const lowY = FENCE_BOARD_HEIGHT + 0.06;
    const highY = WALL_VISUAL_HEIGHT - 0.06;
    const addBox = (parts: ColoredParts, color: THREE.Color,
      x: number, y: number, width: number, height: number, depth: number): void => {
      local.makeScale(width, height, depth).setPosition(x, y, 0);
      matrix.multiplyMatrices(transform, local);
      appendColoredGeometry(box, matrix, color, parts.positions, parts.normals, parts.colors);
    };
    for (const wall of transforms) {
      transform.makeRotationY(wall.turn).setPosition(wall.x, 0, wall.z);
      addBox(boardParts, boardColor, 0, FENCE_BOARD_HEIGHT / 2, length, FENCE_BOARD_HEIGHT, t);
      addBox(boardParts, baseColor, 0, 0.065, length, 0.13, t + 0.008);
      // Narrow flush joints make the continuous lower board look assembled.
      const panels = Math.ceil(length / 3);
      for (let panel = 0; panel <= panels; panel += 1) {
        const x = -length / 2 + panel / panels * length;
        addBox(frameParts, frameColor, x, WALL_VISUAL_HEIGHT / 2, 0.075, WALL_VISUAL_HEIGHT, 0.075);
        if (panel > 0 && panel < panels) {
          addBox(boardParts, baseColor, x, FENCE_BOARD_HEIGHT / 2, 0.018, FENCE_BOARD_HEIGHT - 0.09, t + 0.009);
        }
      }
      for (const y of [FENCE_BOARD_HEIGHT + 0.0325, WALL_VISUAL_HEIGHT - 0.0325]) {
        addBox(frameParts, frameColor, 0, y, length, 0.065, 0.065);
      }
      // Two clipped diagonal families form real open diamonds. There is no
      // transparent sheet behind the wires, so the exterior remains visible.
      for (const slope of [-1, 1]) {
        for (let offset = -length / 2 - highY; offset <= length / 2 + highY; offset += spacing) {
          const ends: Array<[number, number]> = [];
          for (const y of [lowY, highY]) {
            const x = offset + slope * (y - lowY);
            if (x >= -length / 2 && x <= length / 2) ends.push([x, y]);
          }
          for (const x of [-length / 2, length / 2]) {
            const y = lowY + (x - offset) / slope;
            if (y > lowY && y < highY) ends.push([x, y]);
          }
          if (ends.length !== 2) continue;
          for (const [x, y] of ends) {
            point.set(x, y, 0).applyMatrix4(transform);
            netPositions.push(point.x, point.y, point.z);
          }
        }
      }
    }
    box.dispose();
    const boards = new THREE.Mesh(this.track(coloredPartsGeometry(boardParts)), this.track(
      new THREE.MeshStandardMaterial({ color: NEUTRAL_WHITE, vertexColors: true, roughness: 0.91 }),
    ));
    boards.name = "sports-fence-boards";
    boards.receiveShadow = true;
    boards.castShadow = true;
    this.place(boards, scene);
    const frameMaterial = this.track(new THREE.MeshStandardMaterial({
      color: NEUTRAL_WHITE, vertexColors: true, roughness: 0.7, metalness: 0.2,
    }));
    const frame = new THREE.Mesh(this.track(coloredPartsGeometry(frameParts)), frameMaterial);
    frame.name = "sports-fence-frame";
    frame.receiveShadow = true;
    this.place(frame, scene);
    const netGeometry = this.track(new THREE.BufferGeometry());
    netGeometry.setAttribute("position", new THREE.Float32BufferAttribute(netPositions, 3));
    netGeometry.computeBoundingSphere();
    const netMaterial = this.track(new THREE.LineBasicMaterial({ color: BASE_FENCE_NET_DAY }));
    this.fenceNetMaterial = netMaterial;
    this.setFenceNightBlend(this.fenceNightBlend);
    const net = new THREE.LineSegments(netGeometry, netMaterial);
    net.name = "sports-fence-diamond-net";
    this.place(net, scene);
    this.fenceMaterials.push(frameMaterial, netMaterial);
    this.setWallOpacity(this.wallOpacity);
  }

  private buildObstacles(scene: THREE.Scene): void {
    // The four 2m covers are shop stock: full wooden crates, mixed cartons,
    // palletized timber, and a taped carton stack. All upper panels remain on
    // the saved landing height; every detail fits the original solid volume.
    const timber = emptyColoredParts();
    const packaging = emptyColoredParts();
    const box = new THREE.BoxGeometry(1, 1, 1);
    const coverMatrix = new THREE.Matrix4();
    const local = new THREE.Matrix4();
    const matrix = new THREE.Matrix4();
    const wood = new THREE.Color(0xe1c294);
    const darkWood = new THREE.Color(0xa48760);
    const boardEdge = new THREE.Color(0x74603f);
    const cartonColors = [0xac8658, 0xc69b6a, 0xba9061, 0xa88760].map((hex) => new THREE.Color(hex));
    const tape = new THREE.Color(0xd2b78b);
    const label = new THREE.Color(0xd8d5bf);
    const ink = new THREE.Color(0x605546);
    const addBox = (parts: ColoredParts, color: THREE.Color, x: number, y: number, z: number,
      width: number, height: number, depth: number, angle = 0): void => {
      local.makeRotationZ(angle).scale(new THREE.Vector3(width, height, depth)).setPosition(x, y, z);
      matrix.multiplyMatrices(coverMatrix, local);
      appendColoredGeometry(box, matrix, color, parts.positions, parts.normals, parts.colors);
    };
    const pallet = (base: number): void => {
      for (const x of [-0.8, 0, 0.8]) {
        for (const z of [-0.78, 0, 0.78]) {
          addBox(timber, darkWood, x, base + 0.08, z, 0.24, 0.16, 0.3);
        }
      }
      for (const z of [-0.83, 0, 0.83]) {
        addBox(timber, wood, 0, base + 0.045, z, 2, 0.055, 0.28);
      }
      for (let plank = 0; plank < 6; plank += 1) {
        const z = -1 + (plank + 0.5) * 2 / 6;
        addBox(timber, plank % 2 ? darkWood : wood, 0, base + 0.19, z, 2, 0.06, 2 / 6 - 0.028);
      }
    };
    const crate = (x: number, z: number, width: number, height: number, depth: number,
      base: number, variant: number): void => {
      // The solid backing sits behind its planks/straps, which remain inside
      // the saved cover boundary. Visible detail must not be buried in a box.
      addBox(timber, wood, x, base + height / 2, z, width - 0.044, height - 0.02, depth - 0.044);
      const band = 0.075;
      for (const sign of [-1, 1]) {
        const frontZ = z + sign * (depth / 2 - 0.02);
        const sideX = x + sign * (width / 2 - 0.02);
        for (let seam = 1; seam < 4; seam += 1) {
          const y = base + seam * height / 4;
          addBox(timber, boardEdge, x, y, frontZ, width - 0.025, 0.012, 0.038);
          addBox(timber, boardEdge, sideX, y, z, 0.038, 0.012, depth - 0.025);
        }
        for (const edge of [-1, 1]) {
          addBox(timber, darkWood, x + edge * (width / 2 - band / 2), base + height / 2,
            frontZ + sign * 0.0005, band, height, 0.038);
          addBox(timber, darkWood, sideX + sign * 0.0005, base + height / 2,
            z + edge * (depth / 2 - band / 2), 0.038, height, band);
        }
        if (variant % 2 === 0) {
          const run = width - 0.24;
          const rise = height - 0.24;
          addBox(timber, darkWood, x, base + height / 2, frontZ + sign * 0.001,
            Math.hypot(run, rise), 0.065, 0.038, sign * Math.atan2(rise, run));
        }
      }
      // Planks and dark joints tile the same flush top, without coplanar
      // overlays. Their shared saved height remains a safe landing surface.
      const lidDepth = depth - 0.078;
      const plankDepth = lidDepth / 5;
      for (let plank = 0; plank < 5; plank += 1) {
        addBox(timber, wood, x, base + height - 0.005,
          z - lidDepth / 2 + (plank + 0.5) * plankDepth, width - 0.078, 0.01, plankDepth - 0.012);
        if (plank > 0) {
          addBox(timber, boardEdge, x, base + height - 0.005,
            z - lidDepth / 2 + plank * plankDepth, width - 0.078, 0.01, 0.012);
        }
      }
    };
    const carton = (x: number, z: number, width: number, height: number, depth: number,
      base: number, variant: number): void => {
      const cardboard = cartonColors[variant % cartonColors.length]!;
      addBox(packaging, cardboard, x, base + height / 2 + 0.003, z,
        width - 0.018, height - 0.018, depth - 0.018);
      // The thin lid keeps the old top exactly; a shallow gap below each
      // stacked body separates the layers. Its central tape/fold is tiled
      // into the lid so no two top faces compete for the same depth.
      const lidHalfWidth = (width - 0.018 - 0.13) / 2;
      for (const side of [-1, 1]) {
        addBox(packaging, cardboard, x + side * (0.065 + lidHalfWidth / 2),
          base + height - 0.003, z, lidHalfWidth, 0.006, depth - 0.018);
        addBox(packaging, tape, x + side * 0.0355, base + height - 0.003,
          z, 0.059, 0.006, depth);
      }
      addBox(packaging, ink, x, base + height - 0.003, z, 0.012, 0.006, depth);
      for (const sign of [-1, 1]) {
        const faceZ = z + sign * (depth / 2 - 0.005);
        addBox(packaging, tape, x, base + height / 2, faceZ, 0.13, height, 0.004);
        addBox(packaging, label, x - width * 0.23, base + height * 0.62, faceZ,
          width * 0.19, height * 0.22, 0.006);
        for (let line = 0; line < 3; line += 1) {
          addBox(packaging, ink, x - width * 0.23, base + height * (0.58 + line * 0.04),
            faceZ + sign * 0.002, width * (line === 2 ? 0.08 : 0.13), 0.008, 0.004);
        }
      }
    };
    for (const [index, cover] of getObstacleLayout().slice(0, 4).entries()) {
      coverMatrix.makeScale(cover.hx, cover.hy, cover.hz).setPosition(cover.x, 0, cover.z);
      pallet(0);
      if (index === 0) {
        for (const x of [-0.505, 0.505]) {
          crate(x, 0, 0.99, 0.89, 2, 0.22, 0);
          crate(x, 0, 0.99, 0.89, 2, 1.11, 2);
        }
      } else if (index === 1) {
        crate(0, 0, 2, 0.66, 2, 0.22, 1);
        for (const x of [-0.505, 0.505]) {
          for (const z of [-0.505, 0.505]) carton(x, z, 0.99, 1.12, 0.99, 0.88, x < 0 ? 1 : 2);
        }
      } else if (index === 2) {
        pallet(0.22);
        crate(0, -0.505, 2, 1.56, 0.99, 0.44, 0);
        crate(0, 0.505, 2, 1.56, 0.99, 0.44, 1);
      } else {
        for (let layer = 0; layer < 2; layer += 1) {
          for (let row = 0; row < 3; row += 1) {
            for (const [column, x] of [-0.505, 0.505].entries()) {
              carton(x, -1 + (row + 0.5) * 2 / 3, 0.99, 0.89, 2 / 3 - 0.018,
                0.22 + layer * 0.89, row + layer + column);
            }
          }
        }
      }
    }
    box.dispose();
    const woodTexture = this.track(createWoodTexture());
    const timberMesh = new THREE.Mesh(this.track(coloredPartsGeometry(timber)), this.track(
      new THREE.MeshStandardMaterial({
        color: NEUTRAL_WHITE, map: woodTexture, vertexColors: true, roughness: 0.95,
      }),
    ));
    timberMesh.name = "storage-timber";
    const packagingMesh = new THREE.Mesh(this.track(coloredPartsGeometry(packaging)), this.track(
      new THREE.MeshStandardMaterial({ color: NEUTRAL_WHITE, vertexColors: true, roughness: 1 }),
    ));
    packagingMesh.name = "storage-packaging";
    for (const mesh of [timberMesh, packagingMesh]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.place(mesh, scene);
    }
  }

  private buildFlowerBeds(scene: THREE.Scene): void {
    // The entire low cover is a planter: full-height masonry perimeter,
    // broad soil surface at the saved standing height, low planting throughout.
    const beds = getObstacleLayout().slice(4, 8);
    const box = new THREE.BoxGeometry(1, 1, 1);
    const greeneryGeometry = createFlowerStemGeometry();
    const parts = emptyColoredParts();
    const soilColor = new THREE.Color(0x695b45);
    const borderColor = new THREE.Color(0xa9aa91);
    const jointColor = new THREE.Color(0x8b8e79);
    const greeneryColor = new THREE.Color(0x71844b);
    const blossomGeometry = this.track(createBlossomGeometry());
    const blossomMaterial = this.track(new THREE.MeshStandardMaterial({
      color: NEUTRAL_WHITE, vertexColors: true, roughness: 0.95, side: THREE.DoubleSide,
    }));
    const flowersPerBed = 20;
    const blossoms = this.track(new THREE.InstancedMesh(
      blossomGeometry, blossomMaterial, beds.length * flowersPerBed,
    ));
    blossoms.name = "side-flower-blossoms";
    const matrix = new THREE.Matrix4();
    const rotation = new THREE.Quaternion();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const flowerColors = [new THREE.Color(0xe3bf70), new THREE.Color(0xd69991), new THREE.Color(0xe4dfc9)];
    const addBox = (color: THREE.Color, x: number, y: number, z: number,
      width: number, height: number, depth: number): void => {
      matrix.makeScale(width, height, depth).setPosition(x, y, z);
      appendColoredGeometry(box, matrix, color, parts.positions, parts.normals, parts.colors);
    };
    beds.forEach((bed, bedIndex) => {
      const topY = bed.hy * 2;
      const rim = Math.min(0.1, bed.hx * 0.12, bed.hz * 0.12);
      const width = bed.hx * 2;
      const depth = bed.hz * 2;
      addBox(soilColor, bed.x, topY / 2, bed.z, width - rim * 2, topY, depth - rim * 2);
      for (const side of [-1, 1]) {
        addBox(borderColor, bed.x, topY / 2, bed.z + side * (bed.hz - rim / 2), width, topY, rim);
        addBox(borderColor, bed.x + side * (bed.hx - rim / 2), topY / 2, bed.z,
          rim, topY, depth - rim * 2);
        // Restrained blockwork joints stay on the planter faces, below its top.
        for (let seam = 1; seam < 4; seam += 1) {
          addBox(jointColor, bed.x - bed.hx + seam * width / 4, topY / 2,
            bed.z + side * (bed.hz - 0.004), 0.018, topY - 0.1, 0.008);
          addBox(jointColor, bed.x + side * (bed.hx - 0.004), topY / 2,
            bed.z - bed.hz + seam * depth / 4, 0.008, topY - 0.1, 0.018);
        }
      }
      for (let flower = 0; flower < flowersPerBed; flower += 1) {
        const index = bedIndex * flowersPerBed + flower;
        const variation = hash2(flower + 31, bedIndex + 5);
        const height = 0.155 + variation * 0.1;
        const column = flower % 5;
        const row = Math.floor(flower / 5);
        position.set(
          bed.x + (column / 4 - 0.5) * (width - rim * 2) * 0.8 + (variation - 0.5) * 0.08,
          topY,
          bed.z + (row / 3 - 0.5) * (depth - rim * 2) * 0.8
            + (hash2(flower + 7, bedIndex + 11) - 0.5) * 0.08,
        );
        rotation.setFromAxisAngle(new THREE.Vector3(0, 1, 0), variation * Math.PI * 2);
        const foliageWidth = (0.85 + variation * 0.3) * 1.25;
        scale.set(foliageWidth, height, foliageWidth);
        matrix.compose(position, rotation, scale);
        appendColoredGeometry(greeneryGeometry, matrix, greeneryColor, parts.positions, parts.normals, parts.colors);
        position.y += height;
        scale.setScalar((0.7 + variation * 0.25) * 1.35);
        matrix.compose(position, rotation, scale);
        blossoms.setMatrixAt(index, matrix);
        blossoms.setColorAt(index, flowerColors[(flower + bedIndex) % flowerColors.length]!);
      }
    });
    box.dispose();
    greeneryGeometry.dispose();
    const bedMaterial = this.track(new THREE.MeshStandardMaterial({
      color: NEUTRAL_WHITE, vertexColors: true, roughness: 1, side: THREE.DoubleSide,
    }));
    const soilAndGreenery = new THREE.Mesh(this.track(coloredPartsGeometry(parts)), bedMaterial);
    soilAndGreenery.name = "side-flower-beds";
    soilAndGreenery.castShadow = true;
    blossoms.instanceMatrix.needsUpdate = true;
    for (const mesh of [soilAndGreenery, blossoms]) {
      mesh.receiveShadow = true;
      this.place(mesh, scene);
    }
    if (blossoms.instanceColor !== null) blossoms.instanceColor.needsUpdate = true;
  }

  private buildPlatforms(scene: THREE.Scene): void {
    // The authoritative shop volumes provide the same unobstructed flat roof.
    // Neutral membrane and flush metal flashing replace the old green top.
    const platforms = getPlatforms();
    const topGeometry = this.track(new RoundedBoxGeometry(1, 1, 1, 2, 0.045));
    paintBoxFaceVertices(topGeometry, 0x929997, 0xd5d4c8);
    const roofTexture = this.track(createRoofTexture());
    const topMaterial = this.track(new THREE.MeshStandardMaterial({
      color: NEUTRAL_WHITE, map: roofTexture, roughness: 0.97, metalness: 0, vertexColors: true,
    }));
    const tops = this.track(new THREE.InstancedMesh(topGeometry, topMaterial, platforms.length));
    tops.name = "platform-volumes";
    const matrix = new THREE.Matrix4();
    const accents = [0xf7f8f5, 0xffffff, 0xecefee, 0xf5f3ed].map((hex) => new THREE.Color(hex));
    platforms.forEach((platform, index) => {
      matrix.makeScale(platform.hx * 2, platform.topY, platform.hz * 2);
      matrix.setPosition(platform.x, platform.topY / 2, platform.z);
      tops.setMatrixAt(index, matrix);
      tops.setColorAt(index, accents[index]!);
    });
    tops.instanceMatrix.needsUpdate = true;
    if (tops.instanceColor !== null) tops.instanceColor.needsUpdate = true;
    tops.castShadow = true;
    tops.receiveShadow = true;
    this.place(tops, scene);
    // Flashing sits flush with topY and is only 3cm thick. No rails, parapets,
    // roof equipment or raised seams obstruct movement or ladder exits.
    const box = new THREE.BoxGeometry(1, 1, 1);
    const flashing = emptyColoredParts();
    const metal = new THREE.Color(0xb8bcb6);
    for (const platform of platforms) {
      const inset = 0.015;
      const stripWidth = 0.055;
      for (const side of [-1, 1]) {
        matrix.makeScale(platform.hx * 2 - inset * 2, 0.03, stripWidth);
        matrix.setPosition(platform.x, platform.topY - 0.015,
          platform.z + side * (platform.hz - inset - stripWidth / 2));
        appendColoredGeometry(box, matrix, metal, flashing.positions, flashing.normals, flashing.colors);
        matrix.makeScale(stripWidth, 0.03, platform.hz * 2 - inset * 2 - stripWidth * 2);
        matrix.setPosition(platform.x + side * (platform.hx - inset - stripWidth / 2),
          platform.topY - 0.015, platform.z);
        appendColoredGeometry(box, matrix, metal, flashing.positions, flashing.normals, flashing.colors);
      }
    }
    box.dispose();
    const flashingMesh = new THREE.Mesh(this.track(coloredPartsGeometry(flashing)), this.track(
      new THREE.MeshStandardMaterial({ color: NEUTRAL_WHITE, vertexColors: true, roughness: 0.73, metalness: 0.22 }),
    ));
    flashingMesh.name = "shop-roof-flashings";
    flashingMesh.receiveShadow = true;
    this.place(flashingMesh, scene);

    // Open wooden ladders follow the exact original slab transforms. Rails and
    // rungs share one low-poly timber batch; their tops stay on the unchanged
    // collision surface, including the existing clearance beneath its high end.
    const woodTexture = this.track(createWoodTexture());
    const rampMaterial = this.track(new THREE.MeshStandardMaterial({
      color: NEUTRAL_WHITE, map: woodTexture, roughness: 0.96, metalness: 0,
    }));
    const ramps = getRamps();
    const rungCounts = ramps.map((ramp) => Math.ceil(ramp.halfLength * 2 / 0.64) + 1);
    const rampGeometry = this.track(new THREE.BoxGeometry(1, 1, 1));
    const ladders = this.track(new THREE.InstancedMesh(
      rampGeometry, rampMaterial, rungCounts.reduce((sum, count) => sum + count + 2, 0),
    ));
    ladders.name = "ramp-wooden-ladders";
    const rotation = new THREE.Quaternion();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const center = new THREE.Vector3();
    const lightWood = new THREE.Color(NEUTRAL_WHITE);
    const darkWood = new THREE.Color(0xe3d1b8);
    let timberIndex = 0;
    ramps.forEach((ramp, rampIndex) => {
      const runsOnZ = ramp.axis === "x";
      rotation.setFromAxisAngle(
        runsOnZ ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1),
        ramp.angle,
      );
      center.set(ramp.x, ramp.y, ramp.z);
      const railWidth = 0.14;
      for (const side of [-1, 1]) {
        const across = side * (ramp.halfWidth - railWidth / 2);
        position.set(runsOnZ ? across : 0, 0, runsOnZ ? 0 : across);
        position.applyQuaternion(rotation).add(center);
        scale.set(runsOnZ ? railWidth : ramp.halfLength * 2,
          ramp.halfThick * 2, runsOnZ ? ramp.halfLength * 2 : railWidth);
        matrix.compose(position, rotation, scale);
        ladders.setMatrixAt(timberIndex, matrix);
        ladders.setColorAt(timberIndex++, darkWood);
      }
      const rungCount = rungCounts[rampIndex] ?? 0;
      const rungDepth = 0.16;
      const rungThick = Math.min(0.14, ramp.halfThick * 2);
      const span = ramp.halfWidth * 2 - railWidth * 2;
      for (let rung = 0; rung < rungCount; rung += 1) {
        const along = (rung / (rungCount - 1) - 0.5) * (ramp.halfLength * 2 - rungDepth);
        position.set(runsOnZ ? 0 : along, ramp.halfThick - rungThick / 2, runsOnZ ? along : 0);
        position.applyQuaternion(rotation).add(center);
        scale.set(runsOnZ ? span : rungDepth, rungThick, runsOnZ ? rungDepth : span);
        matrix.compose(position, rotation, scale);
        ladders.setMatrixAt(timberIndex, matrix);
        ladders.setColorAt(timberIndex++, rung % 3 === 0 ? darkWood : lightWood);
      }
    });
    ladders.instanceMatrix.needsUpdate = true;
    if (ladders.instanceColor !== null) ladders.instanceColor.needsUpdate = true;
    ladders.castShadow = true;
    ladders.receiveShadow = true;
    this.place(ladders, scene);
  }

  private buildIceZones(scene: THREE.Scene): void {
    const zones = getIceZones();
    const geometry = this.track(new THREE.CircleGeometry(1, 40));
    const texture = this.track(createIceTexture());
    const material = this.track(
      new THREE.MeshStandardMaterial({
        color: NEUTRAL_WHITE,
        map: texture,
        transparent: true,
        opacity: 0.96,
        depthWrite: false,
        roughness: 0.34,
        metalness: 0,
      }),
    );
    const puddles = this.track(new THREE.InstancedMesh(geometry, material, zones.length));
    puddles.name = "ice-zones";
    const matrix = new THREE.Matrix4();
    const rotation = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
    zones.forEach((zone, index) => {
      matrix.copy(rotation);
      matrix.scale(new THREE.Vector3(zone.radius, zone.radius, 1));
      matrix.setPosition(zone.x, 0.02, zone.z);
      puddles.setMatrixAt(index, matrix);
    });
    puddles.instanceMatrix.needsUpdate = true;
    this.place(puddles, scene);
  }

  private buildSwampZones(scene: THREE.Scene): void {
    const zones = getSwampZones();
    const texture = this.track(createSwampTexture());
    const geometry = this.track(new THREE.PlaneGeometry(2, 2));
    const material = this.track(new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      alphaTest: 0.1,
      depthWrite: false,
      side: THREE.DoubleSide,
    }));
    const ground = this.track(new THREE.InstancedMesh(geometry, material, zones.length));
    ground.name = "swamp-zones";
    const matrix = new THREE.Matrix4();
    const rotation = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
    const scale = new THREE.Vector3();
    zones.forEach((zone, index) => {
      matrix.copy(rotation);
      scale.set(zone.radius, zone.radius, 1);
      matrix.scale(scale);
      matrix.setPosition(zone.x, 0.025, zone.z);
      ground.setMatrixAt(index, matrix);
    });
    ground.instanceMatrix.needsUpdate = true;
    ground.frustumCulled = false;
    this.place(ground, scene);

    const bubbleGeometry = this.track(createBubbleGeometry());
    const bubbleMaterial = this.track(new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      side: THREE.DoubleSide,
    }));
    // Seven sparse circular ripples per circle, all in one draw call. The instance
    // matrix alone changes each frame; positions and phases are deterministic.
    const bubbleCountPerZone = 7;
    const bubbles = this.track(new THREE.InstancedMesh(bubbleGeometry, bubbleMaterial, zones.length * bubbleCountPerZone));
    bubbles.name = "swamp-bubbles";
    bubbles.frustumCulled = false;
    zones.forEach((zone, zoneIndex) => {
      for (let i = 0; i < bubbleCountPerZone; i += 1) {
        const angle = (i * 2.399963229728653) + zoneIndex * 0.45;
        const distance = zone.radius * (0.22 + (i % 4) * 0.18);
        this.swampBubbleLocations.push({
          x: zone.x + Math.cos(angle) * distance,
          z: zone.z + Math.sin(angle) * distance,
          phase: (i * 0.61803398875 + zoneIndex * 0.31) % 1,
        });
      }
    });
    this.swampBubbles = bubbles;
    this.update(1 / 60);
    this.place(bubbles, scene);
  }

  private buildTrampolines(scene: THREE.Scene): void {
    const zones = getTrampolines();
    const baseGeometry = this.track(new THREE.CylinderGeometry(1, 1.15, 0.25, 24));
    const baseMaterial = this.track(
      new THREE.MeshStandardMaterial({ color: BASE_TRAMPOLINE, roughness: 0.7, metalness: 0.2 }),
    );
    const bases = new THREE.InstancedMesh(baseGeometry, baseMaterial, zones.length);
    const padGeometry = this.track(new THREE.CylinderGeometry(0.85, 0.85, 0.12, 24));
    const padTexture = this.track(createPadTexture());
    const padMaterial = this.track(
      new THREE.MeshStandardMaterial({
        color: NEUTRAL_WHITE,
        map: padTexture,
        emissive: HL_CHARTREUSE,
        // 4d.3 feedback dim (-20% via TRAMPOLINE_PAD_DIM, palette untouched).
        emissiveIntensity: 0.9 * TRAMPOLINE_PAD_DIM,
        roughness: 0.5,
      }),
    );
    const pads = new THREE.InstancedMesh(padGeometry, padMaterial, zones.length);
    pads.name = "trampoline-pads";
    const matrix = new THREE.Matrix4();
    zones.forEach((zone, index) => {
      matrix.makeScale(zone.radius, 1, zone.radius);
      matrix.setPosition(zone.x, 0.125, zone.z);
      bases.setMatrixAt(index, matrix);
      matrix.makeScale(zone.radius, 1, zone.radius);
      matrix.setPosition(zone.x, 0.3, zone.z);
      pads.setMatrixAt(index, matrix);
    });
    bases.instanceMatrix.needsUpdate = true;
    pads.instanceMatrix.needsUpdate = true;
    pads.castShadow = true;
    this.place(bases, scene);
    this.place(pads, scene);
    this.buildTrampolineEveningEffects(scene, zones);
  }

  private buildTrampolineEveningEffects(scene: THREE.Scene, zones: readonly ZoneSpec[]): void {
    // These are emissive-looking surface meshes, never additional lights or
    // shadows. Two soft ground decals and four small inward-facing decals use
    // one shared radial map; the white-to-black face vertices fade upward.
    const glowTexture = this.track(createGroundGlowTexture());
    const rimGeometry = this.track(new THREE.RingGeometry(0.82, 0.87, 40));
    const rimMaterial = this.track(new THREE.MeshBasicMaterial({
      color: new THREE.Color(HL_CHARTREUSE).multiplyScalar(TRAMPOLINE_NIGHT_GAIN),
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide, toneMapped: false,
    }));
    const rims = this.track(new THREE.InstancedMesh(rimGeometry, rimMaterial, zones.length));
    rims.name = "trampoline-night-rims";
    const groundGeometry = this.track(new THREE.PlaneGeometry(2, 2));
    const groundMaterial = this.track(new THREE.MeshBasicMaterial({
      map: glowTexture, color: HL_CHARTREUSE, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }));
    const ground = this.track(new THREE.InstancedMesh(groundGeometry, groundMaterial, zones.length));
    ground.name = "trampoline-ground-spill";
    const matrix = new THREE.Matrix4();
    const flatRotation = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
    zones.forEach((zone, index) => {
      matrix.copy(flatRotation).scale(new THREE.Vector3(zone.radius, zone.radius, 1));
      matrix.setPosition(zone.x, 0.365, zone.z);
      rims.setMatrixAt(index, matrix);
      matrix.copy(flatRotation).scale(new THREE.Vector3(5.05, 5.05, 1));
      matrix.setPosition(zone.x, 0.032, zone.z);
      ground.setMatrixAt(index, matrix);
    });

    const blocks = getObstacleLayout().slice(0, 4);
    const faceGeometry = this.track(new THREE.PlaneGeometry(1, 1));
    const positions = faceGeometry.getAttribute("position");
    const colors = new Float32Array(positions.count * 3);
    for (let i = 0; i < positions.count; i += 1) {
      const brightness = 0.5 - positions.getY(i);
      colors.set([brightness, brightness, brightness], i * 3);
    }
    faceGeometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const faceMaterial = this.track(new THREE.MeshBasicMaterial({
      map: glowTexture, color: HL_CHARTREUSE, vertexColors: true, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }));
    const faces = this.track(new THREE.InstancedMesh(faceGeometry, faceMaterial, blocks.length));
    faces.name = "trampoline-block-spill";
    blocks.forEach((block, index) => {
      // The saved middle blocks sit either side of the pads, so their inner
      // X faces receive the spill. The plane stays strictly within each face.
      const facing = -Math.sign(block.x);
      matrix.makeRotationY(facing * Math.PI / 2);
      matrix.scale(new THREE.Vector3(block.hz * 2 - 0.24, block.hy * 2 - 0.24, 1));
      matrix.setPosition(block.x + facing * (block.hx + 0.006), block.hy, block.z);
      faces.setMatrixAt(index, matrix);
    });
    const effects = [
      { mesh: rims, material: rimMaterial, opacity: 0.92 },
      { mesh: ground, material: groundMaterial, opacity: 0.14 * TRAMPOLINE_NIGHT_GAIN },
      { mesh: faces, material: faceMaterial, opacity: 0.16 * TRAMPOLINE_NIGHT_GAIN },
    ];
    for (const effect of effects) {
      effect.mesh.instanceMatrix.needsUpdate = true;
      this.eveningEffects.push(effect);
      this.place(effect.mesh, scene);
    }
    this.setEveningLighting(this.eveningAmount);
  }

  private buildSpawns(scene: THREE.Scene): void {
    const spawns = getSpawnPoints();
    const geometry = this.track(new THREE.RingGeometry(0.5, 0.7, 32));
    const material = this.track(
      new THREE.MeshBasicMaterial({ color: HL_CHARTREUSE, transparent: true, opacity: 0.8, side: THREE.DoubleSide }),
    );
    const markers = new THREE.InstancedMesh(geometry, material, spawns.length);
    const matrix = new THREE.Matrix4();
    const rotation = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
    spawns.forEach((spawn, index) => {
      matrix.copy(rotation);
      matrix.setPosition(spawn.x, 0.03, spawn.z);
      markers.setMatrixAt(index, matrix);
    });
    markers.instanceMatrix.needsUpdate = true;
    this.place(markers, scene);
  }
}

// Paint whole faces, rather than using vertex Y (which used to brighten the
// top edge of side walls). Cool shade and warm-facing sides stay distinct even
// on devices with a small shadow map. Vertex colors are linear in Three.js.
function paintBoxFaceVertices(geometry: THREE.BufferGeometry, topHex: number, sideHex: number): void {
  const normals = geometry.getAttribute("normal");
  const colors = new Float32Array(normals.count * 3);
  const top = new THREE.Color(topHex);
  const warm = new THREE.Color(sideHex).lerp(new THREE.Color(ACCENT_STRIP), 0.11);
  const cool = new THREE.Color(sideHex).multiplyScalar(0.78);
  const bottom = new THREE.Color(sideHex).multiplyScalar(0.62);
  for (let i = 0; i < normals.count; i += 1) {
    const picked = normals.getY(i) > 0.5 ? top
      : normals.getY(i) < -0.5 ? bottom
        : normals.getX(i) + normals.getZ(i) > 0 ? warm : cool;
    colors[i * 3] = picked.r;
    colors[i * 3 + 1] = picked.g;
    colors[i * 3 + 2] = picked.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}

function makeRgbTexture(size: number, pick: (x: number, y: number) => number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const hex = pick(x, y);
      const pixel = (y * size + x) * 4;
      data[pixel] = (hex >> 16) & 255;
      data[pixel + 1] = (hex >> 8) & 255;
      data[pixel + 2] = hex & 255;
      data[pixel + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

// Deterministic, quiet variation generated once, never per frame.
function hash2(x: number, y: number): number {
  return (((x * 73856093) ^ (y * 19349663)) >>> 0) % 1024 / 1024;
}

function mixHex(a: number, b: number, t: number): number {
  const amount = Math.max(0, Math.min(1, t));
  const r = Math.round(((a >> 16) & 255) * (1 - amount) + ((b >> 16) & 255) * amount);
  const g = Math.round(((a >> 8) & 255) * (1 - amount) + ((b >> 8) & 255) * amount);
  const blue = Math.round((a & 255) * (1 - amount) + (b & 255) * amount);
  return (r << 16) | (g << 8) | blue;
}

function createFloorTexture(): THREE.DataTexture {
  const size = 256;
  const rows = 12;
  const rowHeight = size / rows;
  // Unequal, staggered joints avoid both a straight grid and repeated stamps.
  const joints = Array.from({ length: rows }, (_, row) => {
    const boundaries = [-32 + hash2(row + 19, 3) * 24];
    let edge = boundaries[0] ?? 0;
    for (let tile = 0; edge < size + 32; tile += 1) {
      edge += 18 + hash2(tile + 17, row + 41) * 10;
      boundaries.push(edge);
    }
    return boundaries;
  });
  const texture = makeRgbTexture(256, (x, y) => {
    const bentY = y + Math.sin(x * 0.043) * 0.55 + Math.sin(x * 0.13) * 0.25;
    const row = Math.max(0, Math.min(rows - 1, Math.floor(bentY / rowHeight)));
    const rowJoints = joints[row] ?? [];
    let tile = 0;
    let verticalDistance = size;
    for (let i = 0; i < rowJoints.length; i += 1) {
      const edge = (rowJoints[i] ?? 0) + Math.sin(y * 0.17 + row) * 0.4;
      if (x > edge) tile = i;
      verticalDistance = Math.min(verticalDistance, Math.abs(x - edge));
    }
    const variation = 0.3 + hash2(tile + 7, row + 13) * 0.24
      + Math.sin(x * 0.075 + y * 0.049) * 0.045
      + Math.sin(x * 0.031 - y * 0.093) * 0.035;
    const stone = mixHex(BASE_FLOOR, BASE_FLOOR_LIGHT, variation);
    const horizontalDistance = Math.abs(bentY - Math.round(bentY / rowHeight) * rowHeight);
    // Broad low-contrast erosion is continuous, avoiding chunky dash marks.
    const wornVertical = Math.max(0, Math.sin(y * 0.31 + tile * 1.7 + row) - 0.05) * 0.26;
    const wornHorizontal = Math.max(0, Math.sin(x * 0.23 + row * 2.3) - 0.15) * 0.22;
    const seam = Math.max(
      Math.max(0, 1 - verticalDistance / 0.9) * wornVertical,
      Math.max(0, 1 - horizontalDistance / 1.05) * wornHorizontal,
    );
    return mixHex(stone, BASE_FLOOR_GROUT, seam);
  });
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

function createWoodTexture(): THREE.DataTexture {
  const texture = makeRgbTexture(64, (x, y) => {
    const grain = Math.sin(y * 0.62 + Math.sin(x * 0.09) * 1.7);
    const weathering = Math.sin(x * 0.07 + y * 0.15) * 0.05;
    return mixHex(0x806344, 0xb39366, 0.45 + grain * 0.065 + weathering);
  });
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

function createRoofTexture(): THREE.DataTexture {
  // Long membrane-sheet seams are flat albedo marks, not raised geometry.
  return makeRgbTexture(128, (x, y) => {
    const grain = (hash2(x + 61, y + 17) - 0.5) * 0.065;
    const seam = Math.min(Math.abs(x - 43), Math.abs(x - 86)) < 1.5;
    return mixHex(0xd0d2cd, 0xe8e9e5, seam ? 0.05 : 0.63 + grain);
  });
}

function createGroundGlowTexture(): THREE.DataTexture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const radius = Math.hypot((x + 0.5 - size / 2) / (size / 2), (y + 0.5 - size / 2) / (size / 2));
      const fade = Math.max(0, 1 - radius * radius);
      const pixel = (y * size + x) * 4;
      data.set([255, 255, 255, Math.round(fade * fade * 255)], pixel);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

function appendColoredGeometry(
  geometry: THREE.BufferGeometry,
  matrix: THREE.Matrix4,
  color: THREE.Color,
  positions: number[],
  normals: number[],
  colors: number[],
): void {
  const sourcePositions = geometry.getAttribute("position");
  const sourceNormals = geometry.getAttribute("normal");
  const indices = geometry.getIndex();
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
  const position = new THREE.Vector3();
  const normal = new THREE.Vector3();
  for (let i = 0; i < (indices?.count ?? sourcePositions.count); i += 1) {
    const vertex = indices?.getX(i) ?? i;
    position.fromBufferAttribute(sourcePositions, vertex).applyMatrix4(matrix);
    normal.fromBufferAttribute(sourceNormals, vertex).applyNormalMatrix(normalMatrix);
    positions.push(position.x, position.y, position.z);
    normals.push(normal.x, normal.y, normal.z);
    colors.push(color.r, color.g, color.b);
  }
}

interface ColoredParts {
  positions: number[];
  normals: number[];
  colors: number[];
}

function emptyColoredParts(): ColoredParts {
  return { positions: [], normals: [], colors: [] };
}

function coloredPartsGeometry(parts: ColoredParts): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(parts.positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(parts.normals, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(parts.colors, 3));
  // Box faces have a common simple grain scale; repeatable local UVs keep the
  // timber batched even after all instance transforms are baked into vertices.
  const uvs: number[] = [];
  for (let i = 0; i < parts.positions.length; i += 3) {
    const x = parts.positions[i]!;
    const y = parts.positions[i + 1]!;
    const z = parts.positions[i + 2]!;
    const nx = Math.abs(parts.normals[i]!);
    const ny = Math.abs(parts.normals[i + 1]!);
    uvs.push(nx > 0.5 ? z : x, ny > 0.5 ? z : y);
  }
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeBoundingSphere();
  return geometry;
}

function createFlowerStemGeometry(): THREE.BufferGeometry {
  const stem = new THREE.BoxGeometry(0.012, 1, 0.012);
  const stemPositions = stem.getAttribute("position");
  const indices = stem.getIndex();
  const positions: number[] = [];
  for (let i = 0; i < (indices?.count ?? 0); i += 1) {
    const index = indices?.getX(i) ?? 0;
    positions.push(stemPositions.getX(index), stemPositions.getY(index) + 0.5, stemPositions.getZ(index));
  }
  stem.dispose();
  for (const side of [-1, 1]) {
    const y = side < 0 ? 0.38 : 0.62;
    positions.push(
      0, y, 0, side * 0.08, y + 0.18, -0.035, side * 0.13, y + 0.29, 0,
      0, y, 0, side * 0.13, y + 0.29, 0, side * 0.08, y + 0.18, 0.035,
    );
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function createBlossomGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const center = new THREE.Color(0xc4ab63);
  const petals = 6;
  for (let i = 0; i < petals; i += 1) {
    const angle = i * Math.PI * 2 / petals;
    const point = (a: number, radius: number, y: number): number[] => [Math.cos(a) * radius, y, Math.sin(a) * radius];
    const inner = point(angle, 0.018, 0.012);
    const left = point(angle - 0.31, 0.071, 0.006);
    const tip = point(angle, 0.1, 0.022);
    const right = point(angle + 0.31, 0.071, 0.006);
    positions.push(...inner, ...left, ...tip, ...inner, ...tip, ...right);
    for (let vertex = 0; vertex < 6; vertex += 1) colors.push(1, 1, 1);
    positions.push(0, 0.025, 0, ...point(angle, 0.027, 0.014), ...point(angle + Math.PI * 2 / petals, 0.027, 0.014));
    for (let vertex = 0; vertex < 3; vertex += 1) colors.push(center.r, center.g, center.b);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

// Pale cloudy ice and sparse wandering fractures share the existing surface
// map. Its translucent, slightly uneven edge blends into the paving without
// a bright rim, extra meshes or self illumination.
function createIceTexture(): THREE.DataTexture {
  const size = 128;
  const data = new Uint8Array(size * size * 4);
  const paths = [
    [[-0.97, -0.34], [-0.72, -0.26], [-0.54, -0.31], [-0.32, -0.18], [-0.05, -0.2],
      [0.2, -0.03], [0.49, 0.08], [0.76, 0.09], [0.98, 0.23]],
    [[0.28, -0.97], [0.17, -0.78], [0.23, -0.58], [0.1, -0.4], [-0.05, -0.2]],
    [[0.49, 0.08], [0.37, 0.3], [0.46, 0.47], [0.3, 0.63], [0.35, 0.94]],
    [[-0.72, -0.26], [-0.75, -0.05], [-0.58, 0.12]],
    [[0.17, -0.78], [0.43, -0.66], [0.65, -0.73]],
  ];
  const segments = paths.flatMap((path) => {
    const points = new THREE.SplineCurve(path.map(([x, y]) => new THREE.Vector2(x!, y!))).getPoints(24);
    return points.slice(1).map((point, index) => {
      const start = points[index]!;
      const dx = point.x - start.x;
      const dy = point.y - start.y;
      return { x: start.x, y: start.y, dx, dy, lengthSq: dx * dx + dy * dy };
    });
  });
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x + 0.5 - size / 2) / (size / 2);
      const dy = (y + 0.5 - size / 2) / (size / 2);
      const radius = Math.hypot(dx, dy);
      const angle = Math.atan2(dy, dx);
      const warpedX = dx + Math.sin(dy * 4.7 + 0.5) * 0.13;
      const warpedY = dy + Math.sin(dx * 5.3 - 1) * 0.12;
      const clouds = 0.5 + Math.sin(warpedX * 5.2 + warpedY * 3.1) * 0.2
        + Math.cos(warpedX * 8.4 - warpedY * 5.7) * 0.15
        + Math.sin(warpedY * 16.3 + warpedX * 12.1) * 0.08;
      let distanceSq = Infinity;
      // A small meander keeps the sampled fractures organic at close range.
      const crackX = dx + Math.sin(dy * 23 + 1) * 0.006;
      const crackY = dy + Math.sin(dx * 19 - 0.7) * 0.005;
      for (const segment of segments) {
        const t = Math.max(0, Math.min(1,
          ((crackX - segment.x) * segment.dx + (crackY - segment.y) * segment.dy) / segment.lengthSq));
        distanceSq = Math.min(distanceSq,
          (crackX - segment.x - t * segment.dx) ** 2 + (crackY - segment.y - t * segment.dy) ** 2);
      }
      const distance = Math.sqrt(distanceSq);
      const fracture = Math.max(0, 1 - distance / 0.0095);
      const frostedLip = Math.max(0, 1 - Math.abs(distance - 0.011) / 0.007) * 0.08;
      let color = mixHex(0x82b9d2, 0xbddfe8, clouds + (hash2(x, y) - 0.5) * 0.018);
      color = mixHex(color, 0xd1e8ef, frostedLip);
      color = mixHex(color, 0x668da4, fracture * 0.38);
      const matteEdge = Math.max(0, Math.min(1, (radius - 0.85) / 0.14));
      color = mixHex(color, 0xabcdd8, matteEdge * 0.22);
      const edge = 0.982 + Math.sin(angle * 5 + 0.4) * 0.008 + Math.sin(angle * 11 - 1) * 0.005;
      const alpha = Math.max(0, Math.min(1, (edge - radius) / 0.035));
      const pixel = (y * size + x) * 4;
      data[pixel] = (color >> 16) & 255;
      data[pixel + 1] = (color >> 8) & 255;
      data[pixel + 2] = color & 255;
      data[pixel + 3] = Math.round(alpha * 255);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

// Concentric mechanical rings clarify the trampoline's trigger surface.
function createPadTexture(): THREE.DataTexture {
  return makeRgbTexture(128, (x, y) => {
    const dx = (x - 63.5) / 63.5;
    const dy = (y - 63.5) / 63.5;
    const radius = Math.hypot(dx, dy);
    if (radius > 0.84) return BASE_PAD_RIM;
    if (radius > 0.58 && radius < 0.67) return HL_CHARTREUSE_DEEP;
    if (radius < 0.22) return HL_CHARTREUSE_DEEP;
    return BASE_PAD;
  });
}

// Smooth 128px mud decal with broad, quiet mineral swirls and an organic soft
// edge. One map is shared by every zone and disposed with the arena.
function createSwampTexture(): THREE.DataTexture {
  const size = 128;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x + 0.5 - size / 2) / (size / 2);
      const dy = (y + 0.5 - size / 2) / (size / 2);
      const radius = Math.hypot(dx, dy);
      const angle = Math.atan2(dy, dx);
      const edge = 0.96 + 0.018 * Math.sin(angle * 5 + 0.6)
        + 0.011 * Math.sin(angle * 9 - 1.3);
      const alpha = Math.max(0, Math.min(1, (edge - radius) / 0.065 + 0.35));
      const swirl = Math.sin(angle * 3 + radius * 13 + Math.sin(angle * 2) * 0.6);
      const depth = mixHex(ACCENT_SWAMP_MUD_EDGE, ACCENT_SWAMP_MUD, 0.22 + radius * 0.76);
      const color = mixHex(depth, ACCENT_SWAMP_MUD_LIGHT,
        Math.max(0, (swirl + 0.35) * 0.11) + Math.max(0, 1 - Math.abs(radius - 0.78) / 0.11) * 0.12);
      const pixel = (y * size + x) * 4;
      data[pixel] = (color >> 16) & 255;
      data[pixel + 1] = (color >> 8) & 255;
      data[pixel + 2] = color & 255;
      data[pixel + 3] = Math.round(alpha * 245);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

// Rounded broken rings read as gas bubbles in still mud. All 14 animated
// ripples share this geometry and one instanced mesh.
function createBubbleGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const light = new THREE.Color(ACCENT_SWAMP_BUBBLE_LIGHT);
  const dark = new THREE.Color(ACCENT_SWAMP_BUBBLE);
  const segments = 24;
  for (let i = 0; i < segments; i += 1) {
    if (i === 2 || i === 3 || i === 15) continue;
    const angle0 = i * Math.PI * 2 / segments;
    const angle1 = (i + 1) * Math.PI * 2 / segments;
    const inner = 0.58;
    const outer = 0.72;
    const x0 = Math.cos(angle0);
    const y0 = Math.sin(angle0);
    const x1 = Math.cos(angle1);
    const y1 = Math.sin(angle1);
    const tint = i < 12 ? light : dark;
    positions.push(
      x0 * inner, y0 * inner, 0, x0 * outer, y0 * outer, 0, x1 * outer, y1 * outer, 0,
      x0 * inner, y0 * inner, 0, x1 * outer, y1 * outer, 0, x1 * inner, y1 * inner, 0,
    );
    for (let vertex = 0; vertex < 6; vertex += 1) colors.push(tint.r, tint.g, tint.b);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();
  return geometry;
}
