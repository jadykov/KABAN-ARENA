export const ARENA_HALF_SIZE: 16.8;
export const RAMP_SLOPE_DEG: 14;
export const PICKUP_VISUAL_Y: 1.1;
export function rampRunForTop(topY: number): number;
export function rampHeightAt(platform: LayoutPlatform, x: number, z: number, extraBand?: number): number;

export interface LayoutPoint {
  x: number;
  z: number;
}

export interface LayoutObstacle extends LayoutPoint {
  hx: number;
  hz: number;
  topY: number;
}

export type RampSide = "+x" | "-x" | "+z" | "-z";

export interface LayoutPlatform extends LayoutObstacle {
  rampSide: RampSide;
  rampWidth: number;
}

export interface LayoutZone extends LayoutPoint {
  radius: number;
}

export type PickupKind = "speed" | "shield" | "impulse";

export interface LayoutPickup extends LayoutPoint {
  kind: PickupKind;
}

export interface ArenaLayout {
  version: 1;
  obstacles: LayoutObstacle[];
  platforms: LayoutPlatform[];
  swampZones: LayoutZone[];
  iceZones: LayoutZone[];
  trampolines: LayoutZone[];
  spawns: LayoutPoint[];
  pickups: LayoutPickup[];
}

export function validateArenaLayout(input: unknown): ArenaLayout;
