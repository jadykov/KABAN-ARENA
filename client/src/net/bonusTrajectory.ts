import { BALL_FIRST_TICK_HOLD_S } from "../config";

// The sausage has no gravity. Its server velocity turns back toward the
// muzzle after six metres, using the room's 50ms motion step and 10/s turn.
// Return the signed distance on the original aim ray, with no allocations.
export function boomerangPreviewDistance(speed: number, index: number, count: number): number | null {
  if (!(speed > 0) || !Number.isFinite(speed) || !(count > 0) || index < 0 || index >= count) return null;
  const sampleTime = BALL_FIRST_TICK_HOLD_S + index / Math.max(1, count - 1) * (12 / speed + 0.1);
  let travelled = 0;
  let distance = 0;
  let velocity = speed;
  let remaining = sampleTime;
  let returning = false;
  while (remaining > 0.000001) {
    if (travelled >= 6) returning = true;
    if (returning && Math.abs(distance) < 0.25) return null;
    const dt = Math.min(0.05, remaining);
    if (returning) velocity += (-Math.sign(distance) * speed - velocity) * Math.min(1, dt * 10);
    const step = velocity * dt;
    distance += step;
    travelled += Math.abs(step);
    remaining -= dt;
  }
  return distance;
}
