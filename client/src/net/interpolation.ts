// Stage 4 client interpolation: exponential lerp for positions + shortest-
// arc slerp-equivalent for rotY. The server patches at 20Hz; the client
// renders at display rate, so remote avatars ease toward the latest snapshot
// instead of snapping (snap only on first sight or teleports/respawns).

import { LERP_SMOOTHING, SNAP_DISTANCE } from "../config";

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// Shortest-arc angle interpolation (rotY wrap at +/-PI).
export function lerpAngle(a: number, b: number, t: number): number {
  const twoPi = Math.PI * 2;
  let delta = (b - a) % twoPi;
  if (delta > Math.PI) {
    delta -= twoPi;
  } else if (delta < -Math.PI) {
    delta += twoPi;
  }
  return a + delta * t;
}

// Frame-rate-independent smoothing factor: 1 - exp(-speed * dt).
export function expSmoothFactor(deltaSeconds: number, speed: number = LERP_SMOOTHING): number {
  if (!(deltaSeconds > 0)) {
    return 0;
  }
  return 1 - Math.exp(-speed * deltaSeconds);
}

export interface RemoteTarget {
  x: number;
  y: number;
  z: number;
  rotY: number;
}

// One interpolated remote avatar: eases toward the newest server snapshot.
export class RemoteTrack {
  public x: number;
  public y: number;
  public z: number;
  public rotY: number;
  private initialized = false;

  public constructor(x = 0, y = 1.1, z = 0, rotY = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.rotY = rotY;
  }

  public snap(target: RemoteTarget): void {
    this.x = target.x;
    this.y = target.y;
    this.z = target.z;
    this.rotY = target.rotY;
    this.initialized = true;
  }

  public get isInitialized(): boolean {
    return this.initialized;
  }

  public update(target: RemoteTarget, deltaSeconds: number): void {
    if (!this.initialized) {
      this.snap(target);
      return;
    }
    const dx = target.x - this.x;
    const dy = target.y - this.y;
    const dz = target.z - this.z;
    // Teleport/respawn guard: snap instead of streaking across the arena.
    if (dx * dx + dy * dy + dz * dz > SNAP_DISTANCE * SNAP_DISTANCE) {
      this.snap(target);
      return;
    }
    const t = expSmoothFactor(deltaSeconds);
    this.x = lerp(this.x, target.x, t);
    this.y = lerp(this.y, target.y, t);
    this.z = lerp(this.z, target.z, t);
    this.rotY = lerpAngle(this.rotY, target.rotY, t);
  }
}
