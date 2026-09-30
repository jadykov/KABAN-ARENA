import * as THREE from "three";
import { AdsManager, getShopfrontTransforms } from "../ads/AdsLoader";
import { FOOTSTEP_MIN_SPEED01 } from "../audio/Sfx";
import {
  ARENA_HALF_SIZE,
  AIRBORNE_VY_THRESHOLD,
  AVATAR_BODY_RADIUS,
  AVATAR_CHARGE_OPACITY,
  CAMERA_CHARGE_DISTANCE,
  CAMERA_FOLLOW_DISTANCE,
  CAMERA_FOLLOW_HEIGHT,
  CAMERA_FOV,
  CAMERA_LOOK_AT_HEIGHT,
  CAMERA_PITCH_MAX,
  CAMERA_PITCH_MIN,
  CAMERA_REST_PITCH,
  CAMERA_SENSITIVITY,
  CAMERA_SMOOTH_RATE,
  CAMERA_WALL_MARGIN,
  BALL_MUZZLE_OFFSET,
  BALL_TORSO_OFFSET,
  BLOOD_BURST_COUNT,
  CHARGE_MOVE_MULT,
  DEATH_BURST_CHARTREUSE,
  DEATH_BURST_COUNT,
  DEATH_BURST_LIFE_S,
  DEATH_BURST_ORANGE,
  DEATH_BURST_RED,
  DEATH_BURST_SPREAD,
  DEATH_BURST_UP,
  DEATH_BURST_YELLOW,
  ICE_SPEED_MULT,
  ICE_INPUT_THRESHOLD,
  IDLE_RECENTER_MOVE_MAX,
  LOCAL_AVATAR_COLOR,
  MOVE_SPEED,
  NEBULA_COUNT,
  PARTICLE_BURST_COUNT,
  PLAYER_GROUND_ACCEL,
  PLAYER_ICE_ACCEL,
  PLAYER_ICE_COAST_ACCEL,
  RECOIL_FULL_M,
  RECOIL_RECONCILE_GRACE_S,
  RECOIL_WEAK_M,
  ROUND_EVENING_LIGHTS_FADE_S,
  ROUND_EVENING_LIGHTS_START_S,
  ROUND_LIGHTING_DAY_SAMPLE_PROGRESS,
  ROUND_LIGHTING_NIGHT_SAMPLE_PROGRESS,
  ROUND_LIGHTING_SUNSET_AT_S,
  ROUND_LIGHTING_SUNSET_SAMPLE_PROGRESS,
  ROUND_LIGHTING_TRANSITION_END_S,
  ROUND_LIGHTING_TRANSITION_START_S,
  ROUND_SECONDS,
  ROUND_SKY_TRANSITION_START_PROGRESS,
  SELF_RECONCILE_MIN_M,
  SELF_RECONCILE_RATE,
  SELF_RECONCILE_SNAP_M,
  SCENE_AMBIENT_INTENSITY,
  SCENE_DIRECTIONAL_INTENSITY,
  SELF_RECONCILE_TOP_TOL,
  SELF_RECONCILE_UP_SNAP_COOLDOWN_S,
  SELF_RECONCILE_STALL_MIN_DIV,
  SELF_RECONCILE_UP_SNAP_MAX_DIV,
  SELF_RECONCILE_STALL_INPUT_MIN,
  SELF_RECONCILE_STALL_MIN_FRAMES,
  SELF_RECONCILE_STALL_WINDOW_S,
  SELF_RECONCILE_STALL_MIN_PROGRESS_M,
  SELF_RECONCILE_STALL_SLOTS,
  SELF_RECONCILE_SNAP_XZ_INSET,
  SELF_RECONCILE_BIG_DIV,
  SELF_RECONCILE_BIG_DIV_HOLD_S,
  SELF_RECONCILE_REST_OFFSET,
  SELF_SPAWN_Y,
  SHADOW_MAP_SIZE,
  SWAMP_SPEED_MULT,
  SURFACE_MAX_BODY_Y,
  SPECTATOR_BOB_AMPLITUDE,
  SPECTATOR_BOB_SPEED,
  SPECTATOR_CAM_X,
  SPECTATOR_CAM_Y,
  SPECTATOR_CAM_Z,
  SPECTATOR_ORBIT_SPEED,
  TRAMPOLINE_COOLDOWN_S,
  TRAMPOLINE_TRIGGER_Y,
  WALL_FADE_OPACITY,
  WALL_GLASS_OPACITY,
  WALL_HEIGHT,
} from "../config";
import { ArenaBuilder, getObstacleLayout, getPlatforms, getTrampolineAt, isOnIce, isOnSwamp } from "../arena/Arena";
import { PowerUpPickups, PowerUpState } from "../arena/PowerUps";
import { BallsPool, SuperCore } from "../fx/Balls";
import { CameraShake, HitFlash } from "../fx/CameraShake";
import { Fireflies } from "../fx/Fireflies";
import {
  AirborneGate,
  applyClothing,
  attachAvatarVisuals,
  createHopState,
  pantsColorForSession,
  resetHopState,
  resetHopVisual,
  seedHopState,
  updateHopVisual,
  type AvatarVisualsHandle,
} from "../fx/AvatarVisuals";
import { ParticlePool } from "../fx/Particles";
import { PowerEffectVisuals, type PowerEffectKind } from "../fx/PowerEffectVisuals";
import { PhysicsWorld, type Vector3Like } from "../physics/World";
import type { NetBallSnapshot, NetPickupSnapshot, NetPlayerSnapshot, NetSuperSnapshot } from "../net/protocol";
import {
  bodyFacingForShotYaw,
  isShotBodyTurnDone,
  stepShotBodyTurnYaw,
} from "../net/idleFollow";
import {
  ACCENT_FIRE_BURST,
  ACCENT_HIT_BURST,
  ACCENT_HIT_FLASH,
  ACCENT_ICE_GLOW,
  ACCENT_OBSTACLE_TINT,
  ACCENT_SPARK,
  BASE_BG,
  HL_TRAMP_BURST,
  NEUTRAL_MOON,
  NEUTRAL_WHITE,
  SCENE_COOL_FILL,
  SCENE_DAWN_FILL,
  SCENE_DAWN_KEY,
  SCENE_DAY_FILL,
  SCENE_DAY_KEY,
  SCENE_SUNSET_FILL,
  SCENE_SUNSET_KEY,
  SCENE_WARM_LIGHT,
  SKY_DAWN_BG,
  SKY_DAWN_FOG,
  SKY_CLOUD_DAY,
  SKY_CLOUD_SUNSET,
  SKY_DAY_BG,
  SKY_DAY_FOG,
  SKY_SUN_DISC,
  SKY_SUNSET_DISC,
  SKY_SUNSET_BG,
  SKY_SUNSET_FOG,
} from "../palette";

// Planar movement input: x = strafe right (+1) / left (-1),
// y = forward (+1) / back (-1). Values are clamped to length 1.
export interface MoveVector {
  x: number;
  y: number;
}

export interface LookDelta {
  dx: number;
  dy: number;
}

export type ArenaEvent =
  | { type: "trampoline" }
  // Own-avatar hop tick (Stage 5 audio): pushed on hop-boundary crossings
  // while grounded and moving — main.ts maps it to the quiet footstep SFX.
  // SceneManager stays audio-agnostic; the engine-level cooldown keeps the
  // ~2-4 Hz hop cadence from ever machine-gunning.
  | { type: "footstep" };

// Authoritative on-top level for the UP-snap: XZ footprint of one elevated
// block plus the body-center Y the server derives on its top (topY +
// SELF_SPAWN_Y). Cached once (no per-frame allocation in reconcileSelf).
interface SupportTop {
  x: number;
  z: number;
  hx: number;
  hz: number;
  levelY: number;
}

// Elevated-block inventory for the UP-snap (bug round 6, BUG 2): every
// walkable top the server can derive — ramped platforms (topY) and obstacle
// blocks (box center hy, full height 2*hy: central towers 2.0, outer 0.8).
// Ramp slabs are NOT tops (a slope Y is never an exact level).
function buildSupportTopList(): SupportTop[] {
  const tops: SupportTop[] = [];
  for (const platform of getPlatforms()) {
    tops.push({
      x: platform.x,
      z: platform.z,
      hx: platform.hx,
      hz: platform.hz,
      levelY: platform.topY + SELF_SPAWN_Y,
    });
  }
  for (const block of getObstacleLayout()) {
    tops.push({
      x: block.x,
      z: block.z,
      hx: block.hx,
      hz: block.hz,
      levelY: block.hy * 2 + SELF_SPAWN_Y,
    });
  }
  return tops;
}

// Live reconcile telemetry (F3 snap-gate debug overlay, diagnostic only):
// reconcileSelf populates this REUSED object on every call (all paths incl.
// "skipped"), so the overlay can display each UP-snap gate with pass/fail
// marks without re-deriving anything. Gameplay logic never reads it.
export type ReconcileResult = "unrun" | "ok" | "lerp" | "snap" | "skipped";
export interface ReconcileTelemetry {
  result: ReconcileResult;
  // Which snap fired: "up" (stall-snap onto a block top), "big" (downward-
  // desync heal to the full server pose) or "far" (XZ far snap).
  snapKind: "none" | "up" | "big" | "far";
  serverX: number;
  serverY: number;
  serverZ: number;
  // Avatar Y at decision time + divergence (serverY - localY).
  localY: number;
  divergence: number;
  // Stall-snap gates: divOk (divergence inside [STALL_MIN_DIV,
  // UP_SNAP_MAX_DIV] — the lower bound clears solver noise, the upper bound
  // keeps grounded post-fall desyncs out of the UP path), input magnitude
  // fed by the caller + inputOk (>= STALL_INPUT_MIN), stall-window net
  // displacement (current XZ vs the oldest slot anchor over STALL_WINDOW_S)
  // + stallOk (< MIN_PROGRESS_M), and the window's observed-frame count +
  // stallFramesOk (>= STALL_MIN_FRAMES, so a fresh/hitched window can never
  // report a stall).
  divOk: boolean;
  moveMag: number;
  inputOk: boolean;
  stallProgressM: number;
  stallOk: boolean;
  stallFrames: number;
  stallFramesOk: boolean;
  // Big-div heal state: sustained-hold timer + its own event counter.
  bigDivHoldS: number;
  bigHealCount: number;
  lastBigHealAtMs: number;
  airborne: boolean;
  cooldownLeftS: number;
  // Support-top candidate for DISPLAY (index into the cached list, -1 when
  // none): among the tops whose level matches serverY within TOP_TOL the
  // pre-scan prefers the one whose STRICT footprint contains the server XZ,
  // then one whose EXPANDED footprint (hx + AVATAR_BODY_RADIUS) contains it,
  // and only then the first level match in list order — so the F3 "G top"
  // line names the top the server actually stands on (a server climbing a
  // ramp slope at 3.117 reads P2, not the first-match P3 at the same nominal
  // 3.1). Observation only; the snap loop below applies the same preference.
  levelTopIndex: number;
  levelTopY: number;
  // Last top the snap loop actually evaluated XZ on (-1 when the loop
  // never reached a level-matching top).
  evalTopIndex: number;
  xzOk: boolean;
  // Whether the SERVER XZ sits on the evaluated top's STRICT physical
  // footprint (|sx - top.x| <= hx && |sz - top.z| <= hz, no radius expansion):
  // false means the snapshot lives in the server's hysteresis ring, where the
  // local collider top does not exist (up-snap refused as "server-off-top").
  srvXzOnTop: boolean;
  blockCenterX: number;
  blockCenterZ: number;
  // Per-top up-snap rate limit (bug round 9): index of the top the last
  // up-snap landed on while the avatar still stands in its expanded
  // footprint (-1 = no top held, snaps re-armed). Gameplay owns the field;
  // telemetry mirrors it so F3 can show the live suppress state.
  heldTopIndex: number;
  // Distance avatar -> evaluated block center (-1 when no top evaluated).
  blockDist: number;
  // XZ distance avatar -> server snapshot + which XZ band owns it.
  xzDist: number;
  xzBand: "deadband" | "lerp" | "snap" | "none";
  // Cumulative stall-snap event counter + wall-clock of the last one
  // (0 = never). The counter keeps its long-standing name so the F3 overlay
  // "SNAPS" line and history stay comparable across rounds.
  upSnapCount: number;
  lastUpSnapAtMs: number;
  // Short machine-readable reason for the outcome (e.g. "no-input",
  // "no-progress", "off-block", "server-off-top", "snap-rate", "airborne",
  // "cooldown", "recoil-grace", "far-snap", "big-heal").
  note: string;
}

const DAY_PHASES = [
  { at: 0, background: new THREE.Color(SKY_DAWN_BG), fog: new THREE.Color(SKY_DAWN_FOG),
    ambient: new THREE.Color(SCENE_DAWN_FILL), key: new THREE.Color(SCENE_DAWN_KEY),
    ambientIntensity: 0.98, keyIntensity: 1.28 },
  { at: 0.32, background: new THREE.Color(SKY_DAY_BG), fog: new THREE.Color(SKY_DAY_FOG),
    ambient: new THREE.Color(SCENE_DAY_FILL), key: new THREE.Color(SCENE_DAY_KEY),
    ambientIntensity: 0.78, keyIntensity: 1.63 },
  { at: 0.68, background: new THREE.Color(SKY_SUNSET_BG), fog: new THREE.Color(SKY_SUNSET_FOG),
    ambient: new THREE.Color(SCENE_SUNSET_FILL), key: new THREE.Color(SCENE_SUNSET_KEY),
    ambientIntensity: 0.49, keyIntensity: 1.28 },
  { at: 1, background: new THREE.Color(BASE_BG), fog: new THREE.Color(BASE_BG),
    ambient: new THREE.Color(SCENE_COOL_FILL), key: new THREE.Color(SCENE_WARM_LIGHT),
    ambientIntensity: 0.31, keyIntensity: 0.48 },
] as const;

// A circular orbital plane crosses above the arena, rather than running
// along one distant wall. Position uses round time independently of grading:
// the moon keeps travelling while the final-minute palette stays fixed.
const SKY_ORBIT_RADIUS = 54;
const SKY_ORBIT_CENTER_Y = 2;
const SKY_ORBIT_AZIMUTH = 0.18;
// Keep the raised arc inside the existing gameplay camera's upward view.
const SKY_ORBIT_TILT = -1.15;
const SKY_ORBIT_HALF_PERIOD_S = ROUND_LIGHTING_TRANSITION_END_S;
const SUN_ORBIT_START = 0.04;
const MOON_RISE_S = ROUND_LIGHTING_TRANSITION_START_S + 3;
const NIGHT_LIGHT_GAIN = 1.06 * 1.15;
const SKY_DISC_TARGET = new THREE.Vector3(0, 2, 0);
const SKY_ORBIT_EAST_X = Math.cos(SKY_ORBIT_AZIMUTH);
const SKY_ORBIT_EAST_Z = Math.sin(SKY_ORBIT_AZIMUTH);
const SKY_ORBIT_UP_X = -Math.sin(SKY_ORBIT_AZIMUTH) * Math.sin(SKY_ORBIT_TILT);
const SKY_ORBIT_UP_Y = Math.cos(SKY_ORBIT_TILT);
const SKY_ORBIT_UP_Z = Math.cos(SKY_ORBIT_AZIMUTH) * Math.sin(SKY_ORBIT_TILT);
const SUN_ARC_END = 0.78;
const SUN_FADE_START = 0.66;
const MOON_ARC_START = 0.66;
const MOON_FADE_DURATION = 0.18;
const CLOUD_FADE_START = 0.68;
const CLOUD_FADE_END = 0.86;
const SUN_DAY_COLOR = new THREE.Color(SKY_SUN_DISC);
const SUN_SUNSET_COLOR = new THREE.Color(SKY_SUNSET_DISC);
const CLOUD_DAY_COLOR = new THREE.Color(SKY_CLOUD_DAY);
const CLOUD_SUNSET_COLOR = new THREE.Color(SKY_CLOUD_SUNSET);

function smooth01(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

// Preserve exact colors and intensities from the previous full-round cycle.
// These three samples allocate once, never in the per-frame lighting path.
interface DayLighting {
  background: THREE.Color;
  fog: THREE.Color;
  skyHorizon: THREE.Color;
  skyZenith: THREE.Color;
  ambient: THREE.Color;
  key: THREE.Color;
  ambientIntensity: number;
  keyIntensity: number;
}

function sampleDayLighting(progress: number): DayLighting {
  let from: (typeof DAY_PHASES)[number] = DAY_PHASES[0];
  let to: (typeof DAY_PHASES)[number] = DAY_PHASES[1];
  for (let i = 1; i < DAY_PHASES.length; i += 1) {
    const next = DAY_PHASES[i];
    if (progress <= next.at) {
      to = next;
      break;
    }
    from = next;
  }
  const blend = smooth01((progress - from.at) / (to.at - from.at));
  return {
    background: new THREE.Color().lerpColors(from.background, to.background, blend),
    fog: new THREE.Color().lerpColors(from.fog, to.fog, blend),
    skyHorizon: new THREE.Color().lerpColors(from.fog, to.fog, blend),
    skyZenith: new THREE.Color().lerpColors(from.background, to.background, blend),
    ambient: new THREE.Color().lerpColors(from.ambient, to.ambient, blend),
    key: new THREE.Color().lerpColors(from.key, to.key, blend),
    ambientIntensity: from.ambientIntensity + (to.ambientIntensity - from.ambientIntensity) * blend,
    keyIntensity: from.keyIntensity + (to.keyIntensity - from.keyIntensity) * blend,
  };
}

const ROUND_DAY_LIGHTING = sampleDayLighting(ROUND_LIGHTING_DAY_SAMPLE_PROGRESS);
const ROUND_SUNSET_LIGHTING = sampleDayLighting(ROUND_LIGHTING_SUNSET_SAMPLE_PROGRESS);
const ROUND_NIGHT_LIGHTING = sampleDayLighting(ROUND_LIGHTING_NIGHT_SAMPLE_PROGRESS);
// The pale cyan/green horizon stays close to the accepted distance fog;
// only the sky deepens toward the cold blue zenith. Sunset keeps its warm
// palette, and the final minute restores the exact accepted flat night sky.
ROUND_DAY_LIGHTING.skyHorizon.lerp(new THREE.Color(0xacdcd2), 0.4);
ROUND_DAY_LIGHTING.skyZenith.set(0x548dce);
ROUND_NIGHT_LIGHTING.skyHorizon.copy(ROUND_NIGHT_LIGHTING.background);
ROUND_NIGHT_LIGHTING.ambientIntensity *= NIGHT_LIGHT_GAIN;
ROUND_NIGHT_LIGHTING.keyIntensity *= NIGHT_LIGHT_GAIN;

function eveningLightsAt(progress: number): number {
  return smooth01((progress * ROUND_SECONDS - ROUND_EVENING_LIGHTS_START_S)
    / ROUND_EVENING_LIGHTS_FADE_S);
}

function skyArcX(t: number): number {
  const angle = Math.PI * t;
  return SKY_ORBIT_RADIUS * (-Math.cos(angle) * SKY_ORBIT_EAST_X
    + Math.sin(angle) * SKY_ORBIT_UP_X);
}

function skyArcY(t: number): number {
  return SKY_ORBIT_CENTER_Y + SKY_ORBIT_RADIUS * Math.sin(Math.PI * t) * SKY_ORBIT_UP_Y;
}

function skyArcZ(t: number): number {
  const angle = Math.PI * t;
  return SKY_ORBIT_RADIUS * (-Math.cos(angle) * SKY_ORBIT_EAST_Z
    + Math.sin(angle) * SKY_ORBIT_UP_Z);
}

// Four diffuse, asymmetric patches share one tiny atlas: two dense, thick
// banks and two thin wisps. Uneven width/density break up the silhouettes
// without detailed lobes. A transparent gutter isolates the atlas cells.
function makeCloudTexture(): THREE.DataTexture {
  const cellSize = 64;
  const size = cellSize * 2;
  const data = new Uint8Array(size * size * 4);
  const shapes = [
    { width: 0.11, density: 0.48, shift: -0.08, slope: 0.12 },
    { width: 0.31, density: 0.86, shift: 0.10, slope: -0.09 },
    { width: 0.40, density: 0.78, shift: -0.13, slope: 0.04 },
    { width: 0.16, density: 0.48, shift: 0.07, slope: -0.15 },
  ] as const;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const variant = Math.floor(x / cellSize) + 2 * Math.floor(y / cellSize);
      const shape = shapes[variant]!;
      const phase = 0.9 + variant * 1.7;
      const u = ((x % cellSize) + 0.5) / cellSize * 2 - 1;
      const v = ((y % cellSize) + 0.5) / cellSize * 2 - 1;
      const center = 0.10 * Math.sin(u * 3.4 + phase)
        + 0.055 * Math.sin(u * 7.3 - phase) + u * shape.slope;
      const width = shape.width * (0.85 + 0.18 * Math.sin(u * 4.5 + phase)
        + 0.15 * smooth01(u + 0.5));
      const span = Math.exp(-Math.pow((u + shape.shift) / 0.69, 4) * 1.25);
      const density = shape.density * (0.78 + 0.11 * Math.sin(u * 6.2 + v * 4.1 + phase)
        + 0.085 * Math.cos(u * 10.7 - v * 7.2 - phase));
      const body = span * Math.exp(-Math.pow((v - center) / width, 2)) * density;
      const wisp = Math.exp(-Math.pow((u - 0.21 * Math.cos(phase)) / 0.62, 2) * 2
        - Math.pow((v - center - 0.23 * Math.sin(phase)) / 0.065, 2)) * 0.12;
      const margin = smooth01((1 - Math.abs(u)) / 0.19) * smooth01((1 - Math.abs(v)) / 0.19);
      const inGutter = x % cellSize < 2 || x % cellSize >= cellSize - 2
        || y % cellSize < 2 || y % cellSize >= cellSize - 2;
      const alpha = inGutter ? 0 : Math.min(0.86, body + wisp) * margin;
      const index = (y * size + x) * 4;
      data[index] = 255;
      data[index + 1] = 255;
      data[index + 2] = 255;
      data[index + 3] = Math.round(alpha * 255);
    }
  }
  const texture = new THREE.DataTexture(data, size, size);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

// Stylized round sky with exactly one shadowed directional light (<= 1024)
// and one ambient light. No additional lights or post-processing. Fog, vertex
// colors, hit flash, pooled particles and light camera shake remain cheap.
// Rapier capsule body drives the avatar once initPhysics() resolves; before
// that the legacy kinematic path applies.
export class SceneManager {
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly disposables: Array<{ dispose(): void }> = [];
  private roundProgress = 0;
  private skyProgress = ROUND_LIGHTING_DAY_SAMPLE_PROGRESS;
  private sceneBackground: THREE.Color | null = null;
  private sceneFog: THREE.Fog | null = null;
  private ambientLight: THREE.AmbientLight | null = null;
  private directionalLight: THREE.DirectionalLight | null = null;
  private skyMaterial: THREE.ShaderMaterial | null = null;
  private sunDisc: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial> | null = null;
  private clouds: THREE.InstancedMesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> | null = null;
  private moonDisc: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial> | null = null;
  private starMaterial: THREE.PointsMaterial | null = null;
  private readonly nebulaMaterials: THREE.SpriteMaterial[] = [];
  private readonly nebulaBaseOpacities: number[] = [];

  // Avatar root (Group at the physics body position — the follow camera
  // tracks THIS) + hop rig child (South Park bounce writes here only, so the
  // camera never bobs) + capsule body mesh (two-tone vertex-colored clothing).
  private avatar: THREE.Group | null = null;
  private avatarRig: THREE.Group | null = null;
  private avatarBody: THREE.Mesh | null = null;
  private avatarMaterial: THREE.MeshStandardMaterial | null = null;
  private readonly hop = createHopState();
  private readonly hopPrev = new THREE.Vector3();
  // Last hop-boundary index the footstep event path consumed (Stage 5 audio):
  // update() pushes one "footstep" event per hop-boundary crossing while
  // grounded and moving, so the tick rate rides the hop cadence for free.
  private lastFootstepHop = -1;
  // Flight gate: airborne while the Rapier body climbs/falls fast
  // (trampoline launch, platform drop) — the hop rig glides instead of
  // bouncing. Two-level gate with exit hold (no ramp trips, no apex
  // flutter); refreshed in updatePhysics every frame.
  private readonly airborneGate = new AirborneGate();
  private powerEffects: PowerEffectVisuals | null = null;
  private yaw = 0;
  private pitch = CAMERA_REST_PITCH;
  private built = false;

  private readonly arena = new ArenaBuilder();
  private readonly ads = new AdsManager();
  private readonly powerState = new PowerUpState();
  private readonly powerHudState = {
    shieldHp: 0,
    shieldRemaining: 0,
    speedRemaining: 0,
    chargeRemaining: 0,
  };
  private readonly pickups = new PowerUpPickups();
  private readonly particles = new ParticlePool();
  private readonly shake = new CameraShake();
  private readonly flash = new HitFlash();
  private readonly events: ArenaEvent[] = [];

  private physics: PhysicsWorld | null = null;
  private physicsFailed = false;
  private trampolineCooldown = 0;

  // R1 pre-join spectator: while spectating the local avatar stays hidden
  // (no ghost body) and the camera runs a slow hover orbit over the arena.
  // Movement/physics inputs are ignored until Play (see update()).
  private spectating = false;
  private spectatorTime = 0;
  // Post-shot body turn (owner fix round 2): after a REAL shot the body eases
  // from the stale run facing toward the shot direction (same
  // avatar.rotation.y the movement writer owns — which is also the rotY
  // value main.ts sends upstream every tick, so remotes learn the turn via
  // the existing pass-through with no server change). Armed by
  // setShotTurnTarget from main.ts stopCharge; eased in update() ONLY while
  // the stick is released (movement input cancels it — the movement writer
  // owns yaw then). Scalar pair, no allocations.
  private shotTurnActive = false;
  private shotTurnTarget = 0;

  // Stage 4d.1 hand-ball combat: held core + face on the local avatar,
  // pooled balls and the SUPER core from the latest authoritative snapshot.
  private avatarVisuals: AvatarVisualsHandle | null = null;
  // Fire-direction aim (camera yaw/pitch at release, fed per frame from
  // main.ts). The body keeps facing movement; the aim feeds the recoil kick
  // dir, the spark emitter and the trajectory preview (no barrel to aim).
  private aimYaw = 0;
  private aimPitch = CAMERA_REST_PITCH;
  private hasAim = false;
  private ballsPool: BallsPool | null = null;
  private superCore: SuperCore | null = null;
  // Stage 4d.3 ambient dressing: 8 glow fireflies as one InstancedMesh
  // (1 draw call, no lights — see fx/Fireflies). Owned here so build /
  // update / dispose stay in one place with the other pooled visuals.
  private fireflies: Fireflies | null = null;
  private charge01 = 0;
  // Charging locomotion flag (bug C): main.ts feeds isCharging here every
  // frame; while true the local move target speed scales by CHARGE_MOVE_MULT
  // (server mirror) so prediction stops wobble-fighting the server during
  // charge+walk — the preview origin stays put. Defaults false (spectators,
  // tests, and pre-charge frames move full speed).
  private charging = false;
  private latestBalls: readonly NetBallSnapshot[] = [];
  private latestSuper: NetSuperSnapshot | null = null;
  // Scratch vectors for the per-frame camera path (no per-frame alloc).
  private readonly cameraOffset = new THREE.Vector3();
  private readonly cameraLookAt = new THREE.Vector3();
  private readonly cameraDesired = new THREE.Vector3();
  // Follow-camera smoothing state: desired position + lookAt ease toward the
  // target at CAMERA_SMOOTH_RATE (exp, 1/s) so per-frame avatar corrections
  // (reconcile lerp, recoil kick) never translate into camera jumps. Yaw
  // itself stays instant (mouse-responsive); only pos + lookAt smooth.
  private readonly smoothCamPos = new THREE.Vector3();
  private readonly smoothCamLook = new THREE.Vector3();
  private cameraSmoothInit = false;
  // Recoil grace: the client kick is prediction-only (the server re-applies
  // the same kick authoritatively), so reconcileSelf skips corrections while
  // this timer runs instead of fighting the kick and double-tugging.
  private recoilGraceLeftS = 0;
  // Snap cooldown (bug round 6c reviewer B2 backstop, kept in round 7):
  // minimum time between snaps on any path (stall, big-div, far), so a
  // snap-then-dip-then-resnap cycle can never loop. Ticks down in
  // reconcileSelf; set on every snap path. 0.3 s exceeds the 0.25 s stall
  // window, so a post-teleport empty window can never fire early.
  private upSnapCooldownLeftS = 0;
  // Stall-window anchor ring (tower-top snap-loop fix): preallocated XZ
  // anchors covering the last STALL_WINDOW_S (SLOTS slots x WINDOW_S/SLOTS
  // each ≈ 0.25 s). The window scores NET DISPLACEMENT — distance from the
  // oldest slot's anchor to the current XZ — so in-place jitter never reads
  // as travel. Scalar pairs only, zero per-frame allocs.
  private readonly stallAnchorX: number[] = new Array<number>(SELF_RECONCILE_STALL_SLOTS).fill(0);
  private readonly stallAnchorZ: number[] = new Array<number>(SELF_RECONCILE_STALL_SLOTS).fill(0);
  private stallSlotIndex = 0;
  private stallSlotTimeS = 0;
  // Frames observed since the last reseed (authoritative placement): the
  // window may only report a stall once >= STALL_MIN_FRAMES frames fed it, so
  // a fresh (zero-evidence) window or a render hitch can never fire a snap.
  private stallWindowFrames = 0;
  // False until the first tracked frame seeds every anchor on the avatar.
  private stallSeeded = false;
  // Big-div sustained-hold timer (bug round 7): accumulates while
  // |serverY - localY| >= BIG_DIV and NOT airborne; reset on agreement,
  // airborne, or any teleport. Fires the downward-desync heal at HOLD_S.
  private bigDivHoldS = 0;
  // Cached elevated-block tops for the stall-snap (built once — reconcileSelf
  // iterates this, never getPlatforms()/getObstacleLayout(), so the per-frame
  // path allocates nothing).
  private readonly supportTops: SupportTop[] = buildSupportTopList();
  // Per-top up-snap rate limit (bug round 9 — the lip-grind loop): after an
  // up-snap onto top T the first heal per visit is done, but the healed body
  // lands supported while the player still pushes into the far lip, so the
  // stall window re-drains and the snap refires on the 0.3 s cooldown cadence
  // (~15 snaps in 8.5 s live). This scalar holds T's list index until the
  // avatar LEAVES T's expanded footprint (checked every reconcile against the
  // live client XZ — outside for >= 1 frame re-arms) or the client goes
  // airborne. A teleport never touches this scalar directly — it lands outside
  // the footprint, so the hold clears on the next live reconcile (deferred).
  // Further up-snaps onto T while held note "snap-rate"; snaps onto any OTHER
  // top stay live, and leaving + re-entering re-arms (the round-6 loop shape
  // still heals). One scalar, zero per-frame allocs.
  private heldTopIndex = -1;
  // Reused reconcile telemetry object (F3 overlay reads it; gameplay ignores
  // it). Mutated in place every reconcileSelf call — never replaced.
  private readonly reconcileTelemetry: ReconcileTelemetry = {
    result: "unrun",
    snapKind: "none",
    serverX: Number.NaN,
    serverY: Number.NaN,
    serverZ: Number.NaN,
    localY: Number.NaN,
    divergence: Number.NaN,
    divOk: false,
    moveMag: 0,
    inputOk: false,
    stallProgressM: 0,
    stallOk: false,
    stallFrames: 0,
    stallFramesOk: false,
    bigDivHoldS: 0,
    bigHealCount: 0,
    lastBigHealAtMs: 0,
    airborne: false,
    cooldownLeftS: 0,
    levelTopIndex: -1,
    levelTopY: Number.NaN,
    evalTopIndex: -1,
    xzOk: false,
    srvXzOnTop: false,
    blockCenterX: Number.NaN,
    blockCenterZ: Number.NaN,
    heldTopIndex: -1,
    blockDist: -1,
    xzDist: -1,
    xzBand: "none",
    upSnapCount: 0,
    lastUpSnapAtMs: 0,
    note: "never-run",
  };

  // Readonly view of the last reconcileSelf telemetry (F3 debug overlay).
  public getLastReconcileTelemetry(): Readonly<ReconcileTelemetry> {
    return this.reconcileTelemetry;
  }
  // Full-charge spark timer: while charge01 >= 0.8 a small ember burst pops
  // at the muzzle every SPARK_INTERVAL_S (pooled, no alloc, no lights).
  private sparkTimer = 0;
  // Stage 4d.2 charge zoom: main.ts feeds charge01 here every frame while
  // charging (0 = default 4m, 1 = CAMERA_CHARGE_DISTANCE ~3.2m). The live
  // cameraDistance eases toward the target at CAMERA_SMOOTH_RATE (no snap);
  // on shot/cancel main feeds 0 and it eases back. Never reset mid-charge —
  // only the actual shot / cancel returns it.
  private chargeZoom01 = 0;
  private cameraDistance = CAMERA_FOLLOW_DISTANCE;

  public constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this.scene = scene;
    this.camera = camera;
  }

  // Called with authoritative elapsed / total round time. Waiting and
  // countdown pass 0; the ended match keeps its final value until the next
  // round resets it. Mutates existing colors/materials only, with no frame
  // allocations or new lights.
  public setDayProgress(progress: number): void {
    this.roundProgress = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
    const elapsed = this.roundProgress * ROUND_SECONDS;
    let from = ROUND_DAY_LIGHTING;
    let to = ROUND_SUNSET_LIGHTING;
    let blend = smooth01((elapsed - ROUND_LIGHTING_TRANSITION_START_S)
      / (ROUND_LIGHTING_SUNSET_AT_S - ROUND_LIGHTING_TRANSITION_START_S));
    if (elapsed >= ROUND_LIGHTING_TRANSITION_END_S) {
      from = ROUND_NIGHT_LIGHTING;
      to = ROUND_NIGHT_LIGHTING;
      blend = 0;
    } else if (elapsed >= ROUND_LIGHTING_SUNSET_AT_S) {
      from = ROUND_SUNSET_LIGHTING;
      to = ROUND_NIGHT_LIGHTING;
      blend = smooth01((elapsed - ROUND_LIGHTING_SUNSET_AT_S)
        / (ROUND_LIGHTING_TRANSITION_END_S - ROUND_LIGHTING_SUNSET_AT_S));
    }
    // This clock only controls sky colors and fades. Celestial positions use
    // elapsed round time below, so holding the night palette never stops them.
    if (elapsed <= ROUND_LIGHTING_TRANSITION_START_S) {
      this.skyProgress = ROUND_LIGHTING_DAY_SAMPLE_PROGRESS
        + (ROUND_SKY_TRANSITION_START_PROGRESS - ROUND_LIGHTING_DAY_SAMPLE_PROGRESS)
        * smooth01(elapsed / ROUND_LIGHTING_TRANSITION_START_S);
    } else if (elapsed < ROUND_LIGHTING_SUNSET_AT_S) {
      this.skyProgress = ROUND_SKY_TRANSITION_START_PROGRESS
        + (ROUND_LIGHTING_SUNSET_SAMPLE_PROGRESS - ROUND_SKY_TRANSITION_START_PROGRESS) * blend;
    } else if (elapsed < ROUND_LIGHTING_TRANSITION_END_S) {
      this.skyProgress = ROUND_LIGHTING_SUNSET_SAMPLE_PROGRESS
        + (ROUND_LIGHTING_NIGHT_SAMPLE_PROGRESS - ROUND_LIGHTING_SUNSET_SAMPLE_PROGRESS) * blend;
    } else {
      this.skyProgress = ROUND_LIGHTING_NIGHT_SAMPLE_PROGRESS;
    }
    this.sceneBackground?.lerpColors(from.background, to.background, blend);
    this.sceneFog?.color.lerpColors(from.fog, to.fog, blend);
    if (this.skyMaterial !== null) {
      (this.skyMaterial.uniforms.skyHorizon!.value as THREE.Color).lerpColors(from.skyHorizon, to.skyHorizon, blend);
      (this.skyMaterial.uniforms.skyZenith!.value as THREE.Color).lerpColors(from.skyZenith, to.skyZenith, blend);
    }
    if (this.ambientLight !== null) {
      this.ambientLight.color.lerpColors(from.ambient, to.ambient, blend);
      this.ambientLight.intensity = from.ambientIntensity
        + (to.ambientIntensity - from.ambientIntensity) * blend;
    }
    if (this.directionalLight !== null) {
      this.directionalLight.color.lerpColors(from.key, to.key, blend);
      this.directionalLight.intensity = from.keyIntensity
        + (to.keyIntensity - from.keyIntensity) * blend;
    }
    const sunArc = SUN_ORBIT_START + elapsed / SKY_ORBIT_HALF_PERIOD_S;
    const sunX = skyArcX(sunArc);
    const sunY = skyArcY(sunArc);
    const sunOpacity = smooth01((SUN_ARC_END - this.skyProgress) / (SUN_ARC_END - SUN_FADE_START));
    if (this.sunDisc !== null) {
      this.sunDisc.position.set(sunX, sunY, skyArcZ(sunArc));
      this.sunDisc.lookAt(SKY_DISC_TARGET);
      this.sunDisc.material.color.lerpColors(
        SUN_DAY_COLOR, SUN_SUNSET_COLOR, smooth01((this.skyProgress - 0.43) / 0.25),
      );
      this.sunDisc.material.opacity = 0.94 * sunOpacity;
      this.sunDisc.visible = sunOpacity > 0;
    }
    if (this.directionalLight !== null) {
      // The key follows the visible disc's azimuth. A minimum elevation keeps
      // shadows legible at dawn; the original night direction resumes as the
      // disc sets, with no second key light or moving target allocation.
      this.directionalLight.position.set(
        sunX * 0.22 * sunOpacity + 5 * (1 - sunOpacity),
        Math.max(9, sunY * 0.22) * sunOpacity + 10 * (1 - sunOpacity),
        skyArcZ(sunArc) * 0.22 * sunOpacity + 5 * (1 - sunOpacity),
      );
    }
    const moonArc = Math.max(0, (elapsed - MOON_RISE_S) / SKY_ORBIT_HALF_PERIOD_S);
    const moonOpacity = 0.92 * smooth01((this.skyProgress - MOON_ARC_START) / MOON_FADE_DURATION);
    if (this.moonDisc !== null) {
      this.moonDisc.position.set(skyArcX(moonArc), skyArcY(moonArc), skyArcZ(moonArc));
      this.moonDisc.lookAt(SKY_DISC_TARGET);
      this.moonDisc.material.opacity = moonOpacity;
      this.moonDisc.visible = moonOpacity > 0;
    }
    if (this.clouds !== null) {
      const fade = 1 - smooth01((this.skyProgress - CLOUD_FADE_START)
        / (CLOUD_FADE_END - CLOUD_FADE_START));
      this.clouds.material.color.lerpColors(
        CLOUD_DAY_COLOR, CLOUD_SUNSET_COLOR, smooth01((this.skyProgress - 0.38) / 0.3),
      );
      this.clouds.material.opacity = (0.24 + 0.15 * smooth01(this.skyProgress / 0.32)) * fade;
      this.clouds.position.x = this.roundProgress * 1.8;
      this.clouds.visible = fade > 0;
    }
    const eveningLights = eveningLightsAt(this.roundProgress);
    this.ads.setPorchLighting(eveningLights);
    this.fireflies?.setVisibility(eveningLights);
    const stars = smooth01((this.skyProgress - 0.66) / 0.3);
    if (this.starMaterial !== null) this.starMaterial.opacity = 0.9 * stars;
    for (let i = 0; i < this.nebulaMaterials.length; i += 1) {
      const material = this.nebulaMaterials[i];
      if (material !== undefined) material.opacity = (this.nebulaBaseOpacities[i] ?? 0) * stars;
    }
  }

  public build(): void {
    if (this.built) {
      return;
    }
    this.built = true;

    this.sceneBackground = new THREE.Color(SKY_DAWN_BG);
    this.sceneFog = new THREE.Fog(SKY_DAWN_FOG, 30, 85);
    this.scene.background = this.sceneBackground;
    this.scene.fog = this.sceneFog;

    // One warm key and one cool fill supply a clear face hierarchy. Their
    // colors/intensities follow the day/transition/night schedule; the shadow map stays
    // within 1024px.
    const ambient = new THREE.AmbientLight(SCENE_COOL_FILL, SCENE_AMBIENT_INTENSITY);
    this.scene.add(ambient);
    this.ambientLight = ambient;

    const directional = new THREE.DirectionalLight(SCENE_WARM_LIGHT, SCENE_DIRECTIONAL_INTENSITY);
    directional.position.set(5, 10, 5);
    directional.castShadow = true;
    directional.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    directional.shadow.normalBias = 0.025;
    directional.shadow.camera.left = -ARENA_HALF_SIZE;
    directional.shadow.camera.right = ARENA_HALF_SIZE;
    directional.shadow.camera.top = ARENA_HALF_SIZE;
    directional.shadow.camera.bottom = -ARENA_HALF_SIZE;
    this.scene.add(directional);
    this.directionalLight = directional;

    this.arena.buildVisuals(this.scene);
    this.buildSky(this.scene);
    this.ads.buildVisuals(this.scene);
    this.setDayProgress(this.roundProgress);
    void this.ads.load().catch(() => {
      // Ads always fall back to generated placeholders; never fatal.
    });

    // QD1-A: capsule avatar (fun physics body in Stage 3). The root Group
    // sits at the physics position (camera target); the rig child carries
    // every visual (body, ball, face, bubble) so the hop bounce never moves
    // the camera anchor. Two-tone clothing is baked as vertex colors with a
    // white base material (ONE draw call, emissive hit-flash untouched).
    const capsuleGeometry = new THREE.CapsuleGeometry(0.5, 1.0, 8, 16);
    const capsuleMaterial = new THREE.MeshStandardMaterial({
      color: NEUTRAL_WHITE,
      emissive: ACCENT_HIT_FLASH,
      emissiveIntensity: 0,
      roughness: 0.55,
      vertexColors: true,
    });
    const avatar = new THREE.Group();
    avatar.position.set(0, 1.1, 0);
    const rig = new THREE.Group();
    avatar.add(rig);
    const bodyMesh = new THREE.Mesh(capsuleGeometry, capsuleMaterial);
    bodyMesh.castShadow = true;
    rig.add(bodyMesh);
    applyClothing(bodyMesh, LOCAL_AVATAR_COLOR, pantsColorForSession(""));
    this.scene.add(avatar);
    this.disposables.push(capsuleGeometry, capsuleMaterial);
    this.avatar = avatar;
    this.avatarRig = rig;
    this.avatarBody = bodyMesh;
    this.avatarMaterial = capsuleMaterial;
    this.hopPrev.set(0, 1.1, 0);

    // 4d.1: held ball + face ride on the rig (ball right hand chest height,
    // face front +Z) so they hop with the body. Tinted local identity red.
    this.avatarVisuals = attachAvatarVisuals(rig, LOCAL_AVATAR_COLOR);
    this.powerEffects = new PowerEffectVisuals(rig);
    this.ballsPool = new BallsPool(this.scene);
    this.superCore = new SuperCore(this.scene);
    this.fireflies = new Fireflies(this.scene);
    this.fireflies.setVisibility(eveningLightsAt(this.roundProgress));

    this.scene.add(this.pickups.object);
    this.scene.add(this.particles.object);

    this.updateCameraTransform(0);
  }

  // Async Rapier boot (WASM init). Idempotent; on failure the scene keeps
  // running on the legacy kinematic path and reports false.
  public async initPhysics(): Promise<boolean> {
    if (this.physics !== null) {
      return true;
    }
    if (this.physicsFailed) {
      return false;
    }
    try {
      const world = await PhysicsWorld.create({ x: 0, y: 1.1, z: 0 });
      this.arena.buildColliders(world);
      this.physicsReady(world);
      return true;
    } catch {
      this.physicsFailed = true;
      return false;
    }
  }

  private physicsReady(world: PhysicsWorld): void {
    this.physics = world;
  }

  public get isPhysicsReady(): boolean {
    return this.physics !== null;
  }

  // R1 spectator mode: hide the local avatar (no ghost body before Play)
  // and switch the camera to the hover orbit. Restoring to false makes the
  // avatar visible again for the follow camera (4m, FOV 75).
  public setSpectating(value: boolean): void {
    this.spectating = value;
    // Any spectate transition drops a pending post-shot turn (no body while
    // watching; a returning fighter re-arms only via a fresh real shot).
    this.shotTurnActive = false;
    if (this.avatar !== null) {
      this.avatar.visible = !value;
    }
    if (value) {
      // Hidden body must not keep a stale bounce pose for the next life.
      this.resetHop();
    }
    if (value && this.built) {
      this.updateSpectatorCamera(0);
    } else if (!value && this.built) {
      this.updateCameraTransform(0);
    }
  }

  public isSpectating(): boolean {
    return this.spectating;
  }

  // Flight gate for tests/telemetry: true while the body is airborne enough
  // to glide instead of hop (see updatePhysics).
  public isAirborne(): boolean {
    return this.airborneGate.isAirborne;
  }

  // Combat wiring: charge 0..1 for the held-ball glow/swell, latest
  // authoritative balls + SUPER core snapshot (null hides the core).
  public setCharge01(value: number): void {
    const clamped = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
    this.charge01 = clamped;
  }

  // Charging locomotion flag (bug C): fed every frame from main.ts while
  // playing. While charging the local move target runs at CHARGE_MOVE_MULT
  // (server mirror) — see updatePhysics.
  public setCharging(active: boolean): void {
    this.charging = active === true;
  }

  // Stage 4d.2 charge-zoom feed (called every frame from main.ts while
  // charging, with 0 on shot/cancel). Stores the target only — the easing
  // happens in updateCameraTransform so it never snaps.
  public setChargeZoom01(value: number): void {
    this.chargeZoom01 = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  }

  // Current (eased) follow distance, for tests/telemetry.
  public getCameraDistance(): number {
    return this.cameraDistance;
  }

  // Stage 4d.2 charge translucency (local avatar only, never remotes):
  // from charge start until the actual shot/cancel the body + hand ball
  // fade to AVATAR_CHARGE_OPACITY. Transparent flips once and stays flagged
  // (no per-frame state churn, cheap). Null/spectator-safe: charging guards
  // failing (no avatar yet) is a silent no-op, never a crash. Hit-flash
  // writes emissiveIntensity — an independent field — so it keeps working
  // while translucent.
  public setChargeTranslucent(active: boolean): void {
    const translucent = active === true;
    const opacity = translucent ? AVATAR_CHARGE_OPACITY : 1;
    if (this.avatarMaterial !== null) {
      this.avatarMaterial.transparent = true;
      this.avatarMaterial.opacity = opacity;
    }
    this.avatarVisuals?.setTranslucent(translucent);
  }

  public getAvatarOpacity(): number {
    return this.avatarMaterial?.opacity ?? 1;
  }

  public getHandBallOpacity(): number {
    return this.avatarVisuals?.getBallOpacity() ?? 1;
  }

  public debugGetAvatarEmissive(): number {
    return this.avatarMaterial?.emissiveIntensity ?? 0;
  }

  public setBattleSnapshot(balls: readonly NetBallSnapshot[], superSnapshot: NetSuperSnapshot | null): void {
    this.latestBalls = balls;
    this.latestSuper = superSnapshot ?? null;
  }

  // Throw feedback on release: the held ball flicks forward, hides for the
  // reload window, then pops back (reload return). Called from stopCharge.
  public playThrow(): void {
    this.avatarVisuals?.ball.playThrow();
  }

  // Player identity: deterministic face variant + two-tone clothing + hop
  // waddle seed for our session. The avatar builds pre-join with defaults;
  // main.ts calls this on welcome once the session id is known (re-bakes
  // pants in place, no realloc).
  public setPlayerSource(sessionId: string): void {
    this.avatarVisuals?.setFaceSource(sessionId);
    seedHopState(this.hop, sessionId);
    if (this.avatarBody !== null) {
      applyClothing(this.avatarBody, LOCAL_AVATAR_COLOR, pantsColorForSession(sessionId));
    }
  }

  // Instant local muzzle feedback (<1 frame, zero network wait): pooled
  // sprite flash AT the hand on release. Called from main.ts stopCharge
  // right after sendFire; the authoritative ball eases in later via lerp.
  // Tint follows the thrower (local fighter color for normal shots, purple
  // for SUPER) so the flash reads as ours.
  public flashMuzzle(x: number, y: number, z: number, superShot: boolean, color?: number): void {
    this.ballsPool?.flashMuzzle(x, y, z, superShot, color);
  }

  // Fire-direction feed (called every frame from main.ts with the live
  // aimYaw/aimPitch). Stored only — feeds the recoil kick dir, the spark
  // emitter and muzzle math. The pitch is clamped to the shared aim band
  // [CAMERA_PITCH_MIN, CAMERA_PITCH_MAX]: the stored aim must never hold an
  // out-of-band value (a stale mirrored camera pitch could only arrive here
  // via the removed charge feedback copy — main.ts never sends out-of-band
  // aim anymore, and the fire payload is clamped again at send in
  // protocol.buildFirePayload). No alloc, two numbers.
  public setAimAngles(yaw: number, pitch: number): void {
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) {
      return;
    }
    this.aimYaw = yaw;
    this.aimPitch = THREE.MathUtils.clamp(pitch, CAMERA_PITCH_MIN, CAMERA_PITCH_MAX);
    this.hasAim = true;
  }

  // Death burst (bug round 5: unmistakable shatter, never hit-blood): 80
  // pooled particles — white 10% / pale violet 30% / muted red remainder /
  // victim identity 15% / chartreuse 5% glint — with a bigger radial spread,
  // a stronger upward pop, and a slightly longer life than the 16-particle
  // all-red hit-blood burst. The identity chunk reuses the victim's fighter
  // color (resolved by the caller through the shared identity derivation),
  // so the burst reads as THAT fighter shattering. Event-time allocations
  // only (per-burst Colors, never per-frame), no lights, one Points draw
  // call via the shared ParticlePool.
  public spawnDeathBurst(x?: number, y?: number, z?: number, identityColor?: number): void {
    const avatar = this.avatar;
    const px = x ?? avatar?.position.x ?? 0;
    const py = y ?? (avatar !== null ? avatar.position.y + 0.2 : 1.2);
    const pz = z ?? avatar?.position.z ?? 0;
    if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) {
      return;
    }
    const identity =
      identityColor !== undefined && Number.isFinite(identityColor) ? identityColor : LOCAL_AVATAR_COLOR;
    const total = DEATH_BURST_COUNT > 0 ? DEATH_BURST_COUNT : 80;
    const yellow = Math.round(total * 0.1);
    const orange = Math.round(total * 0.3);
    const identityCount = Math.round(total * 0.15);
    const chartreuse = Math.round(total * 0.05);
    const red = total - yellow - orange - identityCount - chartreuse;
    if (yellow > 0) {
      this.particles.spawn(px, py, pz, yellow, new THREE.Color(DEATH_BURST_YELLOW), DEATH_BURST_SPREAD, DEATH_BURST_UP, DEATH_BURST_LIFE_S);
    }
    if (orange > 0) {
      this.particles.spawn(px, py, pz, orange, new THREE.Color(DEATH_BURST_ORANGE), DEATH_BURST_SPREAD, DEATH_BURST_UP, DEATH_BURST_LIFE_S);
    }
    if (red > 0) {
      this.particles.spawn(px, py, pz, red, new THREE.Color(DEATH_BURST_RED), DEATH_BURST_SPREAD, DEATH_BURST_UP, DEATH_BURST_LIFE_S);
    }
    if (identityCount > 0) {
      this.particles.spawn(px, py, pz, identityCount, new THREE.Color(identity), DEATH_BURST_SPREAD, DEATH_BURST_UP, DEATH_BURST_LIFE_S);
    }
    if (chartreuse > 0) {
      this.particles.spawn(px, py, pz, chartreuse, new THREE.Color(DEATH_BURST_CHARTREUSE), DEATH_BURST_SPREAD, DEATH_BURST_UP, DEATH_BURST_LIFE_S);
    }
  }

  public getAliveParticleCount(): number {
    return this.particles.aliveCount;
  }

  // Player-hit blood burst (bug round 3): red particles ONLY for the server
  // "ball-hit-player" event (see notifyBallHit below). Environmental vanishes
  // never reach here — BallsPool pops a small neutral puff for those instead.
  // No alloc, no lights, one shared Points draw call via the ParticlePool.
  public spawnBallHitBurst(x: number, y: number, z: number, superShot: boolean): void {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return;
    }
    const count = superShot ? PARTICLE_BURST_COUNT : BLOOD_BURST_COUNT;
    const color = superShot ? ACCENT_FIRE_BURST : ACCENT_HIT_BURST;
    this.particles.spawn(x, y, z, count, new THREE.Color(color));
  }

  // Server player-hit entry point: marks the ball so its snapshot vanish
  // skips the neutral env puff, then pops the red burst at the impact
  // position. Safe in playing + spectator contexts (updateCombat renders
  // balls and ticks particles in both).
  public notifyBallHit(ballId: string, x: number, y: number, z: number, superShot: boolean): void {
    this.ballsPool?.markPlayerHit(ballId);
    this.spawnBallHitBurst(x, y, z, superShot);
  }

  // Local victim hit-flash (Stage 4d.4): spikes the local avatar emissive
  // through the existing HitFlash wiring (update() fades it back over
  // HIT_FLASH_DURATION_S). Flash only — the blood burst stays in
  // notifyBallHit/spawnBallHitBurst, shield/shake stay in applyTestHit.
  public flashLocalHit(): void {
    this.flash.trigger();
  }

  public getWallOpacity(): number {
    return this.arena.getWallOpacity();
  }

  public debugGetCameraPosition(): THREE.Vector3 {
    return this.camera.position.clone();
  }

  // Instant client recoil: nudge the local avatar opposite the live fire dir
  // by the same weak 0.4m -> full 0.8m mapping the server applies
  // (recoilDistanceForPower mirror). Clamped to the arena; velocity kept.
  public applyRecoilKick(power01: number): void {
    if (this.avatar === null || this.spectating) {
      return;
    }
    const clamped = Number.isFinite(power01) ? Math.max(0.5, Math.min(1, power01)) : 0.5;
    const recoil = RECOIL_WEAK_M + (RECOIL_FULL_M - RECOIL_WEAK_M) * ((clamped - 0.5) / 0.5);
    const yaw = this.hasAim ? this.aimYaw : this.yaw;
    const pitch = this.hasAim ? this.aimPitch : this.pitch;
    const cosPitch = Math.cos(pitch);
    const dirX = -Math.sin(yaw) * cosPitch;
    const dirZ = -Math.cos(yaw) * cosPitch;
    const horizontal = Math.hypot(dirX, dirZ);
    if (!(horizontal > 0.0001)) {
      return;
    }
    const kickX = (dirX / horizontal) * recoil;
    const kickZ = (dirZ / horizontal) * recoil;
    const nextX = THREE.MathUtils.clamp(this.avatar.position.x - kickX, -ARENA_HALF_SIZE, ARENA_HALF_SIZE);
    const nextZ = THREE.MathUtils.clamp(this.avatar.position.z - kickZ, -ARENA_HALF_SIZE, ARENA_HALF_SIZE);
    this.avatar.position.x = nextX;
    this.avatar.position.z = nextZ;
    // Start the reconcile grace window (prediction-only kick; the server
    // re-applies the same kick authoritatively right after).
    this.recoilGraceLeftS = RECOIL_RECONCILE_GRACE_S;
    if (this.physics !== null) {
      const bodyPos = this.physics.getPlayerPosition();
      const bx = THREE.MathUtils.clamp(bodyPos.x - kickX, -ARENA_HALF_SIZE, ARENA_HALF_SIZE);
      const bz = THREE.MathUtils.clamp(bodyPos.z - kickZ, -ARENA_HALF_SIZE, ARENA_HALF_SIZE);
      this.physics.setPlayerPosition(bx, bodyPos.y, bz);
    }
  }

  // R1 hover camera: angled top-down above the arena (~14,16,14) looking at
  // the origin, with a slow orbit drift. FOV stays 75 (CAMERA_FOV).
  public updateSpectatorCamera(deltaSeconds: number): void {
    this.spectatorTime += Math.max(0, deltaSeconds);
    const radius = Math.hypot(SPECTATOR_CAM_X, SPECTATOR_CAM_Z);
    const angle = Math.PI / 4 + this.spectatorTime * SPECTATOR_ORBIT_SPEED;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    const y = SPECTATOR_CAM_Y + Math.sin(this.spectatorTime * SPECTATOR_BOB_SPEED) * SPECTATOR_BOB_AMPLITUDE;
    this.camera.position.set(x, y, z);
    if (this.camera.fov !== CAMERA_FOV) {
      this.camera.fov = CAMERA_FOV;
      this.camera.updateProjectionMatrix();
    }
    this.camera.lookAt(0, 0, 0);
  }

  public update(deltaSeconds: number, move: MoveVector, look: LookDelta): void {
    if (!this.built || this.avatar === null || deltaSeconds <= 0) {
      return;
    }
    // R1: while spectating there is no local body — ignore movement and
    // look inputs, keep the hover orbit drifting over the live arena.
    // R2: spectators still watch live balls + SUPER core from the snapshot.
    if (this.spectating) {
      this.particles.update(deltaSeconds);
      this.updateCombat(deltaSeconds);
      this.updateSpectatorCamera(deltaSeconds);
      return;
    }
    // Hold-right-mouse-button rotation: deltas orbit the follow camera.
    // Gated on non-zero input so a preset pitch outside the plain band (the
    // mirrored charge pitch via the setCameraAngles min/max override)
    // survives frames with no look input — main.ts zeroes look deltas while
    // charging, so without this gate update() would re-clamp the mirror to
    // MIN every frame. The clamp still owns every real RMB drag (which only
    // runs when NOT charging), and zero deltas change yaw/pitch by nothing
    // anyway — idle/follow presets pass through byte-identical.
    // A stale out-of-band pitch (the mirrored charge pitch surviving the
    // shot, down to MIRROR_PITCH_MIN) must not snap on the first drag
    // either: the drag is bounded below by min(MIN, current) and above by
    // max(MAX, current), so dragging from an out-of-band start glides back
    // continuously (a downward drag holds the pitch instead of escaping
    // further, an upward drag re-enters the band smoothly). In-band drags
    // clamp exactly as before — mouse sign, rate and band untouched.
    if (look.dx !== 0 || look.dy !== 0) {
      this.yaw -= look.dx * CAMERA_SENSITIVITY;
      this.pitch = THREE.MathUtils.clamp(
        this.pitch + look.dy * CAMERA_SENSITIVITY,
        Math.min(CAMERA_PITCH_MIN, this.pitch),
        Math.max(CAMERA_PITCH_MAX, this.pitch),
      );
    }

    // Movement is camera-relative so WASD never breaks while rotating.
    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(-forward.z, 0, forward.x);
    const worldMove = new THREE.Vector3()
      .addScaledVector(forward, move.y)
      .addScaledVector(right, move.x);
    if (worldMove.lengthSq() > 1) {
      worldMove.normalize();
    }

    const physics = this.physics;
    if (physics !== null) {
      this.updatePhysics(deltaSeconds, worldMove);
    } else {
      this.avatar.position.addScaledVector(worldMove, MOVE_SPEED * deltaSeconds);
      this.avatar.position.x = THREE.MathUtils.clamp(
        this.avatar.position.x,
        -ARENA_HALF_SIZE,
        ARENA_HALF_SIZE,
      );
      this.avatar.position.z = THREE.MathUtils.clamp(
        this.avatar.position.z,
        -ARENA_HALF_SIZE,
        ARENA_HALF_SIZE,
      );
    }
    // Avatar facing tracks movement only above the stick-release threshold
    // (shared IDLE_RECENTER_MOVE_MAX from config: facing is static at/below
    // MAX, which is exactly where released-stick camera paths hold — the
    // follow gate needs |move| >= IDLE_FOLLOW_MOVE_MIN, so a released stick
    // moves neither writer). Post-shot
    // body turn (owner fix round 2): when the stick is released and a turn is
    // armed, the SAME rotation.y eases toward the shot facing instead — same
    // shortest-arc exp pattern, scalar only, no allocations. Resumed movement
    // cancels the turn outright (the movement writer owns yaw then), so the
    // two writers never fight. Camera needs no suppression: the follow reads
    // getAvatarFacing() live and converges behind the shot dir as the body
    // settles (~0.25s).
    const releaseLenSq = IDLE_RECENTER_MOVE_MAX * IDLE_RECENTER_MOVE_MAX;
    if (worldMove.lengthSq() > releaseLenSq) {
      const targetYaw = Math.atan2(worldMove.x, worldMove.z);
      this.avatar.rotation.y = targetYaw;
      this.shotTurnActive = false;
    } else if (this.shotTurnActive) {
      const stepped = stepShotBodyTurnYaw(this.avatar.rotation.y, this.shotTurnTarget, deltaSeconds);
      if (isShotBodyTurnDone(stepped, this.shotTurnTarget)) {
        this.avatar.rotation.y = this.shotTurnTarget;
        this.shotTurnActive = false;
      } else {
        this.avatar.rotation.y = stepped;
      }
    }

    this.powerState.update(deltaSeconds);

    if (this.avatarMaterial !== null) {
      this.flash.update(deltaSeconds, this.avatarMaterial);
    }
    this.powerEffects?.setActive(this.powerState.hasShield(), this.powerState.isSpeedActive());
    this.particles.update(deltaSeconds);
    this.updateCombat(deltaSeconds);
    // South Park hop: displacement speed eases the rig bounce (0 standing
    // still). The rig is a CHILD of the tracked root, so the follow camera
    // keeps following the true body position while only the visual hops.
    // Airborne (trampoline/platform flight) swaps the bounce for a gentle
    // forward-lean glide — no hopping mid-air. No allocations: one scratch
    // vector + scalar math.
    if (this.avatarRig !== null && this.avatar !== null) {
      const movedX = this.avatar.position.x - this.hopPrev.x;
      const movedZ = this.avatar.position.z - this.hopPrev.z;
      const speed01 = deltaSeconds > 0
        ? Math.min(1, Math.hypot(movedX, movedZ) / (deltaSeconds * MOVE_SPEED))
        : 0;
      // Only deliberate grounded running produces the speed wake. Sliding
      // or recoil without movement input must not make an idle buff look active.
      const running = !this.airborneGate.isAirborne && worldMove.lengthSq() > releaseLenSq;
      this.powerEffects?.setRunning(running ? speed01 : 0);
      updateHopVisual(this.avatarRig, 0, speed01, this.hop, deltaSeconds, this.airborneGate.isAirborne);
      // Stage 5 audio footstep tick: one event per hop-boundary crossing
      // (updateHopVisual advances lastHop once per bounce, ~2-4 Hz at full
      // tilt) while grounded and actually moving. Mid-air crossings only
      // re-arm the index so landing never replays a stale boundary.
      if (this.hop.lastHop !== this.lastFootstepHop) {
        this.lastFootstepHop = this.hop.lastHop;
        if (!this.airborneGate.isAirborne && speed01 > FOOTSTEP_MIN_SPEED01) {
          this.events.push({ type: "footstep" });
        }
      }
      this.hopPrev.set(this.avatar.position.x, this.avatar.position.y, this.avatar.position.z);
    }
    this.updateCameraTransform(deltaSeconds);
  }

  // Per-frame combat tick: held-ball charge glow/swell + throw/reload anims,
  // pooled balls from the latest snapshot array, SUPER core from
  // snapshot.super (null hides). PixelRatio clamp, follow cam and spectator
  // hover live elsewhere and are intentionally untouched here.
  private updateCombat(deltaSeconds: number): void {
    this.arena.update(deltaSeconds);
    this.pickups.update(deltaSeconds);
    this.powerEffects?.update(deltaSeconds);
    if (this.avatarVisuals !== null) {
      this.avatarVisuals.ball.setCharge01(this.charge01);
      this.avatarVisuals.update(deltaSeconds);
    }
    // Full-charge sparks: hot embers drip from the muzzle while charge >= 0.8.
    if (!this.spectating && this.charge01 >= 0.8 && this.avatar !== null && deltaSeconds > 0) {
      this.sparkTimer += deltaSeconds;
      const interval = 0.09;
      while (this.sparkTimer >= interval) {
        this.sparkTimer -= interval;
        const muzzle = this.muzzlePosition();
        this.particles.spawn(muzzle.x, muzzle.y, muzzle.z, 2, new THREE.Color(ACCENT_SPARK), 1.5, 1.5);
      }
    } else {
      this.sparkTimer = 0;
    }
    if (this.ballsPool !== null) {
      this.ballsPool.render(this.latestBalls);
      this.ballsPool.update(deltaSeconds);
    }
    if (this.superCore !== null) {
      const snapshot = this.latestSuper;
      if (snapshot === null || snapshot === undefined) {
        this.superCore.render(null, Date.now());
      } else {
        this.superCore.render(snapshot, Date.now());
      }
      this.superCore.update(deltaSeconds);
    }
    // Fireflies drift in play and spectate only after the final-minute
    // lighting gate. The hidden swarm skips its matrix update entirely.
    this.fireflies?.update(deltaSeconds, this.camera);
  }

  private updatePhysics(deltaSeconds: number, worldMove: THREE.Vector3): void {
    const physics = this.physics;
    const avatar = this.avatar;
    if (physics === null || avatar === null) {
      return;
    }
    // Swamp uses direct low-speed control without momentum. Ice uses a
    // reduced target with low-grip steering, so it keeps a short glide.
    const preStep = physics.getPlayerPosition();
    const current = physics.getPlayerVelocity();
    const touchingFloor = preStep.y <= SURFACE_MAX_BODY_Y && Math.abs(current.y) < AIRBORNE_VY_THRESHOLD;
    const onSwamp = touchingFloor && isOnSwamp(preStep.x, preStep.z);
    const onIce = touchingFloor && isOnIce(preStep.x, preStep.z);
    physics.setSlippery(onIce);
    // Charging halves the move target (CHARGE_MOVE_MULT, server mirror): the
    // server simulates charging fighters at half speed, so unscaled client
    // prediction diverged ~2.25 m/s during charge+walk and reconcile tugged
    // the preview origin every frame (bug C jitter source).
    const chargeMult = this.charging ? CHARGE_MOVE_MULT : 1;
    const surfaceMult = onSwamp ? SWAMP_SPEED_MULT : onIce ? ICE_SPEED_MULT : 1;
    const speed = MOVE_SPEED * chargeMult * this.powerState.getSpeedMultiplier() * surfaceMult;
    const iceInputActive = worldMove.lengthSq() >= ICE_INPUT_THRESHOLD * ICE_INPUT_THRESHOLD;
    const targetX = onIce && !iceInputActive ? 0 : worldMove.x * speed;
    const targetZ = onIce && !iceInputActive ? 0 : worldMove.z * speed;
    if (onSwamp) {
      physics.setPlayerVelocity(targetX, current.y, targetZ);
    } else {
      let deltaX = targetX - current.x;
      let deltaZ = targetZ - current.z;
      const iceAccel = iceInputActive ? PLAYER_ICE_ACCEL : PLAYER_ICE_COAST_ACCEL;
      const maxDelta = (onIce ? iceAccel : PLAYER_GROUND_ACCEL) * deltaSeconds;
      const deltaLength = Math.hypot(deltaX, deltaZ);
      if (deltaLength > maxDelta && deltaLength > 0) {
        const scale = maxDelta / deltaLength;
        deltaX *= scale;
        deltaZ *= scale;
      }
      physics.setPlayerVelocity(current.x + deltaX, current.y, current.z + deltaZ);
    }
    physics.step(deltaSeconds);
    const position = physics.getPlayerPosition();
    avatar.position.set(position.x, position.y, position.z);
    // Flight gate for the hop rig: post-step vertical speed past the
    // threshold means trampoline launch / platform drop (glide, no bounce).
    // Trampoline vy=12 trips it immediately; grounded rest stays ~0; ramp
    // climbs (~1.1) never reach the 2.0 entry level.
    this.airborneGate.update(Math.abs(physics.getPlayerVelocity().y), deltaSeconds);

    this.trampolineCooldown = Math.max(0, this.trampolineCooldown - deltaSeconds);
    const pad = getTrampolineAt(position.x, position.z);
    if (pad !== null && position.y < TRAMPOLINE_TRIGGER_Y && this.trampolineCooldown <= 0) {
      this.trampolineCooldown = TRAMPOLINE_COOLDOWN_S;
      physics.launchTrampoline();
      this.particles.spawn(position.x, 0.5, position.z, PARTICLE_BURST_COUNT, new THREE.Color(HL_TRAMP_BURST));
      this.shake.add(0.35);
      this.events.push({ type: "trampoline" });
    }

  }

  // Server-selected pickups and effect durations are replicated to every
  // viewer. The client predicts speed only while the mirrored effect is live;
  // no local proximity check can grant a bonus independently of the server.
  public syncPowerUps(
    player: NetPlayerSnapshot | null,
    serverNow: number,
    pickups: readonly NetPickupSnapshot[],
  ): void {
    this.pickups.sync(pickups);
    if (player === null || !player.alive || player.spectator || !player.ready) {
      this.powerState.reset();
    } else {
      this.powerState.sync(player, serverNow);
    }
    this.powerEffects?.setActive(this.powerState.hasShield(), this.powerState.isSpeedActive());
  }

  public hasChargeBoost(): boolean {
    return this.powerState.hasChargeBoost();
  }

  public getPowerUpHudState(): Readonly<typeof this.powerHudState> {
    this.powerHudState.shieldHp = this.powerState.getShieldHp();
    this.powerHudState.shieldRemaining = this.powerState.getShieldRemaining();
    this.powerHudState.speedRemaining = this.powerState.getSpeedRemaining();
    this.powerHudState.chargeRemaining = this.powerState.getChargeRemaining();
    return this.powerHudState;
  }

  // Test/debug helpers (no gameplay use): seed and read the physics body
  // state so sliding/impulse regression tests can drive update() headless.
  public getPlayerVelocity(): Vector3Like | null {
    return this.physics?.getPlayerVelocity() ?? null;
  }

  public debugSetPlayerState(position: Vector3Like, velocity: Vector3Like): void {
    if (this.physics === null || this.avatar === null) {
      return;
    }
    this.physics.reset(position);
    this.physics.setPlayerVelocity(velocity.x, velocity.y, velocity.z);
    this.avatar.position.set(position.x, position.y, position.z);
  }

  // Test-scene visual hit (H key); real shield absorption is server-side.
  public applyTestHit(): boolean {
    this.flash.trigger();
    this.shake.add(0.45);
    this.burstAtAvatar(new THREE.Color(ACCENT_HIT_BURST), PARTICLE_BURST_COUNT);
    return false;
  }

  public drainEvents(): ArenaEvent[] {
    return this.events.splice(0, this.events.length);
  }

  public showBonusPickup(kind: PowerEffectKind): void {
    this.powerEffects?.showPickup(kind);
  }

  public getAvatarPosition(): THREE.Vector3 {
    if (this.avatar === null) {
      return new THREE.Vector3();
    }
    return this.avatar.position.clone();
  }

  // Hop reset (respawn/teleport/spectate/reset): exact identity transform +
  // zeroed state, so no residual bounce leaks into the next life.
  private resetHop(): void {
    resetHopState(this.hop);
    this.lastFootstepHop = -1;
    if (this.avatarRig !== null) {
      resetHopVisual(this.avatarRig, 0);
    }
    this.powerEffects?.setRunning(0);
  }

  // Spawn/teleport the local avatar + Rapier body to the authoritative
  // server position (welcome spawn, respawn, large-divergence snap). Zeroes
  // velocity via physics.reset, keeps the body facing the server default.
  // The optional y pins the body height (UP-snap onto a block top); it
  // defaults to ground spawn height for spawns/respawns.
  public teleportSelf(x: number, z: number, y: number = SELF_SPAWN_Y): void {
    if (!this.built || this.avatar === null) {
      return;
    }
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      return;
    }
    const snapY = Number.isFinite(y) ? y : SELF_SPAWN_Y;
    this.avatar.position.set(x, snapY, z);
    this.avatar.rotation.y = 0;
    // Authoritative placement (spawn/respawn/snap) invalidates any pending
    // post-shot turn target — a fresh facing starts here.
    this.shotTurnActive = false;
    this.resetHop();
    this.hopPrev.set(x, snapY, z);
    // A teleport zeroes body velocity (physics.reset) — never airborne.
    this.airborneGate.reset();
    // Authoritative placement invalidates the stall window (the jump is not
    // travel) and clears the big-div hold (fresh agreement by construction):
    // reseed the window anchors on the landing spot (slots hold anchor
    // positions, not empty zeroes) with zero observed frames.
    this.resetStallWindow(x, z);
    this.bigDivHoldS = 0;
    // A teleport is authoritative placement (spawn/respawn/snap) — any
    // pending recoil grace is stale, clear it so corrections resume.
    this.recoilGraceLeftS = 0;
    if (this.physics !== null) {
      this.physics.reset({ x, y: snapY, z });
    }
  }

  // Stall-window reset (authoritative placement): the teleport jump is not
  // travel, so every anchor reseeds on the landing spot with zero observed
  // frames — a fresh window carries no stall evidence until STALL_MIN_FRAMES
  // frames feed it. Called from teleportSelf, which every snap/spawn/respawn
  // path funnels through.
  private resetStallWindow(x: number, z: number): void {
    for (let i = 0; i < this.stallAnchorX.length; i += 1) {
      this.stallAnchorX[i] = x;
    }
    for (let i = 0; i < this.stallAnchorZ.length; i += 1) {
      this.stallAnchorZ[i] = z;
    }
    this.stallSlotIndex = 0;
    this.stallSlotTimeS = 0;
    this.stallWindowFrames = 0;
    this.stallSeeded = true;
  }

  // Stall-window tracking (tower-top snap-loop fix): feeds this frame's avatar
  // XZ into the anchor ring and returns the NET DISPLACEMENT from the oldest
  // slot's anchor to the current XZ — the avatar's start-to-current travel
  // over the last STALL_WINDOW_S. Math: SLOTS slots x WINDOW_S/SLOTS s each;
  // per call the slot timer advances by dt and the slot rotates once its share
  // elapses, anchoring the new slot on the current position, so the oldest
  // anchor always trails by ~one window. First call only seeds every anchor
  // on the avatar (zero displacement, zero frames — no stall evidence yet).
  // Scalar writes into the preallocated rings — zero allocs.
  private trackStallWindow(x: number, z: number, deltaSeconds: number): number {
    const slotCount = this.stallAnchorX.length;
    if (slotCount <= 0) {
      return 0;
    }
    if (!this.stallSeeded) {
      this.resetStallWindow(x, z);
    }
    // The seeding call observes this frame too (it saw the landing spot), so
    // the count starts at 1 — the 5th tracked frame already carries evidence.
    this.stallWindowFrames += 1;
    this.stallSlotTimeS += deltaSeconds;
    const slotShareS = SELF_RECONCILE_STALL_WINDOW_S / slotCount;
    while (this.stallSlotTimeS >= slotShareS && slotShareS > 0) {
      this.stallSlotTimeS -= slotShareS;
      this.stallSlotIndex = (this.stallSlotIndex + 1) % slotCount;
      this.stallAnchorX[this.stallSlotIndex] = x;
      this.stallAnchorZ[this.stallSlotIndex] = z;
    }
    const oldest = (this.stallSlotIndex + 1) % slotCount;
    const anchorX = this.stallAnchorX[oldest] ?? x;
    const anchorZ = this.stallAnchorZ[oldest] ?? z;
    return Math.hypot(x - anchorX, z - anchorZ);
  }

  // Gentle self reconciliation toward the server snapshot (XZ only, no
  // alloc): under SELF_RECONCILE_MIN_M stays local (no jitter during normal
  // play), within (MIN, SNAP] lerps avatar + body at SELF_RECONCILE_RATE,
  // beyond SNAP teleports (now to the authoritative Y, not always ground).
  // Returns what happened (for tests/telemetry).
  // Recoil grace: for RECOIL_RECONCILE_GRACE_S after a local kick the
  // correction is skipped (prediction-only kick, server re-applies it) so
  // reconcile never fights the kick and double-tugs the avatar.
  // Stall-snap (bug round 7 stall detector + tower-top snap-loop fix — the
  // round 6/6b/6c Y-threshold + speed-gate UP-snap it replaces was proven dead
  // by live F3 telemetry: healthy Rapier rest sits EXACTLY 0.100 below the
  // server nominal and the resting lip-wedge sits there too, so Y-divergence
  // alone can never tell them apart). The local Rapier body has no auto-step,
  // so a few cm of Y-divergence wedge it against the side lip forever
  // (XZ-only reconcile can never heal it: the edge walk-back invisible wall).
  // The discriminator is STALL EVIDENCE — ALL must hold: not airborne,
  // cooldown == 0, serverY within TOP_TOL of a support top, client XZ in that
  // top's expanded footprint, server XZ on that top's STRICT footprint (a
  // ring-only server XZ is REFUSED as "server-off-top": the server's
  // hysteresis keeps top level where the local collider top does not exist,
  // and it is about to drop anyway), divergence inside [STALL_MIN_DIV,
  // UP_SNAP_MAX_DIV] (the upper bound keeps grounded post-fall desyncs out of
  // the UP path — big-div owns those), input |move| >= STALL_INPUT_MIN (fed
  // by the caller via moveMag — reconcile runs before physics, so the live
  // stick magnitude comes in as a parameter), the window observed for >=
  // STALL_MIN_FRAMES frames (fresh/hitched windows carry no evidence), and XZ
  // net displacement over the last STALL_WINDOW_S < STALL_MIN_PROGRESS_M
  // (zero-alloc anchor ring, see trackStallWindow).
  // Action: teleport to (serverX clamped axis-wise just inside the strict
  // lip, serverZ likewise, serverY - REST_OFFSET) — true Rapier rest on the
  // physical top, no post-snap drop — arm the cooldown, count the snap, and
  // HOLD the top (bug round 9: exactly one up-snap per visit — further snaps
  // onto the same top note "snap-rate" until the avatar leaves its expanded
  // footprint or goes airborne; a teleport lands outside the footprint, so the
  // hold clears on the next live reconcile — teleportSelf never touches it).
  // Healthy rest never fires (no input), normal walking never fires (net
  // displacement progresses — hitch-proof: jitter is not travel), descents /
  // step-offs never fire (XZ progresses — no speed gate needed), ground walls
  // never fire (serverY matches no top).
  // Bug round 9 follow-ups: the div band widened to [0.03, 0.45] (ramp-crest
  // wedges add slope height on top of the rest offset and diverge ~0.204 —
  // the old 0.2 bound dead-zoned them), and both the display pre-scan and the
  // snap loop prefer the level-matching top the SERVER strictly stands on
  // (a same-nominal first match like P3 no longer shadows the true top).
  // Big-div heal (bug round 7): a sustained |serverY - localY| >= BIG_DIV
  // while NOT airborne (hold timer BIG_DIV_HOLD_S, reset on agreement /
  // airborne / teleport) teleports to the FULL server pose — the down-pull
  // the frozen -2.1 desync state never had. Scalar loop over the cached
  // support list; no velocity reads, no per-frame allocs anywhere.
  public reconcileSelf(
    serverX: number,
    serverY: number,
    serverZ: number,
    deltaSeconds: number,
    moveMag = 0,
  ): "ok" | "lerp" | "snap" | "skipped" {
    // F3 telemetry: per-call reset of the reused object (scalar writes only,
    // no allocation). Gameplay below is untouched — every write here is
    // observation of values the gates already compute.
    const t = this.reconcileTelemetry;
    t.result = "skipped";
    t.snapKind = "none";
    t.serverX = serverX;
    t.serverY = serverY;
    t.serverZ = serverZ;
    t.localY = Number.NaN;
    t.divergence = Number.NaN;
    t.divOk = false;
    t.moveMag = moveMag;
    t.inputOk = moveMag >= SELF_RECONCILE_STALL_INPUT_MIN;
    t.stallProgressM = 0;
    t.stallOk = false;
    t.stallFrames = 0;
    t.stallFramesOk = false;
    t.bigDivHoldS = this.bigDivHoldS;
    t.airborne = this.airborneGate.isAirborne;
    t.cooldownLeftS = this.upSnapCooldownLeftS;
    t.levelTopIndex = -1;
    t.levelTopY = Number.NaN;
    t.heldTopIndex = this.heldTopIndex;
    t.evalTopIndex = -1;
    t.xzOk = false;
    t.srvXzOnTop = false;
    t.blockCenterX = Number.NaN;
    t.blockCenterZ = Number.NaN;
    t.blockDist = -1;
    t.xzDist = -1;
    t.xzBand = "none";
    t.note = "";
    if (!this.built || this.avatar === null || this.spectating) {
      t.note = !this.built ? "not-built" : this.avatar === null ? "no-avatar" : "spectating";
      return "skipped";
    }
    if (
      !Number.isFinite(serverX) ||
      !Number.isFinite(serverZ) ||
      !(deltaSeconds > 0)
    ) {
      t.note = "bad-input";
      return "skipped";
    }
    if (this.recoilGraceLeftS > 0) {
      this.recoilGraceLeftS = Math.max(0, this.recoilGraceLeftS - deltaSeconds);
      t.note = "recoil-grace";
      return "skipped";
    }
    if (this.upSnapCooldownLeftS > 0) {
      this.upSnapCooldownLeftS = Math.max(0, this.upSnapCooldownLeftS - deltaSeconds);
    }
    t.cooldownLeftS = this.upSnapCooldownLeftS;
    // Per-top hold re-arm (bug round 9): while a top is held, every live frame
    // compares the CURRENT client XZ against that top's expanded footprint —
    // outside for >= 1 frame re-arms (leave-and-re-enter heals again), as does
    // an airborne frame (a trampoline launch or a fall starts a fresh visit).
    // Runs before the cooldown gate so leaving mid-cooldown still re-arms for
    // the frames after it. Scalar reads, zero allocs.
    if (this.heldTopIndex >= 0) {
      const held = this.supportTops[this.heldTopIndex];
      const outside =
        held === undefined ||
        this.airborneGate.isAirborne ||
        Math.abs(this.avatar.position.x - held.x) > held.hx + AVATAR_BODY_RADIUS ||
        Math.abs(this.avatar.position.z - held.z) > held.hz + AVATAR_BODY_RADIUS;
      if (outside) {
        this.heldTopIndex = -1;
      }
    }
    t.heldTopIndex = this.heldTopIndex;
    t.localY = this.avatar.position.y;
    // Stall-window tracking runs on every live frame (before any gate): the
    // anchor ring always reflects the last STALL_WINDOW_S of motion, scored
    // as net displacement (start-to-current, hitch-proof).
    t.stallProgressM = this.trackStallWindow(
      this.avatar.position.x,
      this.avatar.position.z,
      deltaSeconds,
    );
    t.stallOk = t.stallProgressM < SELF_RECONCILE_STALL_MIN_PROGRESS_M;
    t.stallFrames = this.stallWindowFrames;
    t.stallFramesOk = this.stallWindowFrames >= SELF_RECONCILE_STALL_MIN_FRAMES;
    const serverYFinite = Number.isFinite(serverY);
    // Observation pre-scan (diagnostic only): the support-top candidate for
    // the F3 "G top" line — the strict-server top first, then an
    // expanded-footprint top (a server climbing a ramp slope sits inside no
    // strict box but still belongs to THAT figure), then the first level
    // match. Scalar indices over the cached list, zero allocs.
    if (serverYFinite) {
      t.divergence = serverY - t.localY;
      t.divOk =
        t.divergence >= SELF_RECONCILE_STALL_MIN_DIV &&
        t.divergence <= SELF_RECONCILE_UP_SNAP_MAX_DIV;
      let firstMatch = -1;
      let expandedMatch = -1;
      let strictMatch = -1;
      for (let i = 0; i < this.supportTops.length; i += 1) {
        const scanned = this.supportTops[i];
        if (scanned !== undefined && Math.abs(serverY - scanned.levelY) <= SELF_RECONCILE_TOP_TOL) {
          if (firstMatch < 0) {
            firstMatch = i;
          }
          const strictIn =
            Math.abs(serverX - scanned.x) <= scanned.hx &&
            Math.abs(serverZ - scanned.z) <= scanned.hz;
          if (strictIn) {
            if (strictMatch < 0) {
              strictMatch = i;
            }
          } else if (expandedMatch < 0) {
            const expandedIn =
              Math.abs(serverX - scanned.x) <= scanned.hx + AVATAR_BODY_RADIUS &&
              Math.abs(serverZ - scanned.z) <= scanned.hz + AVATAR_BODY_RADIUS;
            if (expandedIn) {
              expandedMatch = i;
            }
          }
        }
      }
      let chosen = firstMatch;
      if (strictMatch >= 0) {
        chosen = strictMatch;
      } else if (expandedMatch >= 0) {
        chosen = expandedMatch;
      }
      if (chosen >= 0) {
        const picked = this.supportTops[chosen];
        if (picked !== undefined) {
          t.levelTopIndex = chosen;
          t.levelTopY = picked.levelY;
        }
      }
      // Big-div hold timer: accumulate only while NOT airborne and the gap
      // is at least BIG_DIV either way; any agreement, airborne frame, or
      // teleport (which zeroes it directly) restarts the hold from zero.
      if (!this.airborneGate.isAirborne && Math.abs(t.divergence) >= SELF_RECONCILE_BIG_DIV) {
        this.bigDivHoldS += deltaSeconds;
      } else {
        this.bigDivHoldS = 0;
      }
      t.bigDivHoldS = this.bigDivHoldS;
    }
    if (
      serverYFinite &&
      !this.airborneGate.isAirborne &&
      !(this.upSnapCooldownLeftS > 0)
    ) {
      // t.divOk / t.inputOk / t.stallOk / t.stallFramesOk were computed above
      // (divergence band, caller-fed input, live stall window, observed
      // frames); the loop only adds the top-level + footprint match.
      if (t.divOk && t.inputOk && t.stallOk && t.stallFramesOk) {
        let serverOffTop = false;
        // Per-top suppression record: a fully qualifying top skipped because
        // this visit already healed it (bug round 9). -1 when none.
        let heldMatch = -1;
        // Last strict-server top seen (for off-block telemetry below).
        let strictSeen = -1;
        // Pass 1 — strict-server preference (bug round 9): level-matching tops
        // whose STRICT footprint contains the server XZ, in list order. Only a
        // strict-server top can ever snap (a ring-only snapshot is refused —
        // the local collider top does not exist there), so this pass owns
        // every snap; pass 2 only fills ring/off-block telemetry. The snap
        // predicate is unchanged from the single-loop shape, so outcomes match
        // — the preference governs which candidate fires and what F3 names.
        for (let i = 0; i < this.supportTops.length; i += 1) {
          const top = this.supportTops[i];
          if (top === undefined || Math.abs(serverY - top.levelY) > SELF_RECONCILE_TOP_TOL) {
            continue;
          }
          if (Math.abs(serverX - top.x) > top.hx || Math.abs(serverZ - top.z) > top.hz) {
            continue;
          }
          strictSeen = i;
          t.evalTopIndex = i;
          t.blockCenterX = top.x;
          t.blockCenterZ = top.z;
          t.blockDist = Math.hypot(this.avatar.position.x - top.x, this.avatar.position.z - top.z);
          const inX = Math.abs(this.avatar.position.x - top.x) <= top.hx + AVATAR_BODY_RADIUS;
          const inZ = Math.abs(this.avatar.position.z - top.z) <= top.hz + AVATAR_BODY_RADIUS;
          t.xzOk = inX && inZ;
          // Server XZ is strict by pass construction (see the gate above).
          t.srvXzOnTop = true;
          if (inX && inZ) {
            if (i === this.heldTopIndex) {
              // Lip-grind loop: this visit already healed onto T — suppress
              // (note "snap-rate" below), keep scanning in case a different
              // strict top qualifies.
              heldMatch = i;
              continue;
            }
            const firedProgressM = t.stallProgressM;
            // Clamp axis-wise a hair inside the strict lip: even an on-top
            // snapshot at the exact collider edge lands supported, and this
            // IS the walk-back target (BUG2 preserved). Scalar math, no alloc.
            const snapX = Math.min(
              Math.max(serverX, top.x - top.hx + SELF_RECONCILE_SNAP_XZ_INSET),
              top.x + top.hx - SELF_RECONCILE_SNAP_XZ_INSET,
            );
            const snapZ = Math.min(
              Math.max(serverZ, top.z - top.hz + SELF_RECONCILE_SNAP_XZ_INSET),
              top.z + top.hz - SELF_RECONCILE_SNAP_XZ_INSET,
            );
            this.teleportSelf(snapX, snapZ, serverY - SELF_RECONCILE_REST_OFFSET);
            this.upSnapCooldownLeftS = SELF_RECONCILE_UP_SNAP_COOLDOWN_S;
            // The visit is healed — hold T until the avatar leaves it.
            this.heldTopIndex = i;
            t.heldTopIndex = i;
            t.cooldownLeftS = this.upSnapCooldownLeftS;
            t.stallProgressM = 0;
            t.bigDivHoldS = this.bigDivHoldS;
            t.result = "snap";
            t.snapKind = "up";
            t.upSnapCount += 1;
            t.lastUpSnapAtMs = Date.now();
            t.note = "up-snap";
            console.log(
              `[up-snap] #${t.upSnapCount} top#${i} (${top.x},${top.z}) ` +
                `levelY=${top.levelY.toFixed(2)} div=${t.divergence.toFixed(3)} ` +
                `prog=${firedProgressM.toFixed(3)} move=${moveMag.toFixed(2)}`,
            );
            return "snap";
          }
        }
        // Pass 2 — fallback in list order: level-matching tops the server does
        // NOT strictly stand on. Ring snapshots with the client in the
        // expanded footprint refuse as "server-off-top" (the server is about
        // to drop anyway; the big-div heal owns that case) — refusing beats
        // landing over the void, falling, grinding, and resnapping.
        for (let i = 0; i < this.supportTops.length; i += 1) {
          const top = this.supportTops[i];
          if (top === undefined || Math.abs(serverY - top.levelY) > SELF_RECONCILE_TOP_TOL) {
            continue;
          }
          if (
            Math.abs(serverX - top.x) <= top.hx &&
            Math.abs(serverZ - top.z) <= top.hz
          ) {
            continue; // Evaluated in pass 1.
          }
          t.evalTopIndex = i;
          t.blockCenterX = top.x;
          t.blockCenterZ = top.z;
          t.blockDist = Math.hypot(this.avatar.position.x - top.x, this.avatar.position.z - top.z);
          const inX = Math.abs(this.avatar.position.x - top.x) <= top.hx + AVATAR_BODY_RADIUS;
          const inZ = Math.abs(this.avatar.position.z - top.z) <= top.hz + AVATAR_BODY_RADIUS;
          t.xzOk = inX && inZ;
          t.srvXzOnTop = false;
          if (inX && inZ) {
            serverOffTop = true;
          }
        }
        if (heldMatch >= 0) {
          // Re-point the telemetry at the suppressed top so F3 names what was
          // held (pass 2 may have evaluated other tops after it).
          const held = this.supportTops[heldMatch];
          if (held !== undefined) {
            t.evalTopIndex = heldMatch;
            t.blockCenterX = held.x;
            t.blockCenterZ = held.z;
            t.blockDist = Math.hypot(this.avatar.position.x - held.x, this.avatar.position.z - held.z);
            t.xzOk = true;
            t.srvXzOnTop = true;
          }
          t.note = "snap-rate";
        } else if (t.evalTopIndex < 0) {
          t.note = "no-level-match";
        } else if (serverOffTop) {
          t.note = "server-off-top";
        } else if (!t.xzOk) {
          // Name the server's top when it strictly stands on one (the client
          // is simply elsewhere) — more informative than the last fallback
          // top pass 2 happened to evaluate.
          if (strictSeen >= 0) {
            const seen = this.supportTops[strictSeen];
            if (seen !== undefined) {
              t.evalTopIndex = strictSeen;
              t.blockCenterX = seen.x;
              t.blockCenterZ = seen.z;
              t.blockDist = Math.hypot(this.avatar.position.x - seen.x, this.avatar.position.z - seen.z);
              t.xzOk = false;
              t.srvXzOnTop = true;
            }
          }
          t.note = "off-block";
        }
      } else if (!t.divOk) {
        t.note = "no-stall-div";
      } else if (!t.inputOk) {
        t.note = "no-input";
      } else if (!t.stallFramesOk) {
        t.note = "stall-warming";
      } else {
        t.note = "no-progress";
      }
      // Big-div heal (downward-desync last resort): sustained large gap while
      // grounded — e.g. the server walked off the footprint and fell while
      // the client stayed on top. Full server pose, own counter, own log.
      // Checked independently of the stall gates above (different trigger).
      // When the server still reports a top level AND its XZ sits in that
      // top's expanded footprint, the XZ target clamps just inside the
      // strict lip (same inset as the up-snap — a ring XZ would land over
      // the void and re-desync); otherwise the full pose stands (ground
      // levels match no top, and the heal is the only way home, so refusing
      // is worse than landing where the server stands). The footprint test
      // picks the top the server actually stands on — clamping to the first
      // level-matching top in list order would yank the body across the map
      // (e.g. a far platform sharing the same nominal level).
      if (this.bigDivHoldS >= SELF_RECONCILE_BIG_DIV_HOLD_S) {
        let healX = serverX;
        let healZ = serverZ;
        for (let i = 0; i < this.supportTops.length; i += 1) {
          const top = this.supportTops[i];
          if (top === undefined || Math.abs(serverY - top.levelY) > SELF_RECONCILE_TOP_TOL) {
            continue;
          }
          if (
            Math.abs(serverX - top.x) > top.hx + AVATAR_BODY_RADIUS ||
            Math.abs(serverZ - top.z) > top.hz + AVATAR_BODY_RADIUS
          ) {
            continue;
          }
          healX = Math.min(
            Math.max(serverX, top.x - top.hx + SELF_RECONCILE_SNAP_XZ_INSET),
            top.x + top.hx - SELF_RECONCILE_SNAP_XZ_INSET,
          );
          healZ = Math.min(
            Math.max(serverZ, top.z - top.hz + SELF_RECONCILE_SNAP_XZ_INSET),
            top.z + top.hz - SELF_RECONCILE_SNAP_XZ_INSET,
          );
          break;
        }
        this.teleportSelf(healX, healZ, serverY);
        this.upSnapCooldownLeftS = SELF_RECONCILE_UP_SNAP_COOLDOWN_S;
        t.cooldownLeftS = this.upSnapCooldownLeftS;
        t.stallProgressM = 0;
        t.bigDivHoldS = this.bigDivHoldS;
        t.result = "snap";
        t.snapKind = "big";
        t.bigHealCount += 1;
        t.lastBigHealAtMs = Date.now();
        t.note = "big-heal";
        console.log(
          `[big-heal] #${t.bigHealCount} div=${t.divergence.toFixed(3)} ` +
            `hold=${SELF_RECONCILE_BIG_DIV_HOLD_S.toFixed(2)}s`,
        );
        return "snap";
      }
    } else if (!serverYFinite) {
      t.note = "bad-serverY";
    } else if (this.airborneGate.isAirborne) {
      t.note = "airborne";
    } else {
      t.note = "cooldown";
    }
    const dx = serverX - this.avatar.position.x;
    const dz = serverZ - this.avatar.position.z;
    const dist = Math.hypot(dx, dz);
    t.xzDist = dist;
    if (!(dist > SELF_RECONCILE_MIN_M)) {
      t.xzBand = "deadband";
      t.result = "ok";
      return "ok";
    }
    if (dist > SELF_RECONCILE_SNAP_M) {
      this.teleportSelf(serverX, serverZ, serverY);
      this.upSnapCooldownLeftS = SELF_RECONCILE_UP_SNAP_COOLDOWN_S;
      t.cooldownLeftS = this.upSnapCooldownLeftS;
      t.xzBand = "snap";
      t.result = "snap";
      t.snapKind = "far";
      t.note = "far-snap";
      return "snap";
    }
    const factor = 1 - Math.exp(-SELF_RECONCILE_RATE * deltaSeconds);
    const nextX = this.avatar.position.x + dx * factor;
    const nextZ = this.avatar.position.z + dz * factor;
    const nextY = this.avatar.position.y;
    this.avatar.position.set(nextX, nextY, nextZ);
    if (this.physics !== null) {
      const bodyPos = this.physics.getPlayerPosition();
      this.physics.setPlayerPosition(bodyPos.x + dx * factor, bodyPos.y, bodyPos.z + dz * factor);
    }
    t.xzBand = "lerp";
    t.result = "lerp";
    return "lerp";
  }

  // Current avatar facing (radians, world Y) for inputs-only upstream: the
  // server stores rotY per player so remotes render a plausible heading.
  public getAvatarFacing(): number {
    return this.avatar?.rotation.y ?? 0;
  }

  // Post-shot body turn arming (called from main.ts stopCharge on a REAL shot
  // only — never on cancel-without-shot): the body will ease toward facing
  // the shot direction (bodyFacingForShotYaw: shot yaw + PI, matching the
  // fire-payload/ball-dir convention). No-op on non-finite yaw or while
  // spectating (no body). If the player is already holding move, update()
  // cancels the turn on the next frame and the movement writer wins — the
  // call site additionally skips arming while deflected (belt and braces).
  public setShotTurnTarget(shotYaw: number): void {
    if (!Number.isFinite(shotYaw) || this.avatar === null || this.spectating) {
      return;
    }
    this.shotTurnTarget = bodyFacingForShotYaw(shotYaw);
    this.shotTurnActive = true;
  }

  // Turn cancel (charge restarts, cancels, camera-state transitions, death —
  // mirrors where main.ts resets idleTimerS). Scalar flag flip, no alloc.
  public cancelShotBodyTurn(): void {
    this.shotTurnActive = false;
  }

  // Turn state for tests/telemetry.
  public isShotBodyTurnActive(): boolean {
    return this.shotTurnActive;
  }

  // Fire feedback (hit attempt): flash + particles + light shake without
  // touching shield charges — authorititative damage stays server-side.
  public playFireFeedback(): void {
    this.flash.trigger();
    this.shake.add(0.2);
    this.burstAtAvatar(new THREE.Color(ACCENT_FIRE_BURST), 8);
  }

  public getCameraAngles(): { yaw: number; pitch: number } {
    return { yaw: this.yaw, pitch: this.pitch };
  }

  // Stored fire-direction feed for tests/telemetry (mirrors
  // debugGetCameraPosition): the clamped aim written by setAimAngles, i.e.
  // what recoil/spark/muzzle math actually reads — not the live camera.
  public debugGetAimAngles(): { yaw: number; pitch: number } {
    return { yaw: this.aimYaw, pitch: this.aimPitch };
  }

  // Floating-aim camera follow: while charging, the camera takes the live aim
  // yaw and the MIRRORED aim pitch (see mirrorChargeCameraPitch in
  // net/chargeAim.ts) every frame so one right thumb can turn 360 degrees
  // and aiming up drops the camera to look up the shot arc. The optional
  // min/max override exists ONLY for that mirrored charge path (asymmetric
  // band [MIRROR_PITCH_MIN, MIRROR_PITCH_MAX], since the plain MIN -0.41
  // would clip the mirror); every other caller uses the shared
  // [CAMERA_PITCH_MIN, CAMERA_PITCH_MAX] defaults. No alloc, scalar clamp.
  public setCameraAngles(yaw: number, pitch: number, min = CAMERA_PITCH_MIN, max = CAMERA_PITCH_MAX): void {
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) {
      return;
    }
    const lo = Number.isFinite(min) ? min : CAMERA_PITCH_MIN;
    const hi = Number.isFinite(max) ? max : CAMERA_PITCH_MAX;
    this.yaw = yaw;
    this.pitch = THREE.MathUtils.clamp(pitch, Math.min(lo, hi), Math.max(lo, hi));
  }

  public getShopfrontCount(): number {
    return getShopfrontTransforms().length;
  }

  public reset(): void {
    this.yaw = 0;
    this.pitch = CAMERA_REST_PITCH;
    this.trampolineCooldown = 0;
    this.events.length = 0;
    this.charge01 = 0;
    this.charging = false;
    this.chargeZoom01 = 0;
    this.shotTurnActive = false;
    this.shotTurnTarget = 0;
    this.cameraDistance = CAMERA_FOLLOW_DISTANCE;
    this.latestBalls = [];
    this.latestSuper = null;
    this.hasAim = false;
    this.sparkTimer = 0;
    this.aimYaw = 0;
    this.aimPitch = CAMERA_REST_PITCH;
    this.recoilGraceLeftS = 0;
    this.airborneGate.reset();
    this.cameraSmoothInit = false;
    this.smoothCamPos.set(0, 0, 0);
    this.smoothCamLook.set(0, 0, 0);
    // Glass rest state (Stage 4d.3): reset restores the glass opacity, never
    // opaque 1 — the walls are transparent by design.
    this.arena.setWallOpacity(WALL_GLASS_OPACITY);
    this.avatarVisuals?.reset();
    this.powerState.reset();
    this.powerEffects?.reset();
    this.pickups.reset();
    this.particles.clear();
    this.shake.reset();
    this.flash.reset();
    if (this.avatarMaterial !== null) {
      this.avatarMaterial.emissiveIntensity = 0;
    }
    // Stage 4d.2: a reset never leaves the avatar translucent or zoomed.
    this.setChargeTranslucent(false);
    if (this.physics !== null) {
      this.physics.reset({ x: 0, y: 1.1, z: 0 });
    }
    if (this.avatar !== null) {
      this.avatar.position.set(0, 1.1, 0);
      this.avatar.rotation.set(0, 0, 0);
      this.avatar.visible = !this.spectating;
    }
    this.resetHop();
    this.hopPrev.set(0, 1.1, 0);
    // The reset jumps the avatar home — the stall window's anchors belong to
    // the old spot, so reseed them (fresh window, no stall evidence). The
    // per-top hold belongs to the old visit too — clear it (fresh arm).
    this.resetStallWindow(0, 0);
    this.heldTopIndex = -1;
    if (this.built) {
      if (this.spectating) {
        this.updateSpectatorCamera(0);
      } else {
        this.updateCameraTransform(0);
      }
    }
  }

  public dispose(): void {
    if (this.avatarVisuals !== null) {
      // Detaches ball + face groups from the avatar and disposes the
      // per-handle ball material (shared geos stay module-alive).
      this.avatarVisuals.dispose();
      this.avatarVisuals = null;
    }
    this.powerEffects?.dispose();
    this.powerEffects = null;
    if (this.ballsPool !== null) {
      this.ballsPool.dispose();
      this.ballsPool = null;
    }
    if (this.superCore !== null) {
      this.superCore.dispose();
      this.superCore = null;
    }
    if (this.fireflies !== null) {
      this.fireflies.dispose();
      this.fireflies = null;
    }
    this.charge01 = 0;
    this.latestBalls = [];
    this.latestSuper = null;
    if (this.avatar !== null) {
      this.scene.remove(this.avatar);
      this.avatar = null;
    }
    this.avatarRig = null;
    this.avatarBody = null;
    this.avatarMaterial = null;
    this.scene.remove(this.pickups.object);
    this.scene.remove(this.particles.object);
    this.pickups.dispose();
    this.particles.dispose();
    this.arena.dispose(this.scene);
    this.ads.dispose(this.scene);
    if (this.physics !== null) {
      this.physics.dispose();
      this.physics = null;
    }
    for (const tracked of this.disposables) {
      tracked.dispose();
    }
    this.disposables.length = 0;
    // Remove lights/ground/grid leftovers by name-free sweep of known types.
    for (let i = this.scene.children.length - 1; i >= 0; i -= 1) {
      const child = this.scene.children[i];
      if (child !== undefined) {
        this.scene.remove(child);
      }
    }
    this.scene.fog = null;
    this.scene.background = null;
    this.sceneBackground = null;
    this.sceneFog = null;
    this.ambientLight = null;
    this.directionalLight = null;
    this.skyMaterial = null;
    this.sunDisc = null;
    this.clouds = null;
    this.moonDisc = null;
    this.starMaterial = null;
    this.nebulaMaterials.length = 0;
    this.nebulaBaseOpacities.length = 0;
    this.roundProgress = 0;
    this.skyProgress = ROUND_LIGHTING_DAY_SAMPLE_PROGRESS;
    this.built = false;
  }

  private burstAtAvatar(color: THREE.Color, count: number): void {
    if (this.avatar !== null) {
      this.particles.spawn(this.avatar.position.x, 1.2, this.avatar.position.z, count, color);
    }
  }

  // Day/night sky dressing (zero light cost): sun and moon on one orbit,
  // diffuse cloud patches in one batch, then the starfield. All sky materials
  // ignore fog so distant forms stay visible through the glass.
  private buildSky(scene: THREE.Scene): void {
    // One opaque background draw, before all arena and transparent sky
    // objects. World-up grading follows viewing elevation rather than the
    // screen, and centering on the active camera prevents translation parallax.
    const skyGeometry = new THREE.SphereGeometry(140, 20, 12);
    const skyMaterial = new THREE.ShaderMaterial({
      uniforms: {
        skyHorizon: { value: ROUND_DAY_LIGHTING.skyHorizon.clone() },
        skyZenith: { value: ROUND_DAY_LIGHTING.skyZenith.clone() },
      },
      vertexShader: `
        varying vec3 vSkyDirection;
        void main() {
          vSkyDirection = (modelMatrix * vec4(position, 0.0)).xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 skyHorizon;
        uniform vec3 skyZenith;
        varying vec3 vSkyDirection;
        void main() {
          float elevation = smoothstep(0.0, 0.85, normalize(vSkyDirection).y);
          gl_FragColor = vec4(mix(skyHorizon, skyZenith, elevation), 1.0);
          #include <colorspace_fragment>
        }
      `,
      side: THREE.BackSide, fog: false, depthWrite: false, depthTest: false, toneMapped: false,
    });
    const sky = new THREE.Mesh(skyGeometry, skyMaterial);
    sky.name = "sky-gradient";
    sky.renderOrder = -1000;
    sky.frustumCulled = false;
    sky.onBeforeRender = (_renderer, _scene, activeCamera): void => {
      activeCamera.getWorldPosition(sky.position);
      scene.worldToLocal(sky.position);
      sky.updateMatrixWorld(true);
    };
    scene.add(sky);
    this.disposables.push(skyGeometry, skyMaterial);
    this.skyMaterial = skyMaterial;

    const sunGeometry = new THREE.CircleGeometry(1.4, 20);
    const sunMaterial = new THREE.MeshBasicMaterial({
      color: SKY_SUN_DISC, fog: false, transparent: true, opacity: 0,
      depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true,
    });
    const sun = new THREE.Mesh(sunGeometry, sunMaterial);
    sun.name = "sun";
    scene.add(sun);
    this.disposables.push(sunGeometry, sunMaterial);
    this.sunDisc = sun;

    const cloudGeometry = new THREE.PlaneGeometry(1, 1);
    const cloudTexture = makeCloudTexture();
    const cloudMaterial = new THREE.MeshBasicMaterial({
      color: SKY_CLOUD_DAY, map: cloudTexture, fog: false, transparent: true, opacity: 0,
      depthWrite: false,
    });
    cloudMaterial.onBeforeCompile = (shader): void => {
      shader.vertexShader = `attribute vec2 cloudUvOffset;\n${shader.vertexShader}`;
      shader.vertexShader = shader.vertexShader.replace("#include <uv_vertex>",
        "#include <uv_vertex>\n vMapUv = vMapUv * 0.5 + cloudUvOffset;");
    };
    cloudMaterial.customProgramCacheKey = (): string => "cloud-atlas-v1";
    // Uneven loose groups leave different gaps around the sky. Atlas choice,
    // proportions and roll vary so the repeated planes do not read as a ring.
    // The single-sided instances remain one draw call, including on mobile.
    const cloudHints: ReadonlyArray<readonly [number, number, number, number, number, number, number]> = [
      [-9, 3.8, -45, 10.2, 5.1, -0.19, 0],
      [13, 8.7, -81, 14.3, 9.8, 0.25, 2],
      [3, 19.5, -58, 9.1, 7.2, -0.11, 1],
      [49, 10.6, -61, 13.4, 6.4, 0.09, 3],
      [63, 7.1, 2, 10.4, 7.5, -0.27, 1],
      [51, 22.7, 28, 15.7, 6.7, 0.34, 0],
      [-20, 8.4, 77, 12.1, 5.8, -0.16, 3],
      [-44, 18.5, 55, 10.7, 9.3, 0.17, 2],
      [-57, 5.9, -7, 12.8, 6.4, -0.32, 1],
      [-36, 33, -49, 11.5, 8.9, 0.26, 2],
    ];
    const clouds = new THREE.InstancedMesh(cloudGeometry, cloudMaterial, cloudHints.length);
    clouds.name = "day-clouds";
    clouds.frustumCulled = false;
    const cloudMatrix = new THREE.Matrix4();
    const cloudPosition = new THREE.Vector3();
    const cloudScale = new THREE.Vector3();
    const cloudFacing = new THREE.Object3D();
    const cloudUvOffsets = new Float32Array(cloudHints.length * 2);
    cloudHints.forEach(([x, y, z, width, height, angle, variant], index) => {
      cloudPosition.set(x, y, z);
      cloudFacing.position.copy(cloudPosition);
      cloudFacing.lookAt(SKY_DISC_TARGET);
      cloudFacing.rotateZ(angle);
      cloudMatrix.compose(cloudPosition, cloudFacing.quaternion, cloudScale.set(width, height, 1));
      clouds.setMatrixAt(index, cloudMatrix);
      cloudUvOffsets[index * 2] = (variant % 2) * 0.5;
      cloudUvOffsets[index * 2 + 1] = Math.floor(variant / 2) * 0.5;
    });
    cloudGeometry.setAttribute("cloudUvOffset", new THREE.InstancedBufferAttribute(cloudUvOffsets, 2));
    clouds.instanceMatrix.needsUpdate = true;
    scene.add(clouds);
    this.disposables.push(clouds, cloudGeometry, cloudMaterial, cloudTexture);
    this.clouds = clouds;

    const moonGeometry = new THREE.CircleGeometry(2.1, 32);
    const moonMaterial = new THREE.MeshBasicMaterial({
      color: NEUTRAL_MOON, fog: false, transparent: true, opacity: 0, depthWrite: false,
      side: THREE.DoubleSide, forceSinglePass: true,
    });
    const moon = new THREE.Mesh(moonGeometry, moonMaterial);
    moon.name = "moon";
    moon.position.set(skyArcX(0), skyArcY(0), skyArcZ(0));
    moon.lookAt(SKY_DISC_TARGET);
    scene.add(moon);
    this.disposables.push(moonGeometry, moonMaterial);
    this.moonDisc = moon;

    const starCount = 100;
    const positions = new Float32Array(starCount * 3);
    let seed = 1234567;
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < starCount; i += 1) {
      const angle = random() * Math.PI * 2;
      const radius = 55 + random() * 25;
      positions[i * 3] = Math.cos(angle) * radius;
      positions[i * 3 + 1] = 18 + random() * 45;
      positions[i * 3 + 2] = Math.sin(angle) * radius;
    }
    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const starMaterial = new THREE.PointsMaterial({
      color: NEUTRAL_WHITE,
      size: 0.35,
      sizeAttenuation: true,
      fog: false,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const stars = new THREE.Points(starGeometry, starMaterial);
    stars.name = "stars";
    stars.frustumCulled = false;
    scene.add(stars);
    this.disposables.push(starGeometry, starMaterial);
    this.starMaterial = starMaterial;

    // Stage 4d.3 nebulae: NEBULA_COUNT large low-alpha additive sprites
    // behind/above the glass walls (cheap space depth behind the stars —
    // visible THROUGH the transparent walls from inside the arena). One
    // shared 128px procedural canvas texture (tinted per-sprite via the
    // material color: dim violet / muted red / pale violet from the palette
    // — pink stays banned), static (no per-frame update), no lights.
    // Draw-call accounting: +NEBULA_COUNT sprites (each sprite = 1 draw
    // call); with the firefly InstancedMesh (+1) the stage adds exactly 4
    // draw calls (A6 budget <= 4). Materials + texture tracked in
    // disposables; the sprites themselves leave with the dispose() sweep.
    const nebulaTexture = makeNebulaTexture();
    this.disposables.push(nebulaTexture);
    const nebulaDefs: ReadonlyArray<{
      x: number;
      y: number;
      z: number;
      w: number;
      h: number;
      color: number;
      opacity: number;
    }> = [
      { x: -48, y: 26, z: -58, w: 52, h: 30, color: ACCENT_ICE_GLOW, opacity: 0.2 },
      { x: 52, y: 32, z: -28, w: 44, h: 26, color: ACCENT_OBSTACLE_TINT, opacity: 0.16 },
      { x: 2, y: 30, z: 62, w: 48, h: 28, color: ACCENT_SPARK, opacity: 0.18 },
    ];
    nebulaDefs.slice(0, NEBULA_COUNT).forEach((def, index) => {
      const material = new THREE.SpriteMaterial({
        map: nebulaTexture,
        color: def.color,
        transparent: true,
        opacity: def.opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      });
      const sprite = new THREE.Sprite(material);
      sprite.name = `nebula-${index}`;
      sprite.position.set(def.x, def.y, def.z);
      sprite.scale.set(def.w, def.h, 1);
      scene.add(sprite);
      this.disposables.push(material);
      this.nebulaMaterials.push(material);
      this.nebulaBaseOpacities.push(def.opacity);
    });
  }

  // Muzzle world position for full-charge sparks (bodyCenter XZ +
  // dir*offset, y = body y + torso offset so sparks leave the hand on ANY
  // elevation). No alloc: pure math from the live aim angles.
  private muzzlePosition(): { x: number; y: number; z: number } {
    const avatar = this.avatar;
    const ax = avatar !== null ? avatar.position.x : 0;
    const ay = avatar !== null ? avatar.position.y : SELF_SPAWN_Y;
    const az = avatar !== null ? avatar.position.z : 0;
    const yaw = this.hasAim ? this.aimYaw : this.yaw;
    const pitch = this.hasAim ? this.aimPitch : this.pitch;
    const cosPitch = Math.cos(pitch);
    const dirX = -Math.sin(yaw) * cosPitch;
    const dirZ = -Math.cos(yaw) * cosPitch;
    return { x: ax + dirX * BALL_MUZZLE_OFFSET, y: ay + BALL_TORSO_OFFSET, z: az + dirZ * BALL_MUZZLE_OFFSET };
  }

  private updateCameraTransform(deltaSeconds: number): void {
    if (this.avatar === null) {
      return;
    }
    // Stage 4d.2 charge zoom: ease the live distance toward the zoom target
    // (default 4m -> ~3.2m at full charge) at CAMERA_SMOOTH_RATE so it never
    // snaps; dt<=0 snaps (build/reset path).
    const zoomTarget = CAMERA_FOLLOW_DISTANCE
      + (CAMERA_CHARGE_DISTANCE - CAMERA_FOLLOW_DISTANCE) * this.chargeZoom01;
    if (!(deltaSeconds > 0)) {
      this.cameraDistance = zoomTarget;
    } else {
      const zoomAlpha = 1 - Math.exp(-CAMERA_SMOOTH_RATE * deltaSeconds);
      this.cameraDistance += (zoomTarget - this.cameraDistance) * zoomAlpha;
    }
    const horizontal = Math.cos(this.pitch) * this.cameraDistance;
    this.cameraOffset.set(
      Math.sin(this.yaw) * horizontal,
      CAMERA_FOLLOW_HEIGHT + Math.sin(this.pitch) * this.cameraDistance,
      Math.cos(this.yaw) * horizontal,
    );
    // Desired follow target (yaw stays instant for mouse responsiveness;
    // only pos + lookAt smooth below at CAMERA_SMOOTH_RATE).
    this.cameraDesired.copy(this.avatar.position).add(this.cameraOffset);
    this.cameraLookAt.copy(this.avatar.position);
    this.cameraLookAt.y += CAMERA_LOOK_AT_HEIGHT - 1.1;
    if (!this.cameraSmoothInit || !(deltaSeconds > 0)) {
      this.smoothCamPos.copy(this.cameraDesired);
      this.smoothCamLook.copy(this.cameraLookAt);
      this.cameraSmoothInit = true;
    } else {
      const alpha = 1 - Math.exp(-CAMERA_SMOOTH_RATE * deltaSeconds);
      this.smoothCamPos.lerp(this.cameraDesired, alpha);
      this.smoothCamLook.lerp(this.cameraLookAt, alpha);
    }
    this.camera.position.copy(this.smoothCamPos);
    // QD4-A light shake: tiny decaying offset on top of the follow camera,
    // integrated with the real frame delta (never a fixed step).
    const shakeOffset = this.shake.update(deltaSeconds);
    this.camera.position.x += shakeOffset.x;
    this.camera.position.y += shakeOffset.y;
    this.camera.position.z += shakeOffset.z;
    // Camera-wall clamp: keep the follow camera inside the arena walls plus
    // a small margin so it never clips through geometry. When the raw (pre-
    // clamp) position sat outside the allowed box or rides low behind a wall,
    // fade the walls so the fighter stays visible.
    const limit = ARENA_HALF_SIZE + CAMERA_WALL_MARGIN;
    const rawX = this.camera.position.x;
    const rawZ = this.camera.position.z;
    const wasOutside = Math.abs(rawX) > limit || Math.abs(rawZ) > limit;
    this.camera.position.x = THREE.MathUtils.clamp(this.camera.position.x, -limit, limit);
    this.camera.position.z = THREE.MathUtils.clamp(this.camera.position.z, -limit, limit);
    const lowBehindWall = this.camera.position.y < WALL_HEIGHT + 0.6
      && (Math.abs(this.camera.position.x) > ARENA_HALF_SIZE - 1
        || Math.abs(this.camera.position.z) > ARENA_HALF_SIZE - 1);
    if (wasOutside || lowBehindWall) {
      this.arena.setWallOpacity(WALL_FADE_OPACITY);
    } else {
      // Glass rest state (Stage 4d.3): the walls idle at glass opacity, never
      // opaque — the night sky stays visible through them. Fade (above) drops
      // toward more-transparent only while the camera crowds a wall.
      this.arena.setWallOpacity(WALL_GLASS_OPACITY);
    }
    this.camera.lookAt(this.smoothCamLook);
  }
}

// Cheap procedural nebula texture (Stage 4d.3): one shared 128px canvas with
// a soft radial falloff (well under the 256px cap, no asset files),
// tinted per-sprite via the SpriteMaterial color. Headless fallback mirrors
// Balls.makeGlowTexture so vitest (node, no DOM canvas) stays green.
function makeNebulaTexture(): THREE.Texture {
  if (typeof document === "undefined") {
    const pixel = new Uint8Array([255, 255, 255, 255]);
    const fallback = new THREE.DataTexture(pixel, 1, 1);
    fallback.needsUpdate = true;
    return fallback;
  }
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  if (context !== null) {
    const gradient = context.createRadialGradient(64, 64, 4, 64, 64, 62);
    gradient.addColorStop(0, "rgba(255,255,255,0.9)");
    gradient.addColorStop(0.35, "rgba(255,255,255,0.35)");
    gradient.addColorStop(0.7, "rgba(255,255,255,0.12)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 128);
  }
  return new THREE.CanvasTexture(canvas);
}
