import * as THREE from "three";
import { PARTICLE_LIFETIME_S, PARTICLE_POOL_SIZE } from "../config";

// Fixed-size pooled particle system (QD4-A): one THREE.Points draw call,
// zero per-burst allocation. Dead particles park at y=-9999. spawn() reuses
// the oldest slots ring-buffer style, so bursts never grow memory.
export class ParticlePool {
  private readonly capacity: number;
  private readonly positions: Float32Array;
  private readonly velocities: Float32Array;
  private readonly life: Float32Array;
  private readonly activeSlots: Uint32Array;
  private readonly activePositions: Int32Array;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly points: THREE.Points;
  private cursor = 0;
  private activeCount = 0;
  private disposed = false;

  public constructor(capacity: number = PARTICLE_POOL_SIZE) {
    this.capacity = capacity;
    this.positions = new Float32Array(capacity * 3);
    this.velocities = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.activeSlots = new Uint32Array(capacity);
    this.activePositions = new Int32Array(capacity);
    this.activePositions.fill(-1);
    for (let i = 0; i < capacity; i += 1) {
      this.positions[i * 3 + 1] = -9999;
    }
    const positionAttribute = new THREE.BufferAttribute(this.positions, 3);
    positionAttribute.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute("position", positionAttribute);
    const colors = new Float32Array(capacity * 3);
    colors.fill(1);
    this.geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage));
    const material = new THREE.PointsMaterial({
      size: 0.12,
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    });
    this.points = new THREE.Points(this.geometry, material);
    this.points.frustumCulled = false;
    this.points.visible = false;
  }

  public get object(): THREE.Points {
    return this.points;
  }

  public get aliveCount(): number {
    return this.activeCount;
  }

  public spawn(
    x: number,
    y: number,
    z: number,
    count: number,
    color: THREE.Color,
    spread = 3,
    up = 2.5,
    life = PARTICLE_LIFETIME_S,
  ): void {
    if (this.disposed || !Number.isFinite(count) || count <= 0 || this.capacity === 0) return;
    const slotLife = Number.isFinite(life) && life > 0 ? life : PARTICLE_LIFETIME_S;
    const colorAttribute = this.geometry.getAttribute("color") as THREE.BufferAttribute;
    for (let n = 0; n < Math.min(count, this.capacity); n += 1) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.capacity;
      if (this.activePositions[i] < 0) {
        this.activePositions[i] = this.activeCount;
        this.activeSlots[this.activeCount] = i;
        this.activeCount += 1;
      }
      this.positions[i * 3] = x;
      this.positions[i * 3 + 1] = y;
      this.positions[i * 3 + 2] = z;
      this.velocities[i * 3] = (Math.random() - 0.5) * spread * 2;
      this.velocities[i * 3 + 1] = Math.random() * up + 1;
      this.velocities[i * 3 + 2] = (Math.random() - 0.5) * spread * 2;
      this.life[i] = slotLife;
      colorAttribute.setXYZ(i, color.r, color.g, color.b);
    }
    this.points.visible = true;
    colorAttribute.needsUpdate = true;
    (this.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  }

  public update(deltaSeconds: number): void {
    if (!Number.isFinite(deltaSeconds) || !(deltaSeconds > 0) || this.activeCount === 0 || this.disposed) {
      return;
    }
    // Dense slot inventory visits only live particles; expiry swaps in the
    // tail entry without allocating a filtered array or scanning idle slots.
    let activePosition = 0;
    while (activePosition < this.activeCount) {
      const i = this.activeSlots[activePosition];
      this.life[i] -= deltaSeconds;
      if (this.life[i] <= 0) {
        this.life[i] = 0;
        this.positions[i * 3 + 1] = -9999;
        this.activeCount -= 1;
        const tailSlot = this.activeSlots[this.activeCount];
        this.activeSlots[activePosition] = tailSlot;
        this.activePositions[tailSlot] = activePosition;
        this.activePositions[i] = -1;
        continue;
      }
      this.velocities[i * 3 + 1] -= 9.81 * deltaSeconds;
      this.positions[i * 3] += this.velocities[i * 3] * deltaSeconds;
      this.positions[i * 3 + 1] += this.velocities[i * 3 + 1] * deltaSeconds;
      this.positions[i * 3 + 2] += this.velocities[i * 3 + 2] * deltaSeconds;
      if (this.positions[i * 3 + 1] < 0.02) {
        this.positions[i * 3 + 1] = 0.02;
        this.velocities[i * 3 + 1] *= -0.4;
      }
      activePosition += 1;
    }
    this.points.visible = this.activeCount > 0;
    (this.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  }

  public clear(): void {
    for (let activePosition = 0; activePosition < this.activeCount; activePosition += 1) {
      const i = this.activeSlots[activePosition];
      this.life[i] = 0;
      this.positions[i * 3 + 1] = -9999;
      this.activePositions[i] = -1;
    }
    if (this.activeCount > 0) {
      (this.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    }
    this.activeCount = 0;
    this.points.visible = false;
    this.cursor = 0;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
    this.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}
