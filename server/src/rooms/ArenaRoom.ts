import { Room, type Client } from "colyseus";
import {
  ARENA_HALF_SIZE,
  BALL_GRAVITY,
  BALL_GROUND_Y,
  BALL_HIT_RADIUS,
  BALL_HIT_PLAYER_MESSAGE,
  BALL_RADIUS,
  BALL_SETTLE_DAMP_RATE,
  BALL_SETTLE_TIME_MS,
  BALL_STEP_MAX_M,
  BODY_CENTER_Y,
  BOT_NAMES,
  BOT_SPEED,
  CHARGE_MOVE_MULT,
  FIRE_PITCH_MAX,
  FIRE_PITCH_MIN,
  GUEST_NICK_PREFIX,
  HIT_KNOCKBACK_M,
  INVULN_MS,
  LOBBY_COUNTDOWN_MS,
  MAX_BOTS,
  MAX_HP,
  MAX_LIVE_BALLS,
  MAX_PLAYERS,
  MIN_TOTAL_PLAYERS,
  NICK_MAX_LENGTH,
  PATCH_RATE_MS,
  PLAYER_BODY_RADIUS,
  PLAYER_SPEED,
  RAMP_ADMIT_MIN_FEET,
  RAMP_ENTRY_TOL,
  RAMP_LANE_CAPTURE_TOL,
  RELOAD_MS,
  REMATCH_DELAY_MS,
  RESPAWN_DELAY_MS,
  ROUND_DURATION_MS,
  ROUND_HARD_CAP_MS,
  SELF_ARMING_DIST_M,
  SELF_ARMING_TIME_S,
  SERVER_OBSTACLES,
  SERVER_PLATFORMS,
  SIM_TICK_MS,
  SPAWN_INSET,
  SUPER_LIFE_S,
  SUPER_PICKUP_RADIUS,
  SUPER_SPAWN_S,
  SUPPORT_STICK_TOL,
  TRAMPOLINE_MAX_AIR_S,
  WIN_SCORE,
} from "../config.js";
import { createBrain, planBotFire, stepBot, type BotBrain } from "../bots.js";
import {
  applyHit,
  bodyCenterYAt,
  bodyCenterYAtExpanded,
  canDamage,
  damageForPower,
  describeBallSurface,
  groundTopAt,
  isOnTrampolinePad,
  muzzleForShot,
  powerToSpeed,
  rampBandHeightAt,
  rampBandHeightAtExpanded,
  recoilDistanceForPower,
  resolveThrowerY,
  respawnPlayer,
  sanitizeNick,
  sanitizeThrowerY,
  trampolineArcY,
  type BallContact,
} from "../hits.js";
import { ArenaState, BallState, PlayerState, type RoundPhase } from "../state.js";
// Re-exported for unit-test compat (layout data now lives in config).
export { SERVER_OBSTACLES };

interface MoveInput {
  x: number;
  y: number;
  rotY: number;
  seq: number;
  charging: boolean;
}

export interface FirePayload {
  power01: number;
  yaw: number;
  pitch: number;
  super?: boolean;
  throwerY?: number;
}

// Future center-item kinds (extension hook, NOT implemented): "super" is
// the only live kind today (see tickCenterItems). "pineapple" (radius AoE
// on throw) and "heal" (+1 heart on pickup) plug in as new tick*Item()
// methods + ArenaState fields — no changes to the ball pipeline needed.
export type CenterItemKind = "super"; // | "pineapple" | "heal" (future)

// Server obstacle mirrors now live in config (SERVER_OBSTACLES, re-exported
// above for test compat) alongside SERVER_PLATFORMS.

function clampAxis(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(-1, Math.min(1, value));
}

function clampAngle(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return value;
}

// Server-side movement solid: XZ AABB with a top height, per-face openness,
// and a ramp corridor. Obstacles are closed on all four faces. Platforms
// leave their ramp-side face OPEN so fighters can walk up onto the top — but
// ONLY inside the capsule-overlap lane (lateral |offset| <= corridorHalf +
// body radius around the ramp centerline, bug round 6): the pass checks add
// the mover radius to the visual corridor half, matching the widened server
// slope band (hits.rampHeightAt) and the client Rapier edge contact.
// Skirting the ramp mouth at ground level stays blocked via the admitted
// gate (feet above RAMP_ADMIT_MIN_FEET). Corridor axis "z"
// means the ±x faces gate on the Z lateral (and vice versa); obstacles carry
// axis null (corridor never consulted — all faces closed).
interface MoveSolid {
  x: number;
  z: number;
  hx: number;
  hz: number;
  top: number;
  openMinX: boolean;
  openMaxX: boolean;
  openMinZ: boolean;
  openMaxZ: boolean;
  corridorAxis: "x" | "z" | null;
  corridorCenter: number;
  corridorHalf: number;
}

const MOVE_SOLIDS: readonly MoveSolid[] = [
  ...SERVER_OBSTACLES.map((block) => ({
    x: block.x,
    z: block.z,
    hx: block.hx,
    hz: block.hz,
    top: block.topY,
    openMinX: false,
    openMaxX: false,
    openMinZ: false,
    openMaxZ: false,
    corridorAxis: null as "x" | "z" | null,
    corridorCenter: 0,
    corridorHalf: 0,
  })),
  ...SERVER_PLATFORMS.map((platform) => ({
    x: platform.x,
    z: platform.z,
    hx: platform.hx,
    hz: platform.hz,
    top: platform.topY,
    openMinX: platform.rampSide === "-x",
    openMaxX: platform.rampSide === "+x",
    openMinZ: platform.rampSide === "-z",
    openMaxZ: platform.rampSide === "+z",
    corridorAxis: (platform.rampSide === "-x" || platform.rampSide === "+x" ? "z" : "x") as "x" | "z",
    corridorCenter: platform.rampSide === "-x" || platform.rampSide === "+x" ? platform.z : platform.x,
    corridorHalf: platform.rampWidth / 2,
  })),
];

// Strictly-inside test against the radius-expanded footprint. Strict (not
// <=): resting contact ON a face counts as outside, so a fighter pressed
// against a wall keeps colliding instead of flipping into the escape rule.
// The EPS shrinks the inside band by far more than float dust (~1e-16: the
// clamped face coord and the expanded bound round differently, which once
// let a pinned fighter read as "inside" one tick later and walk straight
// through the wall) yet far less than any real penetration, so genuinely
// embedded fighters (platform top, knockback) still escape.
const FOOTPRINT_EPS = 1e-9;
function insideSolidFootprint(solid: MoveSolid, x: number, z: number, radius: number): boolean {
  return (
    Math.abs(x - solid.x) < solid.hx + radius - FOOTPRINT_EPS &&
    Math.abs(z - solid.z) < solid.hz + radius - FOOTPRINT_EPS
  );
}

// Numeric guard for the elevation gate below: feet-vs-top comparisons within
// a micron read as level (float-exact in practice — derived heights snap —
// but the arc math rounds). Far below any real step, far above float dust.
const COLLISION_Y_EPS = 1e-6;
// Pads sit on open ground by layout (groundTop exactly 0 there); the launch
// guard tolerates a centimeter so float dust never blocks a real pad.
const TRAMPOLINE_GROUND_TOL = 0.01;
// Feet height of a body-center y (BODY_CENTER_Y above the feet on the level).
function feetYOf(bodyY: number): number {
  const center = Number.isFinite(bodyY) ? bodyY : BODY_CENTER_Y;
  return center - BODY_CENTER_Y;
}

// Authoritative XZ collision resolution (humans AND bots): per-axis swept
// clamp against every solid face (X first, then Z), so diagonal input slides
// along faces instead of sticking. A step can never tunnel (max ~0.23m per
// 50ms tick vs 1.25m+ expanded half extents).
// Elevation gates (bugs A/B + round 5 defect 1): feetY carries the mover's
// feet height (body-center y minus BODY_CENTER_Y).
// - A solid whose top sits at or below the feet (within the hysteresis stick
//   band) is skipped entirely — the fighter stands on top of it or flies
//   just at its level. The skip band is SUPPORT_STICK_TOL + COLLISION_Y_EPS
//   (not EPS alone): groundSupport keeps the radius-expanded top through the
//   0.5m ring while feet still match within SUPPORT_STICK_TOL, so a fighter
//   in the ring with feet up to 5cm below the top is still supported on top
//   and must walk freely (edge walk-back to center always works). The old
//   EPS-only gate blocked those TOL-window ring moves (invisible wall exactly
//   at the footprint boundary, only in the ring state). Ground entry stays
//   blocked: every solid top (0.8+) exceeds feet 0 + 0.05 by far. Defaults to
//   0 (ground crawler) so pre-elevation call sites behave exactly as before.
// - The ramp-side open face admits ONLY a mover that is actually climbing
//   (feet above RAMP_ADMIT_MIN_FEET) and ONLY inside the capsule-overlap lane
//   (|lateral| <= corridorHalf + radius, bug round 6, BUG 1): the authoritative
//   XZ is the capsule center, so a center up to one radius past the slab edge
//   still overlaps the ramp — the same contact the client Rapier resolves. The
//   admitted gate keeps ground entry blocked (a grounded fighter at the ramp
//   mouth is clamped like any sheer face: face-high surfaces never match feet
//   ~0, so the old no-ramp-band ground leak cannot reopen).
// - The inside-footprint escape is height-gated too: at/above the top the
//   fighter walks out freely (tower tops, knockback embeds at height); a
//   climber inside via the open face in-lane (feet up, lateral on the ramp)
//   passes freely as well; below the top anywhere else the mover is ejected
//   toward the nearest face on each axis — nobody gets trapped, and nobody
//   walks THROUGH to the far side.
// - Climb-lane capture (bug round 4, defect 2): kept as a fallback for an
//   admitted mover crossing a ramped solid's OPEN face off-corridor when the
//   target lateral sits within corridorHalf + RAMP_LANE_CAPTURE_TOL and the
//   lane-projected target is at slope height near the feet (ramp-band surface
//   in (0, feet + RAMP_ENTRY_TOL]). Since round 6 admits the overlap lane
//   (corridorHalf + radius) directly, the capture window now lies inside the
//   direct-pass region and only fires if tolerances ever narrow again. The
//   projection stays lateral-only and bounded (at most the tolerance past the
//   corridor edge, toward the lane, strictly inside the face span — it can
//   never cross a sheer face), and the surface match keeps grounded movers
//   out (face-high surfaces never match feet ~0) with no y jump on entry
//   (support follows the slope).
//   Both a from-lane drift-out and (for axis-x ramps) a mid-crossing target drift-out
//   are captured; for axis-z ramps a mid-crossing target drift-out falls through
//   to the next-tick eject-and-drop path (no trap).
export function resolvePlayerMove(
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number,
  radius: number = PLAYER_BODY_RADIUS,
  feetY: number = 0,
): { x: number; z: number } {
  if (
    !Number.isFinite(fromX) ||
    !Number.isFinite(fromZ) ||
    !Number.isFinite(toX) ||
    !Number.isFinite(toZ) ||
    !(radius > 0)
  ) {
    return { x: fromX, z: fromZ };
  }
  const feet = Number.isFinite(feetY) ? feetY : 0;
  const admitted = feet > RAMP_ADMIT_MIN_FEET;
  // A climber crossing the open face in-lane: inside the footprint below the
  // top but on the ramp (feet up, lateral in the capsule-overlap lane) — free
  // pass, no eject. Only meaningful for ramped platforms (corridorAxis
  // non-null). The lane is corridorHalf + radius (bug round 6, BUG 1): a
  // center past the slab edge by up to one radius still overlaps the ramp.
  const inClimbLane = (solid: MoveSolid, px: number, pz: number): boolean =>
    admitted &&
    ((solid.corridorAxis === "z" && Math.abs(pz - solid.corridorCenter) <= solid.corridorHalf + radius) ||
      (solid.corridorAxis === "x" && Math.abs(px - solid.corridorCenter) <= solid.corridorHalf + radius));
  // Climb-lane capture target (defect 2): when an admitted mover's target
  // lateral is off-corridor but within reach (corridorHalf +
  // RAMP_LANE_CAPTURE_TOL), returns the lane-clamped lateral; otherwise null
  // (in-lane targets need no capture, far-outside targets stay blocked).
  // The clamp stops FOOTPRINT_EPS infield of the lane edge: the ramp-band
  // test is strict, so an exact-edge lateral can read as off-band by float
  // dust (observed 7e-16 on decimal lane edges) and the capture would fail
  // its own surface check — or pass it, then eject the next tick. A hair
  // infield is physically identical and keeps every exact <= half gate green.
  // Callers additionally require the ramp surface at the projected point near
  // the feet before admitting + projecting, so grounded movers never enter
  // and entries never jump in y.
  const laneCaptureTarget = (solid: MoveSolid, lateralTarget: number): number | null => {
    if (!admitted || solid.corridorAxis === null) {
      return null;
    }
    const offset = Math.abs(lateralTarget - solid.corridorCenter);
    if (offset <= solid.corridorHalf || offset > solid.corridorHalf + RAMP_LANE_CAPTURE_TOL) {
      return null;
    }
    return Math.max(
      solid.corridorCenter - solid.corridorHalf + FOOTPRINT_EPS,
      Math.min(solid.corridorCenter + solid.corridorHalf - FOOTPRINT_EPS, lateralTarget),
    );
  };
  // Slope-height match at the projected entry point: the ramp-band surface
  // (band only, no platform tops) must sit just at/above the feet — a genuine
  // slope step, never a wall climb and never a teleport onto the top.
  const laneSurfaceOk = (sx: number, sz: number): boolean => {
    const surface = rampBandHeightAt(sx, sz);
    return surface > 0 && surface <= feet + RAMP_ENTRY_TOL;
  };
  let x = toX;
  // Z goal for the Z loop: an X-ramp lane capture re-lanes the lateral (z)
  // here, and the Z loop then processes the pulled goal with all its usual
  // face checks — a capture can admit through the open face but can never
  // undo a sheer-face clamp.
  let zGoal = toZ;
  for (const solid of MOVE_SOLIDS) {
    if (solid.top <= feet + SUPPORT_STICK_TOL + COLLISION_Y_EPS) {
      continue;
    }
    const minFaceX = solid.x - solid.hx - radius;
    const maxFaceX = solid.x + solid.hx + radius;
    if (insideSolidFootprint(solid, fromX, fromZ, radius)) {
      if (inClimbLane(solid, fromX, fromZ)) {
        continue;
      }
      // Illegally inside below the top: eject toward the nearest X face.
      x = fromX - minFaceX <= maxFaceX - fromX ? Math.min(x, minFaceX) : Math.max(x, maxFaceX);
      continue;
    }
    if (fromZ >= solid.z - solid.hz - radius && fromZ <= solid.z + solid.hz + radius) {
      let minPass =
        admitted &&
        solid.openMinX &&
        solid.corridorAxis === "z" &&
        Math.abs(fromZ - solid.corridorCenter) <= solid.corridorHalf + radius;
      let maxPass =
        admitted &&
        solid.openMaxX &&
        solid.corridorAxis === "z" &&
        Math.abs(fromZ - solid.corridorCenter) <= solid.corridorHalf + radius;
      // Off-corridor capture at the open ±x faces (ramps only): re-lane the
      // lateral (z) goal instead of clamping when the target is within reach
      // and at slope height. In-lane targets need no capture (z is frozen in
      // this loop, so target lateral always equals the from lateral here).
      if (solid.corridorAxis === "z" && admitted) {
        if (!minPass && solid.openMinX && fromX <= minFaceX && x > minFaceX) {
          const cap = laneCaptureTarget(solid, fromZ);
          if (cap !== null && laneSurfaceOk(x, cap)) {
            minPass = true;
            zGoal = cap;
          }
        }
        if (!maxPass && solid.openMaxX && fromX >= maxFaceX && x < maxFaceX) {
          const cap = laneCaptureTarget(solid, fromZ);
          if (cap !== null && laneSurfaceOk(x, cap)) {
            maxPass = true;
            zGoal = cap;
          }
        }
      }
      if (!minPass && fromX <= minFaceX && x > minFaceX) {
        x = minFaceX;
      }
      if (!maxPass && fromX >= maxFaceX && x < maxFaceX) {
        x = maxFaceX;
      }
    }
  }
  let z = zGoal;
  for (const solid of MOVE_SOLIDS) {
    if (solid.top <= feet + SUPPORT_STICK_TOL + COLLISION_Y_EPS) {
      continue;
    }
    const minFaceZ = solid.z - solid.hz - radius;
    const maxFaceZ = solid.z + solid.hz + radius;
    if (insideSolidFootprint(solid, fromX, fromZ, radius)) {
      if (inClimbLane(solid, fromX, fromZ)) {
        continue;
      }
      // Illegally inside below the top: eject toward the nearest Z face.
      z = fromZ - minFaceZ <= maxFaceZ - fromZ ? Math.min(z, minFaceZ) : Math.max(z, maxFaceZ);
      continue;
    }
    if (x >= solid.x - solid.hx - radius && x <= solid.x + solid.hx + radius) {
      let minPass =
        admitted &&
        solid.openMinZ &&
        solid.corridorAxis === "x" &&
        Math.abs(fromX - solid.corridorCenter) <= solid.corridorHalf + radius;
      let maxPass =
        admitted &&
        solid.openMaxZ &&
        solid.corridorAxis === "x" &&
        Math.abs(fromX - solid.corridorCenter) <= solid.corridorHalf + radius;
      // Off-corridor capture at the open ±z faces (ramps only): re-lane the
      // target x instead of clamping when within reach and at slope height.
      // Also covers drifting out mid-crossing (from in-lane, target out):
      // the crossing still passes, but the target is pulled back into the
      // lane so the climber lands on the ramp instead of ejecting.
      if (solid.corridorAxis === "x" && admitted) {
        if (solid.openMinZ && fromZ <= minFaceZ && z > minFaceZ) {
          const cap = laneCaptureTarget(solid, x);
          if (cap !== null && laneSurfaceOk(cap, z)) {
            minPass = true;
            x = cap;
          }
        }
        if (solid.openMaxZ && fromZ >= maxFaceZ && z < maxFaceZ) {
          const cap = laneCaptureTarget(solid, x);
          if (cap !== null && laneSurfaceOk(cap, z)) {
            maxPass = true;
            x = cap;
          }
        }
      }
      if (!minPass && fromZ <= minFaceZ && z > minFaceZ) {
        z = minFaceZ;
      }
      if (!maxPass && fromZ >= maxFaceZ && z < maxFaceZ) {
        z = maxFaceZ;
      }
    }
  }
  return { x, z };
}

// Wedge-side entry block (bug A leak 2): a mover may not step INTO a ramp
// band below its surface — the client wedge is a wall from the side, and
// the server must not materialize fighters onto the slope in one tick.
// Legit climbing always satisfies surface(target) - feet <= climb rate
// (~0.06m/tick), so RAMP_ENTRY_TOL never trips it. Axis-separated fallback
// preserves sliding along the wedge. Flying movers (feet above every ramp)
// pass untouched. Zero per-tick allocation (scalar math only).
function resolveWedgeEntry(
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number,
  feet: number,
): { x: number; z: number } {
  if (rampBandHeightAt(toX, toZ) <= feet + RAMP_ENTRY_TOL) {
    return { x: toX, z: toZ };
  }
  if (rampBandHeightAt(toX, fromZ) <= feet + RAMP_ENTRY_TOL) {
    return { x: toX, z: fromZ };
  }
  if (rampBandHeightAt(fromX, toZ) <= feet + RAMP_ENTRY_TOL) {
    return { x: fromX, z: toZ };
  }
  return { x: fromX, z: fromZ };
}

// Shared grounded-move path (humans, bots, knockback, recoil): wedge-side
// block first, then the elevation-gated face resolver.
export function resolveGroundMove(
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number,
  radius: number = PLAYER_BODY_RADIUS,
  feetY: number = 0,
): { x: number; z: number } {
  if (
    !Number.isFinite(fromX) ||
    !Number.isFinite(fromZ) ||
    !Number.isFinite(toX) ||
    !Number.isFinite(toZ) ||
    !(radius > 0)
  ) {
    return { x: fromX, z: fromZ };
  }
  const feet = Number.isFinite(feetY) ? feetY : 0;
  const wedged = resolveWedgeEntry(fromX, fromZ, toX, toZ, feet);
  return resolvePlayerMove(fromX, fromZ, wedged.x, wedged.z, radius, feet);
}

// Authoritative FFA room (Stage 4): guest-nick join, inputs-only 20/s,
// server hitscan (100HP/25dmg), C2 short-round loop 3/3/2, weak bots.
export class ArenaRoom extends Room<ArenaState> {
  // Overridable clock for deterministic unit tests (null = wall clock).
  public testNow: number | null = null;

  private readonly inputs = new Map<string, MoveInput>();
  private readonly respawnAt = new Map<string, number>();
  private readonly brains = new Map<string, BotBrain>();
  // Trampoline-flight launch timestamps (ms, currentTime clock): present =
  // airborne following trampolineArcY, absent = grounded (y derived from XZ).
  // Humans only — bots never launch (weak ground game by design).
  private readonly airSince = new Map<string, number>();
  private botCounter = 0;
  private ballCounter = 0;
  // Scratch ball-surface contact (Stage 4d.4): reused as the describeBallSurface
  // out-param every ball tick, so the surface path allocates nothing per tick.
  private readonly scratchContact: BallContact = { kind: "none", axis: null, face: 0, restY: 0 };
  private countdownEndsAt = 0;
  private roundEndsAt = 0;
  private playingStartedAt = 0;
  private endedAt = 0;
  private spawnCursor = 0;

  private currentTime(): number {
    return this.testNow ?? Date.now();
  }

  public async onCreate(): Promise<void> {
    this.maxClients = MAX_PLAYERS;
    this.setState(new ArenaState());
    this.setPatchRate(PATCH_RATE_MS);
    this.onMessage("ping", (client: Client): void => {
      client.send("pong", { tick: this.state.tick });
    });
    this.onMessage("input", (client: Client, payload: unknown): void => {
      this.handleInput(client.sessionId, payload);
    });
    // R2 cannon: release-to-fire with power01/yaw/pitch. Old proximity
    // "hit" system is removed (no dual combat systems).
    this.onMessage("fire", (client: Client, payload: unknown): void => {
      this.handleFire(client.sessionId, payload);
    });
    // R1 pre-join spectator: entering the arena requires an explicit "play"
    // message with a nick. Join alone only creates a spectator entry.
    this.onMessage("play", (client: Client, payload: unknown): void => {
      this.handlePlay(client, payload);
    });
    try {
      // Unit tests (VITEST=true) drive tickRoom() manually; a real interval
      // here would keep the tinypool worker alive after the run.
      if (process.env["VITEST"] !== "true") {
        this.setSimulationInterval((deltaMs: number): void => {
          this.tickRoom(typeof deltaMs === "number" ? deltaMs : SIM_TICK_MS);
        }, SIM_TICK_MS);
      }
    } catch {
      // Unit tests instantiate the room without a Colyseus driver: the
      // fixed-step loop is then driven manually via tickRoom().
    }
  }

  // R1 pre-join spectator: onJoin creates a spectator only — no spawn
  // position counted as a player, no HP drain, no killfeed, no bots.
  // The arena entry happens later via the "play" message.
  // Capacity guard is spectator-aware: only human entries (fighters plus
  // spectators) count toward MAX_PLAYERS. Bots are server-side entities,
  // not Colyseus clients, so they must never block a joining spectator.
  // A truly full room (MAX_PLAYERS humans) gets an explicit "room-full"
  // message so the client shows feedback instead of hanging.
  public async onJoin(client: Client, options?: Record<string, unknown>): Promise<void> {
    if (this.humanEntryCount() >= MAX_PLAYERS) {
      // Colyseus maxClients normally rejects first; guard direct calls too.
      client.send("room-full", { reason: "Room is full" });
      return;
    }
    const taken = new Set<string>();
    this.state.players.forEach((player: PlayerState): void => {
      taken.add(player.nick);
    });
    const nick = sanitizeNick(options?.["nick"], taken);
    const player = new PlayerState();
    player.sessionId = client.sessionId;
    player.nick = nick;
    player.x = 0;
    player.z = 0;
    player.y = 1.1;
    player.rotY = 0;
    player.hp = MAX_HP;
    player.score = 0;
    player.alive = false;
    player.isBot = false;
    player.invulnUntil = 0;
    player.ready = false;
    player.spectator = true;
    this.state.players.set(client.sessionId, player);
    this.inputs.delete(client.sessionId);
    this.airSince.delete(client.sessionId);
    // No ensureBots here: spectators alone must never spawn bots or start
    // a countdown. Bots fill only once a ready human exists (see play).
    client.send("spectator", { sessionId: client.sessionId });
  }

  // R1 "play": spectator with a validated nick becomes a ready fighter
  // (spawn + HP + alive + 2s invuln when joining a live round), then bots.
  // Fighter slots are human-only: bots never block Play. A spectator is
  // rejected with an explicit "room-full" only when MAX_PLAYERS human
  // fighters already occupy the room.
  public handlePlay(client: Client, payload: unknown): void {
    const player = this.state.players.get(client.sessionId);
    if (player === undefined || player.isBot) {
      return;
    }
    if (player.ready && !player.spectator) {
      client.send("welcome", { sessionId: client.sessionId, nick: player.nick, x: player.x, z: player.z });
      return;
    }
    if (this.humanCount() >= MAX_PLAYERS) {
      client.send("room-full", { reason: "Room is full" });
      return;
    }
    const taken = new Set<string>();
    this.state.players.forEach((entry: PlayerState): void => {
      if (entry.sessionId !== client.sessionId) {
        taken.add(entry.nick);
      }
    });
    const body = (typeof payload === "object" && payload !== null ? payload : {}) as Record<string, unknown>;
    const nick = resolvePlayNick(body["nick"], taken);
    const spawnIndex = this.spawnCursor;
    this.spawnCursor += 1;
    const now = this.currentTime();
    const spawn = this.pickSpawn(spawnIndex);
    player.nick = nick;
    player.x = spawn.x;
    player.z = spawn.z;
    player.y = 1.1;
    player.rotY = 0;
    player.hp = MAX_HP;
    player.score = 0;
    player.alive = true;
    player.ready = true;
    player.spectator = false;
    // Late joiners spawning into a live round get brief protection so they
    // are not farmed on the spawn marker before their first frame renders.
    player.invulnUntil = this.state.phase === "playing" || this.state.phase === "countdown" ? now + INVULN_MS : 0;
    this.inputs.delete(client.sessionId);
    this.airSince.delete(client.sessionId);
    this.ensureBots();
    client.send("welcome", { sessionId: client.sessionId, nick, x: player.x, z: player.z });
  }

  public async onLeave(client: Client): Promise<void> {
    if (this.state.players.has(client.sessionId)) {
      this.state.players.delete(client.sessionId);
    }
    this.inputs.delete(client.sessionId);
    this.respawnAt.delete(client.sessionId);
    this.airSince.delete(client.sessionId);
    // Bots persist for the next joiner; with no humans left the room idles
    // back in lobby instead of running a bot-only round.
    if (this.humanCount() === 0 && this.state.phase !== "lobby") {
      this.toLobby();
    }
  }

  // Fixed-step authoritative tick (SIM_TICK_MS, 20/s). Public so tests can
  // drive the round loop deterministically via testNow.
  public tickRoom(stepMs: number = SIM_TICK_MS): void {
    const now = this.currentTime();
    this.state.tick += 1;
    const phase = this.state.phase as RoundPhase;
    if (phase === "lobby") {
      this.tickLobby(now);
    } else if (phase === "countdown") {
      this.tickCountdown(now);
    } else if (phase === "playing") {
      this.tickPlaying(now, stepMs);
    } else {
      this.tickEnded(now);
    }
  }

  private tickLobby(now: number): void {
    this.ensureBots();
    // R1: only ready fighters count — spectators never start a countdown.
    if (this.readyCount() >= 2 && this.humanCount() >= 1) {
      this.state.phase = "countdown";
      this.state.countdownMs = LOBBY_COUNTDOWN_MS;
      this.countdownEndsAt = now + LOBBY_COUNTDOWN_MS;
    } else {
      this.state.countdownMs = 0;
    }
  }

  private tickCountdown(now: number): void {
    this.ensureBots();
    const left = this.countdownEndsAt - now;
    this.state.countdownMs = Math.max(0, left);
    if (left <= 0) {
      this.startPlaying(now);
    }
  }

  private tickPlaying(now: number, stepMs: number): void {
    const dt = Math.max(1, stepMs) / 1000;
    this.moveHumans(dt);
    this.moveBots(now, dt);
    this.fireBots(now);
    this.stepBalls(now, dt);
    this.tickCenterItems(now);
    this.tickRespawns(now);
    const left = this.roundEndsAt - now;
    this.state.remainingMs = Math.max(0, left);
    const scoreWinner = this.findScoreWinner();
    const hardCap = now - this.playingStartedAt >= ROUND_HARD_CAP_MS;
    if (scoreWinner !== null) {
      this.endRound(scoreWinner);
    } else if (left <= 0 || hardCap) {
      this.endRound(this.leaderSessionId());
    }
  }

  private tickEnded(now: number): void {
    if (now - this.endedAt >= REMATCH_DELAY_MS) {
      this.resetForRematch();
    }
  }

  private startPlaying(now: number): void {
    this.state.phase = "playing";
    this.state.countdownMs = 0;
    this.state.remainingMs = ROUND_DURATION_MS;
    this.roundEndsAt = now + ROUND_DURATION_MS;
    this.playingStartedAt = now;
    // Fresh spawn for every ready entrant; spectators stay out of the round.
    let index = 0;
    this.state.players.forEach((player: PlayerState): void => {
      if (!player.ready || player.spectator) {
        return;
      }
      respawnPlayer(player, index, now);
      player.superBuff = false;
      player.reloadUntil = 0;
      index += 1;
    });
    this.respawnAt.clear();
    this.airSince.clear();
    // Fresh round: all balls go, including ricocheted/settling/resting ones —
    // rest state lives on BallState itself, so clear() leaks nothing.
    this.state.balls.clear();
    this.ballCounter = 0;
    this.state.superActive = false;
    this.state.superNextAt = now + SUPER_SPAWN_S * 1000;
    this.state.superExpiresAt = 0;
    this.broadcast("killfeed", { message: "Fight!" });
  }

  private endRound(winnerSessionId: string): void {
    this.state.phase = "ended";
    this.state.winner = winnerSessionId;
    this.state.remainingMs = 0;
    this.endedAt = this.currentTime();
    const winner = this.state.players.get(winnerSessionId);
    this.broadcast("killfeed", {
      message: winner !== undefined ? `${winner.nick} wins the round!` : "Round over!",
    });
  }

  private resetForRematch(): void {
    let index = 0;
    const now = this.currentTime();
    this.state.players.forEach((player: PlayerState): void => {
      player.score = 0;
      player.superBuff = false;
      player.reloadUntil = 0;
      if (!player.ready || player.spectator) {
        return;
      }
      respawnPlayer(player, index, now);
      // Rematch spawns are protected only by the countdown itself.
      player.invulnUntil = 0;
      index += 1;
    });
    this.spawnCursor = index;
    this.state.winner = "";
    this.state.remainingMs = 0;
    this.state.countdownMs = 0;
    this.respawnAt.clear();
    this.airSince.clear();
    // Rematch reset: same full clear as round start — no resting ball or
    // settle timer leaks across rounds.
    this.state.balls.clear();
    this.state.superActive = false;
    this.state.superNextAt = 0;
    this.state.superExpiresAt = 0;
    this.toLobby();
  }

  private toLobby(): void {
    this.state.phase = "lobby";
    this.state.countdownMs = 0;
    this.state.remainingMs = 0;
  }

  private handleInput(sessionId: string, payload: unknown): void {
    const player = this.state.players.get(sessionId);
    // R1: spectators have no movable body — inputs are dropped until Play.
    if (player === undefined || player.isBot || !player.alive || !player.ready || player.spectator) {
      return;
    }
    const body = (typeof payload === "object" && payload !== null ? payload : {}) as Record<string, unknown>;
    const x = clampAxis(body["x"]);
    const y = clampAxis(body["y"]);
    const length = Math.hypot(x, y);
    const seqRaw = body["seq"];
    this.inputs.set(sessionId, {
      x: length > 1 ? x / length : x,
      y: length > 1 ? y / length : y,
      rotY: clampAngle(body["rotY"]),
      seq: typeof seqRaw === "number" && Number.isFinite(seqRaw) ? Math.floor(seqRaw) : 0,
      charging: body["charging"] === true,
    });
  }

  // R2 hand-ball throw: release-to-fire with power01/yaw/pitch. Validates the
  // fighter, reload gate, and phase; consumes SUPER buff even on a miss
  // (NEXT shot only). Quick-tap payloads (<80ms of charge) are dropped
  // client-side and never reach here, but a zero power is still clamped.
  // 4d.1: the payload may carry the thrower's body-center y (client avatar
  // position.y) so the spawn tracks platform/jump elevation; absent or
  // insane values fall back to the derived footprint elevation.
  public handleFire(shooterId: string, payload: unknown): void {
    if (this.state.phase !== "playing") {
      return;
    }
    const shooter = this.state.players.get(shooterId);
    if (shooter === undefined || shooter.isBot) {
      // Bots fire through fireBots(), never through the wire.
      if (shooter !== undefined && shooter.isBot) {
        return;
      }
      if (shooter === undefined) {
        return;
      }
    }
    // R1: spectators neither shoot nor take hits.
    if (!shooter.ready || shooter.spectator || !shooter.alive) {
      return;
    }
    const now = this.currentTime();
    if (now < shooter.reloadUntil) {
      return;
    }
    const body = (typeof payload === "object" && payload !== null ? payload : {}) as Record<string, unknown>;
    const rawPower = typeof body["power01"] === "number" && Number.isFinite(body["power01"])
      ? (body["power01"] as number)
      : 0.5;
    const power01 = Math.max(0.5, Math.min(1, rawPower));
    const yaw = clampAngle(body["yaw"]);
    const pitchRaw = typeof body["pitch"] === "number" && Number.isFinite(body["pitch"])
      ? (body["pitch"] as number)
      : 0.25;
    const pitch = Math.max(FIRE_PITCH_MIN, Math.min(FIRE_PITCH_MAX, pitchRaw));
    const wantSuper = body["super"] === true;
    const useSuper = wantSuper && shooter.superBuff;
    // Buff is consumed on fire even on a miss (NEXT shot only).
    shooter.superBuff = false;
    this.spawnBall(shooter, power01, yaw, pitch, useSuper, now, sanitizeThrowerY(body["throwerY"]));
  }

  // Shared spawn path for humans (handleFire) and bots (fireBots).
  // No spray: balls fly exactly along the look yaw/pitch + server gravity
  // (throw-polish removed randomness — the parabola is enough chaos).
  // Muzzle offset, parabolic speed lerp, 12-ball cap, 2.5s reload.
  // 4d.1: spawn y = thrower body-center y + torso offset (ground 1.4,
  // unchanged). Humans send their live y (platforms/jumps); bots and
  // missing/insane values derive from the platform footprint. Optional 7th
  // param so older 6-arg call sites (tests, bots) keep working.
  // Recoil: shooter is nudged opposite the fire dir by
  // recoilDistanceForPower(power01) (weak 0.4m -> full 0.8m), clamped to
  // the arena. Position nudge only, no self-damage.
  public spawnBall(
    shooter: PlayerState,
    power01: number,
    yaw: number,
    pitch: number,
    superShot: boolean,
    now: number,
    throwerY: number | null = null,
  ): BallState | null {
    if (!shooter.alive || !shooter.ready || shooter.spectator) {
      return null;
    }
    // Stage 4d.4 resting cores: the thrower's next shot despawns his resting
    // ball (humans and bots share this path). Firing frees the slot first so
    // the new ball never evicts a stranger's live ball on a full pool.
    this.despawnRestingBallsOf(shooter.sessionId);
    this.ballCounter += 1;
    const finalYaw = yaw;
    const speed = powerToSpeed(power01);
    // Single muzzle helper: spawn == bodyCenter XZ + dir*0.7, y = bodyY +
    // torso offset (identical to client preview math; see hits.muzzleForShot
    // + protocol.muzzleForShot).
    const bodyY = resolveThrowerY(throwerY, shooter.x, shooter.z);
    const muzzle = muzzleForShot(shooter.x, bodyY, shooter.z, finalYaw, pitch);
    const dirX = muzzle.dirX;
    const dirZ = muzzle.dirZ;
    const dirY = muzzle.dirY;
    // Recoil kick opposite the horizontal fire dir, resolved against geometry
    // like any other move (a kick into a wall stops at the face, never
    // embeds — authoritative positions stay legal), then clamped to the arena.
    const recoil = recoilDistanceForPower(power01);
    const horizontal = Math.hypot(dirX, dirZ);
    if (horizontal > 0.0001 && Number.isFinite(recoil) && recoil > 0) {
      const kickX = (dirX / horizontal) * recoil;
      const kickZ = (dirZ / horizontal) * recoil;
      const kicked = resolveGroundMove(
        shooter.x,
        shooter.z,
        shooter.x - kickX,
        shooter.z - kickZ,
        PLAYER_BODY_RADIUS,
        feetYOf(shooter.y),
      );
      shooter.x = clampPosition(kicked.x);
      shooter.z = clampPosition(kicked.z);
    }
    const ball = new BallState();
    ball.ballId = `b${this.ballCounter}`;
    ball.ownerId = shooter.sessionId;
    ball.x = muzzle.x;
    ball.y = muzzle.y;
    ball.z = muzzle.z;
    ball.vx = dirX * speed;
    ball.vy = dirY * speed;
    ball.vz = dirZ * speed;
    ball.power01 = Math.max(0.5, Math.min(1, power01));
    ball.super = superShot;
    ball.ageMs = 0;
    ball.distM = 0;
    ball.ricochet = false;
    ball.resting = false;
    ball.settleMs = 0;
    ball.restY = 0;
    this.state.balls.set(ball.ballId, ball);
    // Perf cap: max 12 live balls server-side, oldest despawns first.
    if (this.state.balls.size > MAX_LIVE_BALLS) {
      let oldestId: string | null = null;
      let oldestAge = -1;
      this.state.balls.forEach((entry: BallState, key: string): void => {
        if (entry.ageMs > oldestAge) {
          oldestAge = entry.ageMs;
          oldestId = key;
        }
      });
      if (oldestId !== null && oldestId !== ball.ballId) {
        this.state.balls.delete(oldestId);
      }
    }
    shooter.reloadUntil = now + RELOAD_MS;
    return ball;
  }

  // Authoritative ball step (Stage 4d.4): gravity arc, substepped flight
  // (each tick move is split into BALL_STEP_MAX_M substeps so the ENTRY face
  // is sampled before deep-penetration misclassification — no tunneling past
  // thin side-entry bands), ricochet/settle contacts, player hits (radius
  // ~0.9, self-damage armed after 1m / 0.3s), damage to ALL incl. self +
  // knockback impulse. Kill/respawn/killfeed reuse existing paths.
  // - Resting balls: purely decorative — aged (so pool overflow evicts
  //   oldest-first, resting included) but never moved or damage-checked.
  // - Settling balls: velocity damps exponentially over BALL_SETTLE_TIME_MS
  //   (~0.4s slide pinned at restY), then resting=true with velocity 0.
  // - Normal flying balls: vertical surfaces (boundary walls, sheer
  //   obstacle/platform sides) REFLECT on the hit axis (ricochet=true, no
  //   damage ever after); floor/up-facing tops ENTER SETTLE. SUPER balls
  //   despawn on first environmental contact, exactly as before.
  // - Ricochet balls reaching a player bounce off (velocity reflected away,
  //   no damage/knockback/broadcast); pre-ricochet direct hits damage, knock
  //   back, broadcast, and despawn exactly as before.
  // First-tick hold: a newborn ball (prevAge < PATCH_RATE_MS) is aged but NOT
  // integrated until the next tick, so the first patched frame still sits at
  // the muzzle instead of 0.7-1m downrange (pre-patch teleport fix).
  // Scratch contact (describeBallSurface out-param) is a room-owned field —
  // no per-tick allocation on the surface path. The dead-id list + forEach
  // closures are the same pre-existing per-tick shapes as before.
  private stepBalls(now: number, dt: number): void {
    const dead: string[] = [];
    this.state.balls.forEach((ball: BallState, ballId: string): void => {
      const prevAge = ball.ageMs;
      ball.ageMs += dt * 1000;
      if (prevAge < PATCH_RATE_MS) {
        return;
      }
      if (ball.resting) {
        return;
      }
      if (ball.settleMs > 0) {
        this.slideSettlingBall(ball, dt);
        ball.settleMs += dt * 1000;
        if (ball.settleMs >= BALL_SETTLE_TIME_MS) {
          ball.vx = 0;
          ball.vy = 0;
          ball.vz = 0;
          // Final re-snap: the slide may have carried the ball off its entry
          // surface (tower edge, block side) on this last sub-step — pin y at
          // the TRUE support under the final xz, never the stale entry restY.
          ball.restY = Math.max(BALL_GROUND_Y, groundTopAt(ball.x, ball.z)) + BALL_RADIUS;
          ball.y = ball.restY;
          ball.settleMs = 0;
          ball.resting = true;
          this.enforceRestingCap(ball);
        }
        return;
      }
      ball.vy -= BALL_GRAVITY * dt;
      const stepX = ball.vx * dt;
      const stepY = ball.vy * dt;
      const stepZ = ball.vz * dt;
      // Tunneling guard: subdivide the ~1m tick step into straight substeps
      // no longer than BALL_STEP_MAX_M, sampling the surface/victim contact
      // at every substep point so the ENTRY face is detected before
      // deep-penetration misclassification (see the config rationale). Each
      // substep integrates the LIVE velocity (re-read every substep over a
      // fixed subDt), so a mid-tick reflection or victim bounce redirects
      // the REMAINING substeps — precomputing the increments once per tick
      // is wrong here (the stale increment marches the ball back across the
      // face it just bounced off: wall pin + flip-flop instead of flight).
      // Scalar math only, no allocation; the substep count is bounded (<= 5
      // even at max speed with falling vy), so per-tick work stays trivial.
      const stepLen = Math.sqrt(stepX * stepX + stepY * stepY + stepZ * stepZ);
      let subCount = Math.ceil(stepLen / BALL_STEP_MAX_M);
      if (!(subCount >= 1)) {
        subCount = 1;
      }
      const subDt = dt / subCount;
      for (let sub = 0; sub < subCount; sub += 1) {
        const moveX = ball.vx * subDt;
        const moveY = ball.vy * subDt;
        const moveZ = ball.vz * subDt;
        ball.x += moveX;
        ball.y += moveY;
        ball.z += moveZ;
        ball.distM += Math.sqrt(moveX * moveX + moveY * moveY + moveZ * moveZ);
        if (this.collideBoundaryWalls(ball)) {
          dead.push(ballId);
          return;
        }
        const contact = describeBallSurface(ball.x, ball.y, ball.z, ball.vx, ball.vz, this.scratchContact);
        if (contact.kind === "vertical") {
          if (ball.super) {
            dead.push(ballId);
            return;
          }
          if (contact.axis === "x") {
            ball.x = contact.face;
            ball.vx = -ball.vx;
          } else {
            ball.z = contact.face;
            ball.vz = -ball.vz;
          }
          ball.ricochet = true;
        } else if (contact.kind === "up") {
          if (ball.super) {
            dead.push(ballId);
            return;
          }
          this.enterSettle(ball, contact.restY, dt);
          return;
        }
        const victim = this.findBallVictim(ball);
        if (victim !== null) {
          if (ball.super || !ball.ricochet) {
            this.damageVictim(ball, victim, ballId, now);
            dead.push(ballId);
            return;
          }
          // Bounced balls never damage: simple bounce away from the victim
          // (~0.9m sphere via findBallVictim) — no damage, no knockback push
          // on the victim, no victim flash (no broadcast). Idempotent: the
          // velocity points away, so repeat contacts keep the same vector
          // until the ball leaves the radius.
          this.bounceBallOffVictim(ball, victim);
        }
      }
    });
    for (const ballId of dead) {
      this.state.balls.delete(ballId);
    }
  }

  // Arena boundary walls (±ARENA_HALF_SIZE): SUPER balls despawn on first
  // contact (returns true); normal balls clamp + reflect per crossed axis
  // (ricochet=true) and keep flying (returns false). Scalar, no allocation.
  private collideBoundaryWalls(ball: BallState): boolean {
    let hit = false;
    if (ball.x > ARENA_HALF_SIZE) {
      ball.x = ARENA_HALF_SIZE;
      if (!ball.super) {
        ball.vx = -ball.vx;
        ball.ricochet = true;
      }
      hit = true;
    } else if (ball.x < -ARENA_HALF_SIZE) {
      ball.x = -ARENA_HALF_SIZE;
      if (!ball.super) {
        ball.vx = -ball.vx;
        ball.ricochet = true;
      }
      hit = true;
    }
    if (ball.z > ARENA_HALF_SIZE) {
      ball.z = ARENA_HALF_SIZE;
      if (!ball.super) {
        ball.vz = -ball.vz;
        ball.ricochet = true;
      }
      hit = true;
    } else if (ball.z < -ARENA_HALF_SIZE) {
      ball.z = -ARENA_HALF_SIZE;
      if (!ball.super) {
        ball.vz = -ball.vz;
        ball.ricochet = true;
      }
      hit = true;
    }
    return hit && ball.super;
  }

  // Settle entry: pin y at the surface rest height, kill vertical motion, run
  // the first slide sub-step immediately so settleMs always holds real elapsed
  // time (never a magic epsilon marker).
  private enterSettle(ball: BallState, restY: number, dt: number): void {
    ball.restY = Number.isFinite(restY) ? restY : ball.y;
    ball.vy = 0;
    ball.y = ball.restY;
    this.slideSettlingBall(ball, dt);
    ball.settleMs = dt * 1000;
  }

  // One settling sub-step: exponential velocity damp (rate
  // BALL_SETTLE_DAMP_RATE), planar slide, y glued to the live support height,
  // arena-clamped (a slide into the boundary stops on that axis instead of
  // tunneling or bouncing — settling balls never ricochet). The support is
  // re-snapped every sub-step (Math.max(BALL_GROUND_Y, groundTopAt) +
  // BALL_RADIUS): a slide off a tower/block edge drops the ball to the true
  // surface below instead of hovering, and a floor slide into a block
  // footprint climbs onto the block top instead of resting embedded inside
  // the solid. Scalar, no allocation.
  private slideSettlingBall(ball: BallState, dt: number): void {
    const damp = Math.exp(-BALL_SETTLE_DAMP_RATE * dt);
    ball.vx *= damp;
    ball.vz *= damp;
    ball.x += ball.vx * dt;
    ball.z += ball.vz * dt;
    if (ball.x > ARENA_HALF_SIZE) {
      ball.x = ARENA_HALF_SIZE;
      ball.vx = 0;
    } else if (ball.x < -ARENA_HALF_SIZE) {
      ball.x = -ARENA_HALF_SIZE;
      ball.vx = 0;
    }
    if (ball.z > ARENA_HALF_SIZE) {
      ball.z = ARENA_HALF_SIZE;
      ball.vz = 0;
    } else if (ball.z < -ARENA_HALF_SIZE) {
      ball.z = -ARENA_HALF_SIZE;
      ball.vz = 0;
    }
    ball.restY = Math.max(BALL_GROUND_Y, groundTopAt(ball.x, ball.z)) + BALL_RADIUS;
    ball.y = ball.restY;
  }

  // Per-owner resting cap (Stage 4d.4 3Б): at most ONE resting ball per
  // thrower — when a ball comes to rest, an older resting ball of the same
  // owner despawns. Rare event path (not per-tick hot), single-id local.
  private enforceRestingCap(rested: BallState): void {
    let olderId: string | null = null;
    this.state.balls.forEach((entry: BallState, key: string): void => {
      if (key !== rested.ballId && entry.resting && entry.ownerId === rested.ownerId) {
        olderId = key;
      }
    });
    if (olderId !== null) {
      this.state.balls.delete(olderId);
    }
  }

  // Thrower's next shot clears his resting ball (hooked in spawnBall, so
  // humans and bots share it). Single-id local, no allocation.
  private despawnRestingBallsOf(ownerId: string): void {
    let restingId: string | null = null;
    this.state.balls.forEach((entry: BallState, key: string): void => {
      if (entry.resting && entry.ownerId === ownerId) {
        restingId = key;
      }
    });
    if (restingId !== null) {
      this.state.balls.delete(restingId);
    }
  }

  // Ricochet bounce off a victim: horizontal velocity points radially away
  // from the victim with its magnitude preserved (speed kept, direction out);
  // vertical motion is untouched. Degenerate overlap (exact coincidence or
  // zero planar speed) falls back to a plain axis flip. Scalar, no allocation.
  private bounceBallOffVictim(ball: BallState, victim: PlayerState): void {
    const dx = ball.x - victim.x;
    const dz = ball.z - victim.z;
    const dist = Math.hypot(dx, dz);
    const speedH = Math.hypot(ball.vx, ball.vz);
    if (!(dist > 0) || !(speedH > 0)) {
      ball.vx = -ball.vx;
      ball.vz = -ball.vz;
      return;
    }
    ball.vx = (dx / dist) * speedH;
    ball.vz = (dz / dist) * speedH;
  }

  // Pre-ricochet direct hit (unchanged damage model): FULL 25 / WEAK 12.5
  // (SUPER x2), knockback impulse, kill/respawn/killfeed, plus the
  // BALL_HIT_PLAYER_MESSAGE blood-FX broadcast (ids + impact position).
  // Owner-left mid-flight still damages with no scorer.
  private damageVictim(ball: BallState, victim: PlayerState, ballId: string, now: number): void {
    const shooter = this.state.players.get(ball.ownerId);
    const damage = damageForPower(ball.power01, ball.super);
    if (shooter !== undefined) {
      const result = applyHit(shooter, victim, now, damage);
      this.applyKnockback(victim, ball);
      if (result.killed) {
        victim.superBuff = false;
        this.respawnAt.set(victim.sessionId, now + RESPAWN_DELAY_MS);
        this.broadcast("killfeed", { message: `${shooter.nick} fragged ${victim.nick}` });
      }
    } else {
      // Owner left mid-flight: still damage the victim, no scorer.
      victim.hp = Math.max(0, victim.hp - damage);
      this.applyKnockback(victim, ball);
      if (victim.hp <= 0) {
        victim.alive = false;
        victim.hp = 0;
        victim.superBuff = false;
        this.respawnAt.set(victim.sessionId, now + RESPAWN_DELAY_MS);
      }
    }
    // Blood-FX trigger: damage registered on a player — clients show the
    // red hit burst ONLY for this event. Environmental contacts (boundary,
    // block, settle, pool overflow) and victim bounces broadcast nothing.
    // Position is the ball spot at hit (post-integration); payload stays
    // minimal (ids + position).
    this.broadcast(BALL_HIT_PLAYER_MESSAGE, {
      ballId,
      victimId: victim.sessionId,
      x: ball.x,
      y: ball.y,
      z: ball.z,
      super: ball.super,
    });
  }

  private findBallVictim(ball: BallState): PlayerState | null {
    let victim: PlayerState | null = null;
    this.state.players.forEach((player: PlayerState): void => {
      if (victim !== null || !player.alive || !player.ready || player.spectator) {
        return;
      }
      if (!canDamage(player, this.currentTime())) {
        return;
      }
      // Self-damage arming: point-blank spawn does not insta-suicide.
      if (player.sessionId === ball.ownerId) {
        if (ball.distM < SELF_ARMING_DIST_M && ball.ageMs < SELF_ARMING_TIME_S * 1000) {
          return;
        }
      }
      const dx = player.x - ball.x;
      // Derived body-center Y (bug 3b): the room maintains player.y every
      // tick (tower tops read ~3.1), so elevated victims are hittable. The
      // old hardcoded 1.1 made dy^2 alone exceed the hit radius^2 on towers.
      const bodyY = Number.isFinite(player.y) ? player.y : BODY_CENTER_Y;
      const dy = bodyY - ball.y;
      const dz = player.z - ball.z;
      if (dx * dx + dy * dy + dz * dz <= BALL_HIT_RADIUS * BALL_HIT_RADIUS) {
        victim = player;
      }
    });
    return victim;
  }

  private applyKnockback(victim: PlayerState, ball: BallState): void {
    const dx = victim.x - ball.x;
    const dz = victim.z - ball.z;
    const length = Math.hypot(dx, dz);
    if (length < 0.001) {
      return;
    }
    // Same collision resolution as movement: a shove toward a wall stops at
    // the face instead of embedding the authoritative position inside a
    // closed footprint (which the by-design escape rule would then let walk
    // out through the far face = pass-through again).
    const moved = resolveGroundMove(
      victim.x,
      victim.z,
      victim.x + (dx / length) * HIT_KNOCKBACK_M,
      victim.z + (dz / length) * HIT_KNOCKBACK_M,
      PLAYER_BODY_RADIUS,
      feetYOf(victim.y),
    );
    victim.x = clampPosition(moved.x);
    victim.z = clampPosition(moved.z);
  }

  // Center-item lifecycle (generic shape for future arena pickups).
  // Today only "super" (x2 NEXT shot) spawns at the center; extension points
  // for future kinds (NOT implemented — see TODOs below):
  //   - "pineapple": radius AoE on throw — plug a new tickPineappleItem(now)
  //     call here + state fields (active/x/z/expiresAt/nextAt) + consume the
  //     buff in handleFire/spawnBall like superBuff.
  //   - "heal": +1 heart on pickup — plug a new tickHealItem(now) call here
  //     + state fields; apply hp directly on pickup (no fire consume).
  // Keep one tick*Item(now) per kind so pickups stay independent (separate
  // timers, no shared cooldown).
  private tickCenterItems(now: number): void {
    this.tickSuperItem(now);
    // TODO(pineapple): this.tickPineappleItem(now);
    // TODO(heal): this.tickHealItem(now);
  }

  // Super-core lifecycle: spawn center every 45s, 15s life, body pickup
  // radius 1.7m grants x2 NEXT shot. Buff consumed on fire even on miss.
  private tickSuperItem(now: number): void {
    if (this.state.superActive) {
      if (now >= this.state.superExpiresAt) {
        this.state.superActive = false;
        this.state.superNextAt = now + SUPER_SPAWN_S * 1000;
      } else {
        this.state.players.forEach((player: PlayerState): void => {
          if (!player.alive || !player.ready || player.spectator || player.superBuff) {
            return;
          }
          const dx = player.x - this.state.superX;
          const dz = player.z - this.state.superZ;
          if (dx * dx + dz * dz <= SUPER_PICKUP_RADIUS * SUPER_PICKUP_RADIUS) {
            player.superBuff = true;
            this.state.superActive = false;
            this.state.superNextAt = now + SUPER_SPAWN_S * 1000;
            this.broadcast("killfeed", { message: `${player.nick} grabbed SUPER core (x2 next shot)` });
          }
        });
      }
      return;
    }
    if (this.state.superNextAt !== 0 && now >= this.state.superNextAt) {
      this.state.superActive = true;
      this.state.superX = 0;
      this.state.superZ = 0;
      this.state.superExpiresAt = now + SUPER_LIFE_S * 1000;
    }
  }

  // Movement applies client input as WORLD-space directly: the client
  // transforms its camera-relative stick (move.x/move.y) via the shared
  // worldMoveFromYaw formula (same math as SceneManager.update) before
  // sending, so input.x -> world X and input.y -> world Z with no server
  // re-transform. Last-known input persists across ticks (inputs map is only
  // replaced on new packets), so a single dropped 20Hz packet never freezes.
  // Elevation (bugs 1/3a): player.y is maintained here every tick and
  // replicates to clients (remotes render it, balls aim at it). Grounded
  // fighters derive y from XZ (platform/ramp/obstacle tops via
  // bodyCenterYAt); a grounded fighter whose XZ enters a trampoline pad
  // launches into the closed-form trampolineArcY flight, landing when the
  // arc meets the support height (tower tops included). XZ collision is
  // gated by the current feet height, so ground fighters stay out of tower
  // footprints while tower-top fighters walk freely on top.
  // Grounded support with hysteresis (bug B): the radius-expanded support
  // sticks while the feet still match it — walking off a top falls only once
  // fully outside the footprint, killing the pinned-at-face state. Otherwise
  // the strict support wins, so the ground beside a solid never snaps up
  // (that path fails the feet match by metres, not microns).
  // Ramp-slope continuity (bug round 6, BUG 1): an admitted climber whose
  // center drifted past the strict slab edge (capsule-overlap sliver, up to
  // one radius out) still stands on the slope — the widened band surface near
  // the feet is the support, so the feet track the slope instead of dropping
  // to the ground (the drop armed the eject loop on the next tick: the ramp
  // edge invisible wall). Gated on admitted (feet above RAMP_ADMIT_MIN_FEET)
  // so grounded fighters beside a ramp never snap up (bug A leak 1), and on
  // a genuine slope step (|surface - feet| <= RAMP_ENTRY_TOL, the same gate
  // family as the wedge block and the lane capture) so entries never jump in
  // y. Scalar math only, zero per-tick allocation.
  private groundSupport(x: number, z: number, feet: number): number {
    const strict = bodyCenterYAt(x, z);
    const wide = bodyCenterYAtExpanded(x, z, PLAYER_BODY_RADIUS);
    if (wide > strict + COLLISION_Y_EPS && feet >= wide - BODY_CENTER_Y - SUPPORT_STICK_TOL) {
      return wide;
    }
    if (feet > RAMP_ADMIT_MIN_FEET) {
      const rampSurface = rampBandHeightAtExpanded(x, z, PLAYER_BODY_RADIUS);
      if (rampSurface > 0 && Math.abs(rampSurface - feet) <= RAMP_ENTRY_TOL) {
        return rampSurface + BODY_CENTER_Y;
      }
    }
    return strict;
  }

  private moveHumans(dt: number): void {
    const now = this.currentTime();
    this.state.players.forEach((player: PlayerState): void => {
      if (player.isBot || !player.alive || !player.ready || player.spectator) {
        return;
      }
      const input = this.inputs.get(player.sessionId);
      // R2: aiming/charging runs slower (CHARGE_MOVE_MULT mirror); reloading
      // runs at normal speed.
      const speed =
        input !== undefined && input.charging ? PLAYER_SPEED * CHARGE_MOVE_MULT : PLAYER_SPEED;
      const airStart = this.airSince.get(player.sessionId);
      if (airStart !== undefined) {
        this.stepAirborneHuman(player, input, speed, dt, now, airStart);
        return;
      }
      // Grounded: wedge-side block + Y-gated XZ move (slide along faces)
      // BEFORE the arena clamp, so the authoritative position never enters
      // geometry. Then the grounded height follows the HYSTERETIC support
      // under the new XZ (ramps read smoothly via the slope band, tops stick
      // through the 0.5m ring, ground beside solids never snaps up).
      const feet = feetYOf(player.y);
      const moved = resolveGroundMove(
        player.x,
        player.z,
        input !== undefined ? player.x + input.x * speed * dt : player.x,
        input !== undefined ? player.z + input.y * speed * dt : player.z,
        PLAYER_BODY_RADIUS,
        feet,
      );
      player.x = clampPosition(moved.x);
      player.z = clampPosition(moved.z);
      if (input !== undefined) {
        player.rotY = input.rotY;
      }
      player.y = this.groundSupport(player.x, player.z, feet);
      // Pad launch (pads sit on open ground by layout; the ground-top guard
      // keeps a future overlapping layout from launching off a rooftop).
      if (isOnTrampolinePad(player.x, player.z) && groundTopAt(player.x, player.z) <= TRAMPOLINE_GROUND_TOL) {
        this.airSince.set(player.sessionId, now);
      }
    });
  }

  // One airborne tick: advance the closed-form arc, steer XZ with the same
  // Y-gated resolver (at apex the feet clear tower tops, so the flight
  // crosses into footprints), and land the moment the arc meets the
  // RADIUS-EXPANDED support under the new XZ — clipping a top edge at
  // support height rests on it (physical), while landing short on open
  // ground beside a solid stays down (no snap-up: expanded support there is
  // still ground level). Zero per-tick allocation (scalar math only).
  private stepAirborneHuman(
    player: PlayerState,
    input: MoveInput | undefined,
    speed: number,
    dt: number,
    now: number,
    airStart: number,
  ): void {
    const airTimeS = (now - airStart) / 1000;
    if (!(airTimeS >= 0) || airTimeS > TRAMPOLINE_MAX_AIR_S) {
      // Stuck arc (clock jump, NaN): force-land on the support below.
      this.airSince.delete(player.sessionId);
      player.y = bodyCenterYAt(player.x, player.z);
      return;
    }
    const arcY = trampolineArcY(airTimeS);
    const moved = resolvePlayerMove(
      player.x,
      player.z,
      input !== undefined ? player.x + input.x * speed * dt : player.x,
      input !== undefined ? player.z + input.y * speed * dt : player.z,
      PLAYER_BODY_RADIUS,
      feetYOf(player.y),
    );
    player.x = clampPosition(moved.x);
    player.z = clampPosition(moved.z);
    if (input !== undefined) {
      player.rotY = input.rotY;
    }
    const support = bodyCenterYAtExpanded(player.x, player.z, PLAYER_BODY_RADIUS);
    if (arcY <= support) {
      this.airSince.delete(player.sessionId);
      player.y = support;
    } else {
      player.y = arcY;
    }
  }

  private moveBots(now: number, dt: number): void {
    this.state.players.forEach((player: PlayerState): void => {
      if (!player.isBot || !player.alive) {
        return;
      }
      let brain = this.brains.get(player.sessionId);
      if (brain === undefined) {
        brain = createBrain(now, this.botCounter + 7);
        this.brains.set(player.sessionId, brain);
      }
      const step = stepBot(player, brain, now);
      // Same grounded path as humans (wedge block + gated collision +
      // hysteretic support): bots stop/slide at geometry instead of walking
      // through it. Bots stay grounded (no pad launches — weak ground game
      // by design) and derive y from XZ, so a bot wandering up a ramp reads
      // at slope height for remotes and balls.
      const feet = feetYOf(player.y);
      const moved = resolveGroundMove(
        player.x,
        player.z,
        player.x + step.moveX * BOT_SPEED * dt,
        player.z + step.moveZ * BOT_SPEED * dt,
        PLAYER_BODY_RADIUS,
        feet,
      );
      player.x = clampPosition(moved.x);
      player.z = clampPosition(moved.z);
      player.y = this.groundSupport(player.x, player.z, feet);
      player.rotY = step.rotY;
    });
  }

  // R2 cannon bots: same cannon, simple AI (random charge 0.6-2.0s via
  // planBotFire, 4s cooldown + jitter, exact aim with zero spray). Reload
  // gated via reloadUntil; SUPER buff consumed on fire like humans.
  private fireBots(now: number): void {
    // R1: spectators are invisible to bot targeting (no phantom kills).
    const all: PlayerState[] = [];
    this.state.players.forEach((player: PlayerState): void => {
      if (!player.ready || player.spectator) {
        return;
      }
      all.push(player);
    });
    this.state.players.forEach((bot: PlayerState): void => {
      if (!bot.isBot || !bot.alive) {
        return;
      }
      if (now < bot.reloadUntil) {
        return;
      }
      const brain = this.brains.get(bot.sessionId);
      if (brain === undefined) {
        return;
      }
      const plan = planBotFire(bot, all, brain, now);
      if (plan === null) {
        return;
      }
      const useSuper = bot.superBuff;
      bot.superBuff = false;
      this.spawnBall(bot, plan.power01, plan.yaw, plan.pitch, useSuper, now);
    });
  }

  private tickRespawns(now: number): void {
    const due: string[] = [];
    this.respawnAt.forEach((at: number, sessionId: string): void => {
      if (now >= at) {
        due.push(sessionId);
      }
    });
    for (const sessionId of due) {
      const player = this.state.players.get(sessionId);
      this.respawnAt.delete(sessionId);
      if (player === undefined || player.alive || !player.ready || player.spectator) {
        continue;
      }
      respawnPlayer(player, this.spawnCursor % MAX_PLAYERS, now);
      // Fresh life: no carried SUPER buff, no pending reload gate, grounded.
      player.superBuff = false;
      player.reloadUntil = 0;
      this.airSince.delete(sessionId);
      this.spawnCursor += 1;
    }
  }

  private findScoreWinner(): string | null {
    let winner: string | null = null;
    this.state.players.forEach((player: PlayerState): void => {
      if (!player.ready || player.spectator) {
        return;
      }
      if (player.score >= WIN_SCORE && winner === null) {
        winner = player.sessionId;
      }
    });
    return winner;
  }

  private leaderSessionId(): string {
    let bestId = "";
    let bestScore = -1;
    this.state.players.forEach((player: PlayerState): void => {
      if (!player.ready || player.spectator) {
        return;
      }
      if (player.score > bestScore) {
        bestScore = player.score;
        bestId = player.sessionId;
      }
    });
    return bestId;
  }

  // R1: only ready humans count toward rounds/bots; spectators are ignored.
  private humanEntryCount(): number {
    let count = 0;
    this.state.players.forEach((player: PlayerState): void => {
      if (!player.isBot) {
        count += 1;
      }
    });
    return count;
  }

  private humanCount(): number {
    let count = 0;
    this.state.players.forEach((player: PlayerState): void => {
      if (!player.isBot && player.ready && !player.spectator) {
        count += 1;
      }
    });
    return count;
  }

  private spectatorCount(): number {
    let count = 0;
    this.state.players.forEach((player: PlayerState): void => {
      if (!player.isBot && (!player.ready || player.spectator)) {
        count += 1;
      }
    });
    return count;
  }

  private readyCount(): number {
    let count = 0;
    this.state.players.forEach((player: PlayerState): void => {
      if (player.ready && !player.spectator) {
        count += 1;
      }
    });
    return count;
  }

  // Public counters for live HUD (Players N | Watching M) and unit tests.
  public readyFighterCount(): number {
    return this.readyCount();
  }

  public watchingCount(): number {
    return this.spectatorCount();
  }

  private botCount(): number {
    let count = 0;
    this.state.players.forEach((player: PlayerState): void => {
      if (player.isBot) {
        count += 1;
      }
    });
    return count;
  }

  // Fill empty slots with weak bots: total target is
  // max(MIN_TOTAL_PLAYERS, humans * 2) capped by MAX_PLAYERS/MAX_BOTS.
  // R1: humans = ready humans; spectators alone never trigger bots. The
  // total-entity cap (players.size < MAX_PLAYERS) keeps bot fills from
  // crowding out spectator slots when several watchers are already in.
  private ensureBots(): void {
    if (this.state.phase !== "lobby" && this.state.phase !== "countdown") {
      return;
    }
    const humans = this.humanCount();
    if (humans === 0) {
      return;
    }
    const desired = Math.min(MAX_PLAYERS, Math.max(MIN_TOTAL_PLAYERS, humans * 2));
    const now = this.currentTime();
    while (this.readyCount() < desired && this.botCount() < MAX_BOTS && this.state.players.size < MAX_PLAYERS) {
      this.botCounter += 1;
      const id = `bot-${this.botCounter}`;
      const bot = new PlayerState();
      bot.sessionId = id;
      bot.nick = this.nextBotName();
      const spawn = this.pickSpawn(this.spawnCursor);
      this.spawnCursor += 1;
      bot.x = spawn.x;
      bot.z = spawn.z;
      bot.y = 1.1;
      bot.rotY = 0;
      bot.hp = 100;
      bot.score = 0;
      bot.alive = true;
      bot.isBot = true;
      bot.invulnUntil = 0;
      bot.ready = true;
      bot.spectator = false;
      this.state.players.set(id, bot);
      this.brains.set(id, createBrain(now, this.botCounter * 131 + 7));
    }
  }

  private nextBotName(): string {
    const taken = new Set<string>();
    this.state.players.forEach((player: PlayerState): void => {
      taken.add(player.nick);
    });
    const index = (this.botCounter - 1) % BOT_NAMES.length;
    const base = BOT_NAMES[index] ?? "Bot";
    if (!taken.has(base)) {
      return base;
    }
    return sanitizeNick(base, taken);
  }

  private pickSpawn(index: number): { x: number; z: number } {
    // Corner cycle with the same inset the client arena uses
    // (ARENA_HALF_SIZE - SPAWN_INSET).
    const inset = ARENA_HALF_SIZE - SPAWN_INSET;
    const spots = [
      { x: -inset, z: -inset },
      { x: inset, z: -inset },
      { x: -inset, z: inset },
      { x: inset, z: inset },
      { x: 0, z: -inset },
      { x: 0, z: inset },
    ];
    const slot = ((index % spots.length) + spots.length) % spots.length;
    const picked = spots[slot];
    if (picked === undefined) {
      return { x: 0, z: 0 };
    }
    return { x: picked.x, z: picked.z };
  }
}

export function clampPosition(value: number): number {
  return Math.max(-ARENA_HALF_SIZE, Math.min(ARENA_HALF_SIZE, value));
}

// R1 Play-nick resolution: trimmed nick (max 16 chars); empty input falls
// back to Guest-XXXX (unique against taken nicks); otherwise the standard
// guest validation + dedupe applies (2-16 chars, Kaban fallback, suffixes).
export function resolvePlayNick(raw: unknown, taken: ReadonlySet<string>): string {
  const text = typeof raw === "string" ? raw.trim().slice(0, NICK_MAX_LENGTH) : "";
  if (text.length === 0) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const candidate = `${GUEST_NICK_PREFIX}-${Math.floor(1000 + Math.random() * 9000)}`;
      if (!taken.has(candidate)) {
        return candidate;
      }
    }
  }
  return sanitizeNick(text, taken);
}
