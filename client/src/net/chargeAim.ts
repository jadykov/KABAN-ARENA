import {
  AIM_PITCH_DAMP,
  AIM_YAW_DAMP,
  CAMERA_PITCH_MAX,
  CHARGE_PITCH_EASE_DONE,
  CHARGE_PITCH_EASE_RATE,
} from "../config";

// Charge pitch leveling (owner: camera eases ONCE toward the horizon at aim
// start, then free aim). Pure state + math so it stays unit-testable; the
// per-frame wiring lives in main.ts. No allocations, scalar only.

// One-shot ease state: armed by startCharge, cleared by the first aim
// deflection, by convergence, or by any charge exit (shot/cancel/reset).
export interface ChargeLevel {
  active: boolean;
}

export function beginChargeLevel(): ChargeLevel {
  return { active: true };
}

// Stick-rate scales while charging/aiming (Stage 4d.2-fix2): both axes run
// calmer at the damped rate, full rate otherwise. The pitch RANGE is never
// touched (aiming down from elevation stays fully possible — only rates
// scale). Yaw damp has its own constant (AIM_YAW_DAMP = 0.6, milder than the
// post-playtest pitch damp AIM_PITCH_DAMP = 0.42) — same pattern, not the
// same value.
export function pitchRateScale(isCharging: boolean): number {
  return isCharging ? AIM_PITCH_DAMP : 1;
}

export function yawRateScale(isCharging: boolean): number {
  return isCharging ? AIM_YAW_DAMP : 1;
}

// Aim-mirror camera pitch (post-playtest fix round 3, industry-standard TPS
// aiming): while charging the camera pitch is the NEGATED aim pitch, so
// aiming UP drops the camera lower behind the character and the view tilts
// up along the shot arc (the player sees where the upward shot goes),
// while aiming down slightly raises it (symmetric). Rationale: with the
// shipped convention (positive pitch = camera higher, looking down) copying
// the aim pitch directly put the camera above the head looking down at it
// whenever the player aimed up — unusable. The aim pitch itself is untouched
// (still clamped to [CAMERA_PITCH_MIN, CAMERA_PITCH_MAX] in main.ts, and the
// fire payload keeps that band); only the CAMERA takes the mirror, clamped
// symmetrically to [-CAMERA_PITCH_MAX, +CAMERA_PITCH_MAX] — the plain
// setCameraAngles MIN (-0.15) would clip the mirror, so the charge call site
// passes the wider band via the min/max override. Ground clearance at the
// widest mirror (charge zoom d = 3.2m, avatar.y ~= 1.1): camera y =
// avatar.y + 2.1 + sin(-0.36)*3.2 ~= avatar.y + 0.97 ~= 2.07 — above ground.
// After the shot the mirrored camera pitch (down to -CAMERA_PITCH_MAX)
// survives on the camera: the next idle follow (while moving) eases it back
// toward IDLE_FOLLOW_PITCH through the widened-band override
// (tolerantCameraPitchMin in idleFollow.ts — the default-band clamp would
// snap -0.36 to CAMERA_PITCH_MIN in a single frame), and RMB drags tolerate
// the out-of-band start the same way (SceneManager.update bounds the drag
// against the current pitch). So the return is a smooth exp ease, never a
// snap — but it DOES need that explicit tolerance at every clamp site.
// Pure math, no allocations; non-finite passes through
// (call sites treat it as "do not move the camera").
export function mirrorChargeCameraPitch(aimPitch: number): number {
  if (!Number.isFinite(aimPitch)) {
    return aimPitch;
  }
  const mirrored = -aimPitch;
  const clamped = Math.max(-CAMERA_PITCH_MAX, Math.min(CAMERA_PITCH_MAX, mirrored));
  return clamped === 0 ? 0 : clamped;
}

// Shared camera->aim un-mirror (F1 fix): every site that derives the TRUE aim
// pitch back from the (possibly mirrored) camera pitch goes through here.
// The mirror is an exact involution on the symmetric band [-CAMERA_PITCH_MAX,
// +CAMERA_PITCH_MAX]: for x in that band, -x is in the band too, so neither
// application clamps and mirror(mirror(x)) = -(-x) = x. The aim pitch during
// charge always lives in [CAMERA_PITCH_MIN, CAMERA_PITCH_MAX] subset of that
// band (main.ts stick integration clamps it there), so un-mirroring a charge
// camera pitch recovers the aim EXACTLY (up to float rounding): an aim of
// +0.3 shows camera -0.3, and unmirror(-0.3) = +0.3. Out-of-band inputs
// (|x| > CAMERA_PITCH_MAX) collapse to the band edge — reachable only via
// the (now removed) charge feedback bug, never in the fixed wiring, so the
// edge collapse is a safe backstop, not a live path. Non-finite passes
// through like the mirror (call sites treat it as "do not move the aim").
// Scalar only, no allocations.
export function unmirrorChargeCameraPitch(cameraPitch: number): number {
  return mirrorChargeCameraPitch(cameraPitch);
}

// Idle aim-track gate (F2 fix): the per-frame camera->aim copy in main.ts
// may run only when it cannot see a mirrored camera. While charging the
// camera is the DERIVED value (camera pitch = mirror(aim pitch) every tick),
// so copying it back into aim feeds -aim into aim: frame N writes the mirror,
// frame N+1 copies it back as aim, frame N+2 mirrors again — a ~30Hz
// sign-flip oscillation of aim, camera, dots and parity. Aim is the source
// of truth during charge; the copy only makes sense for non-charge camera
// moves (RMB free-look), hence false whenever isCharging regardless of stick
// state. Scalar only, no allocations.
export function shouldTrackAimFromCamera(
  isCharging: boolean,
  stickIdle: boolean,
  floatIdle: boolean,
): boolean {
  if (isCharging) {
    return false;
  }
  return stickIdle && floatIdle;
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
