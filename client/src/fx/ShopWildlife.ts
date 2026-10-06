import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  ROUND_LIGHTING_TRANSITION_END_S,
  ROUND_LIGHTING_TRANSITION_START_S,
} from "../config";
import type { NetPlayerSnapshot } from "../net/protocol";
import { getBirdSurfaces, getRatRoutes, isBirdFlightClear, isCargoFootSupported, isWildlifeGroundClear,
  type BirdSurface, type RatRoute } from "./WildlifeLayout";

type Participant = Pick<NetPlayerSnapshot, "sessionId" | "x" | "y" | "z" | "alive" | "spectator">;
type Position = Pick<THREE.Vector3, "x" | "y" | "z">;
type BirdPhase = "hidden" | "arriving" | "perched" | "leaving";

interface Bird {
  phase: BirdPhase;
  x: number; y: number; z: number;
  fromX: number; fromY: number; fromZ: number;
  toX: number; toY: number; toZ: number;
  age: number; duration: number; linger: number; yaw: number;
  flock: number;
}

interface Rat {
  active: boolean;
  x: number; z: number;
  route: RatRoute | null;
  distance: number; segment: number;
  age: number; speed: number; delay: number; yaw: number;
}

function makeBird(): Bird {
  return { phase: "hidden", x: 0, y: 0, z: 0, fromX: 0, fromY: 0, fromZ: 0,
    toX: 0, toY: 0, toZ: 0, age: 0, duration: 0, linger: 0, yaw: 0, flock: -1 };
}

function makeRat(): Rat {
  return { active: false, x: 0, z: 0, route: null, distance: 0, segment: 1,
    age: 0, speed: 0, delay: 0, yaw: 0 };
}

// Colored low-poly parts are baked into one geometry per body/wing. There
// are three instanced batches in total: six bird bodies, twelve wings, rats.
// Day draws at most two batches, night one; no lights, shadows or colliders.
function coloredPart(
  geometry: THREE.BufferGeometry, color: number,
  x: number, y: number, z: number, sx = 1, sy = 1, sz = 1,
): THREE.BufferGeometry {
  const part = geometry.index === null ? geometry : geometry.toNonIndexed();
  if (part !== geometry) geometry.dispose();
  part.scale(sx, sy, sz);
  part.translate(x, y, z);
  const rgb = new THREE.Color(color);
  const colors = new Float32Array(part.getAttribute("position").count * 3);
  for (let index = 0; index < colors.length; index += 3) {
    colors[index] = rgb.r; colors[index + 1] = rgb.g; colors[index + 2] = rgb.b;
  }
  part.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  part.deleteAttribute("uv");
  return part;
}

function combine(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const geometry = mergeGeometries(parts)!;
  for (const part of parts) part.dispose();
  return geometry;
}

function birdGeometry(): THREE.BufferGeometry {
  return combine([
    coloredPart(new THREE.SphereGeometry(1, 7, 5), 0x94a2ac, 0, 0.19, 0, 0.105, 0.12, 0.17),
    coloredPart(new THREE.SphereGeometry(1, 7, 5), 0x566c77, 0, 0.32, 0.11, 0.077, 0.075, 0.077),
    coloredPart(new THREE.BoxGeometry(0.055, 0.035, 0.095), 0xd7ad69, 0, 0.306, 0.20),
    coloredPart(new THREE.BoxGeometry(0.12, 0.025, 0.13), 0x4d5b65, 0, 0.18, -0.19),
    coloredPart(new THREE.BoxGeometry(0.025, 0.085, 0.025), 0xa4805c, -0.04, 0.055, 0.02),
    coloredPart(new THREE.BoxGeometry(0.025, 0.085, 0.025), 0xa4805c, 0.04, 0.055, 0.02),
    coloredPart(new THREE.BoxGeometry(0.06, 0.02, 0.075), 0xa4805c, -0.04, 0.013, 0.04),
    coloredPart(new THREE.BoxGeometry(0.06, 0.02, 0.075), 0xa4805c, 0.04, 0.013, 0.04),
    coloredPart(new THREE.SphereGeometry(0.015, 5, 3), 0x18252c, -0.071, 0.338, 0.14),
    coloredPart(new THREE.SphereGeometry(0.015, 5, 3), 0x18252c, 0.071, 0.338, 0.14),
  ]);
}

function wingGeometry(): THREE.BufferGeometry {
  // Wing root sits at the origin; a tapered fan opens sideways in flight.
  const wing = new THREE.BufferGeometry();
  wing.setAttribute("position", new THREE.Float32BufferAttribute([
    0, 0, 0.08, 0.29, -0.015, 0.01, 0.23, -0.01, -0.14,
    0, 0, 0.08, 0.23, -0.01, -0.14, 0, 0, -0.09,
  ], 3));
  wing.computeVertexNormals();
  return coloredPart(wing, 0x677e8d, 0, 0, 0);
}

function ratGeometry(): THREE.BufferGeometry {
  // Light brown/grey upper coat remains readable in the moonlit arena.
  // Large round ears and a long thin tail make
  // this a rat rather than a tiny anonymous ground particle.
  const parts = [
    coloredPart(new THREE.SphereGeometry(1, 7, 5), 0xa89c85, 0, 0.10, -0.015, 0.082, 0.09, 0.16),
    coloredPart(new THREE.SphereGeometry(1, 7, 4), 0xb4a58e, 0, 0.103, 0.155, 0.067, 0.063, 0.092),
    coloredPart(new THREE.SphereGeometry(0.043, 7, 4), 0xc4b6a0, -0.057, 0.162, 0.11, 1, 1, 0.46),
    coloredPart(new THREE.SphereGeometry(0.043, 7, 4), 0xc4b6a0, 0.057, 0.162, 0.11, 1, 1, 0.46),
    coloredPart(new THREE.SphereGeometry(0.022, 5, 3), 0x6a655e, 0, 0.096, 0.25),
    coloredPart(new THREE.SphereGeometry(0.012, 5, 3), 0x211d18, -0.05, 0.133, 0.194),
    coloredPart(new THREE.SphereGeometry(0.012, 5, 3), 0x211d18, 0.05, 0.133, 0.194),
  ];
  for (const side of [-1, 1]) {
    for (const z of [-0.085, 0.075]) {
      parts.push(coloredPart(new THREE.BoxGeometry(0.035, 0.04, 0.057), 0x9c8977,
        side * 0.065, 0.02, z));
    }
  }
  for (let segment = 0; segment < 4; segment += 1) {
    parts.push(coloredPart(new THREE.BoxGeometry(0.023 - segment * 0.003, 0.024, 0.082),
      0x9a8979, Math.sin(segment * 0.55) * 0.04, 0.027, -0.20 - segment * 0.067));
  }
  return combine(parts);
}

export class ShopWildlife {
  public readonly object = new THREE.Group();
  private readonly birdBodies: THREE.InstancedMesh;
  private readonly wings: THREE.InstancedMesh;
  private readonly ratBodies: THREE.InstancedMesh;
  private readonly material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  private readonly birds = Array.from({ length: 6 }, makeBird);
  private readonly rats = [makeRat(), makeRat()];
  private readonly surfaces = getBirdSurfaces();
  private readonly surfaceGroups = ["ground", "fence", "roof", "cargo"].map((kind) =>
    this.surfaces.filter((surface) => surface.kind === kind));
  private readonly routes = getRatRoutes();
  private readonly landingX = new Float64Array(3);
  private readonly landingZ = new Float64Array(3);
  private readonly landingYaw = new Float64Array(3);
  private readonly transform = new THREE.Object3D();
  private readonly rotation = new THREE.Quaternion();
  private readonly bodyRotation = new THREE.Quaternion();
  private readonly wingAxis = new THREE.Vector3(0, 0, 1);
  private readonly yawAxis = new THREE.Vector3(0, 1, 0);
  private playing = false;
  private wasNight = false;
  private clock = 0;
  private lastElapsed = 0;
  private nextBirdAt = 0;
  private nextRatAt = 0;
  private lastRoute = -1;
  private threatX = 0;
  private threatZ = 0;
  private disposed = false;

  public constructor(private readonly random: () => number = Math.random) {
    this.object.name = "shop-wildlife";
    this.birdBodies = new THREE.InstancedMesh(birdGeometry(), this.material, 6);
    this.birdBodies.name = "shop-birds";
    this.wings = new THREE.InstancedMesh(wingGeometry(), this.material, 12);
    this.wings.name = "shop-bird-wings";
    this.ratBodies = new THREE.InstancedMesh(ratGeometry(), this.material, 2);
    this.ratBodies.name = "shop-rats";
    for (const mesh of [this.birdBodies, this.wings, this.ratBodies]) {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      this.object.add(mesh);
    }
    this.reset();
  }

  public reset(): void {
    this.playing = false;
    this.wasNight = false;
    this.clock = 0;
    this.lastElapsed = 0;
    this.nextBirdAt = 10 + this.random() * 10;
    this.nextRatAt = 0;
    this.lastRoute = -1;
    for (const bird of this.birds) { bird.phase = "hidden"; bird.flock = -1; }
    for (const rat of this.rats) { rat.active = false; rat.route = null; }
    this.birdBodies.count = 0;
    this.wings.count = 0;
    this.ratBodies.count = 0;
    this.birdBodies.visible = false;
    this.wings.visible = false;
    this.ratBodies.visible = false;
  }

  public update(
    deltaSeconds: number, elapsed: number, playing: boolean,
    players: readonly Participant[], localId: string | null, localPosition: Position | null,
  ): void {
    if (this.disposed || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
    if (!playing || !Number.isFinite(elapsed)) {
      if (this.playing) this.reset();
      return;
    }
    if (elapsed < this.lastElapsed - 0.5) this.reset();
    this.playing = true;
    this.lastElapsed = elapsed;
    this.clock += deltaSeconds;
    const day = elapsed < ROUND_LIGHTING_TRANSITION_START_S;
    const night = elapsed >= ROUND_LIGHTING_TRANSITION_END_S;
    if (night && !this.wasNight) this.nextRatAt = this.clock + 1 + this.random() * 3;
    this.wasNight = night;

    for (let index = 0; index < this.birds.length; index += 1) {
      const bird = this.birds[index]!;
      if (night) bird.phase = "hidden";
      if (bird.phase === "hidden") continue;
      const scared = bird.phase !== "leaving"
        && this.nearParticipant(bird.x, bird.z, 3, players, localId, localPosition);
      if (bird.phase !== "leaving" && (!day || scared)) this.leave(bird, index, scared);
      bird.age += deltaSeconds;
      if (bird.phase === "perched") {
        if (bird.age >= bird.linger) this.leave(bird, index, false);
      } else {
        const t = Math.min(1, bird.age / bird.duration);
        // Take off vertically before spreading sideways, clearing shops and
        // ladders even when a player scares a bird right beside a solid.
        const blend = bird.phase === "arriving" ? t * t * (3 - 2 * t) : Math.max(0, (t - 0.18) / 0.82);
        bird.x = bird.fromX + (bird.toX - bird.fromX) * blend;
        const vertical = bird.phase === "arriving" ? blend : Math.sqrt(t);
        bird.y = bird.fromY + (bird.toY - bird.fromY) * vertical + Math.sin(t * Math.PI) * 0.55;
        bird.z = bird.fromZ + (bird.toZ - bird.fromZ) * blend;
        if (t === 1) {
          if (bird.phase === "arriving") { bird.phase = "perched"; bird.age = 0; }
          else bird.phase = "hidden";
        }
      }
    }
    if (day && this.clock >= this.nextBirdAt) this.visit(players, localId, localPosition);

    let activeRats = false;
    for (const rat of this.rats) {
      if (!rat.active) continue;
      if (!night) { rat.active = false; continue; }
      rat.age += deltaSeconds;
      const route = rat.route!;
      rat.distance = Math.max(0, rat.age - rat.delay) * rat.speed;
      if (rat.distance >= route.length) { rat.active = false; continue; }
      while (rat.segment < route.points.length - 1 && rat.distance > route.distances[rat.segment]!) rat.segment += 1;
      const from = route.points[rat.segment - 1]!;
      const to = route.points[rat.segment]!;
      const t = (rat.distance - route.distances[rat.segment - 1]!)
        / (route.distances[rat.segment]! - route.distances[rat.segment - 1]!);
      rat.x = from.x + (to.x - from.x) * t;
      rat.z = from.z + (to.z - from.z) * t;
      rat.yaw = Math.atan2(to.x - from.x, to.z - from.z);
      activeRats = true;
    }
    if (night && !activeRats && this.clock >= this.nextRatAt) this.scurry();
    this.render();
  }

  private nearParticipant(
    x: number, z: number, radius: number, players: readonly Participant[],
    localId: string | null, localPosition: Position | null,
  ): boolean {
    let closest = radius * radius;
    let found = false;
    for (const player of players) {
      if (!player.alive || player.spectator) continue;
      const position = player.sessionId === localId && localPosition !== null ? localPosition : player;
      const dx = position.x - x;
      const dz = position.z - z;
      const distance = dx * dx + dz * dz;
      if (distance > closest || !Number.isFinite(distance)) continue;
      closest = distance;
      this.threatX = position.x;
      this.threatZ = position.z;
      found = true;
    }
    return found;
  }

  private visit(players: readonly Participant[], localId: string | null, localPosition: Position | null): void {
    this.nextBirdAt = this.clock + 5 + this.random() * 6;
    let free = 0;
    let occupied = 0;
    for (const bird of this.birds) {
      if (bird.phase === "hidden") free += 1;
      else occupied |= 1 << bird.flock;
    }
    if (free === 0 || occupied === 7) return;
    // Longer occasional gaps provide quiet even though groups can overlap.
    if (this.random() > 0.9) { this.nextBirdAt += 10 + this.random() * 10; return; }
    let flock = 0;
    while ((occupied & (1 << flock)) !== 0) flock += 1;
    const count = Math.min(free, 1 + Math.floor(this.random() * 3));
    const kind = Math.min(3, Math.floor(this.random() * 4));
    const options = this.surfaceGroups[kind]!;
    if (options.length === 0) return;
    const first = Math.floor(this.random() * options.length);
    let selected: BirdSurface | null = null;
    for (let offset = 0; offset < options.length; offset += 1) {
      const surface = options[(first + offset) % options.length]!;
      const yaw = surface.yaw ?? this.random() * Math.PI * 2;
      const alongX = surface.kind === "fence" ? (surface.hx > 0 ? 1 : 0) : Math.cos(yaw);
      const alongZ = surface.kind === "fence" ? (surface.hz > 0 ? 1 : 0) : -Math.sin(yaw);
      const centerX = surface.x + (this.random() - 0.5) * Math.max(0, surface.hx - 0.8);
      const centerZ = surface.z + (this.random() - 0.5) * Math.max(0, surface.hz - 0.8);
      const firstCorner = surface.kind === "cargo" ? Math.floor(this.random() * 4) : 0;
      let safe = true;
      for (let index = 0; index < count; index += 1) {
        const spacing = (index - (count - 1) / 2) * 0.55;
        const corner = (firstCorner + index) % 4;
        const x = surface.kind === "cargo"
          ? surface.x + ((corner % 2 === 0 ? -0.45 : 0.45) + (this.random() - 0.5) * 0.16) * surface.hx
          : centerX + alongX * spacing - (surface.kind === "fence" ? Math.sin(yaw) * 0.04 : 0);
        const z = surface.kind === "cargo"
          ? surface.z + ((corner < 2 ? -0.55 : 0.55) + (this.random() - 0.5) * 0.16) * surface.hz
          : centerZ + alongZ * spacing - (surface.kind === "fence" ? Math.cos(yaw) * 0.04 : 0);
        const standingYaw = yaw + (surface.kind === "fence" ? 0 : (this.random() - 0.5) * 0.8);
        this.landingX[index] = x;
        this.landingZ[index] = z;
        this.landingYaw[index] = standingYaw;
        if ((surface.kind === "ground" && !isWildlifeGroundClear(x, z))
          || ((surface.kind === "roof" || surface.kind === "cargo")
            && (Math.abs(x - surface.x) > surface.hx - 0.32 || Math.abs(z - surface.z) > surface.hz - 0.32))
          || this.nearParticipant(x, z, 3.4, players, localId, localPosition)) { safe = false; break; }
        if (surface.kind === "cargo") {
          for (const side of [-1, 1]) {
            const footX = x + side * 0.04 * Math.cos(standingYaw) + 0.04 * Math.sin(standingYaw);
            const footZ = z - side * 0.04 * Math.sin(standingYaw) + 0.04 * Math.cos(standingYaw);
            if (!isCargoFootSupported(surface, footX, footZ)) { safe = false; break; }
          }
          if (!safe) break;
        }
        for (const bird of this.birds) {
          if (bird.phase !== "hidden" && Math.hypot(bird.toX - x, bird.toZ - z) < 2) { safe = false; break; }
        }
        if (!safe) break;
      }
      if (safe) { selected = surface; break; }
    }
    if (selected === null) return;
    // Start high and approach almost vertically. Validate the complete flight
    // against the map, including the low final descent beside ramp landings.
    let approach = this.random() * Math.PI * 2;
    let validFlight = false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      validFlight = true;
      for (let index = 0; index < count && validFlight; index += 1) {
        for (let sample = 0; sample <= 30; sample += 1) {
          const t = sample / 30;
          const blend = t * t * (3 - 2 * t);
          const x = this.landingX[index]! - Math.sin(approach) * 2 * (1 - blend);
          const z = this.landingZ[index]! - Math.cos(approach) * 2 * (1 - blend);
          const y = selected.y + 0.025 + 6 * (1 - blend) + Math.sin(t * Math.PI) * 0.55;
          if (!isBirdFlightClear(x, y, z, selected)) { validFlight = false; break; }
        }
      }
      if (validFlight) break;
      approach += Math.PI / 4;
    }
    if (!validFlight) return;
    let assigned = 0;
    for (const bird of this.birds) {
      if (bird.phase !== "hidden") continue;
      bird.phase = "arriving";
      bird.flock = flock;
      bird.age = 0;
      bird.duration = 2.2 + this.random() * 0.7 + assigned * 0.12;
      bird.linger = 12 + this.random() * 12;
      bird.toX = this.landingX[assigned]!;
      bird.toY = selected.y + 0.025;
      bird.toZ = this.landingZ[assigned]!;
      bird.fromX = bird.toX - Math.sin(approach) * 2;
      bird.fromY = bird.toY + 6;
      bird.fromZ = bird.toZ - Math.cos(approach) * 2;
      bird.x = bird.fromX; bird.y = bird.fromY; bird.z = bird.fromZ;
      // A little individual head/body variation when standing on wide areas.
      bird.yaw = this.landingYaw[assigned]!;
      assigned += 1;
      if (assigned === count) break;
    }
  }

  private leave(bird: Bird, index: number, scared: boolean): void {
    let dx = scared ? bird.x - this.threatX : Math.sin(bird.yaw + 2.5);
    let dz = scared ? bird.z - this.threatZ : Math.cos(bird.yaw + 2.5);
    if (dx * dx + dz * dz < 0.001) { dx = Math.sin(index * 2.1 + 0.3); dz = Math.cos(index * 2.1 + 0.3); }
    const angle = Math.atan2(dx, dz) + (index % 3 - 1) * 0.4;
    bird.phase = "leaving";
    bird.fromX = bird.x; bird.fromY = bird.y; bird.fromZ = bird.z;
    bird.toX = bird.x + Math.sin(angle) * (8 + index % 3);
    bird.toY = Math.max(bird.y, 3) + 6;
    bird.toZ = bird.z + Math.cos(angle) * (8 + index % 3);
    bird.yaw = angle;
    bird.age = 0;
    bird.duration = 2.1 + index % 3 * 0.2;
  }

  private scurry(): void {
    this.nextRatAt = this.clock + 12 + this.random() * 16;
    if (this.routes.length === 0) return;
    const count = 1 + Math.floor(this.random() * 2);
    let first = Math.floor(this.random() * this.routes.length);
    if (first === this.lastRoute) first = (first + 1) % this.routes.length;
    this.lastRoute = first;
    for (let index = 0; index < count; index += 1) {
      const rat = this.rats[index]!;
      // A pair may take a different destination/side, so it is not one rigid
      // formation. Every individual still starts and finishes at a shop.
      const routeIndex = index === 0 ? first : (first + 1 + Math.floor(this.random() * (this.routes.length - 1))) % this.routes.length;
      const route = this.routes[routeIndex]!;
      rat.active = true;
      rat.route = route;
      rat.age = 0;
      rat.delay = index * (0.35 + this.random() * 1.2);
      rat.speed = 2.1 + this.random() * 1.1;
      rat.distance = 0;
      rat.segment = 1;
      rat.x = route.points[0]!.x; rat.z = route.points[0]!.z;
      rat.yaw = Math.atan2(route.points[1]!.x - rat.x, route.points[1]!.z - rat.z);
    }
    // Schedule the next episode after the longest route and a variable pause.
    let end = this.clock;
    for (const rat of this.rats) {
      if (rat.active) end = Math.max(end, this.clock + rat.delay + rat.route!.length / rat.speed);
    }
    this.nextRatAt = end + 7 + this.random() * 13;
  }

  private render(): void {
    let birdCount = 0;
    for (let index = 0; index < this.birds.length; index += 1) {
      const bird = this.birds[index]!;
      if (bird.phase === "hidden") continue;
      this.transform.position.set(bird.x, bird.y, bird.z);
      this.transform.rotation.set(0, bird.yaw, bird.phase === "perched" ? Math.sin(this.clock * 1.5 + index) * 0.025 : 0);
      this.transform.scale.setScalar(1);
      this.transform.updateMatrix();
      this.birdBodies.setMatrixAt(birdCount, this.transform.matrix);
      for (let side = 0; side < 2; side += 1) {
        const sign = side === 0 ? -1 : 1;
        const flap = bird.phase === "perched" ? -1.15 : Math.sin(this.clock * 21 + index * 1.9) * 0.75;
        this.bodyRotation.setFromAxisAngle(this.yawAxis, bird.yaw + (side === 0 ? Math.PI : 0));
        this.rotation.setFromAxisAngle(this.wingAxis, flap);
        this.transform.quaternion.copy(this.bodyRotation).multiply(this.rotation);
        this.transform.position.set(bird.x + Math.cos(bird.yaw) * sign * 0.075,
          bird.y + 0.22, bird.z - Math.sin(bird.yaw) * sign * 0.075);
        this.transform.scale.set(bird.phase === "perched" ? 0.62 : 1, 1, 1);
        this.transform.updateMatrix();
        this.wings.setMatrixAt(birdCount * 2 + side, this.transform.matrix);
      }
      birdCount += 1;
    }
    this.birdBodies.count = birdCount;
    this.wings.count = birdCount * 2;
    this.birdBodies.visible = birdCount > 0;
    this.wings.visible = birdCount > 0;
    if (birdCount > 0) {
      this.birdBodies.instanceMatrix.needsUpdate = true;
      this.wings.instanceMatrix.needsUpdate = true;
    }
    let ratCount = 0;
    for (const rat of this.rats) {
      if (!rat.active || rat.age < rat.delay) continue;
      this.transform.position.set(rat.x, 0.026 + Math.abs(Math.sin(this.clock * 35)) * 0.018, rat.z);
      this.transform.rotation.set(0, rat.yaw + Math.sin(this.clock * 26) * 0.035, 0);
      this.transform.scale.setScalar(Math.max(0.1, Math.min(1, rat.distance / 0.3, (rat.route!.length - rat.distance) / 0.4)));
      this.transform.updateMatrix();
      this.ratBodies.setMatrixAt(ratCount, this.transform.matrix);
      ratCount += 1;
    }
    this.ratBodies.count = ratCount;
    this.ratBodies.visible = ratCount > 0;
    if (ratCount > 0) this.ratBodies.instanceMatrix.needsUpdate = true;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.reset();
    this.disposed = true;
    this.object.removeFromParent();
    for (const mesh of [this.birdBodies, this.wings, this.ratBodies]) {
      mesh.dispose();
      mesh.geometry.dispose();
    }
    this.material.dispose();
    this.object.clear();
  }
}
