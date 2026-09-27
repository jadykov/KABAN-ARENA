import * as THREE from "three";
import { SHIELD_CAPACITY, SPEED_MULTIPLIER } from "../config";
import { ARENA_LAYOUT, PICKUP_VISUAL_Y } from "../layout";
import { BASE_PICKUP, HL_CHARTREUSE_BRIGHT } from "../palette";
import type { NetPickupSnapshot } from "../net/protocol";

export type PowerUpKind = "shield" | "speed";
export const POWERUP_KINDS: readonly PowerUpKind[] = ["shield", "speed"];

// The authoritative server owns pickup grants, damage absorption, and effect
// deadlines. This state only mirrors a player's latest replicated effects so
// local movement prediction and visuals agree with the server.
export class PowerUpState {
  private serverNowMs = 0;
  private shieldHp = 0;
  private shieldUntilMs = 0;
  private speedUntilMs = 0;

  public sync(
    player: { shieldHp: number; shieldUntil: number; speedUntil: number },
    serverNow: number,
  ): void {
    this.serverNowMs = Number.isFinite(serverNow) ? Math.max(0, serverNow) : 0;
    this.shieldHp = Number.isFinite(player.shieldHp)
      ? Math.max(0, Math.min(SHIELD_CAPACITY, player.shieldHp))
      : 0;
    this.shieldUntilMs = Number.isFinite(player.shieldUntil) ? Math.max(0, player.shieldUntil) : 0;
    this.speedUntilMs = Number.isFinite(player.speedUntil) ? Math.max(0, player.speedUntil) : 0;
  }

  // Advance the synchronized clock between 20 Hz snapshots. This never
  // creates or extends an effect; the next server snapshot corrects it.
  public update(deltaSeconds: number): void {
    if (Number.isFinite(deltaSeconds) && deltaSeconds > 0 && this.serverNowMs > 0) {
      this.serverNowMs += deltaSeconds * 1000;
    }
  }

  public isSpeedActive(): boolean {
    return this.serverNowMs > 0 && this.serverNowMs < this.speedUntilMs;
  }

  public getSpeedMultiplier(): number {
    return this.isSpeedActive() ? SPEED_MULTIPLIER : 1;
  }

  public getSpeedRemaining(): number {
    return this.isSpeedActive() ? (this.speedUntilMs - this.serverNowMs) / 1000 : 0;
  }

  public hasShield(): boolean {
    return this.shieldHp > 0 && this.serverNowMs > 0 && this.serverNowMs < this.shieldUntilMs;
  }

  public getShieldHp(): number {
    return this.hasShield() ? this.shieldHp : 0;
  }

  public getShieldFraction(): number {
    return this.getShieldHp() / SHIELD_CAPACITY;
  }

  public getShieldRemaining(): number {
    return this.hasShield() ? (this.shieldUntilMs - this.serverNowMs) / 1000 : 0;
  }

  public reset(): void {
    this.serverNowMs = 0;
    this.shieldHp = 0;
    this.shieldUntilMs = 0;
    this.speedUntilMs = 0;
  }
}

export interface PickupSlot {
  id: number;
  x: number;
  z: number;
}

// All three pedestals are neutral. Their stable decimal layout indexes match
// the keys of the server's replicated pickup map.
const PICKUP_SLOTS: readonly PickupSlot[] = ARENA_LAYOUT.pickups.map((point, id) => ({
  id,
  x: point.x,
  z: point.z,
}));

export function getPickupSlots(): readonly PickupSlot[] {
  return PICKUP_SLOTS;
}

// The two granted effects can reuse these accents for particles/icons.
export const KIND_COLORS: Record<PowerUpKind, number> = {
  shield: HL_CHARTREUSE_BRIGHT,
  speed: HL_CHARTREUSE_BRIGHT,
};

// Floating neutral pedestals. Proximity never collects one locally. Only a
// replicated active flag changes visibility, so every viewer sees the same
// pickup and its server-timed return.
export class PowerUpPickups {
  private readonly group = new THREE.Group();
  private readonly meshes = new Map<number, THREE.Mesh>();
  private readonly disposables: Array<{ dispose(): void }> = [];
  private elapsed = 0;

  public constructor() {
    for (const slot of PICKUP_SLOTS) {
      const geometry = new THREE.OctahedronGeometry(0.35);
      const material = new THREE.MeshStandardMaterial({
        color: BASE_PICKUP,
        emissive: HL_CHARTREUSE_BRIGHT,
        emissiveIntensity: 1.25,
        roughness: 0.4,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(slot.x, PICKUP_VISUAL_Y, slot.z);
      mesh.visible = false;
      this.group.add(mesh);
      this.meshes.set(slot.id, mesh);
      this.disposables.push(geometry, material);
    }
  }

  public get object(): THREE.Group {
    return this.group;
  }

  public isAvailable(id: number): boolean {
    return this.meshes.get(id)?.visible === true;
  }

  public sync(pickups: readonly Pick<NetPickupSnapshot, "id" | "active">[]): void {
    const active = new Set<number>();
    for (const pickup of pickups) {
      if (pickup.active === true && Number.isInteger(pickup.id) && pickup.id >= 0) {
        active.add(pickup.id);
      }
    }
    for (const slot of PICKUP_SLOTS) {
      const mesh = this.meshes.get(slot.id);
      if (mesh !== undefined) {
        mesh.visible = active.has(slot.id);
      }
    }
  }

  public update(deltaSeconds: number): void {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) {
      return;
    }
    this.elapsed += deltaSeconds;
    for (const slot of PICKUP_SLOTS) {
      const mesh = this.meshes.get(slot.id);
      if (mesh === undefined || !mesh.visible) {
        continue;
      }
      mesh.rotation.y += deltaSeconds * 2.2;
      mesh.position.y = PICKUP_VISUAL_Y + Math.sin(this.elapsed * 2.5 + slot.id * 2.1) * 0.15;
    }
  }

  public reset(): void {
    this.elapsed = 0;
    this.sync([]);
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
