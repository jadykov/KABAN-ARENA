import * as THREE from "three";
import { AdsManager, getFenceSlotTransforms } from "../ads/AdsLoader";
import {
  ARENA_HALF_SIZE,
  CAMERA_FOLLOW_DISTANCE,
  CAMERA_FOLLOW_HEIGHT,
  CAMERA_FOV,
  CAMERA_LOOK_AT_HEIGHT,
  CAMERA_PITCH_MAX,
  CAMERA_PITCH_MIN,
  CAMERA_SENSITIVITY,
  CAMERA_SMOOTH_RATE,
  CAMERA_WALL_MARGIN,
  BALL_MUZZLE_OFFSET,
  BALL_TORSO_OFFSET,
  DEATH_BURST_COUNT,
  DEATH_BURST_ORANGE,
  DEATH_BURST_RED,
  DEATH_BURST_YELLOW,
  ICE_SPEED_MULT,
  KNOCKBACK_IMPULSE,
  LOCAL_AVATAR_COLOR,
  MOVE_SPEED,
  PARTICLE_BURST_COUNT,
  PLAYER_GROUND_ACCEL,
  PLAYER_ICE_ACCEL,
  RECOIL_FULL_M,
  RECOIL_RECONCILE_GRACE_S,
  RECOIL_WEAK_M,
  SELF_RECONCILE_MIN_M,
  SELF_RECONCILE_RATE,
  SELF_RECONCILE_SNAP_M,
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
  WALL_HEIGHT,
} from "../config";
import { ArenaBuilder, getTrampolineAt, isOnSlippery } from "../arena/Arena";
import { PowerUpPickups, PowerUpState, type PowerUpKind } from "../arena/PowerUps";
import { BallsPool, SuperCore } from "../fx/Balls";
import { CameraShake, HitFlash } from "../fx/CameraShake";
import {
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
  private shieldBubble: THREE.Mesh | null = null;
  private yaw = 0;
  private pitch = 0.25;
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

  // Stage 4d.1 hand-ball combat: held core + face on the local avatar,
  // pooled balls and the SUPER core from the latest authoritative snapshot.
  private avatarVisuals: AvatarVisualsHandle | null = null;
  // Fire-direction aim (camera yaw/pitch at release, fed per frame from
  // main.ts). The body keeps facing movement; the aim feeds the recoil kick
  // dir, the spark emitter and the trajectory preview (no barrel to aim).
  private aimYaw = 0;
  private aimPitch = 0.25;
  private hasAim = false;
  private ballsPool: BallsPool | null = null;
  private superCore: SuperCore | null = null;
  private charge01 = 0;
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
  // Full-charge spark timer: while charge01 >= 0.8 a small ember burst pops
  // at the muzzle every SPARK_INTERVAL_S (pooled, no alloc, no lights).
  private sparkTimer = 0;

  public constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this.scene = scene;
    this.camera = camera;
  }

  public build(): void {
    if (this.built) {
      return;
    }
    this.built = true;

    this.scene.background = new THREE.Color(0x0b0e14);
    this.scene.fog = new THREE.Fog(0x0b0e14, 22, 72);

    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambient);

    const directional = new THREE.DirectionalLight(0xffffff, 1.0);
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
    const bannerSpot = new THREE.SpotLight(0xffe6ff, 50, 14, 0.55, 0.5, 1.2);
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
      color: 0xffffff,
      emissive: 0xff2200,
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
      color: 0x44ffcc,
      transparent: true,
      opacity: 0.28,
    });
    const bubble = new THREE.Mesh(bubbleGeometry, bubbleMaterial);
    bubble.visible = false;
    rig.add(bubble);
    this.disposables.push(bubbleGeometry, bubbleMaterial);
    this.shieldBubble = bubble;

    // 4d.1: held ball + face ride on the rig (ball right hand chest height,
    // face front +Z) so they hop with the body. Tinted local orange.
    this.avatarVisuals = attachAvatarVisuals(rig, LOCAL_AVATAR_COLOR);
    this.ballsPool = new BallsPool(this.scene);
    this.superCore = new SuperCore(this.scene);

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
  // avatar visible again for the follow camera (5m, FOV 75).
  public setSpectating(value: boolean): void {
    this.spectating = value;
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

  // Combat wiring: charge 0..1 for the held-ball glow/swell, latest
  // authoritative balls + SUPER core snapshot (null hides the core).
  public setCharge01(value: number): void {
    const clamped = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
    this.charge01 = clamped;
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
  // emitter and muzzle math. No alloc, two numbers.
  public setAimAngles(yaw: number, pitch: number): void {
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) {
      return;
    }
    this.aimYaw = yaw;
    this.aimPitch = pitch;
    this.hasAim = true;
  }

  // Death burst: 30 pooled particles at the given position with the fixed
  // palette (yellow 10% / orange 30% / red 60%). No alloc, no lights, one
  // Points draw call via the shared ParticlePool.
  public spawnDeathBurst(x?: number, y?: number, z?: number): void {
    const avatar = this.avatar;
    const px = x ?? avatar?.position.x ?? 0;
    const py = y ?? (avatar !== null ? avatar.position.y + 0.2 : 1.2);
    const pz = z ?? avatar?.position.z ?? 0;
    if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) {
      return;
    }
    const total = DEATH_BURST_COUNT > 0 ? DEATH_BURST_COUNT : 30;
    const yellow = Math.round(total * 0.1);
    const orange = Math.round(total * 0.3);
    const red = total - yellow - orange;
    if (yellow > 0) {
      this.particles.spawn(px, py, pz, yellow, new THREE.Color(DEATH_BURST_YELLOW));
    }
    if (orange > 0) {
      this.particles.spawn(px, py, pz, orange, new THREE.Color(DEATH_BURST_ORANGE));
    }
    if (red > 0) {
      this.particles.spawn(px, py, pz, red, new THREE.Color(DEATH_BURST_RED));
    }
  }

  public getAliveParticleCount(): number {
    return this.particles.aliveCount;
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
    this.yaw -= look.dx * CAMERA_SENSITIVITY;
    this.pitch = THREE.MathUtils.clamp(
      this.pitch + look.dy * CAMERA_SENSITIVITY,
      CAMERA_PITCH_MIN,
      CAMERA_PITCH_MAX,
    );

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
    if (worldMove.lengthSq() > 0.0001) {
      const targetYaw = Math.atan2(worldMove.x, worldMove.z);
      this.avatar.rotation.y = targetYaw;
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
    // No allocations: one scratch vector + scalar math.
    if (this.avatarRig !== null && this.avatar !== null) {
      const movedX = this.avatar.position.x - this.hopPrev.x;
      const movedZ = this.avatar.position.z - this.hopPrev.z;
      const speed01 = deltaSeconds > 0
        ? Math.min(1, Math.hypot(movedX, movedZ) / (deltaSeconds * MOVE_SPEED))
        : 0;
      updateHopVisual(this.avatarRig, 0, speed01, this.hop, deltaSeconds);
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
        this.particles.spawn(muzzle.x, muzzle.y, muzzle.z, 2, new THREE.Color(0xffaa33), 1.5, 1.5);
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
    const speed = MOVE_SPEED * this.powerState.getSpeedMultiplier() * (onIce ? ICE_SPEED_MULT : 1);
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

    this.trampolineCooldown = Math.max(0, this.trampolineCooldown - deltaSeconds);
    const pad = getTrampolineAt(position.x, position.z);
    if (pad !== null && position.y < TRAMPOLINE_TRIGGER_Y && this.trampolineCooldown <= 0) {
      this.trampolineCooldown = TRAMPOLINE_COOLDOWN_S;
      physics.launchTrampoline();
      this.particles.spawn(position.x, 0.5, position.z, PARTICLE_BURST_COUNT, new THREE.Color(0xff66ff));
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
      this.particles.spawn(avatar.position.x, 1.2, avatar.position.z, 16, new THREE.Color(0x22eeff));
    } else if (kind === "shield") {
      this.particles.spawn(avatar.position.x, 1.2, avatar.position.z, 16, new THREE.Color(0x44ff66));
    } else if (physics !== null) {
      // Impulse knockback dash in the current move (or facing) direction.
      const direction = worldMove.lengthSq() > 0.0001
        ? worldMove.clone().normalize()
        : new THREE.Vector3(Math.sin(avatar.rotation.y), 0, Math.cos(avatar.rotation.y));
      physics.applyPlayerImpulse(direction.x * KNOCKBACK_IMPULSE, 2.5, direction.z * KNOCKBACK_IMPULSE);
      this.particles.spawn(avatar.position.x, 1.2, avatar.position.z, PARTICLE_BURST_COUNT, new THREE.Color(0xff8833));
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
      this.burstAtAvatar(new THREE.Color(0x44ff66), 12);
      return true;
    }
    this.flash.trigger();
    this.shake.add(0.45);
    this.burstAtAvatar(new THREE.Color(0xff5533), PARTICLE_BURST_COUNT);
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
  public teleportSelf(x: number, z: number): void {
    if (!this.built || this.avatar === null) {
      return;
    }
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      return;
    }
    this.avatar.position.set(x, SELF_SPAWN_Y, z);
    this.avatar.rotation.y = 0;
    this.resetHop();
    this.hopPrev.set(x, SELF_SPAWN_Y, z);
    // A teleport is authoritative placement (spawn/respawn/snap) — any
    // pending recoil grace is stale, clear it so corrections resume.
    this.recoilGraceLeftS = 0;
    if (this.physics !== null) {
      this.physics.reset({ x, y: SELF_SPAWN_Y, z });
    }
  }

  // Gentle self reconciliation toward the server snapshot (XZ only, no
  // alloc): under SELF_RECONCILE_MIN_M stays local (no jitter during normal
  // play), within (MIN, SNAP] lerps avatar + body at SELF_RECONCILE_RATE,
  // beyond SNAP teleports. Returns what happened (for tests/telemetry).
  // Recoil grace: for RECOIL_RECONCILE_GRACE_S after a local kick the
  // correction is skipped (prediction-only kick, server re-applies it) so
  // reconcile never fights the kick and double-tugs the avatar.
  public reconcileSelf(serverX: number, serverZ: number, deltaSeconds: number): "ok" | "lerp" | "snap" | "skipped" {
    if (!this.built || this.avatar === null || this.spectating) {
      return "skipped";
    }
    if (!Number.isFinite(serverX) || !Number.isFinite(serverZ) || !(deltaSeconds > 0)) {
      return "skipped";
    }
    if (this.recoilGraceLeftS > 0) {
      this.recoilGraceLeftS = Math.max(0, this.recoilGraceLeftS - deltaSeconds);
      return "skipped";
    }
    const dx = serverX - this.avatar.position.x;
    const dz = serverZ - this.avatar.position.z;
    const dist = Math.hypot(dx, dz);
    if (!(dist > SELF_RECONCILE_MIN_M)) {
      return "ok";
    }
    if (dist > SELF_RECONCILE_SNAP_M) {
      this.teleportSelf(serverX, serverZ);
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
    return "lerp";
  }

  // Current avatar facing (radians, world Y) for inputs-only upstream: the
  // server stores rotY per player so remotes render a plausible heading.
  public getAvatarFacing(): number {
    return this.avatar?.rotation.y ?? 0;
  }

  // Fire feedback (hit attempt): flash + particles + light shake without
  // touching shield charges — authorititative damage stays server-side.
  public playFireFeedback(): void {
    this.flash.trigger();
    this.shake.add(0.2);
    this.burstAtAvatar(new THREE.Color(0xffcc44), 8);
  }

  public getCameraAngles(): { yaw: number; pitch: number } {
    return { yaw: this.yaw, pitch: this.pitch };
  }

  // Floating-aim camera follow: while charging, the camera copies the live
  // aim yaw/pitch every frame so one right thumb can turn 360 degrees.
  // No alloc, pitch clamped to the shared camera band. Idle path untouched.
  public setCameraAngles(yaw: number, pitch: number): void {
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) {
      return;
    }
    this.yaw = yaw;
    this.pitch = THREE.MathUtils.clamp(pitch, CAMERA_PITCH_MIN, CAMERA_PITCH_MAX);
  }

  public getFenceSlotCount(): number {
    return getFenceSlotTransforms().length;
  }

  public reset(): void {
    this.yaw = 0;
    this.pitch = 0.25;
    this.trampolineCooldown = 0;
    this.speedWasActive = false;
    this.events.length = 0;
    this.charge01 = 0;
    this.latestBalls = [];
    this.latestSuper = null;
    this.hasAim = false;
    this.sparkTimer = 0;
    this.aimYaw = 0;
    this.aimPitch = 0.25;
    this.recoilGraceLeftS = 0;
    this.cameraSmoothInit = false;
    this.smoothCamPos.set(0, 0, 0);
    this.smoothCamLook.set(0, 0, 0);
    this.arena.setWallOpacity(1);
    this.avatarVisuals?.reset();
    this.powerState.reset();
    this.pickups.reset();
    this.particles.clear();
    this.shake.reset();
    this.flash.reset();
    if (this.avatarMaterial !== null) {
      this.avatarMaterial.emissiveIntensity = 0;
    }
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
    const moonMaterial = new THREE.MeshBasicMaterial({ color: 0xf4f1de, fog: false });
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
      color: 0xffffff,
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
    const horizontal = Math.cos(this.pitch) * CAMERA_FOLLOW_DISTANCE;
    this.cameraOffset.set(
      Math.sin(this.yaw) * horizontal,
      CAMERA_FOLLOW_HEIGHT + Math.sin(this.pitch) * CAMERA_FOLLOW_DISTANCE,
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
      this.arena.setWallOpacity(1);
    }
    this.camera.lookAt(this.smoothCamLook);
  }
}
