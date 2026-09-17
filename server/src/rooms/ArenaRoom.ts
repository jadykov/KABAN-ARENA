import { Room, type Client } from "colyseus";
import {
  ARENA_HALF_SIZE,
  BALL_GRAVITY,
  BALL_GROUND_Y,
  BALL_HIT_RADIUS,
  BOT_NAMES,
  BOT_SPEED,
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
  RELOAD_MS,
  REMATCH_DELAY_MS,
  RESPAWN_DELAY_MS,
  ROUND_DURATION_MS,
  ROUND_HARD_CAP_MS,
  SELF_ARMING_DIST_M,
  SELF_ARMING_TIME_S,
  SERVER_PLATFORMS,
  SIM_TICK_MS,
  SPAWN_INSET,
  SUPER_LIFE_S,
  SUPER_PICKUP_RADIUS,
  SUPER_SPAWN_S,
  WIN_SCORE,
} from "../config.js";
import { createBrain, planBotFire, stepBot, type BotBrain } from "../bots.js";
import {
  applyHit,
  canDamage,
  damageForPower,
  muzzleForShot,
  powerToSpeed,
  recoilDistanceForPower,
  resolveThrowerY,
  respawnPlayer,
  sanitizeNick,
  sanitizeThrowerY,
} from "../hits.js";
import { ArenaState, BallState, PlayerState, type RoundPhase } from "../state.js";

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

// Server obstacle mirrors (client Arena.getObstacleLayout): AABB check for
// cannonball impacts AND authoritative movement collision (see
// resolvePlayerMove). Heights ignored — balls fly over low blocks only when
// above hy*2, otherwise they impact. Positions scaled x1.2 with the map
// (4 -> 4.8, 9 -> 10.8); block half extents unchanged.
export const SERVER_OBSTACLES: Array<{ x: number; z: number; hx: number; hz: number; topY: number }> = [
  { x: 4.8, z: 4.8, hx: 1, hz: 1, topY: 1.0 },
  { x: -4.8, z: 4.8, hx: 1, hz: 1, topY: 1.0 },
  { x: 4.8, z: -4.8, hx: 1, hz: 1, topY: 1.0 },
  { x: -4.8, z: -4.8, hx: 1, hz: 1, topY: 1.0 },
  { x: 10.8, z: 0, hx: 1.5, hz: 0.75, topY: 0.8 },
  { x: -10.8, z: 0, hx: 1.5, hz: 0.75, topY: 0.8 },
  { x: 0, z: 10.8, hx: 0.75, hz: 1.5, topY: 0.8 },
  { x: 0, z: -10.8, hx: 0.75, hz: 1.5, topY: 0.8 },
];

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

// Server-side movement solid: XZ AABB with per-face openness. Obstacles are
// closed on all four faces; platforms leave their ramp-side face OPEN so
// fighters can walk up onto the top (the server never tracks body height,
// so a blanket platform block would trap climbers at the footprint edge).
interface MoveSolid {
  x: number;
  z: number;
  hx: number;
  hz: number;
  openMinX: boolean;
  openMaxX: boolean;
  openMinZ: boolean;
  openMaxZ: boolean;
}

const MOVE_SOLIDS: readonly MoveSolid[] = [
  ...SERVER_OBSTACLES.map((block) => ({
    x: block.x,
    z: block.z,
    hx: block.hx,
    hz: block.hz,
    openMinX: false,
    openMaxX: false,
    openMinZ: false,
    openMaxZ: false,
  })),
  ...SERVER_PLATFORMS.map((platform) => ({
    x: platform.x,
    z: platform.z,
    hx: platform.hx,
    hz: platform.hz,
    openMinX: platform.rampSide === "-x",
    openMaxX: platform.rampSide === "+x",
    openMinZ: platform.rampSide === "-z",
    openMaxZ: platform.rampSide === "+z",
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

// Authoritative XZ collision resolution (humans AND bots): per-axis swept
// clamp against every solid face (X first, then Z), so diagonal input slides
// along faces instead of sticking. A step can never tunnel (max ~0.23m per
// 50ms tick vs 1.25m+ expanded half extents). If the start point is already
// inside a footprint (fighter standing on a platform top, or embedded by a
// knockback shove), that solid is skipped for this step so the fighter can
// always walk back out — nobody gets permanently trapped.
export function resolvePlayerMove(
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number,
  radius: number = PLAYER_BODY_RADIUS,
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
  let x = toX;
  for (const solid of MOVE_SOLIDS) {
    if (insideSolidFootprint(solid, fromX, fromZ, radius)) {
      continue;
    }
    if (fromZ >= solid.z - solid.hz - radius && fromZ <= solid.z + solid.hz + radius) {
      const minFace = solid.x - solid.hx - radius;
      const maxFace = solid.x + solid.hx + radius;
      if (!solid.openMinX && fromX <= minFace && x > minFace) {
        x = minFace;
      }
      if (!solid.openMaxX && fromX >= maxFace && x < maxFace) {
        x = maxFace;
      }
    }
  }
  let z = toZ;
  for (const solid of MOVE_SOLIDS) {
    if (insideSolidFootprint(solid, fromX, fromZ, radius)) {
      continue;
    }
    if (x >= solid.x - solid.hx - radius && x <= solid.x + solid.hx + radius) {
      const minFace = solid.z - solid.hz - radius;
      const maxFace = solid.z + solid.hz + radius;
      if (!solid.openMinZ && fromZ <= minFace && z > minFace) {
        z = minFace;
      }
      if (!solid.openMaxZ && fromZ >= maxFace && z < maxFace) {
        z = maxFace;
      }
    }
  }
  return { x, z };
}

// Authoritative FFA room (Stage 4): guest-nick join, inputs-only 20/s,
// server hitscan (100HP/25dmg), C2 short-round loop 3/3/2, weak bots.
export class ArenaRoom extends Room<ArenaState> {
  // Overridable clock for deterministic unit tests (null = wall clock).
  public testNow: number | null = null;

  private readonly inputs = new Map<string, MoveInput>();
  private readonly respawnAt = new Map<string, number>();
  private readonly brains = new Map<string, BotBrain>();
  private botCounter = 0;
  private ballCounter = 0;
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
    this.ensureBots();
    client.send("welcome", { sessionId: client.sessionId, nick, x: player.x, z: player.z });
  }

  public async onLeave(client: Client): Promise<void> {
    if (this.state.players.has(client.sessionId)) {
      this.state.players.delete(client.sessionId);
    }
    this.inputs.delete(client.sessionId);
    this.respawnAt.delete(client.sessionId);
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
    const pitch = Math.max(-0.15, Math.min(0.9, pitchRaw));
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
      const kicked = resolvePlayerMove(shooter.x, shooter.z, shooter.x - kickX, shooter.z - kickZ);
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

  // Authoritative ball step: gravity arc, ground/wall/block impact despawn,
  // player hits (radius ~0.9, self-damage armed after 1m / 0.3s), damage to
  // ALL incl. self + knockback impulse. Kill/respawn/killfeed reuse existing.
  // First-tick hold: a newborn ball (prevAge < PATCH_RATE_MS) is aged but NOT
  // integrated until the next tick, so the first patched frame still sits at
  // the muzzle instead of 0.7-1m downrange (pre-patch teleport fix).
  private stepBalls(now: number, dt: number): void {
    const dead: string[] = [];
    this.state.balls.forEach((ball: BallState, ballId: string): void => {
      const prevAge = ball.ageMs;
      ball.ageMs += dt * 1000;
      if (prevAge < PATCH_RATE_MS) {
        return;
      }
      ball.vy -= BALL_GRAVITY * dt;
      const stepX = ball.vx * dt;
      const stepY = ball.vy * dt;
      const stepZ = ball.vz * dt;
      ball.x += stepX;
      ball.y += stepY;
      ball.z += stepZ;
      ball.distM += Math.hypot(stepX, stepY, stepZ);
      if (ball.y <= BALL_GROUND_Y || Math.abs(ball.x) > ARENA_HALF_SIZE || Math.abs(ball.z) > ARENA_HALF_SIZE) {
        dead.push(ballId);
        return;
      }
      if (this.hitsBlock(ball.x, ball.y, ball.z)) {
        dead.push(ballId);
        return;
      }
      const victim = this.findBallVictim(ball);
      if (victim !== null) {
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
        dead.push(ballId);
      }
    });
    for (const ballId of dead) {
      this.state.balls.delete(ballId);
    }
  }

  private hitsBlock(x: number, y: number, z: number): boolean {
    for (const block of SERVER_OBSTACLES) {
      if (Math.abs(x - block.x) <= block.hx && Math.abs(z - block.z) <= block.hz && y <= block.topY) {
        return true;
      }
    }
    // Two-level platform tops (server SERVER_PLATFORMS mirror of client
    // Arena PLATFORM_FIGURES, 4 asymmetric figures): cannonballs impact
    // the solid tops.
    for (const platform of SERVER_PLATFORMS) {
      if (Math.abs(x - platform.x) <= platform.hx && Math.abs(z - platform.z) <= platform.hz && y <= platform.topY) {
        return true;
      }
    }
    return false;
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
      const dy = 1.1 - ball.y;
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
    const moved = resolvePlayerMove(
      victim.x,
      victim.z,
      victim.x + (dx / length) * HIT_KNOCKBACK_M,
      victim.z + (dz / length) * HIT_KNOCKBACK_M,
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
  private moveHumans(dt: number): void {
    this.state.players.forEach((player: PlayerState): void => {
      if (player.isBot || !player.alive || !player.ready || player.spectator) {
        return;
      }
      const input = this.inputs.get(player.sessionId);
      if (input === undefined) {
        return;
      }
      // R2: aiming/charging runs 50% slower; reloading runs at normal speed.
      // Collision resolved per axis (slide along faces) BEFORE the arena
      // clamp, so the authoritative position never enters geometry — this is
      // what stopped the client reconcile pass-through loop (server targets
      // are always legal now).
      const speed = input.charging ? PLAYER_SPEED * 0.5 : PLAYER_SPEED;
      const moved = resolvePlayerMove(
        player.x,
        player.z,
        player.x + input.x * speed * dt,
        player.z + input.y * speed * dt,
      );
      player.x = clampPosition(moved.x);
      player.z = clampPosition(moved.z);
      player.rotY = input.rotY;
    });
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
      // Same collision resolution as humans: bots stop/slide at geometry
      // instead of walking through it.
      const moved = resolvePlayerMove(
        player.x,
        player.z,
        player.x + step.moveX * BOT_SPEED * dt,
        player.z + step.moveZ * BOT_SPEED * dt,
      );
      player.x = clampPosition(moved.x);
      player.z = clampPosition(moved.z);
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
      // Fresh life: no carried SUPER buff, no pending reload gate.
      player.superBuff = false;
      player.reloadUntil = 0;
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
