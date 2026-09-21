// Light client-side aim assist (mobile, subtle, deterministic).
// If a living enemy within AIM_ASSIST_MAX_DIST_M sits inside a narrow cone
// (AIM_ASSIST_CONE_DEG) around the current aim direction, gently pull
// yaw/pitch toward it by AIM_ASSIST_BLEND (max ~50%, never a snap).
// Pure + deterministic: no randomness, no Date, no DOM. Server authority is
// unchanged (server BALL_HIT_RADIUS 0.9 kept) — this only nudges the
// release-time payload AND the charge preview (same path, so preview dots
// match the real flight — bug 2). Elevation-aware (bug 2, primary): the
// muzzle height comes from the live body-center Y (same torso offset the
// fire payload/preview use) and each target's height from its replicated
// body-center Y — never ground anchors, so downhill shots from towers keep
// their pitch instead of flattening toward horizontal.

import {
  AIM_ASSIST_ACQUIRE_FRACTION,
  AIM_ASSIST_BLEND,
  AIM_ASSIST_CONE_DEG,
  AIM_ASSIST_MAX_DIST_M,
  AIM_ASSIST_STICKY_MARGIN_DEG,
  BALL_TORSO_OFFSET,
} from "../config";

export interface AssistCandidate {
  sessionId: string;
  x: number;
  z: number;
  alive: boolean;
  // Replicated body-center Y (server player.y, eased by RemoteAvatars).
  // Missing/non-finite falls back to muzzle + ASSIST_FALLBACK_DY below.
  y?: number | null;
}

export interface AssistSelf {
  x: number;
  z: number;
  // Live body-center Y (avatar.position.y) — the same base the fire payload
  // (throwerY) and the preview muzzle use.
  y: number;
}

// Nominal muzzle->body drop (m) used ONLY when a height is unknown: the old
// ground anchors (target 1.1, muzzle 1.4) differed by -0.3, kept as the
// fallback delta so open-ground behavior without Y data is unchanged. Never
// a ground anchor in the assist math itself.
export const ASSIST_FALLBACK_DY = -0.3;

function wrapPi(angle: number): number {
  const twoPi = Math.PI * 2;
  let wrapped = angle % twoPi;
  if (wrapped > Math.PI) {
    wrapped -= twoPi;
  } else if (wrapped < -Math.PI) {
    wrapped += twoPi;
  }
  return wrapped;
}

// Sticky-target state for preview-jitter fix (bug C): caller-owned, mutated
// in place (zero-alloc) — main.ts holds one and passes it every refresh.
// lastId = sessionId of the currently tracked target (null = none).
export interface AssistStick {
  lastId: string | null;
}

// Zero-alloc core (bug 2 / AC7): writes into `out` and returns it — no unit
// vectors, no intermediate objects, scalar math only — so the per-frame
// charge preview can share the exact payload path without per-frame allocs.
// Hysteresis (bug C): with `stick` provided, the tracked target is kept
// until it exits the cone or a rival beats its cone angle by
// AIM_ASSIST_STICKY_MARGIN_DEG; newcomers must additionally sit inside
// AIM_ASSIST_ACQUIRE_FRACTION of the cone to steal. Near-tied candidates
// and cone-edge crossings stop flipping the solve every refresh, so the
// preview dots stay glued. Without `stick` (undefined) the behavior is
// exactly the old stateless smallest-angle pick.
export function applyAimAssistTo(
  out: { yaw: number; pitch: number },
  yaw: number,
  pitch: number,
  self: AssistSelf,
  candidates: readonly AssistCandidate[],
  stick?: AssistStick | null,
): { yaw: number; pitch: number } {
  const safeYaw = Number.isFinite(yaw) ? yaw : 0;
  const safePitch = Number.isFinite(pitch) ? pitch : 0.25;
  out.yaw = safeYaw;
  out.pitch = safePitch;
  if (!Number.isFinite(self.x) || !Number.isFinite(self.z) || !Number.isFinite(self.y)) {
    return out;
  }
  // Current aim direction, inline (same convention as directionFromYawPitch:
  // -Z forward, yaw around Y, pitch above horizon).
  const cosPitch = Math.cos(safePitch);
  const currentX = -Math.sin(safeYaw) * cosPitch;
  const currentY = Math.sin(safePitch);
  const currentZ = -Math.cos(safeYaw) * cosPitch;
  const muzzleY = self.y + BALL_TORSO_OFFSET;
  const coneRad = (AIM_ASSIST_CONE_DEG * Math.PI) / 180;
  // Newcomers must clear the dead-zone fraction; the tracked target holds
  // to the full cone edge (enter/exit hysteresis against edge tremor).
  const acquireRad = coneRad * Math.max(0, Math.min(1, AIM_ASSIST_ACQUIRE_FRACTION));
  const stickyMargin = (AIM_ASSIST_STICKY_MARGIN_DEG * Math.PI) / 180;
  const preferId = stick !== undefined && stick !== null ? stick.lastId : null;
  const maxDistSq = AIM_ASSIST_MAX_DIST_M * AIM_ASSIST_MAX_DIST_M;
  let bestX = 0;
  let bestY = 0;
  let bestZ = 0;
  let bestId: string | null = null;
  let bestAngle = coneRad + 1e-9;
  let found = false;
  // Tracked-target angle (Infinity when absent/invalid — never selected).
  let preferAngle = Number.POSITIVE_INFINITY;
  let preferX = 0;
  let preferY = 0;
  let preferZ = 0;
  for (const candidate of candidates) {
    if (candidate.alive !== true) {
      continue;
    }
    if (!Number.isFinite(candidate.x) || !Number.isFinite(candidate.z)) {
      continue;
    }
    const dx = candidate.x - self.x;
    const dz = candidate.z - self.z;
    const distSq = dx * dx + dz * dz;
    if (!(distSq <= maxDistSq)) {
      continue;
    }
    if (distSq < 1e-8) {
      continue;
    }
    const rawY = candidate.y;
    const targetY =
      typeof rawY === "number" && Number.isFinite(rawY) ? rawY : muzzleY + ASSIST_FALLBACK_DY;
    const dy = targetY - muzzleY;
    const length = Math.hypot(dx, dy, dz);
    if (!(length > 1e-6)) {
      continue;
    }
    const tx = dx / length;
    const ty = dy / length;
    const tz = dz / length;
    const dot = Math.max(-1, Math.min(1, currentX * tx + currentY * ty + currentZ * tz));
    const angle = Math.acos(dot);
    if (preferId !== null && candidate.sessionId === preferId && angle <= coneRad && angle < preferAngle) {
      preferAngle = angle;
      preferX = tx;
      preferY = ty;
      preferZ = tz;
    }
    // Newcomer threshold (dead zone, only when stick memory is active):
    // the tracked target always competes at the full cone edge, newcomers
    // must clear the acquire fraction. Stateless calls (no stick) keep the
    // old full-cone pick exactly.
    const useHysteresis = stick !== undefined && stick !== null;
    const isPreferred = preferId !== null && candidate.sessionId === preferId;
    const threshold = !useHysteresis || isPreferred ? coneRad : acquireRad;
    if (angle <= threshold && angle < bestAngle) {
      bestAngle = angle;
      bestX = tx;
      bestY = ty;
      bestZ = tz;
      bestId = candidate.sessionId;
      found = true;
    }
  }
  // Hysteretic selection: keep the tracked target while it is inside the
  // cone unless a rival beats it by the sticky margin; otherwise take the
  // smallest-angle newcomer (or nothing).
  let chosenId: string | null = null;
  if (found) {
    if (preferAngle <= coneRad && bestAngle >= preferAngle - stickyMargin) {
      bestX = preferX;
      bestY = preferY;
      bestZ = preferZ;
      chosenId = preferId;
    } else {
      chosenId = bestId;
    }
  }
  if (stick !== undefined && stick !== null) {
    stick.lastId = chosenId;
  }
  if (!found) {
    return out;
  }
  // Desired yaw/pitch, inline (same convention as yawPitchFromDirection).
  const desiredYaw = Math.atan2(-bestX, -bestZ);
  const desiredPitch = Math.atan2(bestY, Math.max(0.0001, Math.hypot(bestX, bestZ)));
  const blend = Math.max(0, Math.min(1, AIM_ASSIST_BLEND));
  out.yaw = safeYaw + wrapPi(desiredYaw - safeYaw) * blend;
  out.pitch = safePitch + (desiredPitch - safePitch) * blend;
  return out;
}

export function applyAimAssist(
  yaw: number,
  pitch: number,
  self: AssistSelf,
  candidates: readonly AssistCandidate[],
): { yaw: number; pitch: number } {
  return applyAimAssistTo({ yaw: 0, pitch: 0 }, yaw, pitch, self, candidates);
}
