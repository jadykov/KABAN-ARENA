import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { getShopfrontTransforms } from "../ads/AdsLoader";
import { getPlatforms } from "../arena/Arena";
import {
  ROUND_LIGHTING_TRANSITION_END_S,
  ROUND_LIGHTING_TRANSITION_START_S,
} from "../config";
import type { NetPlayerSnapshot } from "../net/protocol";

type Participant = Pick<NetPlayerSnapshot, "sessionId" | "x" | "y" | "z" | "alive" | "spectator">;
type Position = Pick<THREE.Vector3, "x" | "y" | "z">;
type BirdPhase = "hidden" | "arriving" | "perched" | "leaving";

interface Bird {
  phase: BirdPhase;
  x: number; y: number; z: number;
  fromX: number; fromY: number; fromZ: number;
  toX: number; toY: number; toZ: number;
  age: number; duration: number; linger: number; yaw: number;
}

interface Rat {
  active: boolean;
  x: number; z: number;
  fromX: number; fromZ: number; toX: number; toZ: number;
  age: number; duration: number; delay: number; yaw: number;
}

interface Shop {
  x: number; z: number; hx: number; hz: number; topY: number;
  frontX: number; frontZ: number;
  nx: number; nz: number; tx: number; tz: number; halfWidth: number;
}

function makeBird(): Bird {
  return { phase: "hidden", x: 0, y: 0, z: 0, fromX: 0, fromY: 0, fromZ: 0,
    toX: 0, toY: 0, toZ: 0, age: 0, duration: 0, linger: 0, yaw: 0 };
}

function makeRat(): Rat {
  return { active: false, x: 0, z: 0, fromX: 0, fromZ: 0, toX: 0, toZ: 0,
    age: 0, duration: 0, delay: 0, yaw: 0 };
}

// Colored low-poly parts are baked into one geometry per body/wing. There
// are three instanced batches in total: bird bodies, six wings, rat bodies.
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
  // Light brown/grey upper coat remains readable in the moonlit interval
  // before shop lamps switch on. Large round ears and a long thin tail make
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
  private readonly birds = [makeBird(), makeBird(), makeBird()];
  private readonly rats = [makeRat(), makeRat()];
  private readonly shops: Shop[];
  private readonly ratArmed: Uint8Array;
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
  private threatX = 0;
  private threatZ = 0;
  private disposed = false;

  public constructor(private readonly random: () => number = Math.random) {
    const platforms = getPlatforms();
    this.shops = getShopfrontTransforms().map((front) => {
      const platform = platforms[front.platformIndex]!;
      const nx = Math.round(Math.sin(front.rotationY));
      const nz = Math.round(Math.cos(front.rotationY));
      return { ...platform, frontX: front.x, frontZ: front.z, nx, nz,
        tx: nz, tz: -nx, halfWidth: nx === 0 ? platform.hx : platform.hz };
    });
    this.ratArmed = new Uint8Array(this.shops.length);
    this.object.name = "shop-wildlife";
    this.birdBodies = new THREE.InstancedMesh(birdGeometry(), this.material, 3);
    this.birdBodies.name = "shop-birds";
    this.wings = new THREE.InstancedMesh(wingGeometry(), this.material, 6);
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
    this.ratArmed.fill(1);
    for (const bird of this.birds) bird.phase = "hidden";
    for (const rat of this.rats) rat.active = false;
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
    if (night && !this.wasNight) this.ratArmed.fill(1);
    this.wasNight = night;

    let activeBirds = 0;
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
        const blend = bird.phase === "arriving" ? t * t * (3 - 2 * t) : t;
        bird.x = bird.fromX + (bird.toX - bird.fromX) * blend;
        bird.y = bird.fromY + (bird.toY - bird.fromY) * blend + Math.sin(t * Math.PI) * 0.55;
        bird.z = bird.fromZ + (bird.toZ - bird.fromZ) * blend;
        if (t === 1) {
          if (bird.phase === "arriving") { bird.phase = "perched"; bird.age = 0; }
          else bird.phase = "hidden";
        }
      }
      if (bird.phase !== "hidden") activeBirds += 1;
    }
    if (day && activeBirds === 0 && this.clock >= this.nextBirdAt) {
      this.visit(players, localId, localPosition);
    }

    let activeRats = false;
    for (const rat of this.rats) {
      if (!rat.active) continue;
      rat.age += deltaSeconds;
      const t = Math.max(0, Math.min(1, (rat.age - rat.delay) / rat.duration));
      rat.x = rat.fromX + (rat.toX - rat.fromX) * t;
      rat.z = rat.fromZ + (rat.toZ - rat.fromZ) * t;
      if (!night || t === 1) rat.active = false;
      else activeRats = true;
    }
    if (night) {
      for (let index = 0; index < this.shops.length; index += 1) {
        const shop = this.shops[index]!;
        if (this.nearParticipant(shop.frontX, shop.frontZ, 3.5, players, localId, localPosition)) {
          if (this.ratArmed[index] === 0) continue;
          this.ratArmed[index] = 0;
          if (activeRats || this.clock < this.nextRatAt) continue;
          this.nextRatAt = this.clock + 15 + this.random() * 15;
          if (this.random() < 0.7) { this.scurry(shop); activeRats = true; }
        } else if (!this.nearParticipant(shop.frontX, shop.frontZ, 5, players, localId, localPosition)) {
          this.ratArmed[index] = 1;
        }
      }
    }
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
    const first = Math.floor(this.random() * this.shops.length);
    let selected: Shop | null = null;
    for (let offset = 0; offset < this.shops.length; offset += 1) {
      const shop = this.shops[(first + offset) % this.shops.length]!;
      if (!this.nearParticipant(shop.x, shop.z, 3.8, players, localId, localPosition)) {
        selected = shop;
        break;
      }
    }
    if (selected === null) { this.nextBirdAt = this.clock + 3 + this.random() * 3; return; }
    const count = 2 + Math.floor(this.random() * 2);
    for (let index = 0; index < count; index += 1) {
      const bird = this.birds[index]!;
      bird.phase = "arriving";
      bird.age = 0;
      bird.duration = 2.2 + this.random() * 0.7 + index * 0.12;
      bird.linger = 8 + this.random() * 8;
      bird.toX = selected.x + (index - 1) * Math.min(0.46, selected.hx * 0.4);
      bird.toY = selected.topY + 0.025;
      bird.toZ = selected.z + (index % 2 === 0 ? -0.32 : 0.30) * Math.min(1, selected.hz);
      bird.fromX = bird.toX - selected.nx * (7 + index * 0.55) + selected.tx * (index - 1);
      bird.fromY = bird.toY + 4.2 + index * 0.35;
      bird.fromZ = bird.toZ - selected.nz * (7 + index * 0.55) + selected.tz * (index - 1);
      bird.x = bird.fromX; bird.y = bird.fromY; bird.z = bird.fromZ;
      bird.yaw = Math.atan2(bird.toX - bird.fromX, bird.toZ - bird.fromZ);
    }
    // Cooldown begins after the visit ends, so long-lived groups cannot
    // turn into back-to-back arrivals when their timers have expired.
    this.nextBirdAt = Number.POSITIVE_INFINITY;
  }

  private leave(bird: Bird, index: number, scared: boolean): void {
    let dx = scared ? bird.x - this.threatX : Math.sin(bird.yaw + 2.5);
    let dz = scared ? bird.z - this.threatZ : Math.cos(bird.yaw + 2.5);
    if (dx * dx + dz * dz < 0.001) { dx = Math.sin(index * 2.1 + 0.3); dz = Math.cos(index * 2.1 + 0.3); }
    const angle = Math.atan2(dx, dz) + (index - 1) * 0.4;
    bird.phase = "leaving";
    bird.fromX = bird.x; bird.fromY = bird.y; bird.fromZ = bird.z;
    bird.toX = bird.x + Math.sin(angle) * (8 + index);
    bird.toY = Math.max(bird.y, 3) + 5 + index * 0.4;
    bird.toZ = bird.z + Math.cos(angle) * (8 + index);
    bird.yaw = angle;
    bird.age = 0;
    bird.duration = 2.1 + index * 0.2;
    this.nextBirdAt = this.clock + bird.duration + 20 + this.random() * 20;
  }

  private scurry(shop: Shop): void {
    const count = 1 + Math.floor(this.random() * 2);
    const playerAlong = (this.threatX - shop.frontX) * shop.tx + (this.threatZ - shop.frontZ) * shop.tz;
    const direction = playerAlong > 0 ? -1 : 1;
    const span = Math.max(0.3, shop.halfWidth - 0.18);
    for (let index = 0; index < count; index += 1) {
      const rat = this.rats[index]!;
      const x = shop.frontX + shop.nx * (0.52 + index * 0.09);
      const z = shop.frontZ + shop.nz * (0.52 + index * 0.09);
      rat.active = true;
      rat.age = 0;
      rat.delay = index * 0.2;
      rat.duration = span * 2 / (2.1 + this.random() * 0.6);
      rat.fromX = x - shop.tx * span * direction;
      rat.fromZ = z - shop.tz * span * direction;
      rat.toX = x + shop.tx * span * direction;
      rat.toZ = z + shop.tz * span * direction;
      rat.x = rat.fromX; rat.z = rat.fromZ;
      rat.yaw = Math.atan2(shop.tx * direction, shop.tz * direction);
    }
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
    if (this.birdBodies.count > 0 && birdCount === 0 && this.nextBirdAt !== Number.POSITIVE_INFINITY) {
      this.nextBirdAt = Math.max(this.nextBirdAt, this.clock + 20);
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
      const t = (rat.age - rat.delay) / rat.duration;
      this.transform.position.set(rat.x, 0.026 + Math.abs(Math.sin(this.clock * 35)) * 0.018, rat.z);
      this.transform.rotation.set(0, rat.yaw + Math.sin(this.clock * 26) * 0.035, 0);
      this.transform.scale.setScalar(Math.max(0.1, Math.min(1, t / 0.09, (1 - t) / 0.12)));
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
