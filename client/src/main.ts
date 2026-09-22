import "./style.css";
import * as THREE from "three";
import {
  AIM_EXPO,
  AIM_PITCH_RATE,
  AIM_YAW_RATE,
  BALL_GRAVITY,
  CAMERA_PITCH_MAX,
  CAMERA_PITCH_MIN,
  CAMERA_REST_PITCH,
  CHARGE_MAX_S,
  FLOAT_DEADZONE,
  FLOAT_DRAG_RADIUS_PX,
  IDLE_FOLLOW_RATE,
  IDLE_RECENTER_MOVE_MAX,
  INPUT_SEND_INTERVAL_S,
  LOCAL_AVATAR_COLOR,
  MAX_HEARTS,
  MIRROR_PITCH_MAX,
  MIRROR_PITCH_MIN,
  MOVE_STICK_DIAMETER,
  RELOAD_MS,
  ROUND_SECONDS,
  SELF_RECONCILE_SNAP_M,
  START_SCORE,
  TAP_FIRE_MIN_S,
  getServerUrl,
} from "./config";
import { Engine } from "./engine/Engine";
import { InputController, isTypingTarget } from "./engine/InputController";
import { SceneManager } from "./engine/SceneManager";
import { NetworkManager, type RoomSnapshot } from "./net/NetworkManager";
import { RemoteAvatars } from "./net/RemoteAvatars";
import { beginChargeLevel, mirrorChargeCameraPitch, pitchRateScale, shouldTrackAimFromCamera, stepChargeLevel, unmirrorChargeCameraPitch, yawRateScale, type ChargeLevel } from "./net/chargeAim";
import { cameraYawBehindFacing, forwardnessRateScale, shouldIdleFollow, stepIdleFollowPitch, stepIdleFollowYaw, stickAngleFromForward, tolerantCameraPitchMin, type IdleFollowGate } from "./net/idleFollow";
import {
  applyExpo,
  buildInputPayload,
  chargeToPower01,
  directionFromYawPitch,
  formatCounters,
  halvesForHp,
  muzzleForShot,
  normalizePlayNick,
  ownerColorForSession,
  powerToSpeed,
  previewTimeAt,
  worldMoveFromYaw,
} from "./net/protocol";
import { TRAJ_DOT_COUNT, createAim, type TrajSample } from "./ui/aim";
import { createHud } from "./ui/hud";
import { createJoystick } from "./ui/joystick";
import { TouchAimState, isRightHalf } from "./net/touchAim";
import type { PowerUpKind } from "./arena/PowerUps";

// Debug/playtest power-up grants: physical key positions 1/2/3 on any
// layout (e.code, never key) — same layout-independence rule as WASD.
const POWERUP_KEYS: Record<string, PowerUpKind> = {
  Digit1: "speed",
  Numpad1: "speed",
  Digit2: "shield",
  Numpad2: "shield",
  Digit3: "impulse",
  Numpad3: "impulse",
};

// Stage 4 entry with R1 pre-join spectator: boot joins the room immediately
// as a spectator (no nick needed) and watches the live arena from the hover
// camera behind a semi-transparent plate. Pressing Play sends "play" with a
// validated nick; on welcome the view switches to the follow camera (4m),
// the avatar appears and physics/inputs activate. Remote fighters replicate
// from the authoritative room at 20Hz through lerp/slerp interpolation.
async function boot(): Promise<void> {
  const container = document.getElementById("app");
  if (container === null) {
    throw new Error("#app container missing");
  }

  const engine = new Engine(container);
  const sceneManager = new SceneManager(engine.scene, engine.camera);
  sceneManager.build();
  // R1: boot starts spectating — no ghost body, hover orbit over the arena.
  sceneManager.setSpectating(true);

  const input = new InputController();
  input.attach(window, engine.renderer.domElement);

  const hud = createHud(document.body);
  hud.setTimer(ROUND_SECONDS);
  hud.setScore(START_SCORE);
  hud.setStatus("Watching live arena — pick a nick and press Play");
  hud.addKillfeed("Welcome to KABAN ARENA");

  const joystick = createJoystick(document.body, {
    diameter: MOVE_STICK_DIAMETER,
    onMove: (vector): void => {
      input.setJoystick({ x: applyExpo(vector.x, AIM_EXPO), y: applyExpo(vector.y, AIM_EXPO) });
    },
  });
  // R1: spectators see the plate + hover camera only — controls appear on
  // welcome (hover -> follow transition).
  joystick.element.style.display = "none";

  // R2 minimal charge FSM: FIRE button hold / Space / LMB drive yaw/pitch,
  // hold to charge, release to fire via sendFire. Gated by isPlaying && !spectating.
  const aimOverlay = createAim(document.body);
  aimOverlay.hide();
  // Stage 4e mobile scheme (PUBG-style): the fixed aim stick is gone.
  // Right-half touch drag is free camera (no charge) and the FIRE button hold
  // charges + aims; both gestures route by pointer id through one shared
  // TouchAimState (single source of truth, unit-tested in
  // net/touchAim.test.ts). Desktop mouse/keyboard paths below are untouched.
  const touchState = new TouchAimState();

  // Remote deaths shatter visibly at the victim's last tracked position
  // (bug round 5): players and bots share this path, and spectators see it
  // too — particles render in the spectate path, and this callback has no
  // spectating gate (unlike the local-avatar burst below, which needs a
  // visible local body).
  const remotes = new RemoteAvatars(engine.scene, (x, y, z, color): void => {
    sceneManager.spawnDeathBurst(x, y, z, color);
  });

  let latest: RoomSnapshot | null = null;
  let isPlaying = false;
  let inputSeq = 0;
  let inputAccumulator = 0;
  let connecting = false;
  // Last seen self alive flag (null = no snapshot yet): false->true while
  // playing means an authoritative respawn — teleport to the server spawn.
  let lastSelfAlive: boolean | null = null;

  // R2 charge/reload state (ms wall clock via Date.now()).
  let chargeStartMs = 0;
  let isCharging = false;
  let isReloading = false;
  let reloadUntilMs = 0;
  let hasSuperBuff = false;
  let aimYaw = 0;
  let aimPitch = CAMERA_REST_PITCH;
  // One-shot charge pitch leveling (owner: camera eases to horizon at aim
  // start, then free aim): armed in startCharge, cleared on any exit below.
  let chargeLevel: ChargeLevel = { active: false };
  // True once the per-frame charge block has written the mirrored camera
  // pitch at least once during the CURRENT charge (reset in startCharge).
  // stopCharge reads it: a mirrored camera must be un-mirrored back to true
  // aim, while a charge with zero ticks (background-tab rAF stall) never
  // mirrored the camera, so the plain copy is already true aim.
  let chargeMirrored = false;
  // Shared release-time aim (preview == flight): BOTH the trajectory preview
  // (per-frame while charging, see computeAimTrajectory) and the fire payload
  // (stopCharge) read aimYaw/aimPitch directly — same values, so preview dots
  // cannot diverge from the fired ball. No aim assist: the shot goes exactly
  // where the player aims.
  // Floating LMB aim (PC parity): LMB hold on the canvas starts charge at the
  // press point (floating origin, not a fixed disc); drag offset in px maps
  // to [-1, 1] over FLOAT_DRAG_RADIUS_PX, then expo + deadzone + yaw/pitch
  // rates. Touch never charges here — right-half touch drags are free camera
  // (TouchAimState cam path, no charge) and the left half belongs to the move
  // stick. Camera mirrors aim pitch while charging (aim-mirror, fix round 3)
  // so one button hold can turn 360 degrees.
  let floatActive = false;
  let floatPointerId: number | null = null;
  let floatOriginX = 0;
  let floatOriginY = 0;
  let floatVector = { x: 0, y: 0 };
  // Idle-follow gate scratch (Stage 4d.2-fix2 follow-up): mutated every
  // playing frame and passed to shouldIdleFollow so the gate check itself
  // allocates nothing per frame.
  const idleFollowGate: IdleFollowGate = {
    playing: false,
    charging: false,
    alive: false,
    lookDx: 0,
    lookDy: 0,
    moveX: 0,
    moveY: 0,
  };

  // Join overlay + FIRE button are declared early so network callbacks can
  // show/hide them (spectators see the plate, fighters see controls).
  // Join overlay: guest nick + Play press, no auth. R1: a semi-transparent
  // centered plate over the live arena (see style.css); stays visible while
  // spectating, hides on welcome, reappears on disconnect for late join.
  const overlay = document.createElement("div");
  overlay.id = "join-overlay";
  const nickInput = document.createElement("input");
  nickInput.id = "join-nick";
  nickInput.maxLength = 16;
  nickInput.placeholder = "Your nick";
  nickInput.autocomplete = "off";
  const playButton = document.createElement("button");
  playButton.id = "join-play";
  playButton.textContent = "Play";
  overlay.appendChild(nickInput);
  overlay.appendChild(playButton);
  document.body.appendChild(overlay);

  // FIRE button (mobile) + Space (desktop): hitscan A trigger.
  // Hidden until the local player joins the fight (welcome).
  const fireButton = document.createElement("button");
  fireButton.id = "fire-button";
  fireButton.textContent = "FIRE";
  fireButton.style.display = "none";
  document.body.appendChild(fireButton);

  function showJoinOverlay(): void {
    overlay.style.display = "flex";
  }

  function hideJoinOverlay(): void {
    overlay.style.display = "none";
  }

  const net = new NetworkManager(getServerUrl(), {
    onSnapshot: (snapshot): void => {
      latest = snapshot;
      applySnapshot(snapshot);
    },
    onWelcome: (sessionId, nick, spawn): void => {
      isPlaying = true;
      // Our session id is known from join time (ownSessionId set on room
      // join, before welcome): lock in our deterministic Nintendo-style face
      // variant + two-tone clothing now that identity exists (avatar built
      // pre-join, hidden).
      sceneManager.setPlayerSource(net.ownSessionId ?? sessionId);
      // R1 welcome: hover orbit -> follow camera (4m), avatar visible,
      // physics/inputs active, controls revealed. Teleport the local avatar
      // + Rapier body to the authoritative server spawn so the first shot
      // leaves our visible body instead of a phantom corner (~17m gap fix).
      sceneManager.setSpectating(false);
      if (spawn !== null && spawn !== undefined) {
        sceneManager.teleportSelf(spawn.x, spawn.z);
      }
      // Snapshot-driven teleport/respawn below covers payloads without
      // coords (compat) and any later alive-again transitions.
      joystick.element.style.display = "";
      fireButton.style.display = "";
      const angles = sceneManager.getCameraAngles();
      // Out-of-band guard (F3 death/disconnect note): a stale mirrored
      // charge pitch (down to -CAMERA_PITCH_MAX) can survive a disconnect /
      // rejoin on the camera (applySnapshot never touches it). Normalize the
      // camera into the default band here — the hover->follow cut hides the
      // step — so aim starts in-band and the plain per-frame track below
      // cannot re-corrupt it.
      sceneManager.setCameraAngles(angles.yaw, angles.pitch);
      const normalized = sceneManager.getCameraAngles();
      aimYaw = normalized.yaw;
      aimPitch = normalized.pitch;
      isCharging = false;
      chargeLevel.active = false;
      sceneManager.cancelShotBodyTurn();
      isReloading = false;
      reloadUntilMs = 0;
      sceneManager.setCharge01(0);
      sceneManager.setChargeZoom01(0);
      sceneManager.setChargeTranslucent(false);
      aimOverlay.setCharge01(0);
      aimOverlay.setReload01(1);
      aimOverlay.hide();
      hud.addKillfeed(`Joined as ${nick}`);
      hideJoinOverlay();
    },
    onSpectator: (sessionId): void => {
      void sessionId;
      // Still watching: keep the plate + hover camera, controls hidden.
      if (!isPlaying) {
        showJoinOverlay();
      }
    },
    onRoomFull: (message): void => {
      // Explicit capacity rejection: never leave the player on a silent
      // overlay — show the plate again with feedback instead of hanging.
      isPlaying = false;
      isCharging = false;
      chargeLevel.active = false;
      sceneManager.cancelShotBodyTurn();
      isReloading = false;
      sceneManager.setCharge01(0);
      sceneManager.setChargeZoom01(0);
      sceneManager.setChargeTranslucent(false);
      aimOverlay.setCharge01(0);
      aimOverlay.setReload01(1);
      aimOverlay.hide();
      hud.addKillfeed(message);
      hud.setStatus("Room is full — try again later");
      showJoinOverlay();
    },
    onKillfeed: (message): void => {
      hud.addKillfeed(message);
    },
    onBallHit: (info): void => {
      // Server player-hit event: red blood burst at the impact position.
      // The ball id is marked inside notifyBallHit so the snapshot vanish
      // that follows skips the neutral env puff (no double effect).
      sceneManager.notifyBallHit(info.ballId, info.x, info.y, info.z, info.super);
    },
    onLeave: (): void => {
      latest = null;
      isPlaying = false;
      isCharging = false;
      chargeLevel.active = false;
      sceneManager.cancelShotBodyTurn();
      isReloading = false;
      hasSuperBuff = false;
      sceneManager.setCharge01(0);
      sceneManager.setChargeZoom01(0);
      sceneManager.setChargeTranslucent(false);
      sceneManager.setBattleSnapshot([], null);
      aimOverlay.setCharge01(0);
      aimOverlay.setReload01(1);
      aimOverlay.hide();
      hud.setSuperBadge(false);
      sceneManager.setSpectating(true);
      joystick.element.style.display = "none";
      fireButton.style.display = "none";
      hud.setStatus("Disconnected — press Play to rejoin");
      showJoinOverlay();
    },
    onError: (message): void => {
      hud.addKillfeed(`Net error: ${message}`);
    },
  });

  const applySnapshot = (snapshot: RoomSnapshot): void => {
    // Top bar timer + score always visible (QD3); R2 halves (4 hearts x
    // full/half/empty from halvesForHp). Status line shows live counters
    // only (Players N | Watching M) — runners never see a spectator list.
    // Balls + SUPER core go straight to the scene (null hides the core).
    sceneManager.setBattleSnapshot(snapshot.balls, snapshot.super ?? null);
    const counters = formatCounters(snapshot.players);
    const selfId = net.ownSessionId;
    const self = snapshot.players.find((player) => player.sessionId === selfId);
    if (self !== undefined) {
      hud.setScore(self.score);
      hud.setHearts(halvesForHp(self.hp));
      hasSuperBuff = self.superBuff === true;
      const canShowSuper = isPlaying && !sceneManager.isSpectating();
      hud.setSuperBadge(canShowSuper && hasSuperBuff);
      aimOverlay.setSuper(canShowSuper && hasSuperBuff);
    } else {
      hasSuperBuff = false;
      hud.setSuperBadge(false);
      aimOverlay.setSuper(false);
    }
    if (self !== undefined && isPlaying && !self.alive) {
      hud.setStatus("Fragged — respawning…");
    } else {
      hud.setStatus(counters);
    }
    // Self spawn tracking: while fighting, an alive-again transition means
    // the server respawned us at a fresh corner — teleport the local avatar
    // + Rapier body there (no 28m respawn gap). The first alive sighting
    // after welcome is also teleported when the welcome payload carried no
    // coords (compat path); per-frame reconcileSelf below then keeps drift
    // bounded without jitter. The reverse transition (alive -> dead) pops
    // the death burst at the last known position so frags read instantly.
    if (self !== undefined && isPlaying && self.alive && !sceneManager.isSpectating()) {
      if (lastSelfAlive === false) {
        sceneManager.teleportSelf(self.x, self.z);
      } else if (lastSelfAlive === null) {
        const local = sceneManager.getAvatarPosition();
        const gap = Math.hypot(self.x - local.x, self.z - local.z);
        if (gap > SELF_RECONCILE_SNAP_M) {
          sceneManager.teleportSelf(self.x, self.z);
        }
      }
      lastSelfAlive = true;
    } else if (self !== undefined && isPlaying) {
      if (lastSelfAlive === true && self.alive === false && !sceneManager.isSpectating()) {
        sceneManager.spawnDeathBurst(self.x, 1.2, self.z, ownerColorForSession(self.sessionId, selfId));
        sceneManager.cancelShotBodyTurn();
      }
      lastSelfAlive = false;
    }
    if (snapshot.phase === "lobby") {
      hud.setTimer(ROUND_SECONDS);
    } else if (snapshot.phase === "countdown") {
      hud.setTimer(snapshot.countdownMs / 1000);
    } else if (snapshot.phase === "playing") {
      hud.setTimer(snapshot.remainingMs / 1000);
    } else {
      hud.setTimer(0);
      const winner = snapshot.players.find((player) => player.sessionId === snapshot.winner);
      if (winner !== undefined && (self === undefined || self.alive || !isPlaying)) {
        hud.setStatus(`${winner.nick} wins! ${counters}`);
      }
    }
  };
  // R1 Play: while offline it connects as a spectator first and then sends
  // "play" with a validated nick (empty input -> Guest-XXXX); while already
  // connected it just sends "play". The server replies with "welcome".
  const handlePlay = (): void => {
    if (connecting) {
      return;
    }
    const nick = normalizePlayNick(nickInput.value);
    if (!net.isConnected) {
      connecting = true;
      playButton.textContent = "Joining…";
      net
        .connect("")
        .then((): void => {
          connecting = false;
          playButton.textContent = "Play";
          net.sendPlay(nick);
        })
        .catch((error: unknown): void => {
          connecting = false;
          playButton.textContent = "Play";
          const message = error instanceof Error ? error.message : "join failed";
          hud.addKillfeed(`Join failed (${message}) — practice mode`);
          hud.setStatus("Server unreachable — practice mode, retry Play");
        });
      return;
    }
    net.sendPlay(nick);
  };
  playButton.addEventListener("click", handlePlay);
  // Enter with a nick joins the arena room (same path as Play click).
  nickInput.addEventListener("keydown", (event: KeyboardEvent): void => {
    if (event.code === "Enter" || event.code === "NumpadEnter") {
      event.preventDefault();
      handlePlay();
    }
  });

  // R1 auto-join: connect immediately as a spectator (no nick needed) so
  // boot shows the live arena from the hover camera behind the plate.
  // Failures keep the local test scene + plate (practice mode, retry Play).
  const connectAsSpectator = (): void => {
    if (connecting || net.isConnected) {
      return;
    }
    connecting = true;
    net
      .connect("")
      .then((): void => {
        connecting = false;
      })
      .catch((error: unknown): void => {
        connecting = false;
        const message = error instanceof Error ? error.message : "join failed";
        hud.addKillfeed(`Spectate failed (${message}) — practice mode`);
        hud.setStatus("Server unreachable — practice mode, retry Play");
      });
  };

  // R2 release-to-fire FSM: hold (floating right-half / aim stick / FIRE /
  // Space / LMB) to charge, release to sendFire. Quick tap >=80ms fires a
  // weak shot. Gated by playing + alive. Precision pass: aim is NEVER locked
  // at charge-start. The shot direction is resolved at RELEASE moment from
  // the live aim (camera + stick/float), so PC mouse and the mobile gesture
  // share one fire-time path. Charge feeds power/speed/damage only.
  function isSelfAlive(): boolean {
    const selfId = net.ownSessionId;
    if (selfId === null || latest === null) {
      return true;
    }
    const self = latest.players.find((player) => player.sessionId === selfId);
    if (self === undefined) {
      return true;
    }
    return self.alive;
  }

  function startCharge(): void {
    if (!isPlaying || sceneManager.isSpectating()) {
      return;
    }
    if (isCharging) {
      return;
    }
    const nowMs = Date.now();
    if (nowMs < reloadUntilMs) {
      return;
    }
    if (!isSelfAlive()) {
      return;
    }
    isCharging = true;
    chargeStartMs = nowMs;
    // Stage 4e: a charge takes over the right half — drop any active
    // free-camera drag so a second finger cannot swing aim mid-charge (new
    // right-half downs stay ignored until the charge ends, see camDown).
    touchState.clearCam();
    // A new aim takes over the camera: the charge zoom path starts clean. A
    // re-aim also cancels any pending post-shot body turn (a fresh shot
    // re-arms it on release).
    chargeMirrored = false;
    sceneManager.cancelShotBodyTurn();
    // One-shot pitch leveling armed: the camera eases toward the horizon
    // until the first FIRE-aim deflection takes over (per-frame below).
    chargeLevel = beginChargeLevel();
    // Stage 4d.2: avatar fades from charge start until the actual shot /
    // cancel; zoom starts at default and eases per-frame below.
    sceneManager.setChargeTranslucent(true);
    sceneManager.setChargeZoom01(0);
    // No aim snapshot here: direction resolves at release (stopCharge).
    aimOverlay.show();
  }

  function cancelCharge(): void {
    if (!isCharging) {
      return;
    }
    isCharging = false;
    chargeLevel.active = false;
    sceneManager.cancelShotBodyTurn();
    sceneManager.setCharge01(0);
    // Stage 4d.2: cancel returns zoom + opacity (eased, never mid-charge).
    sceneManager.setChargeZoom01(0);
    sceneManager.setChargeTranslucent(false);
    aimOverlay.setCharge01(0);
    aimOverlay.setTrajectory(null);
    aimOverlay.hide();
  }

  function stopCharge(): void {
    if (!isCharging) {
      return;
    }
    const nowMs = Date.now();
    const chargeMs = nowMs - chargeStartMs;
    isCharging = false;
    chargeLevel.active = false;
    sceneManager.setCharge01(0);
    // Stage 4d.2: the shot (or tap) returns zoom + opacity — held until here,
    // never reset mid-charge or on FIRE-aim moves.
    sceneManager.setChargeZoom01(0);
    sceneManager.setChargeTranslucent(false);
    aimOverlay.setCharge01(0);
    aimOverlay.setTrajectory(null);
    aimOverlay.hide();
    if (chargeMs < TAP_FIRE_MIN_S * 1000) {
      return;
    }
    // Cancel without local reload visuals when the shot cannot reach the
    // server: not fighting, offline, or round phase is not playing (the
    // server rejects fire outside playing, so a local 2.5s spin desyncs).
    if (!isPlaying || sceneManager.isSpectating()) {
      return;
    }
    if (!net.isConnected) {
      return;
    }
    if (latest !== null && latest.phase !== "playing") {
      return;
    }
    if (!isSelfAlive()) {
      return;
    }
    // Fire-time aim (shared PC + mobile path): with FIRE, float and camera
    // idle the shot goes exactly where the camera looks RIGHT NOW (release
    // moment), never where it looked at charge-start. A deflected FIRE/float
    // vector keeps the live integrated aimYaw/aimPitch below, so aiming works.
    const fireVec = touchState.fireVector();
    const camVec = touchState.camVector();
    const fireIdle = Math.abs(fireVec.x) < 0.05 && Math.abs(fireVec.y) < 0.05;
    const floatIdle = Math.abs(floatVector.x) < 0.05 && Math.abs(floatVector.y) < 0.05;
    const camIdle = Math.abs(camVec.x) < 0.05 && Math.abs(camVec.y) < 0.05;
    if (fireIdle && floatIdle && camIdle) {
      const releaseAngles = sceneManager.getCameraAngles();
      aimYaw = releaseAngles.yaw;
      // F1: during charge the camera holds the MIRRORED pitch, so copying it
      // back raw sign-inverts the shot. Un-mirror through the shared helper
      // (exact involution on the band — see unmirrorChargeCameraPitch) and
      // clamp to the aim band. The chargeMirrored flag covers a charge with
      // zero ticks (background-tab rAF stall): the camera was never mirrored,
      // so the plain copy is already true aim. This one site serves ALL
      // release flows (Space keyup, FIRE pointerup, float LMB pointerup — the
      // FIRE and float paths zero their vector just before, so they always
      // land here) — there is no other camera->aim copy on release.
      const unmirrored = chargeMirrored
        ? unmirrorChargeCameraPitch(releaseAngles.pitch)
        : releaseAngles.pitch;
      aimPitch = Math.max(CAMERA_PITCH_MIN, Math.min(CAMERA_PITCH_MAX, unmirrored));
      chargeMirrored = false;
    }
    const power01 = chargeToPower01(chargeMs / 1000);
    const selfPos = sceneManager.getAvatarPosition();
    // Release-moment aim: the SAME raw aimYaw/aimPitch the preview has been
    // showing, so payload == preview by construction. No assist — the shot
    // goes exactly where the player aims.
    // The server spawns at torso height on our elevation: send the live
    // body-center y (avatar position.y) with the payload so platform and
    // mid-jump throws leave the hand, not the feet.
    net.sendFire({
      power01,
      yaw: aimYaw,
      pitch: aimPitch,
      super: hasSuperBuff,
      throwerY: selfPos.y,
    });
    // Post-shot body turn (owner fix round 2): after a REAL shot the body
    // turns to face the shot direction (setShotTurnTarget eases the SAME
    // avatar.rotation.y the movement writer owns — which is also the rotY
    // sent upstream every tick, so remotes learn the turn via the existing
    // pass-through, no server change). Skipped while the move stick is held:
    // movement owns yaw then (update() would cancel it next frame anyway).
    // Camera needs no suppression: the follow reads getAvatarFacing()
    // live and converges behind the shot dir as the body settles (~0.25s).
    const shotMove = input.getMoveVector();
    if (shotMove.x * shotMove.x + shotMove.y * shotMove.y <= IDLE_RECENTER_MOVE_MAX * IDLE_RECENTER_MOVE_MAX) {
      sceneManager.setShotTurnTarget(aimYaw);
    }
    // Instant local feedback (<1 frame, zero network wait): pooled flash AT
    // the hand (bodyCenter XZ + dir*0.7, y = bodyY + torso offset) so the eye
    // sees the shot leave the hand before the server round-trip. The
    // authoritative ball eases in later via BallsPool lerp.
    const muzzle = muzzleForShot(selfPos.x, selfPos.y, selfPos.z, aimYaw, aimPitch);
    sceneManager.flashMuzzle(muzzle.x, muzzle.y, muzzle.z, hasSuperBuff, LOCAL_AVATAR_COLOR);
    // Instant client recoil (mirrors the authoritative server kick): nudge
    // the avatar opposite the fire dir so the shot feels punchy with zero
    // network wait. The server re-applies the same kick authoritatively.
    sceneManager.applyRecoilKick(power01);
    sceneManager.playThrow();
    hasSuperBuff = false;
    hud.setSuperBadge(false);
    aimOverlay.setSuper(false);
    isReloading = true;
    reloadUntilMs = nowMs + RELOAD_MS;
  }

  // Stage 4e FIRE (mobile charge + aim, PUBG-style): pointerdown captures the
  // pointer so the same thumb sliding off the button keeps aiming (all later
  // routing is by pointer id on window, never by target); release anywhere
  // fires via stopCharge (tap guard inside), pointercancel discards. There is
  // deliberately NO pointerleave handler — leaving the button must not
  // cancel a held charge.
  const handleFirePointerDown = (event: Event): void => {
    event.preventDefault();
    startCharge();
    // Arm FIRE tracking only for a live charge: a press during reload finds
    // no charge and tracks nothing (same as the legacy button, which only
    // held what startCharge accepted).
    if (!isCharging) {
      return;
    }
    const pointerId = readPointerId(event);
    const point = readClientPoint(event);
    if (pointerId === null || point === null) {
      return;
    }
    const capturable = fireButton as unknown as { setPointerCapture?: unknown };
    if (typeof capturable.setPointerCapture === "function") {
      try {
        (capturable as unknown as { setPointerCapture(id: number): void }).setPointerCapture(pointerId);
      } catch {
        // Pointer capture unsupported here (some stubs): the window-level
        // move/up handlers below still route by id, so aiming and release
        // keep working without it.
      }
    }
    touchState.fireDown({ pointerId, x: point.x, y: point.y });
  };

  // Window-level FIRE gesture: id-keyed, target-free (capture retargets moves
  // to the button and they bubble here; without capture the finger's own
  // element bubbles here) — slide-off keeps aiming, release anywhere fires.
  const handleFirePointerMove = (event: Event): void => {
    const pointerId = readPointerId(event);
    if (pointerId === null || !touchState.isFirePointer(pointerId)) {
      return;
    }
    const point = readClientPoint(event);
    if (point === null) {
      return;
    }
    event.preventDefault();
    touchState.fireMove({ pointerId, x: point.x, y: point.y });
  };

  const handleFirePointerUp = (event: Event): void => {
    if (!touchState.isFireActive()) {
      return;
    }
    const pointerId = readPointerId(event);
    if (pointerId !== null && !touchState.isFirePointer(pointerId)) {
      return;
    }
    // The router zeroes the FIRE vector first, so the release resolves from
    // the mirrored camera exactly like the legacy zero-before-stop ordering.
    touchState.fireUp(pointerId);
    stopCharge();
  };

  const handleFirePointerCancel = (event: Event): void => {
    if (!touchState.isFireActive()) {
      return;
    }
    const pointerId = readPointerId(event);
    if (pointerId !== null && !touchState.isFirePointer(pointerId)) {
      return;
    }
    touchState.fireCancel(pointerId);
    cancelCharge();
  };

  fireButton.addEventListener("pointerdown", handleFirePointerDown);

  // Floating LMB aim (PC parity): LMB hold on the canvas charges + previews +
  // aims, release fires. Touch never charges here — right-half touch is free
  // camera (cam path below), the left half belongs to the move stick. RMB
  // free-look is kept only while NOT charging (tick zeroes look deltas during
  // charge). Strict TS: DOM payloads read through guarded local readers.
  function readPointerId(event: Event): number | null {
    const value = (event as unknown as { pointerId?: unknown }).pointerId;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  function readClientPoint(event: Event): { x: number; y: number } | null {
    const body = event as unknown as { clientX?: unknown; clientY?: unknown };
    if (typeof body.clientX !== "number" || typeof body.clientY !== "number") {
      return null;
    }
    if (!Number.isFinite(body.clientX) || !Number.isFinite(body.clientY)) {
      return null;
    }
    return { x: body.clientX, y: body.clientY };
  }

  function readPointerKind(event: Event): { type: string | null; button: number | null } {
    const body = event as unknown as { pointerType?: unknown; button?: unknown };
    return {
      type: typeof body.pointerType === "string" ? body.pointerType : null,
      button: typeof body.button === "number" ? body.button : null,
    };
  }

  function targetOnGameUi(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) {
      return false;
    }
    if (target instanceof HTMLInputElement || target instanceof HTMLButtonElement) {
      return true;
    }
    return target.closest("#join-overlay,#joystick,#fire-button") !== null;
  }

  function overlayOpen(): boolean {
    return overlay.style.display !== "none";
  }

  const handleFloatPointerDown = (event: Event): void => {
    if (!isPlaying || sceneManager.isSpectating()) {
      return;
    }
    if (isTypingTarget(event)) {
      return;
    }
    const target = (event as unknown as { target?: unknown }).target as EventTarget | null;
    if (targetOnGameUi(target)) {
      return;
    }
    if (overlayOpen() && target instanceof HTMLElement && target.closest("#join-overlay") !== null) {
      return;
    }
    const pointerId = readPointerId(event);
    const point = readClientPoint(event);
    const kind = readPointerKind(event);
    if (pointerId === null || point === null) {
      return;
    }
    if (kind.type === "touch") {
      // Stage 4e: touch never charges here — right-half touch drags are free
      // camera (cam path below, no charge) and the left half belongs to the
      // move stick.
      return;
    }
    // PC parity via the same path: LMB on the canvas starts charge.
    // Guard typing/join overlay; RMB stays free-look (InputController).
    if (kind.button !== 0) {
      return;
    }
    if (overlayOpen()) {
      return;
    }
    if (!(target instanceof HTMLElement) || target !== engine.renderer.domElement) {
      // Canvas-only so HUD/DOM clicks never charge.
      return;
    }
    if (floatActive) {
      return;
    }
    floatActive = true;
    floatPointerId = pointerId;
    floatOriginX = point.x;
    floatOriginY = point.y;
    floatVector = { x: 0, y: 0 };
    startCharge();
  };

  const handleFloatPointerMove = (event: Event): void => {
    if (!floatActive) {
      return;
    }
    const pointerId = readPointerId(event);
    if (pointerId === null || pointerId !== floatPointerId) {
      return;
    }
    const point = readClientPoint(event);
    if (point === null) {
      return;
    }
    const radius = FLOAT_DRAG_RADIUS_PX > 0 ? FLOAT_DRAG_RADIUS_PX : 80;
    let dx = (point.x - floatOriginX) / radius;
    let dy = (point.y - floatOriginY) / radius;
    const length = Math.hypot(dx, dy);
    if (length > 1) {
      dx /= length;
      dy /= length;
    }
    // Joystick convention: screen-up means +y (pitch up).
    floatVector = { x: applyExpo(dx, AIM_EXPO), y: applyExpo(-dy, AIM_EXPO) };
  };

  const handleFloatPointerUp = (event: Event): void => {
    if (!floatActive) {
      return;
    }
    const pointerId = readPointerId(event);
    if (pointerId !== null && pointerId !== floatPointerId) {
      return;
    }
    floatActive = false;
    floatPointerId = null;
    floatVector = { x: 0, y: 0 };
    stopCharge();
  };

  const handleFloatPointerCancel = (event: Event): void => {
    if (!floatActive) {
      return;
    }
    const pointerId = readPointerId(event);
    if (pointerId !== null && pointerId !== floatPointerId) {
      return;
    }
    floatActive = false;
    floatPointerId = null;
    floatVector = { x: 0, y: 0 };
    cancelCharge();
  };

  // Stage 4e free camera (touch-only, NO charge): touch-drag anywhere on the
  // RIGHT half (outside HUD buttons) rotates aimYaw/aimPitch at full rate and
  // the per-frame block below syncs the camera from aim (camera == aim while
  // idle, so no separate camera state). While charging, new downs are ignored
  // and any active drag was already dropped by startCharge — a second finger
  // never swings aim. touch-action:none lives on the canvas; preventDefault
  // here stops the browser from scrolling/zooming on the widened touch path.
  const handleCamPointerDown = (event: Event): void => {
    if (!isPlaying || sceneManager.isSpectating()) {
      return;
    }
    if (isTypingTarget(event)) {
      return;
    }
    const target = (event as unknown as { target?: unknown }).target as EventTarget | null;
    if (targetOnGameUi(target)) {
      return;
    }
    if (overlayOpen() && target instanceof HTMLElement && target.closest("#join-overlay") !== null) {
      return;
    }
    const pointerId = readPointerId(event);
    const point = readClientPoint(event);
    const kind = readPointerKind(event);
    if (pointerId === null || point === null) {
      return;
    }
    // Touch only: mouse uses LMB-charge parity (float path above) and RMB
    // free look (InputController).
    if (kind.type !== "touch") {
      return;
    }
    // Right half only — the left half belongs to the move stick.
    if (!isRightHalf(point.x, window.innerWidth)) {
      return;
    }
    event.preventDefault();
    touchState.camDown({ pointerId, x: point.x, y: point.y }, isCharging);
  };

  const handleCamPointerMove = (event: Event): void => {
    const pointerId = readPointerId(event);
    if (pointerId === null || !touchState.isCamPointer(pointerId)) {
      return;
    }
    const point = readClientPoint(event);
    if (point === null) {
      return;
    }
    event.preventDefault();
    touchState.camMove({ pointerId, x: point.x, y: point.y });
  };

  const handleCamPointerUp = (event: Event): void => {
    if (!touchState.isCamActive()) {
      return;
    }
    const pointerId = readPointerId(event);
    if (pointerId !== null && !touchState.isCamPointer(pointerId)) {
      return;
    }
    // Finger lifted: no charge calls and no automatic catch-up — the camera
    // holds until the player moves (follow) or looks again.
    touchState.camUp(pointerId);
  };

  const handleCamPointerCancel = (event: Event): void => {
    if (!touchState.isCamActive()) {
      return;
    }
    const pointerId = readPointerId(event);
    if (pointerId !== null && !touchState.isCamPointer(pointerId)) {
      return;
    }
    touchState.camCancel(pointerId);
  };

  window.addEventListener("pointerdown", handleFloatPointerDown);
  window.addEventListener("pointerdown", handleCamPointerDown);
  window.addEventListener("pointermove", handleFloatPointerMove);
  window.addEventListener("pointermove", handleFirePointerMove);
  window.addEventListener("pointermove", handleCamPointerMove);
  window.addEventListener("pointerup", handleFloatPointerUp);
  window.addEventListener("pointerup", handleFirePointerUp);
  window.addEventListener("pointerup", handleCamPointerUp);
  window.addEventListener("pointercancel", handleFloatPointerCancel);
  window.addEventListener("pointercancel", handleFirePointerCancel);
  window.addEventListener("pointercancel", handleCamPointerCancel);

  // Async Rapier WASM boot. The scene stays playable on the legacy
  // kinematic path when physics fails — never a fatal error.
  const physicsReady = await sceneManager.initPhysics();
  hud.addKillfeed(physicsReady ? "Physics ready — have fun!" : "Physics offline — fallback movement");

  const handleKeyDown = (event: KeyboardEvent): void => {
    // Typing a nick must never fire Space/H/R/power-up shortcuts.
    if (isTypingTarget(event)) {
      return;
    }
    const granted = POWERUP_KEYS[event.code];
    if (granted !== undefined) {
      // Spectators have no avatar: power-up grants are fighters-only, same
      // gate as Space/fire below.
      if (!isPlaying) {
        return;
      }
      sceneManager.grantPowerUp(granted);
      hud.addKillfeed(`Power-up granted: ${granted}`);
      return;
    }
    if (event.code === "Space") {
      event.preventDefault();
      // R2 Space hold charges, release fires (same FSM as sticks). Gated
      // inside startCharge by isPlaying && !spectating && alive + reload.
      if (!event.repeat) {
        if (isPlaying && !sceneManager.isSpectating()) {
          startCharge();
        }
      }
      return;
    }
    if (event.code === "KeyH") {
      // Test-scene hit: a shield charge absorbs one hit, otherwise the HUD
      // loses one heart (QD3: 1 hit = 1 heart). Fighters-only: spectators
      // must not fake hearts while watching.
      if (!isPlaying) {
        return;
      }
      const absorbed = sceneManager.applyTestHit();
      if (absorbed) {
        hud.addKillfeed("Shield absorbed the hit");
      } else {
        hud.simulateHit("test hit");
      }
    }
    if (event.code === "KeyR") {
      // Scene reset is fighters-only: a spectator pressing R must not wipe
      // the watched arena or fake the HUD timer/score/hearts.
      if (!isPlaying) {
        return;
      }
      sceneManager.reset();
      input.reset();
      isCharging = false;
      chargeLevel.active = false;
      sceneManager.cancelShotBodyTurn();
      isReloading = false;
      reloadUntilMs = 0;
      touchState.reset();
      floatActive = false;
      floatPointerId = null;
      floatVector = { x: 0, y: 0 };
      sceneManager.setCharge01(0);
      aimOverlay.setCharge01(0);
      aimOverlay.setReload01(1);
      aimOverlay.hide();
      hud.setTimer(ROUND_SECONDS);
      hud.setScore(START_SCORE);
      hud.setHeartsFromHearts(MAX_HEARTS);
    }
  };
  window.addEventListener("keydown", handleKeyDown);

  const handleKeyUp = (event: KeyboardEvent): void => {
    if (isTypingTarget(event)) {
      return;
    }
    if (event.code === "Space") {
      event.preventDefault();
      stopCharge();
    }
  };
  window.addEventListener("keyup", handleKeyUp);

  const handlePageHide = (): void => {
    window.removeEventListener("keydown", handleKeyDown);
    window.removeEventListener("keyup", handleKeyUp);
    window.removeEventListener("pointerdown", handleFloatPointerDown);
    window.removeEventListener("pointerdown", handleCamPointerDown);
    window.removeEventListener("pointermove", handleFloatPointerMove);
    window.removeEventListener("pointermove", handleFirePointerMove);
    window.removeEventListener("pointermove", handleCamPointerMove);
    window.removeEventListener("pointerup", handleFloatPointerUp);
    window.removeEventListener("pointerup", handleFirePointerUp);
    window.removeEventListener("pointerup", handleCamPointerUp);
    window.removeEventListener("pointercancel", handleFloatPointerCancel);
    window.removeEventListener("pointercancel", handleFirePointerCancel);
    window.removeEventListener("pointercancel", handleCamPointerCancel);
    playButton.removeEventListener("click", handlePlay);
    fireButton.removeEventListener("pointerdown", handleFirePointerDown);
    void net.disconnect();
    joystick.destroy();
    aimOverlay.dispose();
    hud.dispose();
    input.dispose();
    remotes.dispose();
    sceneManager.dispose();
    engine.dispose();
    if (overlay.parentElement === document.body) {
      document.body.removeChild(overlay);
    }
    if (fireButton.parentElement === document.body) {
      document.body.removeChild(fireButton);
    }
  };
  window.addEventListener("pagehide", handlePageHide);

  // Honest trajectory preview: the same v0 (charge power -> speed) and
  // gravity the authoritative server integrates, sampled at fixed steps and
  // projected to screen-space offsets from the crosshair. Runs while
  // charging so the dots move with power + aim. DOM overlay only.
  // Direction == payload direction by construction: both read raw
  // aimYaw/aimPitch directly (no assist, no throttle). Time base includes
  // the server first-tick hold (previewTimeAt), matching the first patched
  // ball frame.
  const projScratch = new THREE.Vector3();
  function computeAimTrajectory(): TrajSample[] {
    const chargeS = Math.max(0, (Date.now() - chargeStartMs) / 1000);
    const speed = powerToSpeed(chargeToPower01(chargeS));
    const dir = directionFromYawPitch(aimYaw, aimPitch);
    const origin = sceneManager.getAvatarPosition();
    // Identical muzzle helper as the fire path (bodyCenter XZ + dir*0.7,
    // y = bodyY + torso offset) so the preview tracks elevation too.
    const muzzle = muzzleForShot(origin.x, origin.y, origin.z, aimYaw, aimPitch);
    const muzzleX = muzzle.x;
    const muzzleY = muzzle.y;
    const muzzleZ = muzzle.z;
    const width = window.innerWidth;
    const height = window.innerHeight;
    engine.camera.updateMatrixWorld();
    const samples: TrajSample[] = [];
    // Start at the first-tick hold (muzzle + one server tick) so the first
    // dot matches the first patched ball frame — same origin/offset/height/
    // gravity as the authoritative spawn.
    for (let i = 0; i < TRAJ_DOT_COUNT; i += 1) {
      const t = previewTimeAt(i);
      projScratch.set(
        muzzleX + dir.x * speed * t,
        muzzleY + dir.y * speed * t - 0.5 * BALL_GRAVITY * t * t,
        muzzleZ + dir.z * speed * t,
      );
      projScratch.project(engine.camera);
      const behind = projScratch.z > 1 || projScratch.z < -1;
      const rawX = projScratch.x * (width / 2);
      const rawY = -projScratch.y * (height / 2);
      samples.push({
        x: Math.max(-width / 2 + 6, Math.min(width / 2 - 6, rawX)),
        y: Math.max(-height / 2 + 6, Math.min(height / 2 - 6, rawY)),
        visible: !behind,
      });
    }
    return samples;
  }

  engine.onUpdate((deltaSeconds): void => {
    if (deltaSeconds <= 0) {
      return;
    }
    // R1: spectators send no movement — gate inputs by the playing flag
    // (SceneManager also ignores them while spectating; belt and braces).
    // Dead fighters drive nothing: with instant respawn the dead window is
    // ~1 tick, but while a dead snapshot is live the avatar must freeze
    // instead of running on (movement + upstream input gated here; camera
    // look below stays free so the death read is never disorienting).
    // Look deltas are still consumed so they never pile up before welcome.
    const rawMove = input.getMoveVector();
    const rawLook = input.consumeLookDelta();
    const playing = isPlaying && !sceneManager.isSpectating();
    const selfAlive = lastSelfAlive !== false;
    const move = playing && selfAlive ? rawMove : { x: 0, y: 0 };
    // While charging the camera mirrors aim (one-thumb 360 turn); RMB
    // free-look applies only when NOT charging.
    const look = playing ? (isCharging ? { dx: 0, dy: 0 } : rawLook) : { dx: 0, dy: 0 };
    // R2 aim + charge + reload tick (fighters only, spectators gated out).
    // Aim rule: a deflected FIRE/float vector integrates yaw/pitch at the
    // shared rate (aiming, also while charging); idle FIRE AND idle float AND
    // idle camera track the live camera every frame — but ONLY when not
    // charging (shouldTrackAimFromCamera: during charge the camera is the
    // mirrored derived value, so copying it back would sign-flip the aim).
    // While charging the camera takes the aim yaw and the MIRRORED aim pitch
    // each frame (360-degree one thumb turn, aim-up drops the camera to look
    // up the arc — see mirrorChargeCameraPitch). Charge only drives power
    // (charge01), never direction.
    // Charge leveling: at aim start the pitch eases ONCE toward the horizon
    // (interrupted by any aim deflection); while charging both aim rates
    // run damped (calmer aiming, full down-aim range kept).
    if (playing) {
      const pitchScale = pitchRateScale(isCharging);
      const yawScale = yawRateScale(isCharging);
      // Live vector references (mutated in place by the pointer handlers,
      // never replaced): reading them here allocates nothing per frame.
      const fireVector = touchState.fireVector();
      const camVector = touchState.camVector();
      if (Math.hypot(fireVector.x, fireVector.y) >= FLOAT_DEADZONE) {
        aimYaw -= fireVector.x * AIM_YAW_RATE * yawScale * deltaSeconds;
        const nextPitch = aimPitch + fireVector.y * AIM_PITCH_RATE * pitchScale * deltaSeconds;
        aimPitch = Math.max(CAMERA_PITCH_MIN, Math.min(CAMERA_PITCH_MAX, nextPitch));
      }
      if (Math.hypot(floatVector.x, floatVector.y) >= FLOAT_DEADZONE) {
        aimYaw -= floatVector.x * AIM_YAW_RATE * yawScale * deltaSeconds;
        const nextFloatPitch = aimPitch + floatVector.y * AIM_PITCH_RATE * pitchScale * deltaSeconds;
        aimPitch = Math.max(CAMERA_PITCH_MIN, Math.min(CAMERA_PITCH_MAX, nextFloatPitch));
      }
      // Stage 4e touch free camera (no charge): the right-half drag vector
      // integrates into aimYaw/aimPitch with the SAME expo/deadzone/rates as
      // the paths above — pitchRateScale/yawRateScale return 1 when not
      // charging, so this is full-rate. The camera then takes aim directly
      // (default band): camera == aim while idle, so this rotates the view
      // with zero new state. Suppressed while charging (charge start drops
      // the drag, new downs are ignored) so a second finger never swings aim.
      if (!isCharging) {
        if (Math.hypot(camVector.x, camVector.y) >= FLOAT_DEADZONE) {
          aimYaw -= camVector.x * AIM_YAW_RATE * yawScale * deltaSeconds;
          const nextCamPitch = aimPitch + camVector.y * AIM_PITCH_RATE * pitchScale * deltaSeconds;
          aimPitch = Math.max(CAMERA_PITCH_MIN, Math.min(CAMERA_PITCH_MAX, nextCamPitch));
          sceneManager.setCameraAngles(aimYaw, aimPitch);
        }
      }
      // Idle soft-follow (Stage 4d.2-fix2): not charging, no explicit look
      // input, avatar moving with the stick predominantly forward → ease the
      // camera yaw behind the avatar's facing yaw and level the pitch toward
      // near-horizon. The yaw target
      // is cameraYawBehindFacing(facing) = facing + PI (camera-behind
      // convention: camera sits at avatar + (sin c, cos c)*d per
      // updateCameraTransform while the avatar faces (sin r, cos r) per
      // the movement yaw, so behind requires c = r + PI — raw facing as a
      // target would sit exactly PI away and orbit ~1.3 rev/s). The
      // forwardness gate (|phi| <= IDLE_FOLLOW_MAX_STICK_ANGLE = PI/2 inside
      // shouldIdleFollow) is the orbit invariant: per frame facing is
      // recomputed as r = c + PI - phi, so only forward-through-sideways
      // inputs run the follow (|delta| <= phi <= PI/2, gentle straightening)
      // while backward-leaning inputs leave the camera untouched. The yaw rate
      // is softened by forwardnessRateScale(phi) = cos(phi) at the call site
      // (1.0 pure forward, ~0 at pure sideways; interior peak phi*cos(phi)
      // ~= 0.56 keeps drift <= RATE * 0.56 ~= 1.4 rad/s). Pitch levels at the
      // full rate. Gated
      // on rawLook == 0 so an RMB drag always wins; dead/spectating never
      // reach here (playing folds in !spectating, alive folds in the last
      // self snapshot). Runs before the idle-track copy below so aim
      // re-syncs to the followed camera in the same frame. Scalar math,
      // no per-frame allocations beyond the existing getCameraAngles shape
      // (gate runs through the reused idleFollowGate scratch above). Stage 4e:
      // an active free-camera drag counts as look input (same as an RMB drag)
      // so the follow never fights the finger.
      const camLook = touchState.isCamActive() ? 1 : 0;
      idleFollowGate.playing = playing;
      idleFollowGate.charging = isCharging;
      idleFollowGate.alive = lastSelfAlive !== false;
      idleFollowGate.lookDx = rawLook.dx + camLook;
      idleFollowGate.lookDy = rawLook.dy + camLook;
      idleFollowGate.moveX = move.x;
      idleFollowGate.moveY = move.y;
      if (shouldIdleFollow(idleFollowGate)) {
        const followed = sceneManager.getCameraAngles();
        const phi = stickAngleFromForward(move.x, move.y);
        const followRate = IDLE_FOLLOW_RATE * forwardnessRateScale(phi);
        sceneManager.setCameraAngles(
          stepIdleFollowYaw(
            followed.yaw,
            cameraYawBehindFacing(sceneManager.getAvatarFacing()),
            deltaSeconds,
            followRate,
          ),
          stepIdleFollowPitch(followed.pitch, deltaSeconds),
          // F3: tolerate a stale mirrored post-shot pitch until it eases
          // back into the default band (no one-frame snap).
          tolerantCameraPitchMin(followed.pitch),
          CAMERA_PITCH_MAX,
        );
      }
      // Idle aim-track (F2 fix): skipped entirely while charging — the
      // camera holds the mirrored pitch then, and copying it back would
      // sign-flip aimPitch every frame (30Hz oscillation with the mirror
      // write below). Aim is the source of truth during charge; this copy
      // only follows non-charge camera moves (RMB free-look). Stage 4e: an
      // active free-camera drag counts as look (floatIdle=false semantics —
      // the drag already integrated aim above, so the copy must not run).
      const fireIdle = Math.abs(fireVector.x) < 0.05 && Math.abs(fireVector.y) < 0.05;
      const floatIdle = Math.abs(floatVector.x) < 0.05 && Math.abs(floatVector.y) < 0.05;
      const camIdle = Math.abs(camVector.x) < 0.05 && Math.abs(camVector.y) < 0.05;
      if (shouldTrackAimFromCamera(isCharging, fireIdle, floatIdle && camIdle)) {
        const cam = sceneManager.getCameraAngles();
        aimYaw = cam.yaw;
        aimPitch = cam.pitch;
      }
      if (isCharging) {
        // One-shot level: no input → ease toward horizon; any deflection
        // hands control back to the aim instantly (damped rate above).
        const deflected =
          Math.hypot(fireVector.x, fireVector.y) >= FLOAT_DEADZONE ||
          Math.hypot(floatVector.x, floatVector.y) >= FLOAT_DEADZONE ||
          Math.hypot(camVector.x, camVector.y) >= FLOAT_DEADZONE;
        aimPitch = stepChargeLevel(chargeLevel, aimPitch, deflected, deltaSeconds);
        // Aim-mirror camera while charging (fix round 3): yaw follows aim
        // directly, pitch takes the negated aim pitch in the asymmetric
        // [MIRROR_MIN, MIRROR_MAX] band (the plain MIN -0.41 would clip the
        // mirror). The aim pitch itself stays in [MIN, MAX] above; the fire
        // payload keeps that band too — only the camera mirrors.
        sceneManager.setCameraAngles(
          aimYaw,
          mirrorChargeCameraPitch(aimPitch),
          MIRROR_PITCH_MIN,
          MIRROR_PITCH_MAX,
        );
        // This charge mirrored the camera at least once: stopCharge must
        // un-mirror the release copy back to true aim (F1).
        chargeMirrored = true;
      }
      // Aim feed every frame (recoil kick dir + spark emitter; body keeps
      // movement yaw — no barrel to track since 4d.1).
      sceneManager.setAimAngles(aimYaw, aimPitch);
      const nowMs = Date.now();
      if (isCharging) {
        const charge01 = Math.max(0, Math.min(1, (nowMs - chargeStartMs) / (CHARGE_MAX_S * 1000)));
        sceneManager.setCharge01(charge01);
        // Stage 4d.2: zoom follows charge01 every frame (eased in the scene),
        // held until stopCharge/cancelCharge — FIRE-aim moves never reset it.
        sceneManager.setChargeZoom01(charge01);
        aimOverlay.setCharge01(charge01);
      }
      // Charging locomotion mirror (bug C): the server simulates charging
      // fighters at CHARGE_MOVE_MULT, so the client prediction runs the same
      // factor — otherwise charge+walk diverges ~2.25 m/s and reconcile tugs
      // the preview origin every frame.
      sceneManager.setCharging(isCharging && playing);
      if (isReloading) {
        if (nowMs >= reloadUntilMs) {
          isReloading = false;
          aimOverlay.setReload01(1);
        } else {
          const progress = 1 - (reloadUntilMs - nowMs) / RELOAD_MS;
          aimOverlay.setReload01(progress);
        }
      } else if (!isCharging) {
        aimOverlay.setReload01(1);
      }
    }
    // Self reconciliation FIRST (playing + alive only): correct toward the
    // authoritative server self before local physics integrates, so input
    // builds on top of the authoritative base instead of overwriting the
    // correction same-frame. Lerp 0.5-6m, snap beyond, no jitter in band.
    if (latest !== null && playing) {
      const selfId = net.ownSessionId;
      const selfSnap = latest.players.find((player) => player.sessionId === selfId);
      if (selfSnap !== undefined && selfSnap.alive) {
        sceneManager.reconcileSelf(selfSnap.x, selfSnap.z, deltaSeconds);
      }
    }
    sceneManager.update(deltaSeconds, move, look);
    // Honest preview after the camera moved: dots track the real arc.
    if (playing && isCharging) {
      aimOverlay.setTrajectory(computeAimTrajectory());
    }
    for (const arenaEvent of sceneManager.drainEvents()) {
      if (arenaEvent.type === "pickup") {
        hud.addKillfeed(`Picked up ${arenaEvent.kind}`);
      } else if (arenaEvent.type === "trampoline") {
        hud.addKillfeed("Boing! Trampoline launch");
      } else {
        hud.addKillfeed("Speed boost expired");
      }
    }
    // Remote replication: ease every snapshot through lerp/slerp.
    if (latest !== null) {
      remotes.sync(latest.players, net.ownSessionId, deltaSeconds);
    }
    // Inputs-only upstream at 20 ticks/s: camera-relative stick (move.x/y)
    // rotated to WORLD-space via the shared worldMoveFromYaw helper (same
    // formula as SceneManager.update local physics) + avatar facing rotY.
    // The server applies input.x -> world X, input.y -> world Z directly.
    // R1: gated by the playing flag — spectators have no body to drive.
    // Dead fighters send nothing either (the server ignores dead inputs;
    // with instant respawn the gap is ~1 tick, but a dead snapshot must
    // never drive the corpse for even a frame).
    // R2: charging flag slows the server 50% while aiming a shot.
    if (net.isConnected && isPlaying && selfAlive) {
      inputAccumulator += deltaSeconds;
      if (inputAccumulator >= INPUT_SEND_INTERVAL_S) {
        inputAccumulator = 0;
        inputSeq += 1;
        const facing = sceneManager.getAvatarFacing();
        const cameraYaw = sceneManager.getCameraAngles().yaw;
        const world = worldMoveFromYaw(move.x, move.y, cameraYaw);
        net.sendInput(buildInputPayload(world.x, world.y, facing, inputSeq, isCharging));
      }
    }
  });
  // R1: join immediately as a spectator so boot shows the live arena.
  connectAsSpectator();
  engine.start();
}

void boot();
