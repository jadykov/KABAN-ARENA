import * as THREE from "three";
import { AdsManager, getFenceSlotTransforms } from "../ads/AdsLoader";
import {
  ARENA_HALF_SIZE,
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
  IDLE_RECENTER_MOVE_MAX,
  KNOCKBACK_IMPULSE,
  LOCAL_AVATAR_COLOR,
  MOVE_SPEED,
  NEBULA_COUNT,
  PARTICLE_BURST_COUNT,
  PLAYER_GROUND_ACCEL,
  PLAYER_ICE_ACCEL,
  RECOIL_FULL_M,
  RECOIL_RECONCILE_GRACE_S,
  RECOIL_WEAK_M,
  SELF_RECONCILE_MIN_M,
  SELF_RECONCILE_RATE,
  SELF_RECONCILE_SNAP_M,
  SELF_RECONCILE_TOP_TOL,
  SELF_RECONCILE_UP_SNAP_COOLDOWN_S,
  SELF_RECONCILE_STALL_MIN_DIV,
  SELF_RECONCILE_STALL_INPUT_MIN,
  SELF_RECONCILE_STALL_WINDOW_S,
  SELF_RECONCILE_STALL_MIN_PROGRESS_M,
  SELF_RECONCILE_STALL_SLOTS,
  SELF_RECONCILE_BIG_DIV,
  SELF_RECONCILE_BIG_DIV_HOLD_S,
  SELF_RECONCILE_REST_OFFSET,
  SELF_SPAWN_Y,
  SHADOW_MAP_SIZE,
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
import { ArenaBuilder, getObstacleLayout, getPlatforms, getTrampolineAt, isOnSlippery } from "../arena/Arena";
import { KIND_COLORS, PowerUpPickups, PowerUpState, type PowerUpKind } from "../arena/PowerUps";
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
import { PhysicsWorld, type Vector3Like } from "../physics/World";
import type { NetBallSnapshot, NetSuperSnapshot } from "../net/protocol";
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
  ACCENT_SPOT,
  BASE_BG,
  HL_SHIELD,
  HL_TRAMP_BURST,
  NEUTRAL_MOON,
  NEUTRAL_WHITE,
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
  | { type: "pickup"; kind: PowerUpKind }
  | { type: "speed-expired" }
  | { type: "trampoline" };

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
  // Stall-snap gates: divOk (divergence >= STALL_MIN_DIV), input magnitude
  // fed by the caller + inputOk (>= STALL_INPUT_MIN), stall-window progress
  // (XZ travel over the last STALL_WINDOW_S) + stallOk (< MIN_PROGRESS_M).
  divOk: boolean;
  moveMag: number;
  inputOk: boolean;
  stallProgressM: number;
  stallOk: boolean;
  // Big-div heal state: sustained-hold timer + its own event counter.
  bigDivHoldS: number;
  bigHealCount: number;
  lastBigHealAtMs: number;
  airborne: boolean;
  cooldownLeftS: number;
  // First support top whose level matches serverY within TOP_TOL (index into
  // the cached list, -1 when none) — observation pre-scan, mirrors the loop.
  levelTopIndex: number;
  levelTopY: number;
  // Last top the snap loop actually evaluated XZ on (-1 when the loop
  // never reached a level-matching top).
  evalTopIndex: number;
  xzOk: boolean;
  blockCenterX: number;
  blockCenterZ: number;
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
  // "no-progress", "off-block", "airborne", "cooldown", "recoil-grace",
  // "far-snap", "big-heal").
  note: string;
}

// Stage 3 scene (QD1-A capsule + QD2-A neon warehouse + QD5-A blocks):
// exactly 1 directional light (shadow <= 1024) + 1 ambient light + ONE
// no-shadow SpotLight aimed at the center banner (explicit MAP exception:
// banner dressing light, castShadow false, cheap fixed cost). No
// post-processing, fog + vertex colors + hit flash + pooled particles +
// light camera shake (QD4-A). Rapier capsule body drives the avatar once
// initPhysics() resolves; before that the legacy kinematic path applies.
export class SceneManager {
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly disposables: Array<{ dispose(): void }> = [];

  // Avatar root (Group at the physics body position — the follow camera
  // tracks THIS) + hop rig child (South Park bounce writes here only, so the
  // camera never bobs) + capsule body mesh (two-tone vertex-colored clothing).
  private avatar: THREE.Group | null = null;
  private avatarRig: THREE.Group | null = null;
  private avatarBody: THREE.Mesh | null = null;
  private avatarMaterial: THREE.MeshStandardMaterial | null = null;
  private readonly hop = createHopState();
  private readonly hopPrev = new THREE.Vector3();
  // Flight gate: airborne while the Rapier body climbs/falls fast
  // (trampoline launch, platform drop) — the hop rig glides instead of
  // bouncing. Two-level gate with exit hold (no ramp trips, no apex
  // flutter); refreshed in updatePhysics every frame.
  private readonly airborneGate = new AirborneGate();
  private shieldBubble: THREE.Mesh | null = null;
  private yaw = 0;
  private pitch = CAMERA_REST_PITCH;
  private built = false;

  private readonly arena = new ArenaBuilder();
  private readonly ads = new AdsManager();
  private readonly powerState = new PowerUpState();
  private readonly pickups = new PowerUpPickups();
  private readonly particles = new ParticlePool();
  private readonly shake = new CameraShake();
  private readonly flash = new HitFlash();
  private readonly events: ArenaEvent[] = [];

  private physics: PhysicsWorld | null = null;
  private physicsFailed = false;
  private trampolineCooldown = 0;
  private speedWasActive = false;

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
  // Stall-window ring buffer (bug round 7): preallocated per-slot XZ-travel
  // accumulators covering the last STALL_WINDOW_S (SLOTS slots x
  // WINDOW_S/SLOTS each ≈ 0.25 s). The window sum is the avatar's XZ
  // displacement over that span — under MIN_PROGRESS_M with input held it
  // proves a run-in-place stall. Scalar only, zero per-frame allocs.
  private readonly stallSlots: number[] = new Array<number>(SELF_RECONCILE_STALL_SLOTS).fill(0);
  private stallSlotIndex = 0;
  private stallSlotTimeS = 0;
  private stallLastX = Number.NaN;
  private stallLastZ = Number.NaN;
  // Big-div sustained-hold timer (bug round 7): accumulates while
  // |serverY - localY| >= BIG_DIV and NOT airborne; reset on agreement,
  // airborne, or any teleport. Fires the downward-desync heal at HOLD_S.
  private bigDivHoldS = 0;
  // Cached elevated-block tops for the stall-snap (built once — reconcileSelf
  // iterates this, never getPlatforms()/getObstacleLayout(), so the per-frame
  // path allocates nothing).
  private readonly supportTops: SupportTop[] = buildSupportTopList();
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
    bigDivHoldS: 0,
    bigHealCount: 0,
    lastBigHealAtMs: 0,
    airborne: false,
    cooldownLeftS: 0,
    levelTopIndex: -1,
    levelTopY: Number.NaN,
    evalTopIndex: -1,
    xzOk: false,
    blockCenterX: Number.NaN,
    blockCenterZ: Number.NaN,
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

  public build(): void {
    if (this.built) {
      return;
    }
    this.built = true;

    this.scene.background = new THREE.Color(BASE_BG);
    this.scene.fog = new THREE.Fog(BASE_BG, 22, 72);

    const ambient = new THREE.AmbientLight(NEUTRAL_WHITE, 0.6);
    this.scene.add(ambient);

    const directional = new THREE.DirectionalLight(NEUTRAL_WHITE, 1.0);
    directional.position.set(5, 10, 5);
    directional.castShadow = true;
    directional.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    directional.shadow.camera.left = -ARENA_HALF_SIZE;
    directional.shadow.camera.right = ARENA_HALF_SIZE;
    directional.shadow.camera.top = ARENA_HALF_SIZE;
    directional.shadow.camera.bottom = -ARENA_HALF_SIZE;
    this.scene.add(directional);

    // MAP exception: a single no-shadow spotlight for the hanging banner
    // (ads dressing QA3-A). Fixed cheap cost, no shadow map, aimed down.
    const bannerSpot = new THREE.SpotLight(ACCENT_SPOT, 50, 14, 0.55, 0.5, 1.2);
    bannerSpot.position.set(0, WALL_HEIGHT + 4.5, 0);
    bannerSpot.target.position.set(0, WALL_HEIGHT + 1.2, 0);
    bannerSpot.castShadow = false;
    this.scene.add(bannerSpot);
    this.scene.add(bannerSpot.target);

    this.arena.buildVisuals(this.scene);
    this.buildSky(this.scene);
    this.ads.buildFrames(this.scene);
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

    const bubbleGeometry = new THREE.SphereGeometry(0.95, 20, 14);
    const bubbleMaterial = new THREE.MeshBasicMaterial({
      color: HL_SHIELD,
      transparent: true,
      opacity: 0.28,
    });
    const bubble = new THREE.Mesh(bubbleGeometry, bubbleMaterial);
    bubble.visible = false;
    rig.add(bubble);
    this.disposables.push(bubbleGeometry, bubbleMaterial);
    this.shieldBubble = bubble;

    // 4d.1: held ball + face ride on the rig (ball right hand chest height,
    // face front +Z) so they hop with the body. Tinted local identity red.
    this.avatarVisuals = attachAvatarVisuals(rig, LOCAL_AVATAR_COLOR);
    this.ballsPool = new BallsPool(this.scene);
    this.superCore = new SuperCore(this.scene);
    this.fireflies = new Fireflies(this.scene);

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
    if (this.speedWasActive && !this.powerState.isSpeedActive()) {
      this.events.push({ type: "speed-expired" });
    }
    this.speedWasActive = this.powerState.isSpeedActive();

    if (this.avatarMaterial !== null) {
      this.flash.update(deltaSeconds, this.avatarMaterial);
    }
    if (this.shieldBubble !== null) {
      this.shieldBubble.visible = this.powerState.hasShield();
    }
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
      updateHopVisual(this.avatarRig, 0, speed01, this.hop, deltaSeconds, this.airborneGate.isAirborne);
      this.hopPrev.set(this.avatar.position.x, this.avatar.position.y, this.avatar.position.z);
    }
    this.updateCameraTransform(deltaSeconds);
  }

  // Per-frame combat tick: held-ball charge glow/swell + throw/reload anims,
  // pooled balls from the latest snapshot array, SUPER core from
  // snapshot.super (null hides). PixelRatio clamp, follow cam and spectator
  // hover live elsewhere and are intentionally untouched here.
  private updateCombat(deltaSeconds: number): void {
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
    // Stage 4d.3 fireflies: ambient drift every frame in BOTH play and
    // spectate paths (updateCombat runs in both). Billboard + sine bob,
    // zero per-frame allocations, no lights, 1 draw call.
    this.fireflies?.update(deltaSeconds, this.camera);
  }

  private updatePhysics(deltaSeconds: number, worldMove: THREE.Vector3): void {
    const physics = this.physics;
    const avatar = this.avatar;
    if (physics === null || avatar === null) {
      return;
    }
    // Blend toward the input target instead of hard-setting absolute
    // velocity: steer by at most ACCEL*dt per frame (zero target when there
    // is no input, so the body coasts to a stop — slowly on ice). Ice
    // sliding and knockback impulses therefore survive and decay via
    // damping/friction instead of being zeroed every frame.
    const preStep = physics.getPlayerPosition();
    const onIce = isOnSlippery(preStep.x, preStep.z);
    physics.setSlippery(onIce);
    // Charging halves the move target (CHARGE_MOVE_MULT, server mirror): the
    // server simulates charging fighters at half speed, so unscaled client
    // prediction diverged ~2.25 m/s during charge+walk and reconcile tugged
    // the preview origin every frame (bug C jitter source).
    const chargeMult = this.charging ? CHARGE_MOVE_MULT : 1;
    const speed = MOVE_SPEED * chargeMult * this.powerState.getSpeedMultiplier() * (onIce ? ICE_SPEED_MULT : 1);
    const current = physics.getPlayerVelocity();
    const targetX = worldMove.x * speed;
    const targetZ = worldMove.z * speed;
    let deltaX = targetX - current.x;
    let deltaZ = targetZ - current.z;
    const maxDelta = (onIce ? PLAYER_ICE_ACCEL : PLAYER_GROUND_ACCEL) * deltaSeconds;
    const deltaLength = Math.hypot(deltaX, deltaZ);
    if (deltaLength > maxDelta && deltaLength > 0) {
      const scale = maxDelta / deltaLength;
      deltaX *= scale;
      deltaZ *= scale;
    }
    physics.setPlayerVelocity(current.x + deltaX, current.y, current.z + deltaZ);
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

    for (const kind of this.pickups.update(deltaSeconds, position.x, position.z)) {
      this.collectPowerUp(kind, worldMove);
    }
  }

  private collectPowerUp(kind: PowerUpKind, worldMove: THREE.Vector3): void {
    const physics = this.physics;
    const avatar = this.avatar;
    this.powerState.applyPickup(kind);
    this.events.push({ type: "pickup", kind });
    if (avatar === null) {
      return;
    }
    if (kind === "speed") {
      this.particles.spawn(avatar.position.x, 1.2, avatar.position.z, 16, new THREE.Color(KIND_COLORS.speed));
    } else if (kind === "shield") {
      this.particles.spawn(avatar.position.x, 1.2, avatar.position.z, 16, new THREE.Color(KIND_COLORS.shield));
    } else if (physics !== null) {
      // Impulse knockback dash in the current move (or facing) direction.
      // Same shared release threshold as the facing freeze above.
      const direction = worldMove.lengthSq() > IDLE_RECENTER_MOVE_MAX * IDLE_RECENTER_MOVE_MAX
        ? worldMove.clone().normalize()
        : new THREE.Vector3(Math.sin(avatar.rotation.y), 0, Math.cos(avatar.rotation.y));
      physics.applyPlayerImpulse(direction.x * KNOCKBACK_IMPULSE, 2.5, direction.z * KNOCKBACK_IMPULSE);
      this.particles.spawn(avatar.position.x, 1.2, avatar.position.z, PARTICLE_BURST_COUNT, new THREE.Color(KIND_COLORS.impulse));
      this.shake.add(0.25);
    }
  }

  // Debug/playtest pickup grant (keys 1/2/3 in main.ts).
  public grantPowerUp(kind: PowerUpKind): void {
    this.pickups.grant(kind);
    const fallbackMove = new THREE.Vector3();
    this.collectPowerUp(kind, fallbackMove);
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

  // Test-scene hit (H key): shield absorbs one hit, otherwise the caller
  // applies HUD damage. Returns true when the shield absorbed the hit.
  public applyTestHit(): boolean {
    if (this.powerState.consumeShieldHit()) {
      this.flash.trigger();
      this.burstAtAvatar(new THREE.Color(KIND_COLORS.shield), 12);
      return true;
    }
    this.flash.trigger();
    this.shake.add(0.45);
    this.burstAtAvatar(new THREE.Color(ACCENT_HIT_BURST), PARTICLE_BURST_COUNT);
    return false;
  }

  public drainEvents(): ArenaEvent[] {
    return this.events.splice(0, this.events.length);
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
    if (this.avatarRig !== null) {
      resetHopVisual(this.avatarRig, 0);
    }
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
    // reseed the window on the landing spot with empty slots.
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
  // travel, so the ring is emptied and reseeded on the landing spot. Called
  // from teleportSelf, which every snap/spawn/respawn path funnels through.
  private resetStallWindow(x: number, z: number): void {
    for (let i = 0; i < this.stallSlots.length; i += 1) {
      this.stallSlots[i] = 0;
    }
    this.stallSlotIndex = 0;
    this.stallSlotTimeS = 0;
    this.stallLastX = x;
    this.stallLastZ = z;
  }

  // Stall-window tracking (bug round 7): feeds this frame's avatar XZ travel
  // into the current ring slot and returns the window sum — the avatar's XZ
  // displacement over the last STALL_WINDOW_S. Math: SLOTS slots x
  // WINDOW_S/SLOTS s each; per call the slot timer advances by dt and the
  // slot rotates (zeroed) once its share elapses, so the sum always covers
  // ~one window of recent motion. First call only seeds the reference (no
  // travel yet). Scalar writes into the preallocated ring — zero allocs.
  private trackStallWindow(x: number, z: number, deltaSeconds: number): number {
    if (!Number.isFinite(this.stallLastX) || !Number.isFinite(this.stallLastZ)) {
      this.stallLastX = x;
      this.stallLastZ = z;
      return 0;
    }
    const frameTravel = Math.hypot(x - this.stallLastX, z - this.stallLastZ);
    this.stallLastX = x;
    this.stallLastZ = z;
    const slotCount = this.stallSlots.length;
    if (slotCount <= 0) {
      return frameTravel;
    }
    const current = this.stallSlots[this.stallSlotIndex];
    this.stallSlots[this.stallSlotIndex] = (current ?? 0) + frameTravel;
    this.stallSlotTimeS += deltaSeconds;
    const slotShareS = SELF_RECONCILE_STALL_WINDOW_S / slotCount;
    while (this.stallSlotTimeS >= slotShareS && slotShareS > 0) {
      this.stallSlotTimeS -= slotShareS;
      this.stallSlotIndex = (this.stallSlotIndex + 1) % slotCount;
      this.stallSlots[this.stallSlotIndex] = 0;
    }
    let progressM = 0;
    for (let i = 0; i < slotCount; i += 1) {
      progressM += this.stallSlots[i] ?? 0;
    }
    return progressM;
  }

  // Gentle self reconciliation toward the server snapshot (XZ only, no
  // alloc): under SELF_RECONCILE_MIN_M stays local (no jitter during normal
  // play), within (MIN, SNAP] lerps avatar + body at SELF_RECONCILE_RATE,
  // beyond SNAP teleports (now to the authoritative Y, not always ground).
  // Returns what happened (for tests/telemetry).
  // Recoil grace: for RECOIL_RECONCILE_GRACE_S after a local kick the
  // correction is skipped (prediction-only kick, server re-applies it) so
  // reconcile never fights the kick and double-tugs the avatar.
  // Stall-snap (bug round 7 — replaces the round 6/6b/6c Y-threshold +
  // speed-gate UP-snap, which live F3 telemetry proved dead: healthy Rapier
  // rest sits EXACTLY 0.100 below the server nominal and the resting
  // lip-wedge sits there too, so Y-divergence alone can never tell them
  // apart; the 0.11 hang gate was structurally blind and the 1.5 speed gate
  // blocked the only live heal window). The local Rapier body has no
  // auto-step, so a few cm of Y-divergence wedge it against the side lip
  // forever (XZ-only reconcile can never heal it: the edge walk-back
  // invisible wall). The discriminator is STALL EVIDENCE — ALL must hold:
  // not airborne, cooldown == 0, serverY within TOP_TOL of a support top,
  // client XZ in that top's expanded footprint, serverY - localY >=
  // STALL_MIN_DIV, input |move| >= STALL_INPUT_MIN (fed by the caller via
  // moveMag — reconcile runs before physics, so the live stick magnitude
  // comes in as a parameter), and XZ travel over the last STALL_WINDOW_S <
  // STALL_MIN_PROGRESS_M (zero-alloc ring buffer, see trackStallWindow).
  // Action: teleport to (serverX, serverZ, serverY - REST_OFFSET) — true
  // Rapier rest, no post-snap drop — arm the cooldown, count the snap.
  // Healthy rest never fires (no input), normal walking never fires (XZ
  // progresses), descents/step-offs never fire (XZ progresses — no speed
  // gate needed), ground walls never fire (serverY matches no top).
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
    t.bigDivHoldS = this.bigDivHoldS;
    t.airborne = this.airborneGate.isAirborne;
    t.cooldownLeftS = this.upSnapCooldownLeftS;
    t.levelTopIndex = -1;
    t.levelTopY = Number.NaN;
    t.evalTopIndex = -1;
    t.xzOk = false;
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
    t.localY = this.avatar.position.y;
    // Stall-window tracking runs on every live frame (before any gate): the
    // avatar's XZ travel since the last call feeds the current ring slot, so
    // the window sum always reflects the last STALL_WINDOW_S of motion.
    t.stallProgressM = this.trackStallWindow(
      this.avatar.position.x,
      this.avatar.position.z,
      deltaSeconds,
    );
    t.stallOk = t.stallProgressM < SELF_RECONCILE_STALL_MIN_PROGRESS_M;
    const serverYFinite = Number.isFinite(serverY);
    // Observation pre-scan (diagnostic only): first support top whose level
    // matches serverY within TOP_TOL — mirrors the loop's level check so the
    // overlay can show the top match even when a later gate fails.
    if (serverYFinite) {
      t.divergence = serverY - t.localY;
      t.divOk = t.divergence >= SELF_RECONCILE_STALL_MIN_DIV;
      for (let i = 0; i < this.supportTops.length; i += 1) {
        const scanned = this.supportTops[i];
        if (scanned !== undefined && Math.abs(serverY - scanned.levelY) <= SELF_RECONCILE_TOP_TOL) {
          t.levelTopIndex = i;
          t.levelTopY = scanned.levelY;
          break;
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
      // t.divOk / t.inputOk / t.stallOk were computed above (divergence,
      // caller-fed input, live stall window); the loop only adds the
      // top-level + footprint match.
      if (t.divOk && t.inputOk && t.stallOk) {
        for (let i = 0; i < this.supportTops.length; i += 1) {
          const top = this.supportTops[i];
          if (top === undefined || Math.abs(serverY - top.levelY) > SELF_RECONCILE_TOP_TOL) {
            continue;
          }
          t.evalTopIndex = i;
          t.blockCenterX = top.x;
          t.blockCenterZ = top.z;
          t.blockDist = Math.hypot(this.avatar.position.x - top.x, this.avatar.position.z - top.z);
          const inX = Math.abs(this.avatar.position.x - top.x) <= top.hx + AVATAR_BODY_RADIUS;
          const inZ = Math.abs(this.avatar.position.z - top.z) <= top.hz + AVATAR_BODY_RADIUS;
          t.xzOk = inX && inZ;
          if (inX && inZ) {
            const firedProgressM = t.stallProgressM;
            this.teleportSelf(serverX, serverZ, serverY - SELF_RECONCILE_REST_OFFSET);
            this.upSnapCooldownLeftS = SELF_RECONCILE_UP_SNAP_COOLDOWN_S;
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
        if (t.evalTopIndex < 0) {
          t.note = "no-level-match";
        } else if (!t.xzOk) {
          t.note = "off-block";
        }
      } else if (!t.divOk) {
        t.note = "no-stall-div";
      } else if (!t.inputOk) {
        t.note = "no-input";
      } else {
        t.note = "no-progress";
      }
      // Big-div heal (downward-desync last resort): sustained large gap while
      // grounded — e.g. the server walked off the footprint and fell while
      // the client stayed on top. Full server pose, own counter, own log.
      // Checked independently of the stall gates above (different trigger).
      if (this.bigDivHoldS >= SELF_RECONCILE_BIG_DIV_HOLD_S) {
        this.teleportSelf(serverX, serverZ, serverY);
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

  public getFenceSlotCount(): number {
    return getFenceSlotTransforms().length;
  }

  public reset(): void {
    this.yaw = 0;
    this.pitch = CAMERA_REST_PITCH;
    this.trampolineCooldown = 0;
    this.speedWasActive = false;
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
    this.shieldBubble = null;
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
    this.built = false;
  }

  private burstAtAvatar(color: THREE.Color, count: number): void {
    if (this.avatar !== null) {
      this.particles.spawn(this.avatar.position.x, 1.2, this.avatar.position.z, count, color);
    }
  }

  // Night-sky dressing (zero light cost): one moon disc (MeshBasicMaterial,
  // fog=false, no lighting) + one THREE.Points starfield (~100 points, one
  // draw call, fog=false, no lighting). Light budget untouched (1 dir +
  // 1 ambient + the pre-existing banner spot exception).
  private buildSky(scene: THREE.Scene): void {
    const moonGeometry = new THREE.CircleGeometry(3, 32);
    const moonMaterial = new THREE.MeshBasicMaterial({ color: NEUTRAL_MOON, fog: false });
    const moon = new THREE.Mesh(moonGeometry, moonMaterial);
    moon.name = "moon";
    moon.position.set(-30, 38, -60);
    moon.lookAt(0, 0, 0);
    scene.add(moon);
    this.disposables.push(moonGeometry, moonMaterial);

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
      opacity: 0.9,
      depthWrite: false,
    });
    const stars = new THREE.Points(starGeometry, starMaterial);
    stars.name = "stars";
    stars.frustumCulled = false;
    scene.add(stars);
    this.disposables.push(starGeometry, starMaterial);

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
