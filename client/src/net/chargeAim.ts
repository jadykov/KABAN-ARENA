import { AIM_PITCH_DAMP, CHARGE_PITCH_EASE_DONE, CHARGE_PITCH_EASE_RATE } from "../config";

// Charge pitch leveling (owner: camera eases ONCE toward the horizon at aim
// start, then free aim). Pure state + math so it stays unit-testable; the
// per-frame wiring lives in main.ts. No allocations, scalar only.

// One-shot ease state: armed by startCharge, cleared by the first aim-stick
// deflection, by convergence, or by any charge exit (shot/cancel/reset).
export interface ChargeLevel {
  active: boolean;
}

export function beginChargeLevel(): ChargeLevel {
  return { active: true };
}

// Vertical stick-rate scale: muted wander while charging, full rate
// otherwise. Yaw is never damped; the pitch RANGE is never touched (aiming
// down from elevation stays fully possible — only the rate scales).
export function pitchRateScale(isCharging: boolean): number {
  return isCharging ? AIM_PITCH_DAMP : 1;
}

// One ease step toward the horizon (pitch 0). Returns the updated pitch.
// A deflected aim stick takes over instantly (pitch untouched, ease off);
// without input the pitch converges and the ease completes inside the DONE
// band (snapped to exactly 0). Inactive or non-positive dt is a passthrough.
export function stepChargeLevel(
  level: ChargeLevel,
  pitch: number,
  aimDeflected: boolean,
  deltaSeconds: number,
): number {
  if (!level.active || !(deltaSeconds > 0) || !Number.isFinite(pitch)) {
    return pitch;
  }
  if (aimDeflected) {
    level.active = false;
    return pitch;
  }
  const blend = 1 - Math.exp(-CHARGE_PITCH_EASE_RATE * deltaSeconds);
  const next = pitch + (0 - pitch) * blend;
  if (Math.abs(next) <= CHARGE_PITCH_EASE_DONE) {
    level.active = false;
    return 0;
  }
  return next;
}
