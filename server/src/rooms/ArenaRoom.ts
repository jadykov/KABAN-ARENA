import { Room, type Client } from "colyseus";
import { activeTemporarySurface, getSuperBonus, GRENADE_FRAGMENT_COUNT, isSuperBonusKind, TEMPORARY_SWAMP_SPEED_MULT } from "../../../shared/super-bonuses.mjs";
import { SuperBonusSystem, bonusLineOfSight } from "../super-bonuses.js";
import { PICKUP_VISUAL_Y } from "../../../shared/arena-layout.mjs";
import {
  ARENA_LAYOUT,
  ARENA_HALF_SIZE,
  BALL_GRAVITY,
  BALL_GROUND_Y,
  BALL_HIT_RADIUS,
  BALL_HIT_PLAYER_MESSAGE,
  BALL_RADIUS,
  BALL_ROLL_CLIMB_MAX,
  BALL_ROLL_ENTER_KEEP,
  BALL_ROLL_FRICTION,
  BALL_ROLL_MIN_SPEED,
  BALL_ROLL_STOP_SPEED,
  BALL_ROLL_WALL_KEEP,
  BALL_SETTLE_DAMP_RATE,
  BALL_SETTLE_TIME_MS,
  BALL_STEP_MAX_M,
  BODY_CENTER_Y,
  BOT_NAMES,
  BOT_SPEED,
  CENTER_ITEM_NAMES,
  type CenterItemKind,
  CHARGE_DURATION_MS,
  CHARGE_MOVE_MULT,
  FIRE_PITCH_MAX,
  FIRE_PITCH_MIN,
  GUEST_NICK_PREFIX,
  HIT_KNOCKBACK_M,
  ICE_ACCEL,
  ICE_COAST_ACCEL,
  ICE_INPUT_THRESHOLD,
  ICE_LINEAR_DAMPING,
  ICE_SPEED_MULT,
  INVULN_MS,
  isOnIce,
  isOnSwamp,
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
  POWERUP_PICKUP_RADIUS,
  POWERUP_RESPAWN_MS,
  RAMP_ADMIT_MIN_FEET,
  RAMP_ENTRY_TOL,
  RAMP_LANE_CAPTURE_TOL,
  RELOAD_MS,
  REMATCH_DELAY_MS,
  RESPAWN_DELAY_MS,
  ROUND_DURATION_MS,
  SHIELD_CAPACITY,
  SHIELD_DURATION_MS,
  SELF_ARMING_DIST_M,
  SELF_ARMING_TIME_S,
  SERVER_OBSTACLES,
  SERVER_PLATFORMS,
  SIM_TICK_MS,
  SPEED_DURATION_MS,
  SPEED_MULTIPLIER,
  SWAMP_SPEED_MULT,
  SURFACE_MAX_BODY_Y,
  SUPER_LIFE_S,
  SUPER_PICKUP_RADIUS,
  SUPER_SPAWN_S,
  SUPPORT_STICK_TOL,
  TRAMPOLINE_MAX_AIR_S,
} from "../config.js";
import { createBrain, planBotFire, stepBot, type BotBrain } from "../bots.js";
import {
  applyHit,
  absorbShieldDamage,
  bodyCenterYAt,
  bodyCenterYAtExpanded,
  bodyCenterYForFighterAt,
  canDamage,
  damageForPower,
  describeBallSurface,
  groundTopAt,
  getSpawnForIndex,
  isOnTrampolinePad,
  muzzleForShot,
  powerToSpeed,
  rampBandHeightAt,
  rampBandHeightAtExpanded,
  rampClearsCapsuleAt,
  rampHeightAt,
  recoilDistanceForPower,
  resolveThrowerY,
  respawnPlayer,
  sanitizeNick,
  sanitizeThrowerY,
  trampolineArcY,
  type BallContact,
} from "../hits.js";
import { ArenaState, BallState, PickupState, PlayerState, type RoundPhase } from "../state.js";
// Re-exported for unit-test compat (layout data now lives in config).
export { SERVER_OBSTACLES };

interface MoveInput {
  x: number;
  y: number;
  rotY: number;
  seq: number;
  charging: boolean;
}

interface PlanarMotion {
  vx: number;
  vz: number;
}

export interface FirePayload {
  power01: number;
  yaw: number;
  pitch: number;
  super?: boolean;
  throwerY?: number;
}

// Future center-item kinds live in config (CENTER_ITEM_NAMES carries the
// feed display name per kind: "super" is the only live kind today, see
// tickCenterItems). Re-exported here so existing import sites keep working.
export type { CenterItemKind };

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

// A slab blocks side entry while it intersects the capsule. Its upper
// surface remains climbable, and its raised lower face leaves a true
// underpass when the capsule fits. The extra lateral radius matches Rapier's
// capsule contact with the visual slab's side.
function rampBlocksCapsuleAt(x: number, z: number, feet: number, radius: number): boolean {
  for (const platform of SERVER_PLATFORMS) {
    if (rampHeightAt(platform, x, z, radius) > feet + RAMP_ENTRY_TOL &&
        !rampClearsCapsuleAt(platform, x, z, feet, radius)) {
      return true;
    }
  }
  return false;
}

// Axis-separated fallback preserves sliding along a blocked slab. Legitimate
// climbing changes slope height by ~0.06m per tick, below RAMP_ENTRY_TOL.
function resolveWedgeEntry(
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number,
  feet: number,
  radius: number,
): { x: number; z: number } {
  if (!rampBlocksCapsuleAt(toX, toZ, feet, radius)) {
    return { x: toX, z: toZ };
  }
  if (!rampBlocksCapsuleAt(toX, fromZ, feet, radius)) {
    return { x: toX, z: fromZ };
  }
  if (!rampBlocksCapsuleAt(fromX, toZ, feet, radius)) {
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
  const wedged = resolveWedgeEntry(fromX, fromZ, toX, toZ, feet, radius);
  return resolvePlayerMove(fromX, fromZ, wedged.x, wedged.z, radius, feet);
}

// Authoritative FFA room (Stage 4): guest-nick join, inputs-only 20/s,
// server hitscan (100HP/25dmg), C2 short-round loop 3/3/2, weak bots.
export class ArenaRoom extends Room<ArenaState> {
  // Overridable clock for deterministic unit tests (null = wall clock).
  public testNow: number | null = null;

  private readonly inputs = new Map<string, MoveInput>();
  // Reused for each fighter's last resolved planar speed. On ice this becomes
  // sliding velocity; on ordinary ground the direct input path stays intact.
  private readonly planarMotion = new Map<string, PlanarMotion>();
  private readonly respawnAt = new Map<string, number>();
  private readonly brains = new Map<string, BotBrain>();
  // Trampoline-flight launch timestamps (ms, currentTime clock): present =
  // airborne following trampolineArcY, absent = grounded (y derived from XZ).
  // Humans only — bots never launch (weak ground game by design).
  private readonly airSince = new Map<string, number>();
  private readonly bonusAir = new Map<string, { velocity: number }>();
  private bonuses!: SuperBonusSystem;
  // Kept outside Schema so neither snapshots nor patches reveal the gift.
  private pendingSuperKind = "";
  private botCounter = 0;
  private ballCounter = 0;
  // Scratch ball-surface contact (Stage 4d.4): reused as the describeBallSurface
  // out-param every ball tick, so the surface path allocates nothing per tick.
  private readonly scratchContact: BallContact = { kind: "none", axis: null, face: 0, restY: 0 };
  private countdownEndsAt = 0;
  private roundEndsAt = 0;
  private endedAt = 0;
  private spawnCursor = 0;
  // Overridable for deterministic pickup tests; production uses Math.random.
  public pickupRandom: () => number = Math.random;

  private currentTime(): number {
    return this.testNow ?? Date.now();
  }

  public async onCreate(): Promise<void> {
    this.maxClients = MAX_PLAYERS;
    this.setState(new ArenaState());
    this.bonuses = new SuperBonusSystem({
      state: this.state,
      hasCentralSheep: () => this.state.superActive && this.pendingSuperKind === "sheep",
      move: (fx, fz, x, z, radius, feet) => {
        const moved = resolveGroundMove(fx, fz, x, z, radius, feet);
        return { x: clampPosition(moved.x), z: clampPosition(moved.z) };
      },
      die: (victim, owner, now) => this.killBonusVictim(victim, owner, now),
      launch: (victim, velocity) => {
        this.airSince.delete(victim.sessionId);
        this.bonusAir.set(victim.sessionId, { velocity });
      },
      cancelCharge: (victim) => {
        const input = this.inputs.get(victim.sessionId);
        if (input !== undefined) input.charging = false;
      },
      broadcastHit: (ballId, victim, x, y, z) => this.broadcast(BALL_HIT_PLAYER_MESSAGE, {
        ballId, victimId: victim.sessionId, x, y, z, super: true,
      }),
      surface: (x, y, z) => this.bonusSurface(x, y, z),
    }, () => this.pickupRandom());
    this.state.serverNow = this.currentTime();
    ARENA_LAYOUT.pickups.forEach((slot, index) => {
      const pickup = new PickupState();
      pickup.x = slot.x;
      pickup.z = slot.z;
      this.state.pickups.set(String(index), pickup);
    });
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
      client.send("room-full", { reason: "Комната заполнена" });
      return;
    }
    // A connected spectator needs an entity slot too. Retire enough bots
    // before adding the entry, preserving the total cap without rejecting
    // a human because server-controlled fighters occupied the room.
    if (this.state.players.size >= MAX_PLAYERS) {
      for (const [id, entry] of this.state.players) {
        if (!entry.isBot) continue;
        this.removeBot(id);
        if (this.state.players.size < MAX_PLAYERS) break;
      }
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
    this.planarMotion.delete(client.sessionId);
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
      client.send("room-full", { reason: "Комната заполнена" });
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
    this.planarMotion.delete(client.sessionId);
    this.airSince.delete(client.sessionId);
    this.ensureBots();
    client.send("welcome", { sessionId: client.sessionId, nick, x: player.x, z: player.z });
    // Event feed (owner 4d.4): everyone sees who entered the fight, in the
    // same killfeed channel as kills and pickups (brief one-liner).
    this.broadcast("killfeed", { message: `${nick} вступил в бой` });
  }

  public async onLeave(client: Client): Promise<void> {
    this.bonuses.removeOwner(client.sessionId);
    this.bonusAir.delete(client.sessionId);
    if (this.state.players.has(client.sessionId)) {
      this.state.players.delete(client.sessionId);
    }
    this.inputs.delete(client.sessionId);
    this.planarMotion.delete(client.sessionId);
    this.respawnAt.delete(client.sessionId);
    this.airSince.delete(client.sessionId);
    // Restore the solo opponents immediately, including during a live
    // round; no participants means no bots even if spectators remain.
    this.ensureBots();
    if (this.humanCount() === 0 && this.state.phase !== "lobby") {
      this.toLobby();
    }
  }

  // Fixed-step authoritative tick (SIM_TICK_MS, 20/s). Public so tests can
  // drive the round loop deterministically via testNow.
  public tickRoom(stepMs: number = SIM_TICK_MS): void {
    const now = this.currentTime();
    this.state.tick += 1;
    this.state.serverNow = now;
    // Enforce suppression/cap before combat in every phase. Joins/leaves
    // restore the population; live ticks do not spawn opponents each frame.
    this.ensureBots(false);
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
    const left = this.roundEndsAt - now;
    this.state.remainingMs = Math.max(0, left);
    if (left <= 0) {
      this.endRound(this.leaderSessionId());
      return;
    }
    const dt = Math.max(1, stepMs) / 1000;
    this.expireBonuses(now);
    this.moveHumans(dt);
    this.moveBots(now, dt);
    this.tickPickups(now);
    this.fireBots(now);
    this.stepBalls(now, dt);
    this.bonuses.tick(now, dt);
    this.tickCenterItems(now);
    this.tickRespawns(now);
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
    // Fresh spawn for every ready entrant; spectators stay out of the round.
    let index = 0;
    this.state.players.forEach((player: PlayerState): void => {
      if (!player.ready || player.spectator) {
        return;
      }
      respawnPlayer(player, index, now);
      player.superBuff = false;
      this.clearBonuses(player);
      player.reloadUntil = 0;
      index += 1;
    });
    this.respawnAt.clear();
    this.planarMotion.clear();
    this.airSince.clear();
    // Fresh round: all balls go, including ricocheted/settling/resting ones —
    // rest state lives on BallState itself, so clear() leaks nothing.
    this.state.balls.clear();
    this.bonuses.clear();
    this.bonusAir.clear();
    this.ballCounter = 0;
    this.clearCenterItem(now + SUPER_SPAWN_S * 1000);
    this.resetPickups();
    // Event feed (owner 4d.4): join/kill/pickup one-liners ONLY — round
    // start/end stay silent so the 2-line feed never fills with non-events.
  }

  private endRound(winnerSessionId: string): void {
    this.state.phase = "ended";
    this.state.winner = winnerSessionId;
    this.state.remainingMs = 0;
    this.endedAt = this.currentTime();
    this.state.balls.clear();
    this.bonuses.clear();
    this.clearCenterItem();
    this.bonusAir.clear();
    this.airSince.clear();
    this.inputs.clear();
  }

  private resetForRematch(): void {
    let index = 0;
    const now = this.currentTime();
    this.state.players.forEach((player: PlayerState): void => {
      player.score = 0;
      player.superBuff = false;
      this.clearBonuses(player);
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
    this.planarMotion.clear();
    this.airSince.clear();
    // Rematch reset: same full clear as round start — no resting ball or
    // settle timer leaks across rounds.
    this.state.balls.clear();
    this.bonuses.clear();
    this.bonusAir.clear();
    this.clearCenterItem();
    this.resetPickups();
    this.toLobby();
  }

  private toLobby(): void {
    this.state.balls.clear();
    this.bonuses.clear();
    this.clearCenterItem();
    this.bonusAir.clear();
    this.airSince.clear();
    this.state.phase = "lobby";
    this.state.countdownMs = 0;
    this.state.remainingMs = 0;
    this.planarMotion.clear();
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
      charging: body["charging"] === true && this.currentTime() >= player.frozenUntil && this.currentTime() >= player.reloadUntil,
    });
  }

  // Release-to-fire validates the fighter, freeze, reload and phase. A held
  // centre item replaces the next accepted throw, including a missed throw. Quick-tap payloads (<80ms of charge) are dropped
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
    if (shooter.chargeUntil > 0 && now >= shooter.chargeUntil) {
      shooter.chargeUntil = 0;
    }
    this.bonuses.expirePlayer(shooter, now);
    if (now < shooter.reloadUntil || now < shooter.frozenUntil) {
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
    const useSuper = isSuperBonusKind(shooter.superKind) || (wantSuper && shooter.superBuff);
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
    if (!shooter.alive || !shooter.ready || shooter.spectator || now < shooter.frozenUntil || (shooter.superKind !== "" && now < shooter.reloadUntil)) {
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
    const bodyY = this.bonusAir.has(shooter.sessionId) ? shooter.y : resolveThrowerY(throwerY, shooter.x, shooter.z);
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
    ball.bonusKind = isSuperBonusKind(shooter.superKind) ? shooter.superKind : "";
    ball.super = superShot || ball.bonusKind !== "";
    ball.originX = muzzle.x;
    ball.originY = muzzle.y;
    ball.originZ = muzzle.z;
    if (ball.bonusKind) this.bonuses.register(ball);
    ball.ageMs = 0;
    ball.distM = 0;
    ball.ricochet = false;
    ball.resting = false;
    ball.rolling = false;
    ball.settleMs = 0;
    ball.restY = 0;
    // Perf cap: max 12 live balls server-side, oldest despawns first.
    this.reserveBallSlots(1);
    this.state.balls.set(ball.ballId, ball);
    shooter.superKind = "";
    shooter.superUntil = 0;
    shooter.superBuff = false;
    shooter.reloadUntil = now + RELOAD_MS;
    // This is the first accepted shot after pickup. Canceling a charge never
    // calls spawnBall, while denied shots return before reaching this path.
    shooter.chargeUntil = 0;
    return ball;
  }

  private reserveBallSlots(count: number): void {
    while (this.state.balls.size + count > MAX_LIVE_BALLS) {
      let oldestId: string | null = null;
      let oldestAge = -1;
      this.state.balls.forEach((entry: BallState, key: string): void => {
        if (entry.ageMs > oldestAge) {
          oldestAge = entry.ageMs;
          oldestId = key;
        }
      });
      if (oldestId !== null) {
        this.state.balls.delete(oldestId);
        this.bonuses.forgetBall(oldestId);
      } else break;
    }
  }

  private grenadeContact(ball: BallState, now: number, nx: number, ny: number, nz: number): void {
    if (ball.grenadeFragment) { this.bonuses.grenadeBurst(ball, now); return; }
    // Replace the original atomically. Reserve all three slots before any
    // child is inserted; a full pool still produces exactly three children.
    this.state.balls.delete(ball.ballId);
    this.reserveBallSlots(GRENADE_FRAGMENT_COUNT);
    let normalLength = Math.hypot(nx, ny, nz);
    if (!(normalLength > 0)) { nx = 0; ny = 1; nz = 0; normalLength = 1; }
    nx /= normalLength; ny /= normalLength; nz /= normalLength;
    const heading = Math.atan2(Math.abs(ny) > 0.5 ? ball.vz : nz, Math.abs(ny) > 0.5 ? ball.vx : nx);
    for (let i = 0; i < GRENADE_FRAGMENT_COUNT; i += 1) {
      const angle = heading + (i - 1) * 0.7;
      const dx = Math.cos(angle); const dz = Math.sin(angle);
      const fragment = new BallState();
      fragment.ballId = `${ball.ballId}:fragment${i + 1}`;
      fragment.ownerId = ball.ownerId;
      fragment.bonusKind = "grenade";
      fragment.grenadeFragment = true;
      fragment.grenadeParentId = ball.ballId;
      fragment.super = true;
      fragment.x = ball.x + nx * 0.2 + dx * 0.04;
      fragment.y = ball.y + ny * 0.2;
      fragment.z = ball.z + nz * 0.2 + dz * 0.04;
      fragment.vx = dx * 4.4;
      fragment.vy = ny < -0.5 ? -2 : 2;
      fragment.vz = dz * 4.4;
      fragment.originX = fragment.x; fragment.originY = fragment.y; fragment.originZ = fragment.z;
      this.bonuses.register(fragment);
      this.state.balls.set(fragment.ballId, fragment);
    }
  }

  private grenadeRampContact(ball: BallState, now: number, previousX: number, previousY: number, previousZ: number): boolean {
    for (const ramp of SERVER_PLATFORMS) {
      const top = rampHeightAt(ramp, ball.x, ball.z);
      if (top <= 0) continue;
      const previousTop = rampHeightAt(ramp, previousX, previousZ);
      const crossesTop = previousTop > 0 && previousY >= previousTop && ball.y <= top;
      const crossesUnderside = previousTop > 0 && previousY < previousTop - 0.25 && ball.y >= top - 0.25;
      if (!crossesTop && !crossesUnderside && (ball.y > top || ball.y < top - 0.25)) continue;
      const underside = crossesUnderside || (previousTop > 0 && previousY < previousTop - 0.25);
      ball.y = top + (underside ? -0.29 : 0.04);
      this.grenadeContact(ball, now, 0, underside ? -1 : 1, 0);
      return true;
    }
    return false;
  }

  // Authoritative ball step (Stage 4d.4): gravity arc, substepped flight
  // (each tick move is split into BALL_STEP_MAX_M substeps so the ENTRY face
  // is sampled before deep-penetration misclassification — no tunneling past
  // thin side-entry bands), ricochet/roll/settle contacts, player hits (radius
  // ~0.9, self-damage armed after 1m / 0.3s), damage to ALL incl. self +
  // knockback impulse. Kill/respawn/killfeed reuse existing paths.
  // - Resting balls: purely decorative — aged (so pool overflow evicts
  //   oldest-first, resting included) but never moved or damage-checked.
  // - Rolling balls (owner 4d.4: lively inertia after ricochets): gentle
  //   friction-damped planar motion glued to the live support (rolls off
  //   tower edges onto the true surface below, climbs low block tops like
  //   the settle re-snap, reflects damped off tall faces), then resting=true
  //   once slow. Post-ricochet state: no damage, no knockback, no broadcast.
  // - Settling balls: near-zero-speed landings only — velocity damps
  //   exponentially over BALL_SETTLE_TIME_MS (~0.4s slide pinned at restY),
  //   then resting=true with velocity 0.
  // - Normal flying balls: vertical surfaces (boundary walls, sheer
  //   obstacle/platform sides) REFLECT on the hit axis (ricochet=true, no
  //   damage ever after); floor/up-facing tops ENTER ROLL when fast or SETTLE
  //   when slow. SUPER balls despawn on first environmental contact, exactly
  //   as before.
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
    // New fragments are visible in this patch but are first simulated on the
    // next tick. A snapshot also avoids advancing siblings inserted mid-loop.
    [...this.state.balls].forEach(([ballId, ball]): void => {
      if (!this.state.balls.has(ballId)) return;
      const prevAge = ball.ageMs;
      ball.ageMs += dt * 1000;
      if (ball.bonusKind === "grenade" && ball.ageMs >= (ball.grenadeFragment ? 4000 : 8000)) { dead.push(ballId); return; }
      if (prevAge < PATCH_RATE_MS) {
        return;
      }
      if (ball.resting) {
        return;
      }
      if (ball.rolling) {
        this.stepRollingBall(ball, dt);
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
      if (ball.bonusKind === "boomerang") {
        if (ball.ageMs >= 2500) { dead.push(ballId); return; }
        if (ball.distM >= 6) ball.returning = true;
        if (ball.returning) {
          const dx = ball.originX - ball.x;
          const dy = ball.originY - ball.y;
          const dz = ball.originZ - ball.z;
          const distance = Math.hypot(dx, dy, dz);
          if (distance < 0.25) { dead.push(ballId); return; }
          const speed = powerToSpeed(ball.power01);
          const turn = Math.min(1, dt * 10);
          ball.vx += (dx / distance * speed - ball.vx) * turn;
          ball.vy += (dy / distance * speed - ball.vy) * turn;
          ball.vz += (dz / distance * speed - ball.vz) * turn;
        }
      } else ball.vy -= BALL_GRAVITY * dt;
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
        const previousX = ball.x; const previousY = ball.y; const previousZ = ball.z;
        const moveX = ball.vx * subDt;
        const moveY = ball.vy * subDt;
        const moveZ = ball.vz * subDt;
        ball.x += moveX;
        ball.y += moveY;
        ball.z += moveZ;
        ball.distM += Math.sqrt(moveX * moveX + moveY * moveY + moveZ * moveZ);
        if (this.collideBoundaryWalls(ball)) {
          if (ball.bonusKind === "grenade") {
            const nx = Math.abs(ball.x) === ARENA_HALF_SIZE ? -Math.sign(ball.x) : 0;
            const nz = Math.abs(ball.z) === ARENA_HALF_SIZE ? -Math.sign(ball.z) : 0;
            ball.x += nx * 0.04; ball.z += nz * 0.04;
            this.grenadeContact(ball, now, nx, 0, nz);
          } else if (ball.bonusKind) this.bonuses.install(ball, now);
          dead.push(ballId);
          return;
        }
        const contact = describeBallSurface(ball.x, ball.y, ball.z, ball.vx, ball.vz, this.scratchContact);
        if (contact.kind === "vertical") {
          if (ball.bonusKind === "grenade") {
            const nx = contact.axis === "x" ? Math.sign(contact.face - ball.x) || -Math.sign(ball.vx) || 1 : 0;
            const nz = contact.axis === "z" ? Math.sign(contact.face - ball.z) || -Math.sign(ball.vz) || 1 : 0;
            if (contact.axis === "x") ball.x = contact.face + nx * 0.04;
            else ball.z = contact.face + nz * 0.04;
            this.grenadeContact(ball, now, nx, 0, nz);
            dead.push(ballId);
            return;
          }
          if (ball.bonusKind) {
            const clearance = ball.bonusKind === "sheep" ? 0.3 : 0.04;
            const x = contact.axis === "x" ? contact.face - Math.sign(ball.vx) * clearance : ball.x;
            const z = contact.axis === "z" ? contact.face - Math.sign(ball.vz) * clearance : ball.z;
            this.bonuses.install(ball, now, x, ball.y, z);
            dead.push(ballId);
            return;
          }
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
          if (ball.bonusKind === "grenade") {
            ball.y = contact.restY - BALL_RADIUS + 0.04;
            this.grenadeContact(ball, now, 0, 1, 0);
            dead.push(ballId);
            return;
          }
          if (ball.bonusKind) {
            this.bonuses.install(ball, now, ball.x, Math.max(0, contact.restY - BALL_RADIUS), ball.z);
            dead.push(ballId);
            return;
          }
          if (ball.super) {
            dead.push(ballId);
            return;
          }
          // Lively touchdown (owner 4d.4): fast arrivals keep rolling with
          // inertia; near-zero-speed landings take the fast settle path.
          if (Math.hypot(ball.vx, ball.vz) >= BALL_ROLL_MIN_SPEED) {
            this.enterRoll(ball, contact.restY);
          } else {
            this.enterSettle(ball, contact.restY, dt);
          }
          return;
        }
        if (ball.bonusKind === "grenade" && this.grenadeRampContact(ball, now, previousX, previousY, previousZ)) {
          dead.push(ballId);
          return;
        }
        if (this.bonuses.disarmAt(ball)) { dead.push(ballId); return; }
        const victim = ball.bonusHit ? null : this.findBallVictim(ball);
        if (victim !== null) {
          if (ball.bonusKind) {
            if (ball.bonusKind === "grenade") {
              if (!ball.grenadeFragment) this.bonuses.directHit(ball, victim, now);
              this.bonuses.grenadeBurst(ball, now);
              dead.push(ballId);
              return;
            }
            this.bonuses.directHit(ball, victim, now);
            if (ball.bonusKind === "boomerang") { ball.bonusHit = true; continue; }
            this.bonuses.install(ball, now);
            dead.push(ballId);
            return;
          }
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
      this.bonuses.forgetBall(ballId);
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

  // Roll entry (owner 4d.4 lively physics): pin y at the touchdown surface,
  // kill vertical motion, keep a scrubbed share of the horizontal speed (the
  // impact loses energy — full-power arrivals still roll several meters).
  // Rolling is a post-ricochet state (ricochet=true: never damages again);
  // motion starts on the next tick, no timer needed.
  private enterRoll(ball: BallState, restY: number): void {
    ball.restY = Number.isFinite(restY) ? restY : ball.y;
    ball.vy = 0;
    ball.y = ball.restY;
    ball.vx *= BALL_ROLL_ENTER_KEEP;
    ball.vz *= BALL_ROLL_ENTER_KEEP;
    ball.settleMs = 0;
    ball.ricochet = true;
    ball.rolling = true;
  }

  // One rolling tick: gentle friction damp, axis-separated planar move glued
  // to the live support, damped reflection off tall faces. Low block tops
  // (step up <= BALL_ROLL_CLIMB_MAX, e.g. the outer 0.8m blocks from the
  // floor) climb exactly like the settle re-snap; tall faces (towers,
  // platforms, boundary walls) reflect that axis at BALL_ROLL_WALL_KEEP and
  // keep rolling. Rolls off edges drop to the true support below (no hover,
  // no embed); boundary clamps reflect instead of tunneling. Victim contact
  // bounces off via the shared flight helper (no damage, no knockback, no
  // broadcast). Speeds below BALL_ROLL_STOP_SPEED come to rest — the existing
  // per-owner cap and fire-despawn paths take over from there. Scalar math
  // only, zero per-tick allocation.
  private stepRollingBall(ball: BallState, dt: number): void {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0.05;
    const damp = Math.exp(-BALL_ROLL_FRICTION * step);
    ball.vx *= damp;
    ball.vz *= damp;
    ball.vy = 0;
    if (Math.hypot(ball.vx, ball.vz) < BALL_ROLL_STOP_SPEED) {
      ball.vx = 0;
      ball.vy = 0;
      ball.vz = 0;
      ball.restY = Math.max(BALL_GROUND_Y, groundTopAt(ball.x, ball.z)) + BALL_RADIUS;
      ball.y = ball.restY;
      ball.settleMs = 0;
      ball.rolling = false;
      ball.resting = true;
      this.enforceRestingCap(ball);
      return;
    }
    const fromX = ball.x;
    const fromZ = ball.z;
    let nextX = ball.x + ball.vx * step;
    if (nextX > ARENA_HALF_SIZE) {
      nextX = ARENA_HALF_SIZE;
      ball.vx = -ball.vx * BALL_ROLL_WALL_KEEP;
    } else if (nextX < -ARENA_HALF_SIZE) {
      nextX = -ARENA_HALF_SIZE;
      ball.vx = -ball.vx * BALL_ROLL_WALL_KEEP;
    }
    const supportX = Math.max(BALL_GROUND_Y, groundTopAt(nextX, ball.z)) + BALL_RADIUS;
    if (supportX - ball.y <= BALL_ROLL_CLIMB_MAX) {
      ball.x = nextX;
      ball.y = supportX;
    } else {
      ball.vx = -ball.vx * BALL_ROLL_WALL_KEEP;
    }
    let nextZ = ball.z + ball.vz * step;
    if (nextZ > ARENA_HALF_SIZE) {
      nextZ = ARENA_HALF_SIZE;
      ball.vz = -ball.vz * BALL_ROLL_WALL_KEEP;
    } else if (nextZ < -ARENA_HALF_SIZE) {
      nextZ = -ARENA_HALF_SIZE;
      ball.vz = -ball.vz * BALL_ROLL_WALL_KEEP;
    }
    const supportZ = Math.max(BALL_GROUND_Y, groundTopAt(ball.x, nextZ)) + BALL_RADIUS;
    if (supportZ - ball.y <= BALL_ROLL_CLIMB_MAX) {
      ball.z = nextZ;
      ball.y = supportZ;
    } else {
      ball.vz = -ball.vz * BALL_ROLL_WALL_KEEP;
    }
    ball.restY = ball.y;
    ball.distM += Math.hypot(ball.x - fromX, ball.z - fromZ);
    const victim = this.findBallVictim(ball);
    if (victim !== null) {
      this.bounceBallOffVictim(ball, victim);
    }
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
    const { healthDamage } = absorbShieldDamage(victim, damage, now);
    if (shooter !== undefined) {
      const result = applyHit(shooter, victim, now, healthDamage);
      this.applyKnockback(victim, ball);
      if (result.killed) {
        victim.superBuff = false;
        this.clearBonuses(victim);
        this.planarMotion.delete(victim.sessionId);
        this.respawnAt.set(victim.sessionId, now + RESPAWN_DELAY_MS);
        this.broadcast("killfeed", { message: `${shooter.nick} победил ${victim.nick}` });
      }
    } else {
      // Owner left mid-flight: still damage the victim, no scorer.
      victim.hp = Math.max(0, victim.hp - healthDamage);
      this.applyKnockback(victim, ball);
      if (victim.hp <= 0) {
        victim.alive = false;
        victim.hp = 0;
        victim.superBuff = false;
        this.clearBonuses(victim);
        this.planarMotion.delete(victim.sessionId);
        this.respawnAt.set(victim.sessionId, now + RESPAWN_DELAY_MS);
      }
    }
    // Blood-FX trigger: damage registered on a player — clients show the
    // red hit burst ONLY for this event. Environmental contacts (boundary,
    // block, settle, pool overflow) and victim bounces broadcast nothing.
    // Position is the ball spot at hit (post-integration); payload stays
    // minimal (ids + position).
    if (healthDamage > 0) {
      this.broadcast(BALL_HIT_PLAYER_MESSAGE, {
        ballId,
        victimId: victim.sessionId,
        x: ball.x,
        y: ball.y,
        z: ball.z,
        super: ball.super,
      });
    }
  }

  private findBallVictim(ball: BallState): PlayerState | null {
    let victim: PlayerState | null = null;
    this.state.players.forEach((player: PlayerState): void => {
      if (victim !== null || !player.alive || !player.ready || player.spectator) {
        return;
      }
      if (ball.bonusKind && this.bonuses.alreadyHit(ball, player)) return;
      if (!canDamage(player, this.currentTime()) && ball.bonusKind !== "grenade") {
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
      const hitRadius = ball.grenadeFragment ? PLAYER_BODY_RADIUS + BALL_RADIUS * 0.5 : BALL_HIT_RADIUS;
      if (dx * dx + dy * dy + dz * dz <= hitRadius * hitRadius) {
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

  // One central item from the ten-kind bag; neutral pickups stay independent.
  private tickCenterItems(now: number): void {
    this.tickSuperItem(now);
  }

  private clearBonuses(player: PlayerState): void {
    this.bonuses.clearPlayer(player);
    this.bonusAir.delete(player.sessionId);
    player.shieldHp = 0;
    player.shieldUntil = 0;
    player.speedUntil = 0;
    player.chargeUntil = 0;
    player.pickupKind = "";
    player.pickupAt = 0;
  }

  private expireBonuses(now: number): void {
    this.state.players.forEach((player: PlayerState): void => {
      this.bonuses.expirePlayer(player, now);
      if (player.shieldHp > 0 && now >= player.shieldUntil) {
        player.shieldHp = 0;
        player.shieldUntil = 0;
      }
      if (player.speedUntil > 0 && now >= player.speedUntil) {
        player.speedUntil = 0;
      }
      if (player.chargeUntil > 0 && now >= player.chargeUntil) {
        player.chargeUntil = 0;
      }
    });
  }

  private resetPickups(): void {
    this.state.pickups.forEach((pickup: PickupState): void => {
      pickup.active = true;
      pickup.nextAt = 0;
    });
  }

  private tickPickups(now: number): void {
    this.state.pickups.forEach((pickup: PickupState, key: string): void => {
      if (!pickup.active && now >= pickup.nextAt) {
        pickup.active = true;
        pickup.nextAt = 0;
      }
      if (!pickup.active) return;
      this.state.players.forEach((player: PlayerState): void => {
        if (!pickup.active || !player.alive || !player.ready || player.spectator) return;
        // Pickups sit on the floor; an airborne fighter crossing the marker
        // well above it cannot collect it through the air.
        if (player.y > PICKUP_VISUAL_Y + POWERUP_PICKUP_RADIUS) return;
        const dx = player.x - pickup.x;
        const dz = player.z - pickup.z;
        if (dx * dx + dz * dz > POWERUP_PICKUP_RADIUS * POWERUP_PICKUP_RADIUS) return;
        const roll = this.pickupRandom();
        const kind = roll < 1 / 3 ? "shield" : roll < 2 / 3 ? "speed" : "charge";
        if (kind === "shield") {
          player.shieldHp = SHIELD_CAPACITY;
          player.shieldUntil = now + SHIELD_DURATION_MS;
        } else if (kind === "speed") {
          player.speedUntil = now + SPEED_DURATION_MS;
        } else {
          player.chargeUntil = now + CHARGE_DURATION_MS;
        }
        player.pickupKind = kind;
        player.pickupAt = now;
        player.pickupSeq += 1;
        pickup.active = false;
        pickup.nextAt = now + POWERUP_RESPAWN_MS;
        this.broadcast("pickup-granted", { playerId: player.sessionId, slotId: Number(key), kind, seq: player.pickupSeq });
      });
    });
  }

  private clearCenterItem(nextAt = 0): void {
    this.pendingSuperKind = "";
    this.state.superActive = false;
    this.state.superKind = "";
    this.state.superExpiresAt = 0;
    this.state.superNextAt = nextAt;
  }

  // Centre timing is 10/10/15 seconds. Each appearance consumes
  // one bag entry, even when nobody collects it. Sheep reserve a live slot.
  private tickSuperItem(now: number): void {
    if (this.state.superActive) {
      if (now >= this.state.superExpiresAt) {
        this.clearCenterItem(now + SUPER_SPAWN_S * 1000);
      } else {
        for (const player of this.state.players.values()) {
          if (!player.alive || !player.ready || player.spectator || player.superBuff || player.superKind || player.y > SURFACE_MAX_BODY_Y) continue;
          const dx = player.x - this.state.superX;
          const dz = player.z - this.state.superZ;
          if (dx * dx + dz * dz <= SUPER_PICKUP_RADIUS * SUPER_PICKUP_RADIUS) {
            const kind = this.pendingSuperKind;
            this.bonuses.give(player, kind, now);
            this.clearCenterItem(now + SUPER_SPAWN_S * 1000);
            this.broadcast("killfeed", { message: kind ? `${player.nick} подобрал ${getSuperBonus(kind)?.name ?? "СУПЕР-ядро"}` : `${player.nick} подобрал ${CENTER_ITEM_NAMES.super} (следующий бросок ×2)` });
            break;
          }
        }
      }
      return;
    }
    if (this.state.superNextAt !== 0 && now >= this.state.superNextAt) {
      const kind = this.bonuses.nextKind();
      if (kind === null) return;
      this.pendingSuperKind = kind;
      this.state.superKind = "";
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
    const strict = bodyCenterYForFighterAt(x, z, feet, PLAYER_BODY_RADIUS);
    const wide = bodyCenterYForFighterAt(x, z, feet, PLAYER_BODY_RADIUS, PLAYER_BODY_RADIUS);
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

  private killBonusVictim(victim: PlayerState, owner: PlayerState | undefined, now: number): void {
    this.clearBonuses(victim);
    this.inputs.delete(victim.sessionId);
    this.airSince.delete(victim.sessionId);
    this.planarMotion.delete(victim.sessionId);
    this.respawnAt.set(victim.sessionId, now + RESPAWN_DELAY_MS);
    if (owner !== undefined) this.broadcast("killfeed", { message: owner.sessionId === victim.sessionId ? `${victim.nick} попал в свою ловушку` : `${owner.nick} победил ${victim.nick}` });
  }

  private bonusSurface(x: number, bodyY: number, z: number): "ice" | "swamp" | "temporary-swamp" | "normal" {
    const temporary = activeTemporarySurface(this.state.bonusEffects.values(), x, bodyY, z, this.currentTime(), BODY_CENTER_Y,
      (effect) => bonusLineOfSight(effect.x, effect.y + 0.35, effect.z, x, bodyY, z));
    if (temporary !== undefined) return temporary.kind === "swamp" ? "temporary-swamp" : "ice";
    if (bodyY <= SURFACE_MAX_BODY_Y && isOnSwamp(x, z)) return "swamp";
    if (bodyY <= SURFACE_MAX_BODY_Y && isOnIce(x, z)) return "ice";
    return "normal";
  }

  private stepBonusAir(player: PlayerState, input: MoveInput | undefined, motion: PlanarMotion, dt: number): boolean {
    const air = this.bonusAir.get(player.sessionId);
    if (air === undefined) return false;
    const fromX = player.x; const fromZ = player.z;
    const moved = resolvePlayerMove(fromX, fromZ, fromX + motion.vx * dt, fromZ + motion.vz * dt, PLAYER_BODY_RADIUS, feetYOf(player.y));
    player.x = clampPosition(moved.x); player.z = clampPosition(moved.z);
    motion.vx = (player.x - fromX) / dt; motion.vz = (player.z - fromZ) / dt;
    if (input !== undefined) player.rotY = input.rotY;
    air.velocity = (air.velocity - 9.81 * dt) * Math.exp(-2.5 * dt);
    const nextY = player.y + air.velocity * dt;
    const support = bodyCenterYAtExpanded(player.x, player.z, PLAYER_BODY_RADIUS);
    if (air.velocity <= 0 && nextY <= support) {
      player.y = support;
      this.bonusAir.delete(player.sessionId);
      player.launchVelocity = 0;
    } else player.y = nextY;
    return true;
  }

  private motionFor(player: PlayerState): PlanarMotion {
    let motion = this.planarMotion.get(player.sessionId);
    if (motion === undefined) {
      // One allocation per life, then only scalar updates in the tick path.
      motion = { vx: 0, vz: 0 };
      this.planarMotion.set(player.sessionId, motion);
    }
    return motion;
  }

  private steerPlanarVelocity(
    motion: PlanarMotion,
    desiredX: number,
    desiredZ: number,
    maxSpeed: number,
    iceInputActive: boolean,
    touchingFloor: boolean,
    x: number,
    z: number,
    dt: number,
    bodyY: number = BODY_CENTER_Y,
  ): void {
    const surface = this.bonusSurface(x, bodyY, z);
    if (surface === "temporary-swamp" || (touchingFloor && surface === "swamp")) {
      // Mud cancels inherited planar momentum each tick, including for bots.
      const multiplier = surface === "temporary-swamp" ? TEMPORARY_SWAMP_SPEED_MULT : SWAMP_SPEED_MULT;
      motion.vx = desiredX * multiplier;
      motion.vz = desiredZ * multiplier;
      return;
    }
    if (surface !== "ice") {
      // Preserve existing direct control off ice, for humans and bots alike.
      motion.vx = desiredX;
      motion.vz = desiredZ;
      return;
    }
    // Mirror the client's low-grip steering at floor level: reduced speed
    // is a target and last velocity carries the slide. Positive bounded
    // acceleration always escapes from rest.
    const targetX = iceInputActive ? desiredX * ICE_SPEED_MULT : 0;
    const targetZ = iceInputActive ? desiredZ * ICE_SPEED_MULT : 0;
    let deltaX = targetX - motion.vx;
    let deltaZ = targetZ - motion.vz;
    const deltaLength = Math.hypot(deltaX, deltaZ);
    const maxDelta = (iceInputActive ? ICE_ACCEL : ICE_COAST_ACCEL) * dt;
    if (deltaLength > maxDelta) {
      const scale = maxDelta / deltaLength;
      deltaX *= scale;
      deltaZ *= scale;
    }
    const damping = Math.exp(-ICE_LINEAR_DAMPING * dt);
    motion.vx = (motion.vx + deltaX) * damping;
    motion.vz = (motion.vz + deltaZ) * damping;
    // An old normal-ground step or unusual clock jump cannot produce
    // unbounded glide; the target remains the much lower ice speed.
    const velocityLength = Math.hypot(motion.vx, motion.vz);
    if (velocityLength > maxSpeed) {
      const scale = maxSpeed / velocityLength;
      motion.vx *= scale;
      motion.vz *= scale;
    }
  }

  private moveHumans(dt: number): void {
    const now = this.currentTime();
    this.state.players.forEach((player: PlayerState): void => {
      if (player.isBot || !player.alive || !player.ready || player.spectator) {
        return;
      }
      const lastInput = this.inputs.get(player.sessionId);
      const input = now < player.frozenUntil ? undefined : lastInput;
      // R2: aiming/charging runs slower (CHARGE_MOVE_MULT mirror); reloading
      // runs at normal speed.
      const bonusMultiplier = now < player.speedUntil ? SPEED_MULTIPLIER : 1;
      const maxSpeed = PLAYER_SPEED * bonusMultiplier;
      const speed = input !== undefined && input.charging ? maxSpeed * CHARGE_MOVE_MULT : maxSpeed;
      const airStart = this.airSince.get(player.sessionId);
      const motion = this.motionFor(player);
      this.steerPlanarVelocity(
        motion,
        input !== undefined ? input.x * speed : 0,
        input !== undefined ? input.y * speed : 0,
        maxSpeed,
        input !== undefined && input.x * input.x + input.y * input.y >= ICE_INPUT_THRESHOLD * ICE_INPUT_THRESHOLD,
        airStart === undefined && player.y <= SURFACE_MAX_BODY_Y,
        player.x,
        player.z,
        dt,
        player.y,
      );
      if (this.stepBonusAir(player, input, motion, dt)) return;
      if (airStart !== undefined) {
        this.stepAirborneHuman(player, input, motion, dt, now, airStart);
        return;
      }
      // Grounded: wedge-side block + Y-gated XZ move (slide along faces)
      // BEFORE the arena clamp, so the authoritative position never enters
      // geometry. Then the grounded height follows the HYSTERETIC support
      // under the new XZ (ramps read smoothly via the slope band, tops stick
      // through the 0.5m ring, ground beside solids never snaps up).
      const feet = feetYOf(player.y);
      const fromX = player.x;
      const fromZ = player.z;
      const moved = resolveGroundMove(
        fromX,
        fromZ,
        fromX + motion.vx * dt,
        fromZ + motion.vz * dt,
        PLAYER_BODY_RADIUS,
        feet,
      );
      player.x = clampPosition(moved.x);
      player.z = clampPosition(moved.z);
      // Read back collision-resolved speed so a wall never stores a ghost
      // velocity that resumes after a later turn on ice.
      motion.vx = (player.x - fromX) / dt;
      motion.vz = (player.z - fromZ) / dt;
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
    motion: PlanarMotion,
    dt: number,
    now: number,
    airStart: number,
  ): void {
    const airTimeS = (now - airStart) / 1000;
    if (!(airTimeS >= 0) || airTimeS > TRAMPOLINE_MAX_AIR_S) {
      // Stuck arc (clock jump, NaN): force-land on the support below.
      this.airSince.delete(player.sessionId);
      motion.vx = 0;
      motion.vz = 0;
      player.y = bodyCenterYAt(player.x, player.z);
      return;
    }
    const arcY = trampolineArcY(airTimeS);
    const fromX = player.x;
    const fromZ = player.z;
    const moved = resolvePlayerMove(
      player.x,
      player.z,
      player.x + motion.vx * dt,
      player.z + motion.vz * dt,
      PLAYER_BODY_RADIUS,
      feetYOf(player.y),
    );
    player.x = clampPosition(moved.x);
    player.z = clampPosition(moved.z);
    motion.vx = (player.x - fromX) / dt;
    motion.vz = (player.z - fromZ) / dt;
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
      const motion = this.motionFor(player);
      const speed = BOT_SPEED * (now < player.speedUntil ? SPEED_MULTIPLIER : 1);
      this.steerPlanarVelocity(
        motion,
        now < player.frozenUntil ? 0 : step.moveX * speed,
        now < player.frozenUntil ? 0 : step.moveZ * speed,
        speed,
        now >= player.frozenUntil && step.moveX * step.moveX + step.moveZ * step.moveZ >= ICE_INPUT_THRESHOLD * ICE_INPUT_THRESHOLD,
        player.y <= SURFACE_MAX_BODY_Y,
        player.x,
        player.z,
        dt,
        player.y,
      );
      if (this.stepBonusAir(player, undefined, motion, dt)) return;
      // Same grounded path as humans (wedge block + gated collision +
      // hysteretic support): bots stop/slide at geometry instead of walking
      // through it. Bots stay grounded (no pad launches — weak ground game
      // by design) and derive y from XZ, so a bot wandering up a ramp reads
      // at slope height for remotes and balls.
      const feet = feetYOf(player.y);
      const fromX = player.x;
      const fromZ = player.z;
      const moved = resolveGroundMove(
        fromX,
        fromZ,
        fromX + motion.vx * dt,
        fromZ + motion.vz * dt,
        PLAYER_BODY_RADIUS,
        feet,
      );
      player.x = clampPosition(moved.x);
      player.z = clampPosition(moved.z);
      motion.vx = (player.x - fromX) / dt;
      motion.vz = (player.z - fromZ) / dt;
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
      if (now < bot.reloadUntil || now < bot.frozenUntil) {
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
      // getSpawnForIndex wraps by the editable spawn list length. Room
      // capacity is separate: a map may contain more than six spawn markers.
      respawnPlayer(player, this.spawnCursor, now);
      // Fresh life: no carried SUPER buff, no pending reload gate, grounded.
      player.superBuff = false;
      this.clearBonuses(player);
      player.reloadUntil = 0;
      this.airSince.delete(sessionId);
      this.planarMotion.delete(sessionId);
      this.spawnCursor += 1;
    }
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

  private removeBot(sessionId: string): void {
    for (const [id, ball] of this.state.balls) {
      if (ball.ownerId === sessionId) this.state.balls.delete(id);
    }
    // Releases owned effects, projectiles, their runtime/throw ledgers and
    // sheep reservations. Held sheep cease reserving a slot with the player.
    this.bonuses.removeOwner(sessionId);
    this.state.players.delete(sessionId);
    this.inputs.delete(sessionId);
    this.planarMotion.delete(sessionId);
    this.respawnAt.delete(sessionId);
    this.brains.delete(sessionId);
    this.airSince.delete(sessionId);
    this.bonusAir.delete(sessionId);
  }

  // Exactly one participating human gets the normal two weak opponents.
  // A dead human awaiting respawn still participates; spectators do not.
  // Lifecycle calls fill in any phase without restarting the round. Room
  // ticks also retire excess bots, keeping the entity cap with spectators.
  private ensureBots(allowFill = true): void {
    const humans = this.humanCount();
    const desired = humans === 1
      ? Math.max(0, Math.min(MAX_BOTS, MIN_TOTAL_PLAYERS - 1, MAX_PLAYERS - this.humanEntryCount()))
      : 0;
    let count = this.botCount();
    for (const [id, player] of this.state.players) {
      if (count <= desired) break;
      if (!player.isBot) continue;
      this.removeBot(id);
      count -= 1;
    }
    if (!allowFill || desired === 0) return;
    const now = this.currentTime();
    while (count < desired && this.state.players.size < MAX_PLAYERS) {
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
      bot.hp = MAX_HP;
      bot.score = 0;
      bot.alive = true;
      bot.isBot = true;
      bot.invulnUntil = this.state.phase === "playing" ? now + INVULN_MS : 0;
      bot.ready = true;
      bot.spectator = false;
      this.state.players.set(id, bot);
      this.brains.set(id, createBrain(now, this.botCounter * 131 + 7));
      count += 1;
    }
  }

  private nextBotName(): string {
    const taken = new Set<string>();
    this.state.players.forEach((player: PlayerState): void => {
      taken.add(player.nick);
    });
    const index = (this.botCounter - 1) % BOT_NAMES.length;
    const base = BOT_NAMES[index] ?? "Бот";
    if (!taken.has(base)) {
      return base;
    }
    return sanitizeNick(base, taken);
  }

  private pickSpawn(index: number): { x: number; z: number } {
    return getSpawnForIndex(index);
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
