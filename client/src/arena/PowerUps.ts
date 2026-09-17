import * as THREE from "three";
import {
  POWERUP_PICKUP_RADIUS,
  POWERUP_RESPAWN_S,
  SHIELD_MAX_HITS,
  SPEED_DURATION_S,
  SPEED_MULTIPLIER,
} from "../config";
import {
  BASE_PICKUP,
  HL_CHARTREUSE,
  HL_CHARTREUSE_BRIGHT,
  HL_CHARTREUSE_DEEP,
} from "../palette";

export type PowerUpKind = "speed" | "shield" | "impulse";

export const POWERUP_KINDS: readonly PowerUpKind[] = ["speed", "shield", "impulse"];

// Pure skill-based power-up state (set A1). No three.js dependency so the
// apply/expire rules are unit-testable without a renderer.
export class PowerUpState {
  private nowSeconds = 0;
  private speedUntilSeconds = 0;
  private shieldHits = 0;

  public get now(): number {
    return this.nowSeconds;
  }

  public update(deltaSeconds: number): void {
    if (deltaSeconds > 0) {
      this.nowSeconds += deltaSeconds;
    }
  }

  public applyPickup(kind: PowerUpKind): void {
    if (kind === "speed") {
      this.speedUntilSeconds = this.nowSeconds + SPEED_DURATION_S;
    } else if (kind === "shield") {
      this.shieldHits = SHIELD_MAX_HITS;
    }
    // "impulse" applies instantly at the call site (knockback burst) and
    // holds no timed state, so there is nothing to store here.
  }

  public isSpeedActive(): boolean {
    return this.nowSeconds < this.speedUntilSeconds;
  }

  public getSpeedMultiplier(): number {
    return this.isSpeedActive() ? SPEED_MULTIPLIER : 1;
  }

  public getSpeedRemaining(): number {
    return Math.max(0, this.speedUntilSeconds - this.nowSeconds);
  }

  public hasShield(): boolean {
    return this.shieldHits > 0;
  }

  // Returns true when a shield charge absorbed the hit.
  public consumeShieldHit(): boolean {
    if (this.shieldHits <= 0) {
      return false;
    }
    this.shieldHits -= 1;
    return true;
  }

  public reset(): void {
    this.nowSeconds = 0;
    this.speedUntilSeconds = 0;
    this.shieldHits = 0;
  }
}

export interface PickupSlot {
  kind: PowerUpKind;
  x: number;
  z: number;
}

// Fixed pedestal positions, clear of obstacles/zones (see Arena layout).
export function getPickupSlots(): PickupSlot[] {
  return [
    { kind: "speed", x: 0, z: 11 },
    { kind: "shield", x: -11, z: 0 },
    { kind: "impulse", x: 11, z: 0 },
  ];
}

// Highlight-bucket pickup colors (chartreuse family, slight per-kind
// brightness variation for distinguishability): speed base, shield brighter,
// impulse deep. Exported so burst flashes reuse the exact same colors.
export const KIND_COLORS: Record<PowerUpKind, number> = {
  speed: HL_CHARTREUSE,
  shield: HL_CHARTREUSE_BRIGHT,
  impulse: HL_CHARTREUSE_DEEP,
};

// Floating pickup visuals (octahedrons, bob + spin, cheap stylized). update()
// returns the kinds collected this frame by proximity; taken slots respawn
// after POWERUP_RESPAWN_S. grant() forces a pickup (debug keys / playtest).
export class PowerUpPickups {
  private readonly group = new THREE.Group();
  private readonly meshes = new Map<PowerUpKind, THREE.Mesh>();
  private readonly available = new Map<PowerUpKind, boolean>();
  private readonly respawnAt = new Map<PowerUpKind, number>();
  private readonly disposables: Array<{ dispose(): void }> = [];
  private elapsed = 0;

  public constructor() {
    for (const slot of getPickupSlots()) {
      const geometry = new THREE.OctahedronGeometry(0.35);
      const material = new THREE.MeshStandardMaterial({
        color: BASE_PICKUP,
        emissive: KIND_COLORS[slot.kind],
        emissiveIntensity: 1.6,
        roughness: 0.4,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(slot.x, 1.1, slot.z);
      this.group.add(mesh);
      this.meshes.set(slot.kind, mesh);
      this.available.set(slot.kind, true);
      this.respawnAt.set(slot.kind, 0);
      this.disposables.push(geometry, material);
    }
  }

  public get object(): THREE.Group {
    return this.group;
  }

  public isAvailable(kind: PowerUpKind): boolean {
    return this.available.get(kind) ?? false;
  }

  public grant(kind: PowerUpKind): void {
    this.available.set(kind, false);
    this.respawnAt.set(kind, this.elapsed + POWERUP_RESPAWN_S);
    const mesh = this.meshes.get(kind);
    if (mesh !== undefined) {
      mesh.visible = false;
    }
  }

  public update(deltaSeconds: number, playerX: number, playerZ: number): PowerUpKind[] {
    if (deltaSeconds > 0) {
      this.elapsed += deltaSeconds;
    }
    const collected: PowerUpKind[] = [];
    for (const slot of getPickupSlots()) {
      const mesh = this.meshes.get(slot.kind);
      if (mesh === undefined) {
        continue;
      }
      if (this.available.get(slot.kind) === true) {
        mesh.rotation.y += deltaSeconds * 2.2;
        mesh.position.y = 1.1 + Math.sin(this.elapsed * 2.5 + slot.x) * 0.15;
        const dx = playerX - slot.x;
        const dz = playerZ - slot.z;
        if (dx * dx + dz * dz <= POWERUP_PICKUP_RADIUS * POWERUP_PICKUP_RADIUS) {
          this.grant(slot.kind);
          collected.push(slot.kind);
        }
      } else if (this.elapsed >= (this.respawnAt.get(slot.kind) ?? 0)) {
        this.available.set(slot.kind, true);
        mesh.visible = true;
      }
    }
    return collected;
  }

  public reset(): void {
    this.elapsed = 0;
    for (const kind of POWERUP_KINDS) {
      this.available.set(kind, true);
      this.respawnAt.set(kind, 0);
      const mesh = this.meshes.get(kind);
      if (mesh !== undefined) {
        mesh.visible = true;
      }
    }
  }

  public dispose(): void {
    for (const tracked of this.disposables) {
      tracked.dispose();
    }
    this.disposables.length = 0;
    this.meshes.clear();
    this.group.clear();
  }
}
