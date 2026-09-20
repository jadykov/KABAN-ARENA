// Shared tunable constants for Stage 2 (client test scene + controls).
// Values confirmed with the owner (see MAP.md Stage 2 / Q9-A): camera FOV 75,
// follow distance 4m (Stage 4d.2: 5m -> 4m), joystick diameter 120px. Keep
// them named here instead of hardcoding literals across modules
// (AGENTS.md hardcoding rule).

// Color values live in palette.ts (single source of truth); this file only
// re-exports them under the long-standing gameplay names.
import {
  ACCENT_CROSSHAIR_CHARGING,
  ACCENT_CROSSHAIR_FULL,
  ACCENT_DEATH_PALE,
  ACCENT_DEATH_RED,
  ACCENT_DEATH_WHITE,
  HL_CHARTREUSE_CSS,
  IDENTITY_LOCAL,
  IDENTITY_REMOTES,
  NEUTRAL_WHITE_CSS,
} from "./palette";

// Third-person follow camera (Q9-A confirmed 2026-09-11; distance 4m since
// Stage 4d.2, charge zoom ~3.2m held until the actual shot).
export const CAMERA_FOV = 75;
export const CAMERA_FOLLOW_DISTANCE = 4;
// Follow distance while fully charged (charge01 = 1): eased toward at
// CAMERA_SMOOTH_RATE, held until the shot/cancel returns it to default.
export const CAMERA_CHARGE_DISTANCE = 3.2;
export const CAMERA_FOLLOW_HEIGHT = 2.1;
export const CAMERA_LOOK_AT_HEIGHT = 1.2;
export const CAMERA_SENSITIVITY = 0.0045;
export const CAMERA_PITCH_MIN = -0.15;
// Post-playtest fix round 2 (owner: aim-time view still too top-down):
// max 0.36 rad (~20.6 deg) above horizon — another ~20% down from the 0.45
// cap. All clamp sites (SceneManager RMB look + setCameraAngles, main.ts
// aim/float pitch, protocol fire payload) share this constant, so they
// tighten automatically. Worst case at charge zoom (d = 3.2m):
// elevation = atan((2.1 + sin(0.36)*3.2 - 1.2) / (cos(0.36)*3.2))
//           = atan(2.0273 / 2.9949) ~= 34.1 deg onto the avatar
// (was atan(2.2919 / 2.8814) ~= 38.5 deg at 0.45). CAMERA_PITCH_MIN kept.
export const CAMERA_PITCH_MAX = 0.36;
// Post-playtest fix round 3 (owner: resting view too top-down): default/
// resting camera pitch 0.15 rad (~8.6 deg above horizon) — ~0.1 rad (~6 deg)
// closer to the horizon than the old 0.25, opening the distant view. Single
// source of truth for the spawn/reset pitch (SceneManager initial + reset)
// and the aim-idle init (main.ts aimPitch start). Worst case at default
// distance (d = 4m): elevation = atan((2.1 + sin(0.15)*4 - 1.2) /
// (cos(0.15)*4)) = atan(1.4978 / 3.9551) ~= 20.7 deg onto the avatar
// (was ~= 26.0 deg at 0.25). Stays well above CAMERA_PITCH_MIN (-0.15).
export const CAMERA_REST_PITCH = 0.15;

// Virtual joystick (Q9-A: left side, diameter 120px, transparent look-through).
export const JOYSTICK_DIAMETER = 120;
export const JOYSTICK_RADIUS = JOYSTICK_DIAMETER / 2;
export const JOYSTICK_KNOB_DIAMETER = 52;
// Low opacity so the game view stays visible through the control (A2).
export const JOYSTICK_OPACITY = 0.4;
export const JOYSTICK_KNOB_OPACITY = 0.55;

// Test-scene avatar movement. Map +20% (28m -> ~33.6m): half 14 -> 16.8,
// spawn inset scaled proportionally (2 -> 2.4).
export const MOVE_SPEED = 4.5;
export const ARENA_HALF_SIZE = 16.8;
// Movement blending (ice/impulse fix): horizontal velocity is steered toward
// the input target by at most ACCEL m/s per second instead of being hard-set
// every frame, so ice sliding and knockback impulses survive and decay via
// damping/friction. Ground stays snappy, ice redirects slowly (slippery).
export const PLAYER_GROUND_ACCEL = 24;
// Sticky ice (owner 1A): weak controllable slide — on ice the target speed
// is cut to ICE_SPEED_MULT (~67% cut since Stage 4d.2: 0.5 -> 0.33, 1.5x
// stronger slow) and steering is slow (ICE_ACCEL) but strong enough to
// escape, so ice feels sticky, never a trap.
export const PLAYER_ICE_ACCEL = 3.0;
export const ICE_SPEED_MULT = 0.33;

// HUD placeholder round (QD3 hybrid; real loop lands in Stage 4).
export const MAX_HEARTS = 4;
export const ROUND_SECONDS = 180;
export const START_SCORE = 0;

// Perf budget (AGENTS.md pitfalls): shadow map stays at or below 1024.
export const SHADOW_MAP_SIZE = 1024;

// Stage 3 physics (QT3-A confirmed 2026-09-11: fixed tick 60Hz decoupled,
// ice friction 0.05-0.1, trampoline impulse 8-12, tuned here).
export const PHYSICS_TICK_HZ = 60;
export const PHYSICS_FIXED_DT = 1 / PHYSICS_TICK_HZ;
export const PHYSICS_GRAVITY_Y = -9.81;
export const PHYSICS_MAX_ACCUMULATOR = 0.1;
export const PLAYER_FRICTION = 0.7;
export const PLAYER_RESTITUTION = 0.1;
export const PLAYER_LINEAR_DAMPING = 2.5;
// Ice/puddle friction inside the QT3-A 0.05-0.1 band; damping raised for
// sticky ice (owner 1A) so the capsule slows to the halved target speed
// instead of gliding forever — escapable via ICE_ACCEL steering.
export const ICE_FRICTION = 0.07;
export const ICE_LINEAR_DAMPING = 1.0;
export const TRAMPOLINE_IMPULSE = 10;
export const TRAMPOLINE_COOLDOWN_S = 0.5;
// Airborne flight gate (hop visuals): enter when |vertical velocity| tops
// THRESHOLD, exit only after it sits below THRESHOLD*EXIT_FRACTION for
// EXIT_HOLD_S (two-level gate + hold kills apex flutter: at a jump apex
// |vy| dips under the exit level for ~0.16s, shorter than the hold).
// THRESHOLD sits safely above ramp-climb vy (tan14° × 4.5m/s ≈ 1.1 —
// climbing a ramp stays grounded) and far below trampoline launch
// (TRAMPOLINE_IMPULSE 8-12). Grounded Rapier rest/contact reads ~0.
export const AIRBORNE_VY_THRESHOLD = 2.0;
export const AIRBORNE_EXIT_FRACTION = 0.4;
export const AIRBORNE_EXIT_HOLD_S = 0.25;
// Trampoline pads are trigger-only by design (no physical pad collider —
// see ArenaBuilder.buildColliders): pad top sits at ~0.36m, a resting
// capsule center at ~1.0m, so the trigger band stays above ground level
// but below the launch apex.
export const TRAMPOLINE_TRIGGER_Y = 1.7;
export const KNOCKBACK_IMPULSE = 9;

// Stage 3 arena (QD2-A neon-warehouse, QD5-A 6-8 low symmetric blocks).
export const OBSTACLE_COUNT = 8;
export const WALL_HEIGHT = 3;
export const WALL_THICKNESS = 0.5;
export const TRAMPOLINE_RADIUS = 1.2;
export const SLIPPERY_RADIUS = 2.64;
export const SPAWN_COUNT = 4;
export const SPAWN_INSET = 2.4;

// Power-up set A1 (speed x1.3 timed, shield 1 hit, impulse knockback).
export const SPEED_MULTIPLIER = 1.3;
export const SPEED_DURATION_S = 6;
export const SHIELD_MAX_HITS = 1;
export const POWERUP_RESPAWN_S = 8;
export const POWERUP_PICKUP_RADIUS = 1.2;

// Beauty-perf FX (QD4-A: hit flash + pooled particles + light camera shake).
export const PARTICLE_POOL_SIZE = 128;
export const PARTICLE_LIFETIME_S = 0.6;
export const PARTICLE_BURST_COUNT = 24;
export const SHAKE_MAX_OFFSET = 0.25;
export const SHAKE_DECAY = 3;
export const HIT_FLASH_DURATION_S = 0.18;

// Ads dressing (QA1-5A confirmed): 6 fence slots 512x256 + 1 banner 4x1m.
// Owner drops fence-*.png/jpg + banner.png/jpg into client/assets/ads/
// (synced to public/ads by scripts/sync-ads.mjs); placeholders are SVGs.
export const FENCE_SLOT_COUNT = 6;
export const FENCE_TEXTURE_WIDTH = 512;
export const FENCE_TEXTURE_HEIGHT = 256;
export const BANNER_WIDTH_M = 4;
export const BANNER_HEIGHT_M = 1;
export const BANNER_TEXTURE_WIDTH = 512;
export const BANNER_TEXTURE_HEIGHT = 128;
export const ADS_PUBLIC_BASE_PATH = "/ads";

// Stage 4 netcode (client mirrors; server src/config.ts is authoritative).
// Inputs-only upstream at 20 ticks/s, delta patches downstream at 20/s.
export const SERVER_URL_DEFAULT_PORT = 2567;
export const ROOM_NAME = "arena";
export const INPUT_SEND_HZ = 20;
export const INPUT_SEND_INTERVAL_S = 1 / INPUT_SEND_HZ;
export const MAX_PLAYERS = 6;
// Hitscan A mirrors (100HP / 25 dmg = 4 hits = 4 hearts, QD3/Q8).
export const HIT_MAX_RANGE = 18;
export const HIT_COOLDOWN_MS = 350;
export const HIT_DAMAGE = 25;
// Client interpolation of remote avatars (server patches at 20Hz).
export const LERP_SMOOTHING = 10;
export const SNAP_DISTANCE = 6;
// Self reconciliation toward the authoritative server snapshot (XZ only,
// per-frame, no alloc): drift under MIN stays local (no jitter), drift in
// [MIN, SNAP] eases at RATE, drift beyond SNAP snaps (spawn/respawn/teleport).
// Gentle tuning (0.7/8): the client predicts the server instant-move rule, so
// small per-tick differences must not visibly tug the avatar — the wider
// deadband plus slower ease hides high-frequency lateral jitter at 60/120Hz.
export const SELF_RECONCILE_MIN_M = 0.7;
export const SELF_RECONCILE_SNAP_M = 6;
export const SELF_RECONCILE_RATE = 8;
// Follow-camera smoothing: desired position + lookAt ease at this exp rate
// (1/s), so per-frame avatar corrections never translate into camera jumps.
// Yaw stays instant (responsive mouse); remote-avatar yaw wrap already uses
// shortest-arc lerpAngle (see net/interpolation.ts).
export const CAMERA_SMOOTH_RATE = 13;
// Recoil grace: the client kick is prediction-only (the server re-applies the
// same kick authoritatively), so reconcileSelf skips corrections for this long
// after a local kick instead of fighting it and double-tugging the avatar.
export const RECOIL_RECONCILE_GRACE_S = 0.15;
// Avatar colors: local fighter salmon-red, remotes cycle the shared identity
// palette by sessionId hash. Balls reuse the same mapping (cap/glow/trail
// tinted by the owner color, basalt body kept) so every core reads as its
// thrower's. Values live in palette.ts (IDENTITY_*); these names are kept
// so tests and config consumers don't break.
export const LOCAL_AVATAR_COLOR = IDENTITY_LOCAL;
export const REMOTE_PALETTE = IDENTITY_REMOTES;
// Local spawn height mirrors the server PlayerState y (1.1).
export const SELF_SPAWN_Y = 1.1;
// Guest nicks (no auth): validated locally, deduped server-side.
export const NICK_MIN_LENGTH = 2;
export const NICK_MAX_LENGTH = 16;
export const DEFAULT_NICK = "Kaban";
// R1 pre-join spectator: empty Play nick falls back to Guest-XXXX.
export const GUEST_NICK_PREFIX = "Guest";

// R1 spectator hover camera: cinematic angled top-down above the arena
// with a slow drift/orbit (see SceneManager.updateSpectatorCamera).
// Scaled +20% with the map (14/16/14 -> 16.8/19.2/16.8).
export const SPECTATOR_CAM_X = 16.8;
export const SPECTATOR_CAM_Y = 19.2;
export const SPECTATOR_CAM_Z = 16.8;
export const SPECTATOR_ORBIT_SPEED = 0.12;
export const SPECTATOR_BOB_AMPLITUDE = 0.6;
export const SPECTATOR_BOB_SPEED = 0.4;

// R2 hand-ball combat (client mirrors; server src/config.ts authoritative).
// Charge 0-1.0s -> power01 [0.5, 1], 2.5s reload, FULL 25 / WEAK 12.5 (halves).
export const CHARGE_MAX_S = 1.0;
export const RELOAD_MS = 2500;
export const FULL_DAMAGE = 25;
export const WEAK_DAMAGE = 12.5;
export const SUPER_DAMAGE_MULT = 2;
export const FULL_POWER_THRESHOLD = 0.8;
// Weak shots fly slightly slower than before (MIN 14 -> 11, ~21% down);
// strong/full shots keep the current MAX 20 speed/physics.
export const BALL_MIN_SPEED = 11;
export const BALL_MAX_SPEED = 20;
// Client preview mirror of the authoritative server ball (server
// src/config.ts is truth): same muzzle/body-height/gravity so the aim dots
// show the real arc. Light-lob tuning (precision pass), MAX 20 kept.
export const BALL_GRAVITY = 3.5;
// Torso/hand height above the thrower body-center y: ground body-center is
// SELF_SPAWN_Y 1.1, so spawn y = bodyY + 0.3 == 1.4 on the ground (unchanged
// from the old absolute height); on platforms it tracks the elevation.
export const BALL_TORSO_OFFSET = 0.3;
export const TRAJ_PREVIEW_DT_S = 0.12;
// Post-playtest fix round 3 (owner: charge feedback): trajectory-preview dot
// progressive glow. Dot i (of TRAJ_DOT_COUNT, see ui/aim.ts) counts as lit
// once charge01 >= (i+1)/N; a lit dot paints at base opacity x this boost
// (clamped to 1) — subtle, slightly brighter one by one, never distracting.
// DOM opacity scalar on the already-pooled dot divs only: no new lights, no
// new elements, no draw-call growth (dots are a DOM overlay, zero WebGL
// cost), no per-frame allocations. Charge cancel/reset feeds charge01 0 +
// setTrajectory(null), which returns every dot to base automatically.
export const TRAJ_DOT_LIT_BOOST = 1.6;
export const MAX_LIVE_BALLS = 12;
export const MAX_HALVES = 8;
export const SUPER_SPAWN_S = 45;
export const SUPER_LIFE_S = 15;
export const SUPER_BLINK_S = 3;
// Recoil: server-authoritative kick opposite the fire dir, mirrored here
// for the instant client feedback nudge (weak 0.4m -> full 0.8m).
export const RECOIL_WEAK_M = 0.4;
export const RECOIL_FULL_M = 0.8;
// CS-like asymmetric figures (owner 2A): 4 distinct hills — tall cube (SE),
// long block (NW), box (SW), prism (N lane). One quadrant each, footprints
// and heights vary (1.8-2.6m, all <= 3m so the camera sees over), center
// (0,0) stays empty for Worms drops (SUPER core). Each figure has a walk-up
// ramp on EXACTLY ONE side (rampSide); the other 3 sides are sheer walls the
// capsule cannot climb. Ramp slope is RAMP_SLOPE_DEG (run = topY/tan) so the
// capsule walks up with no jumping. rampWidth is the full slab width (m).
export const RAMP_SLOPE_DEG = 14;
export interface PlatformFigureDef {
  x: number;
  z: number;
  hx: number;
  hz: number;
  topY: number;
  rampSide: "+x" | "-x" | "+z" | "-z";
  rampWidth: number;
}
export const PLATFORM_FIGURES: readonly PlatformFigureDef[] = [
  { x: 13.8, z: -8.5, hx: 1.2, hz: 1.2, topY: 2.6, rampSide: "+z", rampWidth: 2.0 },
  { x: -13.5, z: 10.0, hx: 2.4, hz: 1.0, topY: 1.8, rampSide: "-z", rampWidth: 1.6 },
  { x: -11.5, z: -9.5, hx: 1.4, hz: 1.4, topY: 2.2, rampSide: "+x", rampWidth: 1.8 },
  { x: 5.0, z: 13.5, hx: 1.0, hz: 1.0, topY: 2.0, rampSide: "-x", rampWidth: 1.6 },
] as const;
export const RAMP_SLAB_THICKNESS = 0.2;
// Platform cap plates sit this far below the figure top (Stage 4d.2
// z-fighting fix): the cap top face must never be coplanar with the body
// top face. 5mm is visually imperceptible, zero draw-call cost.
export const PLATFORM_CAP_DROP = 0.005;
// Camera-wall occlusion: camera clamped inside HALF + this margin (wall line).
export const CAMERA_WALL_MARGIN = 0.5;
// Faded wall opacity while the camera sits low/close behind a wall.
export const WALL_FADE_OPACITY = 0.25;
// Hand-ball prop: the avatar holds a round core in its right hand (no
// barrel anymore). Throw flick duration (forward snap on release) + held-ball
// look (radius, right-side chest attach mirroring the old cannon offset).
// NOTE: the avatar faces local +Z, so the anatomical RIGHT hand is local −X.
export const HANDBALL_THROW_FLICK_S = 0.15;
export const HANDBALL_RADIUS = 0.16;
export const HANDBALL_OFFSET_X = -0.55;
export const HANDBALL_OFFSET_Y = 0.5;
export const HANDBALL_OFFSET_Z = 0.1;
// Local avatar translucency while charging (Stage 4d.2): body + hand ball
// fade to this opacity from charge start until the actual shot/cancel.
// Hit-flash emissive is independent of opacity, so it keeps working.
export const AVATAR_CHARGE_OPACITY = 0.3;
// Death burst palette (white 10% / pale violet 30% / muted red 60%).
// Names kept for consumers; values live in palette.ts (scheme buckets).
export const DEATH_BURST_YELLOW = ACCENT_DEATH_WHITE;
export const DEATH_BURST_ORANGE = ACCENT_DEATH_PALE;
export const DEATH_BURST_RED = ACCENT_DEATH_RED;
export const DEATH_BURST_COUNT = 30;
// Tap shorter than this never fires (touch blip, not a shot).
export const TAP_FIRE_MIN_S = 0.08;
// Chest-exit muzzle mirror of server BALL_MUZZLE_OFFSET (single constants:
// preview origin and authoritative spawn must stay identical). 0.7m along
// the aim dir from the body center — just in front of the 0.5m capsule.
export const BALL_MUZZLE_OFFSET = 0.7;
// Stage 4e mobile scheme (PUBG-style): no fixed aim stick — the FIRE button
// hold charges + aims and right-half touch drags rotate the camera, both
// shaped by AIM_EXPO below. The left stick stays enlarged (~140px) with expo
// response so small drifts stay precise.
export const MOVE_STICK_DIAMETER = 140;
export const AIM_EXPO = 1.4;
export const AIM_YAW_RATE = 2.4;
export const AIM_PITCH_RATE = 1.6;
// Floating right-thumb aim zone (Brawl-Stars-like one-thumb flow): pointerdown
// anywhere on the right half starts charge at the touch point (floating
// origin, not a fixed disc); drag offset in px maps to [-1, 1] over this
// radius, then expo + deadzone + yaw/pitch rates above. Camera mirrors aim
// pitch while charging (aim-mirror, fix round 3) so one thumb can turn
// 360 degrees.
export const FLOAT_DRAG_RADIUS_PX = 80;
export const FLOAT_DEADZONE = 0.05;
// Charge pitch leveling (owner: at aim start the camera eases ONCE toward
// the horizon/view direction, then free aim; vertical wander while aiming is
// slightly damped, but aiming down from elevation stays fully possible).
// One-shot exp ease toward pitch 0 at charge start (cancelled instantly by
// any FIRE/float/camera deflection); afterwards vertical stick rate scales by
// AIM_PITCH_DAMP while charging only (normal look untouched, range untouched).
export const CHARGE_PITCH_EASE_RATE = 3.5;
export const CHARGE_PITCH_EASE_DONE = 0.01;
// Post-playtest vertical aim sensitivity -30%: 0.6 -> 0.42, so the effective
// vertical rate AIM_PITCH_RATE * AIM_PITCH_DAMP = 1.6 * 0.42 ~= 0.67 rad/s.
export const AIM_PITCH_DAMP = 0.42;
// Stage 4d.2-fix2: yaw damp while charging/aiming so aiming feels calmer on
// both axes (yaw stays 0.6 of the normal rate; pitch is now 0.42 after the
// post-playtest vertical-sensitivity cut, i.e. 1.6 * 0.42 ~= 0.67 rad/s).
// Normal (non-charging) stick rates are untouched — see yawRateScale().
export const AIM_YAW_DAMP = 0.6;
// Idle soft-follow (Stage 4d.2-fix2, owner comfort): while playing, NOT
// charging, with no explicit look input and the avatar moving, the camera
// yaw eases behind the avatar's movement/facing yaw and the pitch levels
// toward near-horizon — same exp-ease pattern as the follow camera, no
// allocations (scalar math only). Any look delta that frame wins outright.
export const IDLE_FOLLOW_RATE = 2.5;
// Post-playtest fix round 3 (owner: resting view too top-down): idle
// follow pitch target 0.05 rad (~2.9 deg above horizon) — ~0.1 rad
// (~6 deg) closer to the horizon than the old 0.15, matching the lowered
// CAMERA_REST_PITCH above. Stays above CAMERA_PITCH_MIN
// (-0.15): 0.05 > -0.15, so the shared clamp never fights the target.
export const IDLE_FOLLOW_PITCH = 0.05;
export const IDLE_FOLLOW_MOVE_MIN = 0.1;
// Idle-follow stick-direction gate (review round-2 FAIL #1, widened per owner
// to the maximum safe limit): the follow may run only while the stick angle
// from forward phi = atan2(moveX, moveY) satisfies |phi| <= this = PI/2, i.e.
// straight-ahead through diagonals to pure sideways (strafe). Anything
// leaning backward (> PI/2, backpedal included) never moves the camera.
// Rationale: per frame the SceneManager recomputes facing from the
// just-followed camera yaw as r = c + PI - phi, so with target c + PI the
// per-frame delta is permanently -phi for ANY held off-forward input. With
// the gate at PI/2 the in-gate |delta| = |phi| <= PI/2 < PI, so the
// shortest-arc wrap sign can never flip mid-follow — the eternal-spin orbit
// class is structurally unreachable while moving; out-of-gate inputs produce
// exactly ZERO camera motion. The sustained in-gate drift is softened by
// forwardnessRateScale = cos(phi) (1.0 pure forward, ~0 at pure sideways),
// so sideways holds barely crawl while diagonals follow firmly; the interior
// peak phi*cos(phi) ~= 0.56 at phi ~= 0.86 keeps drift <= RATE * 0.56
// ~= 1.4 rad/s. See net/idleFollow.ts.
export const IDLE_FOLLOW_MAX_STICK_ANGLE = Math.PI / 2;
// Shared stick-rest threshold (was the idle-recenter release threshold; the
// recenter gate it was named for is removed — no time-based camera catch-up
// anymore by owner decision). Kept under its long-standing name as the ONE
// source of truth for "the stick is effectively released": SceneManager
// compares worldMove.lengthSq() > IDLE_RECENTER_MOVE_MAX *
// IDLE_RECENTER_MOVE_MAX to freeze facing (for stick mags < 1 |worldMove| ==
// |move|, so facing is static at/below 0.01), and main.ts arms the post-shot
// body turn only at/below the same product. The two can never drift apart.
export const IDLE_RECENTER_MOVE_MAX = 0.01;
// Post-shot body turn (owner fix round 2): after a REAL shot the avatar body
// turns to face the shot direction (it used to stay frozen at the stale run
// direction, and the camera then re-aligned behind that stale facing — a
// jarring 180-degree swing). The turn eases avatar.rotation.y toward the
// shot facing at this exp rate (1/s): rate 12 settles a full PI flip to
// ~5% residual in ~0.25s (exp(-12*0.25) ~= 0.05), so the follow target,
// which reads the live facing, converges behind the shot direction naturally
// with no camera suppression.
// Movement input cancels the turn (the movement writer owns yaw then).
export const SHOT_BODY_TURN_RATE_S = 12;
// Post-shot turn completion band (radians): below this wrapped gap the body
// is snapped to the target and the turn deactivates. 0.01 rad (~0.6 deg) is
// invisible on the avatar and leaves the camera-behind target aligned.
export const SHOT_BODY_TURN_DONE_RAD = 0.01;
// Light client-side aim assist (subtle, deterministic, no randomness):
// living enemy within ASSIST range and inside the aim cone gets a gentle
// pull toward its center (blend fraction, never a snap). Server authority
// unchanged (server BALL_HIT_RADIUS 0.9 kept); assist only nudges the
// release-time yaw/pitch in buildFirePayload path.
export const AIM_ASSIST_MAX_DIST_M = 18;
export const AIM_ASSIST_CONE_DEG = 12;
export const AIM_ASSIST_BLEND = 0.5;
// Crosshair colors (DOM aim overlay, pointer-events none). Values live in
// palette.ts: idle white, charging white, full muted red, reload + super
// chartreuse (highlight bucket).
export const CROSSHAIR_IDLE_COLOR = NEUTRAL_WHITE_CSS;
export const CROSSHAIR_CHARGING_COLOR = ACCENT_CROSSHAIR_CHARGING;
export const CROSSHAIR_FULL_COLOR = ACCENT_CROSSHAIR_FULL;
export const CROSSHAIR_RELOAD_COLOR = HL_CHARTREUSE_CSS;
export const CROSSHAIR_SUPER_COLOR = HL_CHARTREUSE_CSS;

// WebSocket endpoint for the Colyseus server. Env override first
// (VITE_SERVER_URL), otherwise same host as the page on the default port.
export function getServerUrl(): string {
  const fromEnv = import.meta.env["VITE_SERVER_URL"];
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return fromEnv;
  }
  if (typeof window !== "undefined" && window.location !== undefined) {
    const host = window.location.hostname !== "" ? window.location.hostname : "localhost";
    return `ws://${host}:${SERVER_URL_DEFAULT_PORT}`;
  }
  return `ws://localhost:${SERVER_URL_DEFAULT_PORT}`;
}
