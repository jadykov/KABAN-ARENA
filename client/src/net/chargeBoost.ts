import { CHARGE_BOOST_MULTIPLIER, CHARGE_MAX_S } from "../config";

// Accumulation lets a pickup or expiry mid-hold affect only the active time.
// Canceling a hold never spends the server's next-shot bonus.
export function advanceEffectiveChargeMs(currentMs: number, elapsedMs: number, boostRemainingMs: number): number {
  const current = Number.isFinite(currentMs) ? Math.max(0, currentMs) : 0;
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const boostLeft = Number.isFinite(boostRemainingMs) ? Math.max(0, boostRemainingMs) : 0;
  const boostedPart = Math.min(elapsed, boostLeft);
  return Math.min(CHARGE_MAX_S * 1000,
    current + elapsed + boostedPart * (CHARGE_BOOST_MULTIPLIER - 1));
}
