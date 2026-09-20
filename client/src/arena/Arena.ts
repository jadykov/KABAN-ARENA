import * as THREE from "three";
import {
  ARENA_HALF_SIZE,
  ICE_FRICTION,
  PLATFORM_CAP_DROP,
  PLATFORM_FIGURES,
  PLAYER_FRICTION,
  RAMP_SLAB_THICKNESS,
  RAMP_SLOPE_DEG,
  SLIPPERY_RADIUS,
  SPAWN_COUNT,
  SPAWN_INSET,
  TRAMPOLINE_RADIUS,
  WALL_FADE_OPACITY,
  WALL_GLASS_OPACITY,
  WALL_HEIGHT,
  WALL_THICKNESS,
} from "../config";
import type { PhysicsWorld } from "../physics/World";
import {
  ACCENT_ICE_GLOW,
  ACCENT_OBSTACLE_TINT,
  ACCENT_STRIP,
  ACCENT_STRIP_BASE,
  BASE_CAP,
  BASE_FIGURE_TINTS,
  BASE_FLOOR,
  BASE_ICE,
  BASE_OBSTACLE,
  BASE_OBSTACLE_TOP,
  BASE_PAD,
  BASE_PLATFORM,
  BASE_PLATFORM_TOP,
  BASE_RAMP,
  BASE_TRAMPOLINE,
  BASE_WALL,
  HL_CHARTREUSE,
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

// QD5-A: 8 symmetric obstacle blocks + Stage 4d.3 central towers. Layout is
// mirror-symmetric on both axes and under 180-degree rotation, so no spawn
// side has an advantage. The 4 CENTRAL blocks (at +-4.8) are doubled to
// hy 1.0 (2.0m full height, topY 2.0 — mirrors server SERVER_OBSTACLES):
// reachable ONLY via trampoline bounce (no ramps touch them — see the
// Arena.test trampoline-only pin), so they read as high ground worth
// fighting for. The 4 OUTER blocks (at +-10.8) stay low (hy 0.4) so the
// phone camera always sees over the lanes. Positions/half-extents unchanged
// (gameplay density kept); block sizes scaled +20% with the map long ago
// (4 -> 4.8, 9 -> 10.8).
export function getObstacleLayout(): ObstacleSpec[] {
  const corner: ObstacleSpec[] = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      corner.push({ x: 4.8 * sx, z: 4.8 * sz, hx: 1, hy: 1.0, hz: 1 });
    }
  }
  return [
    ...corner,
    { x: 10.8, z: 0, hx: 1.5, hy: 0.4, hz: 0.75 },
    { x: -10.8, z: 0, hx: 1.5, hy: 0.4, hz: 0.75 },
    { x: 0, z: 10.8, hx: 0.75, hy: 0.4, hz: 1.5 },
    { x: 0, z: -10.8, hx: 0.75, hy: 0.4, hz: 1.5 },
  ];
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

// Two slippery puddles/ice zones, 180-degree symmetric, clear of obstacles.
// Positions scaled +20% with the map (8/-5 -> 9.6/-6).
export function getSlipperyZones(): ZoneSpec[] {
  return [
    { x: 9.6, z: -6, radius: SLIPPERY_RADIUS },
    { x: -9.6, z: 6, radius: SLIPPERY_RADIUS },
  ];
}

// Two auto trampolines on the center lane, clear of obstacles.
// Positions scaled +20% with the map (3.5 -> 4.2).
export function getTrampolines(): ZoneSpec[] {
  return [
    { x: 0, z: 4.2, radius: TRAMPOLINE_RADIUS },
    { x: 0, z: -4.2, radius: TRAMPOLINE_RADIUS },
  ];
}

// Four corner spawns (2-6 players cycle through them in Stage 4).
export function getSpawnPoints(): SpawnSpec[] {
  const inset = ARENA_HALF_SIZE - SPAWN_INSET;
  const spawns: SpawnSpec[] = [];
  for (let i = 0; i < SPAWN_COUNT; i += 1) {
    spawns.push({
      x: i % 2 === 0 ? -inset : inset,
      z: i < 2 ? -inset : inset,
    });
  }
  return spawns;
}

export function isInsideZone(x: number, z: number, zone: ZoneSpec): boolean {
  const dx = x - zone.x;
  const dz = z - zone.z;
  return dx * dx + dz * dz <= zone.radius * zone.radius;
}

export function isOnSlippery(x: number, z: number): boolean {
  return getSlipperyZones().some((zone) => isInsideZone(x, z, zone));
}

export function getTrampolineAt(x: number, z: number): ZoneSpec | null {
  return getTrampolines().find((zone) => isInsideZone(x, z, zone)) ?? null;
}

// Friction reported for Rapier tuning checks (ice inside QT3-A 0.05-0.1).
export function getFrictionAt(x: number, z: number): number {
  return isOnSlippery(x, z) ? ICE_FRICTION : PLAYER_FRICTION;
}

// Neon-warehouse builder (QD2-A: dark floor + neon accents, readable
// contrast). One InstancedMesh per repeated shape (perf budget), Rapier
// static colliders matching every visual that blocks movement. Owns all
// geometries/materials it creates — dispose() releases them.
export class ArenaBuilder {
  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly actors: THREE.Object3D[] = [];
  private wallMaterial: THREE.MeshStandardMaterial | null = null;
  private wallOpacity = WALL_GLASS_OPACITY;

  public buildVisuals(scene: THREE.Scene): void {
    this.buildFloor(scene);
    this.buildWalls(scene);
    this.buildObstacles(scene);
    this.buildPlatforms(scene);
    this.buildSlipperyZones(scene);
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
    // Deliberately no colliders for slippery zones (friction switch in
    // PhysicsWorld.setSlippery) or trampoline pads: pads are trigger-only
    // by design (proximity launch in SceneManager at TRAMPOLINE_TRIGGER_Y),
    // so the capsule passes over them freely and never gets stuck on a lip.
  }

  // Camera-wall occlusion over GLASS walls (Stage 4d.3): the rest state is
  // the glass opacity itself (WALL_GLASS_OPACITY — transparent, stars show
  // through); while the camera sits low/close behind a wall the opacity
  // eases toward WALL_FADE_OPACITY (more transparent so the fighter stays
  // visible, still opaque enough to read the boundary — anti-cheat intent
  // kept). Clamp band is [FADE, GLASS]; transparent flips only below 1
  // (always true for glass — assigned every call, no per-frame churn beyond
  // the two existing fields). No extra lights, no new materials per frame.
  public setWallOpacity(opacity: number): void {
    const clamped = Number.isFinite(opacity)
      ? Math.max(WALL_FADE_OPACITY, Math.min(WALL_GLASS_OPACITY, opacity))
      : WALL_GLASS_OPACITY;
    this.wallOpacity = clamped;
    if (this.wallMaterial !== null) {
      this.wallMaterial.transparent = true;
      this.wallMaterial.opacity = clamped;
      this.wallMaterial.needsUpdate = false;
    }
  }

  public getWallOpacity(): number {
    return this.wallOpacity;
  }

  public dispose(scene: THREE.Scene): void {
    for (const actor of this.actors) {
      scene.remove(actor);
    }
    this.actors.length = 0;
    this.wallMaterial = null;
    this.wallOpacity = WALL_GLASS_OPACITY;
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
    const material = this.track(
      new THREE.MeshStandardMaterial({ color: BASE_FLOOR, roughness: 0.9, metalness: 0.05 }),
    );
    const floor = new THREE.Mesh(geometry, material);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.place(floor, scene);
  }

  private buildWalls(scene: THREE.Scene): void {
    // Four glass walls as a single InstancedMesh (unit box scaled per
    // instance — same geometry, 1 draw call, zero growth vs opaque walls).
    // Transparent glass (WALL_GLASS_OPACITY rest) shows the night sky through
    // (stars + nebulae behind stay visible); depthWrite off so the far sky
    // never gets occluded by the wall depth regardless of sort order
    // (opaque bodies still blend correctly — they render in the opaque pass
    // first). Collision unchanged (buildColliders untouched).
    const half = ARENA_HALF_SIZE;
    const t = WALL_THICKNESS;
    const geometry = this.track(new THREE.BoxGeometry(1, 1, 1));
    const material = this.track(
      new THREE.MeshStandardMaterial({
        color: BASE_WALL,
        roughness: 0.3,
        metalness: 0.1,
        transparent: true,
        opacity: this.wallOpacity,
        depthWrite: false,
      }),
    );
    const walls = new THREE.InstancedMesh(geometry, material, 4);
    this.wallMaterial = material;
    // Glass stays transparent in every state (rest and faded differ only in
    // opacity within [FADE, GLASS] — see setWallOpacity).
    this.wallMaterial.transparent = true;
    this.wallMaterial.opacity = this.wallOpacity;
    const matrix = new THREE.Matrix4();
    const transforms: Array<{ x: number; z: number; sx: number; sz: number }> = [
      { x: 0, z: -half - t / 2, sx: (half + t) * 2, sz: t },
      { x: 0, z: half + t / 2, sx: (half + t) * 2, sz: t },
      { x: -half - t / 2, z: 0, sx: t, sz: (half + t) * 2 },
      { x: half + t / 2, z: 0, sx: t, sz: (half + t) * 2 },
    ];
    transforms.forEach((transform, index) => {
      matrix.makeScale(transform.sx, WALL_HEIGHT, transform.sz);
      matrix.setPosition(transform.x, WALL_HEIGHT / 2, transform.z);
      walls.setMatrixAt(index, matrix);
    });
    walls.instanceMatrix.needsUpdate = true;
    walls.castShadow = true;
    walls.receiveShadow = true;
    this.place(walls, scene);

    // Neon top strips (muted red): one more InstancedMesh, emissive, no shadows.
    const stripGeometry = this.track(new THREE.BoxGeometry(1, 0.08, 1));
    const stripMaterial = this.track(
      new THREE.MeshStandardMaterial({
        color: ACCENT_STRIP_BASE,
        emissive: ACCENT_STRIP,
        emissiveIntensity: 1.0,
      }),
    );
    const strips = new THREE.InstancedMesh(stripGeometry, stripMaterial, 4);
    transforms.forEach((transform, index) => {
      matrix.makeScale(transform.sx, 1, transform.sz);
      matrix.setPosition(transform.x, WALL_HEIGHT + 0.04, transform.z);
      strips.setMatrixAt(index, matrix);
    });
    strips.instanceMatrix.needsUpdate = true;
    this.place(strips, scene);
  }

  private buildObstacles(scene: THREE.Scene): void {
    const specs = getObstacleLayout();
    // Vertex colors: top face carries a subtle neon tint (QD4-A polish),
    // multiplied with the dark base material.
    const geometry = this.track(new THREE.BoxGeometry(1, 1, 1));
    paintTopFaceVertices(geometry, new THREE.Color(BASE_OBSTACLE_TOP), new THREE.Color(NEUTRAL_WHITE));
    const material = this.track(
      new THREE.MeshStandardMaterial({
        color: BASE_OBSTACLE,
        roughness: 0.8,
        metalness: 0.15,
        vertexColors: true,
      }),
    );
    const blocks = new THREE.InstancedMesh(geometry, material, specs.length);
    const matrix = new THREE.Matrix4();
    const accent = new THREE.Color(ACCENT_OBSTACLE_TINT);
    const plain = new THREE.Color(NEUTRAL_WHITE);
    specs.forEach((spec, index) => {
      matrix.makeScale(spec.hx * 2, spec.hy * 2, spec.hz * 2);
      matrix.setPosition(spec.x, spec.hy, spec.z);
      blocks.setMatrixAt(index, matrix);
      // Alternate subtle muted-red edge instance tint for readability.
      blocks.setColorAt(index, index % 2 === 0 ? plain : accent);
    });
    blocks.instanceMatrix.needsUpdate = true;
    if (blocks.instanceColor !== null) {
      blocks.instanceColor.needsUpdate = true;
    }
    blocks.castShadow = true;
    blocks.receiveShadow = true;
    this.place(blocks, scene);
  }

  private buildPlatforms(scene: THREE.Scene): void {
    // Elevated CS-like hills: one InstancedMesh for all figure tops (dark
    // material, neon-tinted top vertices, per-instance accent tint so the
    // four figures read as distinct), plus one thin inset cap plate per
    // figure (tiered prism look, top 5mm below the collider top so the faces
    // never z-fight — the capsule stands on the figure box). No extra lights.
    const platforms = getPlatforms();
    const topGeometry = this.track(new THREE.BoxGeometry(1, 1, 1));
    paintTopFaceVertices(topGeometry, new THREE.Color(BASE_PLATFORM_TOP), new THREE.Color(NEUTRAL_WHITE));
    const topMaterial = this.track(
      new THREE.MeshStandardMaterial({
        color: BASE_PLATFORM,
        roughness: 0.8,
        metalness: 0.15,
        vertexColors: true,
      }),
    );
    const tops = new THREE.InstancedMesh(topGeometry, topMaterial, platforms.length);
    const matrix = new THREE.Matrix4();
    // Distinct accent per figure (white / muted red / dark violet / pale violet).
    const accents = [
      new THREE.Color(BASE_FIGURE_TINTS[0] ?? NEUTRAL_WHITE),
      new THREE.Color(BASE_FIGURE_TINTS[1] ?? NEUTRAL_WHITE),
      new THREE.Color(BASE_FIGURE_TINTS[2] ?? NEUTRAL_WHITE),
      new THREE.Color(BASE_FIGURE_TINTS[3] ?? NEUTRAL_WHITE),
    ];
    platforms.forEach((platform, index) => {
      matrix.makeScale(platform.hx * 2, platform.topY, platform.hz * 2);
      matrix.setPosition(platform.x, platform.topY / 2, platform.z);
      tops.setMatrixAt(index, matrix);
      tops.setColorAt(index, accents[index % accents.length] ?? new THREE.Color(NEUTRAL_WHITE));
    });
    tops.instanceMatrix.needsUpdate = true;
    if (tops.instanceColor !== null) {
      tops.instanceColor.needsUpdate = true;
    }
    tops.castShadow = true;
    tops.receiveShadow = true;
    this.place(tops, scene);

    // Flush tier caps: thin inset slabs whose top face sits PLATFORM_CAP_DROP
    // below topY (Stage 4d.2 z-fighting fix — never coplanar with the figure
    // top face; 5mm is visually imperceptible). No collider needed — the
    // figure box already tops out there.
    const capMaterial = this.track(
      new THREE.MeshStandardMaterial({ color: BASE_CAP, roughness: 0.6, metalness: 0.25 }),
    );
    for (const platform of platforms) {
      const capHeight = 0.1;
      const capGeometry = this.track(new THREE.BoxGeometry(platform.hx * 2 * 0.7, capHeight, platform.hz * 2 * 0.7));
      const cap = new THREE.Mesh(capGeometry, capMaterial);
      cap.position.set(platform.x, platform.topY - capHeight / 2 - PLATFORM_CAP_DROP, platform.z);
      cap.castShadow = false;
      cap.receiveShadow = true;
      this.place(cap, scene);
    }

    // Walk-up ramps: individual rotated slabs (2 meshes, no instancing —
    // only two of them). Same material family, tilted to match colliders.
    const rampMaterial = this.track(
      new THREE.MeshStandardMaterial({ color: BASE_RAMP, roughness: 0.75, metalness: 0.15 }),
    );
    for (const ramp of getRamps()) {
      const length = ramp.halfLength * 2;
      const thick = ramp.halfThick * 2;
      const width = ramp.halfWidth * 2;
      const isX = ramp.axis === "x";
      const geometry = this.track(
        new THREE.BoxGeometry(isX ? width : length, thick, isX ? length : width),
      );
      const mesh = new THREE.Mesh(geometry, rampMaterial);
      mesh.position.set(ramp.x, ramp.y, ramp.z);
      if (isX) {
        mesh.rotation.x = ramp.angle;
      } else {
        mesh.rotation.z = ramp.angle;
      }
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.place(mesh, scene);
    }
  }

  private buildSlipperyZones(scene: THREE.Scene): void {
    const zones = getSlipperyZones();
    const geometry = this.track(new THREE.CircleGeometry(1, 40));
    const material = this.track(
      new THREE.MeshStandardMaterial({
        color: BASE_ICE,
        emissive: ACCENT_ICE_GLOW,
        emissiveIntensity: 0.35,
        transparent: true,
        opacity: 0.75,
        roughness: 0.25,
        metalness: 0.1,
      }),
    );
    const puddles = new THREE.InstancedMesh(geometry, material, zones.length);
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

  private buildTrampolines(scene: THREE.Scene): void {
    const zones = getTrampolines();
    const baseGeometry = this.track(new THREE.CylinderGeometry(1, 1.15, 0.25, 24));
    const baseMaterial = this.track(
      new THREE.MeshStandardMaterial({ color: BASE_TRAMPOLINE, roughness: 0.7, metalness: 0.2 }),
    );
    const bases = new THREE.InstancedMesh(baseGeometry, baseMaterial, zones.length);
    const padGeometry = this.track(new THREE.CylinderGeometry(0.85, 0.85, 0.12, 24));
    const padMaterial = this.track(
      new THREE.MeshStandardMaterial({
        color: BASE_PAD,
        emissive: HL_CHARTREUSE,
        emissiveIntensity: 0.9,
        roughness: 0.5,
      }),
    );
    const pads = new THREE.InstancedMesh(padGeometry, padMaterial, zones.length);
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

// Paint a neon tint onto the top (+Y) face vertices of a BoxGeometry so the
// obstacle blocks read as warehouse crates under the single directional
// light. Cheap stylized polish, zero extra draw calls.
function paintTopFaceVertices(
  geometry: THREE.BoxGeometry,
  top: THREE.Color,
  side: THREE.Color,
): void {
  const positions = geometry.getAttribute("position");
  const colors = new Float32Array(positions.count * 3);
  for (let i = 0; i < positions.count; i += 1) {
    const picked = positions.getY(i) > 0 ? top : side;
    colors[i * 3] = picked.r;
    colors[i * 3 + 1] = picked.g;
    colors[i * 3 + 2] = picked.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}
