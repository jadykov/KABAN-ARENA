import { HIT_FLASH_DURATION_S, SHAKE_DECAY, SHAKE_MAX_OFFSET } from "../config";

export interface ShakeOffset {
  x: number;
  y: number;
  z: number;
}

// Light trauma-based camera shake (QD4-A): small offsets only, decays fast,
// never nauseating on phones. Pure math — no three.js dependency.
export class CameraShake {
  private trauma = 0;
  private seed = 0;

  public add(amount: number): void {
    this.trauma = Math.max(0, Math.min(1, this.trauma + amount));
  }

  public update(deltaSeconds: number): ShakeOffset {
    if (deltaSeconds > 0) {
      this.trauma = Math.max(0, this.trauma - SHAKE_DECAY * deltaSeconds);
    }
    this.seed += deltaSeconds * 30;
    const strength = this.trauma * this.trauma * SHAKE_MAX_OFFSET;
    return {
      x: Math.sin(this.seed * 1.1) * strength,
      y: Math.cos(this.seed * 1.7) * strength * 0.6,
      z: Math.sin(this.seed * 0.9 + 1.3) * strength,
    };
  }

  public reset(): void {
    this.trauma = 0;
    this.seed = 0;
  }
}

// Hit flash (QD4-A): spikes the avatar material emissive intensity, then
// fades back over HIT_FLASH_DURATION_S. Structural material typing keeps
// this unit-testable with a stub.
export class HitFlash {
  private timer = 0;

  public trigger(): void {
    this.timer = HIT_FLASH_DURATION_S;
  }

  public update(deltaSeconds: number, material: { emissiveIntensity: number }): boolean {
    if (this.timer <= 0) {
      material.emissiveIntensity = 0;
      return false;
    }
    if (deltaSeconds > 0) {
      this.timer = Math.max(0, this.timer - deltaSeconds);
    }
    const progress = this.timer / HIT_FLASH_DURATION_S;
    material.emissiveIntensity = 2.5 * progress;
    return this.timer > 0;
  }

  public reset(): void {
    this.timer = 0;
  }
}
