import {
  IDLE_FOLLOW_MAX_STICK_ANGLE,
  IDLE_FOLLOW_MOVE_MIN,
  IDLE_FOLLOW_PITCH,
  IDLE_FOLLOW_RATE,
  IDLE_RECENTER_DELAY_S,
  IDLE_RECENTER_MOVE_MAX,
  IDLE_RECENTER_RATE_S,
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
// never fights an active RMB drag), the avatar actually moving, AND the move
// stick predominantly forward (|phi| <= IDLE_FOLLOW_MAX_STICK_ANGLE).
// The forwardness check is the round-2 orbit invariant: without it the
// per-frame delta is permanently -phi for any held off-forward input
// (backpedal/strafe orbit), so those inputs must produce ZERO camera motion.
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

// Forwardness rate scale (post-playtest Option A): softens the sustained
// drift at the gate edge by scaling the follow rate with cos(phi) — 1.0 at
// pure forward, cos(0.8) ~= 0.70 at the 0.8 rad gate edge, so edge drift is
// bounded by IDLE_FOLLOW_RATE * 0.8 * cos(0.8) ~= 1.4 rad/s while pure
// forward is unchanged (cos(0) = 1, and delta -> 0 as phi -> 0 so the
// follow still converges). Input is clamped to [0, MAX] so overshoot
// angles scale like the edge, never negative; non-finite input yields 0
// (no motion) so a NaN stick can never drive the camera. Scalar, no alloc.
export function forwardnessRateScale(phi: number): number {
  if (!Number.isFinite(phi)) {
    return 0;
  }
  const clamped = Math.max(0, Math.min(Math.abs(phi), IDLE_FOLLOW_MAX_STICK_ANGLE));
  return Math.cos(clamped);
}

// Idle recenter gate (post-playtest Option A, creep-band fix): true only when
// the stick is TRULY released (stick lengthSq <= IDLE_RECENTER_MOVE_MAX^2,
// i.e. |move| <= 0.01) — the exact mirror of the SceneManager facing-freeze
// threshold (worldMove.lengthSq() > MAX*MAX recomputes facing; for stick
// mags < 1 |worldMove| == |move|, so facing is static exactly where this
// gate holds). This is deliberately TIGHTER than the follow gate's complement
// (follow needs |move| >= IDLE_FOLLOW_MOVE_MIN = 0.1): the creep band
// (0.01, 0.1) is a dead zone where NEITHER path moves the camera, because
// there facing is recomputed every frame from the just-recentered yaw and the
// behind-facing target would orbit (at phi=PI up to RATE*PI ~ 9.2 rad/s).
// With no look input, not charging, playing, alive, AND the main.ts idle
// timer past IDLE_RECENTER_DELAY_S. The timer itself lives in main.ts
// (scalar idleTimerS, reset on any stick lengthSq above THIS threshold —
// creep input included — plus look input, charge start, and camera-state
// transitions); this predicate only reads it, so it stays pure and
// unit-testable. Because the avatar is NOT moving while this gate holds,
// facing is static and the behind-facing target below is a true fixed
// point — the recenter converges instead of orbiting.
export interface IdleRecenterGate {
  playing: boolean;
  charging: boolean;
  alive: boolean;
  lookDx: number;
  lookDy: number;
  moveX: number;
  moveY: number;
  idleTimerS: number;
}

export function shouldIdleRecenter(gate: IdleRecenterGate): boolean {
  if (!gate.playing || gate.charging || !gate.alive) {
    return false;
  }
  if (gate.lookDx !== 0 || gate.lookDy !== 0) {
    return false;
  }
  if (!Number.isFinite(gate.moveX) || !Number.isFinite(gate.moveY)) {
    return false;
  }
  if (!Number.isFinite(gate.idleTimerS)) {
    return false;
  }
  // Static-facing premise: mirror the SceneManager facing-freeze threshold
  // exactly (lengthSq > MAX*MAX recomputes facing). Strictly-greater rejects
  // so the boundary |move| == MAX still counts as released, exactly like the
  // facing freeze (lengthSq == MAX*MAX keeps the old facing).
  const moveLenSq = gate.moveX * gate.moveX + gate.moveY * gate.moveY;
  const releaseLenSq = IDLE_RECENTER_MOVE_MAX * IDLE_RECENTER_MOVE_MAX;
  if (moveLenSq > releaseLenSq) {
    return false;
  }
  return gate.idleTimerS >= IDLE_RECENTER_DELAY_S;
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
// passes IDLE_FOLLOW_RATE * forwardnessRateScale(phi) (cos softening at the
// gate edge), the recenter wrappers below pass IDLE_RECENTER_RATE_S.
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

// Idle-recenter ease steps (post-playtest Option A): same shortest-arc yaw
// + near-horizon pitch easing as the follow, but at IDLE_RECENTER_RATE_S.
// The recenter call site uses these so the rate choice stays documented in
// one place; they are thin wrappers, not a second easing implementation.
export function stepIdleRecenterYaw(yaw: number, targetYaw: number, deltaSeconds: number): number {
  return stepIdleFollowYaw(yaw, targetYaw, deltaSeconds, IDLE_RECENTER_RATE_S);
}

export function stepIdleRecenterPitch(pitch: number, deltaSeconds: number): number {
  return stepIdleFollowPitch(pitch, deltaSeconds, IDLE_RECENTER_RATE_S);
}
