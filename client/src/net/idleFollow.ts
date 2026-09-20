import {
  CAMERA_PITCH_MAX,
  CAMERA_PITCH_MIN,
  IDLE_FOLLOW_MAX_STICK_ANGLE,
  IDLE_FOLLOW_MOVE_MIN,
  IDLE_FOLLOW_PITCH,
  IDLE_FOLLOW_RATE,
  SHOT_BODY_TURN_DONE_RAD,
  SHOT_BODY_TURN_RATE_S,
} from "../config";

// Idle soft-follow camera (Stage 4d.2-fix2, owner comfort): while playing,
// NOT charging, with no explicit look input and the avatar moving, the
// camera yaw eases behind the avatar's movement/facing yaw and the pitch
// levels toward near-horizon. Pure state + math so it stays unit-testable;
// the per-frame wiring lives in main.ts (inside `if (playing)`, which already
// excludes spectators). Scalar only, no allocations.

export interface IdleFollowGate {
  // `playing` already folds in !spectating (main.ts computes it as
  // isPlaying && !sceneManager.isSpectating()); `alive` is false only once
  // a snapshot explicitly reports the self dead (lastSelfAlive === false).
  playing: boolean;
  charging: boolean;
  alive: boolean;
  lookDx: number;
  lookDy: number;
  moveX: number;
  moveY: number;
}

// Stick angle from forward (radians, 0 = pure forward, PI = pure backpedal):
// phi = |atan2(moveX, moveY)| over the camera-relative stick vector
// (x = strafe right, y = forward), the same vector the gate carries.
// Scale-invariant (atan2 normalizes by construction); NaN for non-finite
// input so the gate below rejects it. Scalar only, no allocations.
export function stickAngleFromForward(moveX: number, moveY: number): number {
  if (!Number.isFinite(moveX) || !Number.isFinite(moveY)) {
    return Number.NaN;
  }
  return Math.abs(Math.atan2(moveX, moveY));
}

// True only when the follow may run this frame: playing, not charging,
// alive, zero explicit look input (any look delta wins outright — the follow
// never fights an active RMB drag or a free-camera touch drag), the avatar
// actually moving, AND the stick angle from forward within the PI/2 gate.
// The gate is the anti-orbit invariant: without it the per-frame delta is
// permanently -phi for any held off-forward input, so backward-leaning
// inputs (> PI/2, backpedal included) must produce ZERO camera motion.
export function shouldIdleFollow(gate: IdleFollowGate): boolean {
  if (!gate.playing || gate.charging || !gate.alive) {
    return false;
  }
  if (gate.lookDx !== 0 || gate.lookDy !== 0) {
    return false;
  }
  if (!Number.isFinite(gate.moveX) || !Number.isFinite(gate.moveY)) {
    return false;
  }
  if (Math.hypot(gate.moveX, gate.moveY) < IDLE_FOLLOW_MOVE_MIN) {
    return false;
  }
  return stickAngleFromForward(gate.moveX, gate.moveY) <= IDLE_FOLLOW_MAX_STICK_ANGLE;
}

// Forwardness rate scale: softens the sustained drift off the forward axis
// by scaling the follow rate with cos(phi) — 1.0 at pure forward, ~0 at pure
// sideways (cos(PI/2) ~= 0), so strafe holds barely crawl while diagonals
// follow firmly and pure forward is unchanged (cos(0) = 1, and delta -> 0 as
// phi -> 0 so the follow still converges). The interior peak phi*cos(phi)
// ~= 0.56 bounds sustained drift by IDLE_FOLLOW_RATE * 0.56 ~= 1.4 rad/s.
// Input is clamped to [0, MAX] so overshoot angles scale like the edge,
// never negative; non-finite input yields 0 (no motion) so a NaN stick can
// never drive the camera. Scalar, no alloc.
export function forwardnessRateScale(phi: number): number {
  if (!Number.isFinite(phi)) {
    return 0;
  }
  const clamped = Math.max(0, Math.min(Math.abs(phi), IDLE_FOLLOW_MAX_STICK_ANGLE));
  return Math.cos(clamped);
}

// Camera-behind conversion (4d.2-fix2 review follow-up): the follow camera
// sits at avatar + (sin c, cos c)*d and looks along (-sin c, -cos c)
// (SceneManager.updateCameraTransform), while the avatar faces
// (sin r, cos r) with rotation.y = r (SceneManager.update movement yaw, and
// the knockback fallback dir). Camera BEHIND the avatar therefore requires
// c = r + PI (mod 2PI) — passing raw r as the yaw target sits exactly PI
// away while moving (rotY is recomputed from camera-relative worldMove every
// frame), i.e. a permanent +/-PI shortest-arc delta -> ~1.3 rev/s orbit with
// WASD and no mouse input. Wrapped to [-PI, PI] so the shortest-arc step
// below converges to a fixed point.
export function cameraYawBehindFacing(facing: number): number {
  if (!Number.isFinite(facing)) {
    return facing;
  }
  const twoPi = Math.PI * 2;
  let behind = (facing + Math.PI) % twoPi;
  if (behind > Math.PI) {
    behind -= twoPi;
  } else if (behind < -Math.PI) {
    behind += twoPi;
  }
  return behind;
}

// One exp-ease step of the camera yaw toward the behind-avatar target yaw
// the shortest arc (wrap-safe at +/-PI, same convention as lerpAngle).
// Non-positive dt, non-positive rate, or non-finite input is a passthrough.
// The optional rate defaults to IDLE_FOLLOW_RATE: the follow call site
// passes IDLE_FOLLOW_RATE * forwardnessRateScale(phi) (cos softening toward
// the sideways edge).
export function stepIdleFollowYaw(
  yaw: number,
  targetYaw: number,
  deltaSeconds: number,
  rate: number = IDLE_FOLLOW_RATE,
): number {
  if (!(deltaSeconds > 0) || !(rate > 0) || !Number.isFinite(yaw) || !Number.isFinite(targetYaw)) {
    return yaw;
  }
  const twoPi = Math.PI * 2;
  let delta = (targetYaw - yaw) % twoPi;
  if (delta > Math.PI) {
    delta -= twoPi;
  } else if (delta < -Math.PI) {
    delta += twoPi;
  }
  return yaw + delta * (1 - Math.exp(-rate * deltaSeconds));
}

// One exp-ease step of the camera pitch toward near-horizon
// (IDLE_FOLLOW_PITCH). Non-positive dt, non-positive rate, or non-finite
// pitch is a passthrough. Same rate convention as the yaw step above.
export function stepIdleFollowPitch(
  pitch: number,
  deltaSeconds: number,
  rate: number = IDLE_FOLLOW_RATE,
): number {
  if (!(deltaSeconds > 0) || !(rate > 0) || !Number.isFinite(pitch)) {
    return pitch;
  }
  return pitch + (IDLE_FOLLOW_PITCH - pitch) * (1 - Math.exp(-rate * deltaSeconds));
}

// Post-shot follow clamp tolerance (F3 fix, option (a)): the pitch floor to
// floor to pass as the min override to setCameraAngles at the idle-follow
// call site. Normally CAMERA_PITCH_MIN (the shared default band). But the
// mirrored charge pitch (down to -CAMERA_PITCH_MAX) survives the shot on the
// camera, and the first eased follow frame from that out-of-band start would
// clamp -0.36 -> CAMERA_PITCH_MIN (-0.15) in ONE frame (~12 deg snap). While the current pitch sits below the
// default band, return the mirrored-widened floor -CAMERA_PITCH_MAX instead:
// the exp ease toward IDLE_FOLLOW_PITCH is monotonic, so the pitch glides
// back continuously and re-enters the default band on its own, at which
// point this returns MIN again and the plain clamp resumes — no persistent
// widening, no second easing implementation. Non-finite input returns MIN
// (setCameraAngles ignores NaN anyway). Scalar only, no allocations.
export function tolerantCameraPitchMin(currentPitch: number): number {
  if (Number.isFinite(currentPitch) && currentPitch < CAMERA_PITCH_MIN) {
    return -CAMERA_PITCH_MAX;
  }
  return CAMERA_PITCH_MIN;
}

// Post-shot body turn (owner fix round 2): after a REAL shot the avatar body
// turns to FACE THE SHOT DIRECTION. Yaw convention, re-derived from the
// shipped code (do not flip the sign):
// - Fire payload yaw vs ball dir: protocol.directionFromYawPitch(yaw, pitch)
//   (protocol.ts) returns dir = (-sin yaw * cosP, sinP, -cos yaw * cosP);
//   the server spawns from the identical formula (server hits.muzzleForShot,
//   dirX = -sin(yaw)*cosP, dirZ = -cos(yaw)*cosP, "must stay identical to
//   client directionFromYawPitch"). So the ball's horizontal direction is
//   -(sin shotYaw, cos shotYaw).
// - Body facing: SceneManager.update writes avatar.rotation.y =
//   atan2(worldMove.x, worldMove.z) (SceneManager.ts movement writer), i.e.
//   the facing dir is (sin r, cos r) — confirmed by the knockback fallback
//   dir (sin(avatar.rotation.y), cos(avatar.rotation.y)) in collectPowerUp.
// Hence the target body facing r satisfies (sin r, cos r) = ball dir, i.e.
// r = shotYaw + PI (wrapped to [-PI, PI]). For aimYaw = 0 the ball flies
// toward -Z and the body ends facing (0, -1) = rotation.y PI. Scalar math,
// no allocations.

// Shot yaw (fire payload / camera yaw at release) -> body facing that looks
// along the shot direction. Wrapped to [-PI, PI]; non-finite passes through
// (call sites treat it as "do not arm").
export function bodyFacingForShotYaw(shotYaw: number): number {
  if (!Number.isFinite(shotYaw)) {
    return shotYaw;
  }
  const twoPi = Math.PI * 2;
  let behind = (shotYaw + Math.PI) % twoPi;
  if (behind > Math.PI) {
    behind -= twoPi;
  } else if (behind < -Math.PI) {
    behind += twoPi;
  }
  return behind;
}

// Minimal turn state (target + active flag): the turn writes through the SAME
// avatar.rotation.y the movement writer owns (which is also the rotY value
// synced upstream every tick), so no new synced state is needed.
export interface ShotBodyTurn {
  active: boolean;
  target: number;
}

export function beginShotBodyTurn(shotYaw: number): ShotBodyTurn {
  if (!Number.isFinite(shotYaw)) {
    return { active: false, target: 0 };
  }
  return { active: true, target: bodyFacingForShotYaw(shotYaw) };
}

// One exp-ease step of the body yaw toward the shot facing along the
// shortest arc, at SHOT_BODY_TURN_RATE_S (settles a PI flip in ~0.25-0.5s,
// so a follow target that reads the live facing converges smoothly even if
// it fires mid-turn). Thin wrapper, not a second easing implementation.
// Non-positive dt or non-finite input is a passthrough.
export function stepShotBodyTurnYaw(currentYaw: number, targetYaw: number, deltaSeconds: number): number {
  return stepIdleFollowYaw(currentYaw, targetYaw, deltaSeconds, SHOT_BODY_TURN_RATE_S);
}

// Completion check: the wrapped gap is inside SHOT_BODY_TURN_DONE_RAD, so
// the owner (SceneManager.update) can snap + deactivate. Non-finite input
// never counts as done (a NaN gap must not kill the turn silently — the
// step above already passes NaN through unchanged).
export function isShotBodyTurnDone(currentYaw: number, targetYaw: number): boolean {
  if (!Number.isFinite(currentYaw) || !Number.isFinite(targetYaw)) {
    return false;
  }
  const twoPi = Math.PI * 2;
  let delta = (targetYaw - currentYaw) % twoPi;
  if (delta > Math.PI) {
    delta -= twoPi;
  } else if (delta < -Math.PI) {
    delta += twoPi;
  }
  return Math.abs(delta) <= SHOT_BODY_TURN_DONE_RAD;
}
