export type SuperBonusKind = "sheep" | "turkey" | "freeze" | "boomerang" | "jelly" | "herring" | "swamp" | "ice" | "soda" | "vacuum" | "grenade";
export interface SuperBonusDefinition {
  readonly id: string;
  readonly kind: SuperBonusKind;
  readonly name: string;
  readonly hint: string;
  readonly color: number;
  readonly directWeak: number;
  readonly directStrong: number;
}
export const SUPER_BONUS_SLOT_MS: number;
export const MAX_SHEEP: number;
export const FREEZE_MS: number;
export const TURKEY_MS: number;
export const CONTROL_IMMUNITY_MS: number;
export const VACUUM_ACTIVE_MS: number;
export const TEMPORARY_SWAMP_SPEED_MULT: number;
export const GRENADE_FRAGMENT_COUNT: number;
export const GRENADE_FRAGMENT_DAMAGE: number;
export const GRENADE_FRAGMENT_RADIUS: number;
export const GRENADE_BURST_MS: number;
export const SUPER_BONUSES: readonly SuperBonusDefinition[];
export const SUPER_BONUS_KINDS: readonly SuperBonusKind[];
export function isSuperBonusKind(value: unknown): value is SuperBonusKind;
export function getSuperBonus(value: unknown): SuperBonusDefinition | undefined;
export function directBonusDamage(kind: unknown, power01: number): number;
export interface TemporarySurfaceEffect {
  effectId: string;
  kind: string;
  x: number;
  y: number;
  z: number;
  radius: number;
  createdAt: number;
  expiresAt: number;
}
export function activeTemporarySurface<T extends TemporarySurfaceEffect>(
  effects: Iterable<T>, x: number, bodyY: number, z: number, now: number,
  bodyCentreY?: number, visible?: (effect: T) => boolean,
): (T & { kind: "swamp" | "ice" }) | undefined;
