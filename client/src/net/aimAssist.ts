// Light client-side aim assist (mobile, subtle, deterministic).
// If a living enemy within AIM_ASSIST_MAX_DIST_M sits inside a narrow cone
// (AIM_ASSIST_CONE_DEG) around the current aim direction, gently pull
// yaw/pitch toward it by AIM_ASSIST_BLEND (max ~50%, never a snap).
// Pure + deterministic: no randomness, no Date, no DOM. Server authority is
// unchanged (server BALL_HIT_RADIUS 0.9 kept) — this only nudges the
// release-time payload built in main.ts stopCharge.

import {
  AIM_ASSIST_BLEND,
  AIM_ASSIST_CONE_DEG,
  AIM_ASSIST_MAX_DIST_M,
} from "../config";
import { directionFromYawPitch, yawPitchFromDirection } from "./protocol";

export interface AssistCandidate {
  sessionId: string;
  x: number;
  z: number;
  alive: boolean;
}

export interface AssistSelf {
  x: number;
  z: number;
}

// Target body center height vs ground-level muzzle height (body-center 1.1
// + BALL_TORSO_OFFSET 0.3 = 1.4). Named so the vertical aim math stays
// reviewable. Elevation throws (4d.1) keep these ground anchors: the assist
// cone absorbs the small torso delta, no per-target height lookup needed.
export const ASSIST_TARGET_HEIGHT = 1.1;
export const ASSIST_MUZZLE_HEIGHT = 1.4;

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

export function applyAimAssist(
  yaw: number,
  pitch: number,
  self: AssistSelf,
  candidates: readonly AssistCandidate[],
): { yaw: number; pitch: number } {
  const safeYaw = Number.isFinite(yaw) ? yaw : 0;
  const safePitch = Number.isFinite(pitch) ? pitch : 0.25;
  if (!Number.isFinite(self.x) || !Number.isFinite(self.z)) {
    return { yaw: safeYaw, pitch: safePitch };
  }
  const coneRad = (AIM_ASSIST_CONE_DEG * Math.PI) / 180;
  const maxDistSq = AIM_ASSIST_MAX_DIST_M * AIM_ASSIST_MAX_DIST_M;
  const current = directionFromYawPitch(safeYaw, safePitch);
  let bestYaw = 0;
  let bestPitch = 0;
  let bestAngle = coneRad + 1e-9;
  let found = false;
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
    const dy = ASSIST_TARGET_HEIGHT - ASSIST_MUZZLE_HEIGHT;
    const length = Math.hypot(dx, dy, dz);
    if (!(length > 1e-6)) {
      continue;
    }
    const tx = dx / length;
    const ty = dy / length;
    const tz = dz / length;
    const dot = Math.max(-1, Math.min(1, current.x * tx + current.y * ty + current.z * tz));
    const angle = Math.acos(dot);
    if (angle <= coneRad && angle < bestAngle) {
      bestAngle = angle;
      const desired = yawPitchFromDirection(tx, ty, tz);
      bestYaw = desired.yaw;
      bestPitch = desired.pitch;
      found = true;
    }
  }
  if (!found) {
    return { yaw: safeYaw, pitch: safePitch };
  }
  const blend = Math.max(0, Math.min(1, AIM_ASSIST_BLEND));
  const yawOut = safeYaw + wrapPi(bestYaw - safeYaw) * blend;
  const pitchOut = safePitch + (bestPitch - safePitch) * blend;
  return { yaw: yawOut, pitch: pitchOut };
}
