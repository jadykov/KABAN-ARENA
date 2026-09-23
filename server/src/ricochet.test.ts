import { describe, expect, it } from "vitest";
import type { Client } from "colyseus";
import {
  ARENA_HALF_SIZE,
  BALL_GROUND_Y,
  BALL_HIT_PLAYER_MESSAGE,
  BALL_RADIUS,
  BALL_ROLL_MIN_SPEED,
  BALL_SETTLE_DAMP_RATE,
  BALL_SETTLE_TIME_MS,
  FULL_DAMAGE,
  LOBBY_COUNTDOWN_MS,
  MAX_LIVE_BALLS,
  PATCH_RATE_MS,
  REMATCH_DELAY_MS,
  ROUND_DURATION_MS,
  SERVER_PLATFORMS,
  WEAK_DAMAGE,
} from "./config.js";
import { ArenaRoom, SERVER_OBSTACLES } from "./rooms/ArenaRoom.js";
import { groundTopAt } from "./hits.js";
import { BallState, type PlayerState } from "./state.js";

function fakeClient(sessionId: string): Client {
  return {
    sessionId,
    send: (): void => {},
  } as unknown as Client;
}

async function joinRoom(room: ArenaRoom, sessionId: string, nick: string): Promise<void> {
  room.testNow = 0;
  const client = fakeClient(sessionId);
  await room.onJoin(client, { nick });
  (room as unknown as { handlePlay(client: Client, payload: unknown): void }).handlePlay(client, { nick });
}

function getPlayer(room: ArenaRoom, sessionId: string): PlayerState | undefined {
  return room.state.players.get(sessionId);
}

function advance(room: ArenaRoom, ms: number): void {
  room.testNow = (room.testNow ?? 0) + ms;
}

function removeBots(room: ArenaRoom): void {
  const ids: string[] = [];
  room.state.players.forEach((player: PlayerState, key: string): void => {
    if (player.isBot) {
      ids.push(key);
    }
  });
  for (const id of ids) {
    room.state.players.delete(id);
  }
}

function isolateDuel(room: ArenaRoom): { shooter: PlayerState; target: PlayerState } {
  removeBots(room);
  const shooter = getPlayer(room, "s1");
  const target = getPlayer(room, "s2");
  if (shooter === undefined || target === undefined) {
    throw new Error("duel room missing fighters");
  }
  shooter.x = 0;
  shooter.z = 0;
  shooter.invulnUntil = 0;
  shooter.reloadUntil = 0;
  shooter.superBuff = false;
  target.x = 0;
  target.z = -3;
  target.invulnUntil = 0;
  target.reloadUntil = 0;
  target.superBuff = false;
  return { shooter, target };
}

async function playingRoom(): Promise<ArenaRoom> {
  const room = new ArenaRoom();
  room.testNow = 0;
  await room.onCreate();
  await joinRoom(room, "s1", "Alpha");
  await joinRoom(room, "s2", "Beta");
  room.testNow = 1;
  room.tickRoom();
  room.testNow = 1 + LOBBY_COUNTDOWN_MS + 1;
  room.tickRoom();
  return room;
}

function fireAs(room: ArenaRoom, sessionId: string, payload: unknown): void {
  (room as unknown as { handleFire(shooterId: string, payload: unknown): void }).handleFire(sessionId, payload);
}

function godmode(room: ArenaRoom): void {
  room.state.players.forEach((player: PlayerState): void => {
    player.invulnUntil = 1e15;
  });
}

function captureBroadcasts(room: ArenaRoom): Array<{ type: string; message: unknown }> {
  const out: Array<{ type: string; message: unknown }> = [];
  const recorder = (type: string, message?: unknown): void => {
    out.push({ type, message });
  };
  (room as unknown as { broadcast: (type: string, message?: unknown) => void }).broadcast = recorder;
  return out;
}

function hitMessages(captured: Array<{ type: string; message: unknown }>): unknown[] {
  return captured
    .filter((entry) => entry.type === BALL_HIT_PLAYER_MESSAGE)
    .map((entry) => entry.message);
}

function getBall(room: ArenaRoom, ballId: string): BallState | undefined {
  return room.state.balls.get(ballId);
}

function singleBall(room: ArenaRoom): BallState {
  let found: BallState | undefined;
  room.state.balls.forEach((ball: BallState): void => {
    found = ball;
  });
  if (found === undefined) {
    throw new Error("expected exactly one ball");
  }
  return found;
}

// Direct-insert probe: bypasses the muzzle + first-tick hold (ageMs past
// PATCH_RATE_MS) so the next step integrates immediately. Zero horizontal
// ambiguity — the caller owns the full velocity vector.
function insertProbe(
  room: ArenaRoom,
  ballId: string,
  ownerId: string,
  x: number,
  y: number,
  z: number,
  vx: number,
  vy: number,
  vz: number,
  superShot = false,
): BallState {
  const ball = new BallState();
  ball.ballId = ballId;
  ball.ownerId = ownerId;
  ball.x = x;
  ball.y = y;
  ball.z = z;
  ball.vx = vx;
  ball.vy = vy;
  ball.vz = vz;
  ball.power01 = 1;
  ball.super = superShot;
  ball.ageMs = PATCH_RATE_MS;
  ball.distM = 5;
  ball.ricochet = false;
  ball.resting = false;
  ball.rolling = false;
  ball.settleMs = 0;
  ball.restY = 0;
  room.state.balls.set(ball.ballId, ball);
  return ball;
}

function tick50(room: ArenaRoom): void {
  advance(room, 50);
  room.tickRoom(50);
}

// Stage 4d.4 ricochet + rest: vertical surfaces reflect (ricochet=true, no
// damage after), floor/up-facing tops settle (~0.4s slide -> resting), SUPER
// despawns on first environmental contact exactly as before.
describe("4d.4 ricochet: flat shot into the boundary wall reflects", () => {
  it("axis flip, speed magnitude preserved, keeps flying, ricochet=true", async () => {
    const room = await playingRoom();
    removeBots(room);
    godmode(room);
    room.state.balls.clear();
    // One tick from the +z wall: crosses this step, must clamp + flip.
    insertProbe(room, "wall-probe", "s1", 0, 5, ARENA_HALF_SIZE - 0.3, 3, 0, 15);
    const before = singleBall(room);
    const horizontalBefore = Math.hypot(before.vx, before.vz);
    tick50(room);
    expect(room.state.balls.size).toBe(1);
    const after = singleBall(room);
    // Mid-tick reflection: the wall clamps the crossing substep, flips vz,
    // and the REMAINING substeps fly back into the room — the ball never
    // stops at the wall (ends ~= 16.55, one 0.25 substep back inside).
    expect(after.z).toBeLessThan(ARENA_HALF_SIZE);
    expect(after.z).toBeGreaterThan(ARENA_HALF_SIZE - 1.0);
    expect(after.vz).toBeCloseTo(-15, 9);
    expect(after.vx).toBeCloseTo(3, 9);
    expect(Math.hypot(after.vx, after.vz)).toBeCloseTo(horizontalBefore, 9);
    expect(after.ricochet).toBe(true);
    expect(after.resting).toBe(false);
  });

  it("a real fired shot bounces and continues flight (not despawned)", async () => {
    const room = await playingRoom();
    removeBots(room);
    godmode(room);
    const shooter = getPlayer(room, "s1");
    const target = getPlayer(room, "s2");
    if (shooter === undefined || target === undefined) {
      throw new Error("missing fighters");
    }
    shooter.x = 0;
    shooter.z = 0;
    shooter.reloadUntil = 0;
    target.x = -12;
    target.z = -12;
    // Open x=0 lane: clears the low outer cube, reaches the far boundary.
    fireAs(room, "s1", { power01: 1, yaw: Math.PI, pitch: 0.05, super: false });
    expect(room.state.balls.size).toBe(1);
    let bounced = false;
    for (let i = 0; i < 25; i += 1) {
      tick50(room);
      const ball = getBall(room, "b1");
      if (ball !== undefined && ball.ricochet) {
        bounced = true;
        break;
      }
    }
    expect(bounced).toBe(true);
    const ball = getBall(room, "b1");
    expect(ball).toBeDefined();
    expect(ball?.resting).toBe(false);
    expect(ball?.settleMs ?? 0).toBe(0);
    // Still flying after the bounce: position advances on later ticks.
    const zBefore = ball?.z ?? 0;
    tick50(room);
    tick50(room);
    expect(room.state.balls.size).toBe(1);
    expect((getBall(room, "b1")?.z ?? zBefore)).not.toBeCloseTo(zBefore, 6);
  });
});

describe("4d.4 ricochet: shot into the central tower side reflects", () => {
  it("face-hugging probe flips the approach axis and clamps to the face", async () => {
    const room = await playingRoom();
    removeBots(room);
    godmode(room);
    room.state.balls.clear();
    // Just outside the tower -z face (3.8) flying +Z low (y 1.0 < top 2.0):
    // side penetration is shallowest -> vertical reflect on z.
    insertProbe(room, "face-probe", "s1", 4.8, 1.0, 3.5, 0, 0, 10);
    tick50(room);
    expect(room.state.balls.size).toBe(1);
    const after = singleBall(room);
    expect(after.z).toBeCloseTo(3.8, 9);
    expect(after.vz).toBeCloseTo(-10, 9);
    expect(after.ricochet).toBe(true);
    expect(after.resting).toBe(false);
  });

  it("flat center-lane shot into the tower side reflects (no tunneling)", async () => {
    // Owner spec: "miss into wall/obstacle = ricochet". A flat full-power
    // shot down the x=4.8 lane (muzzle 1.4, pitch 0.05, arrival y ~= 1.5 at
    // the face) enters the (4.8, 4.8) tower through its -z SIDE face with a
    // mostly horizontal arrival, so it must REFLECT — never settle on the
    // top. The substepped flight (BALL_STEP_MAX_M) samples the thin
    // side-entry band before the deep-penetration sample that used to read
    // the top as shallowest. Godmode isolates the geometry (no victim
    // ping-pong on the return lane).
    const room = await playingRoom();
    removeBots(room);
    godmode(room);
    const shooter = getPlayer(room, "s1");
    const target = getPlayer(room, "s2");
    if (shooter === undefined || target === undefined) {
      throw new Error("missing fighters");
    }
    shooter.x = 4.8;
    shooter.z = 0;
    shooter.reloadUntil = 0;
    target.x = -12;
    target.z = -12;
    // yaw PI fires +Z down the x=4.8 lane, pitch 0.05 stays nearly level.
    fireAs(room, "s1", { power01: 1, yaw: Math.PI, pitch: 0.05, super: false });
    expect(room.state.balls.size).toBe(1);
    let bounced = false;
    for (let i = 0; i < 8; i += 1) {
      tick50(room);
      const ball = getBall(room, "b1");
      if (ball !== undefined && ball.ricochet) {
        bounced = true;
        break;
      }
    }
    // Pre-substep this settled on the tower top here; now it ricochets off
    // the tower face and stays live.
    expect(bounced).toBe(true);
    expect(room.state.balls.size).toBe(1);
    const ball = singleBall(room);
    expect(ball.ricochet).toBe(true);
    expect(ball.resting).toBe(false);
    expect(ball.settleMs).toBe(0);
    // Entered through the -z face, so the z axis flipped at full magnitude
    // (heads back -Z): vz = -cos(0.05) * 20, untouched by gravity or damp.
    expect(ball.vz).toBeCloseTo(-Math.cos(0.05) * 20, 6);
    expect(ball.vx).toBeCloseTo(0, 9);
    expect(ball.y).toBeLessThan(2.0);
    expect(target.hp).toBe(100);
    expect(shooter.hp).toBe(100);
    // Flight continues after the bounce: position advances on later ticks.
    const zBefore = ball.z;
    tick50(room);
    tick50(room);
    expect(room.state.balls.size).toBe(1);
    expect((getBall(room, "b1")?.z ?? zBefore)).not.toBeCloseTo(zBefore, 6);
    expect(getBall(room, "b1")?.ricochet).toBe(true);
  });
});

describe("4d.4 settle: shots onto obstacle/platform tops come to rest", () => {
  it("platform top probe settles: resting, velocity 0, y = top + BALL_RADIUS", async () => {
    expect(BALL_RADIUS).toBe(0.38);
    const room = await playingRoom();
    isolateDuel(room);
    room.state.balls.clear();
    const platform = SERVER_PLATFORMS[0];
    if (platform === undefined) {
      throw new Error("no server platform defined");
    }
    // Inside the footprint below the top with zero velocity: up-facing hit.
    insertProbe(room, "top-probe", "s1", platform.x, platform.topY - 0.5, platform.z, 0, 0, 0);
    tick50(room);
    const settling = getBall(room, "top-probe");
    expect(settling).toBeDefined();
    expect(settling?.resting).toBe(false);
    expect(settling?.settleMs ?? 0).toBeGreaterThan(0);
    for (let i = 0; i < 11; i += 1) {
      tick50(room);
    }
    const rested = getBall(room, "top-probe");
    expect(rested?.resting).toBe(true);
    expect(rested?.vx).toBe(0);
    expect(rested?.vy).toBe(0);
    expect(rested?.vz).toBe(0);
    expect(rested?.y).toBeCloseTo(platform.topY + BALL_RADIUS, 9);
  });

  it("obstacle top probe dropped from above rests at top + BALL_RADIUS", async () => {
    const room = await playingRoom();
    isolateDuel(room);
    room.state.balls.clear();
    const tower = SERVER_OBSTACLES.find((block) => block.x === 4.8 && block.z === 4.8);
    if (tower === undefined) {
      throw new Error("no central tower defined");
    }
    // Falls from above the tower top, then settles on it.
    insertProbe(room, "drop-probe", "s1", tower.x, tower.topY + 0.5, tower.z, 0, 0, 0);
    let settled = false;
    for (let i = 0; i < 30; i += 1) {
      tick50(room);
      if ((getBall(room, "drop-probe")?.settleMs ?? 0) > 0) {
        settled = true;
        break;
      }
    }
    expect(settled).toBe(true);
    for (let i = 0; i < 11; i += 1) {
      tick50(room);
    }
    const rested = getBall(room, "drop-probe");
    expect(rested?.resting).toBe(true);
    expect(rested?.y).toBeCloseTo(tower.topY + BALL_RADIUS, 9);
  });
});

describe("4d.4 smooth rest: exponential slide, resting within 0.5s, stays put", () => {
  it("slow floor contact (below roll speed) damps exponentially then pins the ball", async () => {
    expect(BALL_SETTLE_TIME_MS).toBe(400);
    expect(BALL_SETTLE_DAMP_RATE).toBe(8);
    // Rolling takes over at BALL_ROLL_MIN_SPEED: only a slow arrival settles.
    expect(BALL_ROLL_MIN_SPEED).toBe(1.5);
    const room = await playingRoom();
    isolateDuel(room);
    room.state.balls.clear();
    // Open ground at (-2, -2): falls onto the floor with horizontal speed 1
    // (below the 1.5 roll threshold, so this takes the settle path).
    insertProbe(room, "slow-settle", "s1", -2, 0.5, -2, 1, -1, 0);
    let settleTicks = -1;
    for (let i = 0; i < 10; i += 1) {
      tick50(room);
      if ((getBall(room, "slow-settle")?.settleMs ?? 0) > 0) {
        settleTicks = i;
        break;
      }
    }
    expect(settleTicks).toBeGreaterThanOrEqual(0);
    const entered = getBall(room, "slow-settle");
    expect(entered?.rolling).toBe(false);
    // Exponential damp per 50ms tick: vx *= exp(-8 * 0.05).
    const dampStep = Math.exp(-BALL_SETTLE_DAMP_RATE * 0.05);
    const first = getBall(room, "slow-settle")?.vx ?? 0;
    expect(first).toBeGreaterThan(0);
    tick50(room);
    const second = getBall(room, "slow-settle")?.vx ?? 0;
    expect(second).toBeGreaterThan(0);
    expect(second).toBeLessThan(first);
    expect(second / first).toBeCloseTo(dampStep, 6);
    // Resting within the 0.5s window (10 ticks) after settle entry...
    let restedAt = -1;
    for (let i = 0; i < 10; i += 1) {
      tick50(room);
      if (getBall(room, "slow-settle")?.resting === true) {
        restedAt = i;
        break;
      }
    }
    expect(restedAt).toBeGreaterThanOrEqual(0);
    const rested = getBall(room, "slow-settle");
    expect(rested?.y).toBeCloseTo(BALL_GROUND_Y + BALL_RADIUS, 9);
    // ...and stays put on later ticks (pinned, zero velocity).
    const px = rested?.x ?? 0;
    const py = rested?.y ?? 0;
    const pz = rested?.z ?? 0;
    for (let i = 0; i < 5; i += 1) {
      tick50(room);
    }
    const held = getBall(room, "slow-settle");
    expect(held?.resting).toBe(true);
    expect(held?.x).toBe(px);
    expect(held?.y).toBe(py);
    expect(held?.z).toBe(pz);
  });
});

describe("rolling slide re-snaps support: tower-top fast arrival never hovers", () => {
  it("tower-top probe with vx=10 rolls off and rests at the true support under its final xz", async () => {
    // Fast arrivals (>= BALL_ROLL_MIN_SPEED) take the rolling path, not the
    // settle path: the ball rolls on the tower top, slides off the edge, drops
    // to the ground under per-tick support glue, and rests there — never
    // hovering at tower height.
    expect(BALL_ROLL_MIN_SPEED).toBe(1.5);
    const room = await playingRoom();
    isolateDuel(room);
    room.state.balls.clear();
    const tower = SERVER_OBSTACLES.find((block) => block.x === 4.8 && block.z === 4.8);
    if (tower === undefined) {
      throw new Error("no central tower defined");
    }
    // Inside the footprint below the top with fast horizontal speed: the
    // first tick enters ROLL on the tower top (no settleMs, rolling=true).
    insertProbe(room, "tower-slide", "s1", 4.9, tower.topY - 0.5, tower.z, 10, 0, 0);
    tick50(room);
    const entered = getBall(room, "tower-slide");
    expect(entered).toBeDefined();
    expect(entered?.rolling).toBe(true);
    expect(entered?.ricochet).toBe(true);
    expect(entered?.resting).toBe(false);
    expect(entered?.settleMs ?? 0).toBe(0);
    // Roll until rest (friction window: ~1.5s from the scrubbed entry speed).
    let rested = false;
    let droppedBelowTop = false;
    for (let i = 0; i < 120; i += 1) {
      tick50(room);
      const ball = getBall(room, "tower-slide");
      if (ball === undefined) {
        throw new Error("rolling ball vanished mid-roll");
      }
      // Per-tick support glue: once past the footprint edge the ball must
      // already read ground height — no hover frames at tower height.
      if (ball.x > tower.x + tower.hx && ball.y < tower.topY) {
        droppedBelowTop = true;
      }
      if (ball.resting === true) {
        rested = true;
        break;
      }
    }
    expect(droppedBelowTop).toBe(true);
    expect(rested).toBe(true);
    const final = getBall(room, "tower-slide");
    expect(final?.rolling).toBe(false);
    expect(final?.vx).toBe(0);
    expect(final?.vy).toBe(0);
    expect(final?.vz).toBe(0);
    // The roll must have carried the ball off the tower footprint — otherwise
    // this test cannot discriminate the hover bug.
    expect((final?.x ?? 0)).toBeGreaterThan(tower.x + tower.hx);
    // True support at the final xz is open ground beside the tower.
    const expected = Math.max(BALL_GROUND_Y, groundTopAt(final?.x ?? 0, final?.z ?? 0)) + BALL_RADIUS;
    expect(expected).toBeCloseTo(BALL_GROUND_Y + BALL_RADIUS, 9);
    expect(final?.restY).toBeCloseTo(expected, 9);
    expect(final?.y).toBeCloseTo(expected, 9);
    // Discriminating: a stale-entry pin would hover at tower-top height.
    expect(final?.y ?? 0).toBeLessThan(tower.topY);
  });

  it("floor-settling ball sliding into an outer block rests on the block top", async () => {
    const room = await playingRoom();
    isolateDuel(room);
    room.state.balls.clear();
    const block = SERVER_OBSTACLES.find((entry) => entry.x === 10.8 && entry.z === 0);
    if (block === undefined) {
      throw new Error("no outer block defined");
    }
    // Mid-settle state on open floor just outside the -x face, sliding +X
    // into the footprint (slide distance ~1m > 0.5m to the face).
    const startX = block.x - block.hx - 0.5;
    const ball = insertProbe(room, "floor-slide", "s1", startX, BALL_GROUND_Y + BALL_RADIUS, 0, 10, 0, 0);
    ball.restY = BALL_GROUND_Y + BALL_RADIUS;
    ball.settleMs = PATCH_RATE_MS;
    expect(Math.abs(startX - block.x)).toBeGreaterThan(block.hx);
    let rested = false;
    for (let i = 0; i < 20; i += 1) {
      tick50(room);
      if (getBall(room, "floor-slide")?.resting === true) {
        rested = true;
        break;
      }
    }
    expect(rested).toBe(true);
    const final = getBall(room, "floor-slide");
    expect(final?.vx).toBe(0);
    expect(final?.vy).toBe(0);
    expect(final?.vz).toBe(0);
    // The slide must have carried the ball into the block footprint.
    expect(Math.abs((final?.x ?? 0) - block.x)).toBeLessThanOrEqual(block.hx);
    expect(Math.abs((final?.z ?? 0) - block.z)).toBeLessThanOrEqual(block.hz);
    // True support at the final xz is the block top, not the entry floor.
    const expected = Math.max(BALL_GROUND_Y, groundTopAt(final?.x ?? 0, final?.z ?? 0)) + BALL_RADIUS;
    expect(expected).toBeCloseTo(block.topY + BALL_RADIUS, 9);
    expect(final?.restY).toBeCloseTo(expected, 9);
    expect(final?.y).toBeCloseTo(block.topY + BALL_RADIUS, 9);
    // Discriminating: the stale floor pin would rest embedded (center below
    // the solid top, i.e. inside the block).
    expect(final?.y ?? 0).toBeGreaterThan(block.topY);
  });
});

describe("4d.4 victim bounce: ricochet balls deal no damage", () => {
  it("0 damage, no knockback, no broadcast, velocity reflected away", async () => {
    const room = await playingRoom();
    const { shooter, target } = isolateDuel(room);
    shooter.x = 10;
    shooter.z = 10;
    room.state.balls.clear();
    const captured = captureBroadcasts(room);
    // Armed ricochet ball flying +Z straight at the victim at (0, -3).
    insertProbe(room, "bounce-probe", "s1", 0, 1.1, -4.5, 0, 0, 10);
    const probe = getBall(room, "bounce-probe");
    if (probe === undefined) {
      throw new Error("probe missing");
    }
    probe.ricochet = true;
    const victimX = target.x;
    const victimZ = target.z;
    let bounced = false;
    for (let i = 0; i < 10; i += 1) {
      tick50(room);
      if ((getBall(room, "bounce-probe")?.vz ?? 1) < 0) {
        bounced = true;
        break;
      }
    }
    expect(bounced).toBe(true);
    expect(target.hp).toBe(100);
    expect(target.x).toBeCloseTo(victimX, 9);
    expect(target.z).toBeCloseTo(victimZ, 9);
    expect(hitMessages(captured)).toHaveLength(0);
    // Ball survives the bounce, heading radially away from the victim.
    const ball = getBall(room, "bounce-probe");
    expect(ball).toBeDefined();
    expect(ball?.ricochet).toBe(true);
    expect(ball?.vz).toBeLessThan(0);
    expect(ball?.vx).toBeCloseTo(0, 9);
    // Later ticks never convert the bounce into damage.
    for (let i = 0; i < 10; i += 1) {
      tick50(room);
    }
    expect(target.hp).toBe(100);
    expect(hitMessages(captured)).toHaveLength(0);
  });
});

describe("4d.4 direct hits unchanged: full 25 / weak 12.5 + despawn + broadcast", () => {
  it("full-power pre-ricochet hit deals 25, despawns, broadcasts once", async () => {
    const room = await playingRoom();
    const { target } = isolateDuel(room);
    const captured = captureBroadcasts(room);
    fireAs(room, "s1", { power01: 1, yaw: 0, pitch: 0.1, super: false });
    expect(room.state.balls.size).toBe(1);
    for (let i = 0; i < 60 && target.hp === 100; i += 1) {
      tick50(room);
    }
    expect(target.hp).toBe(100 - FULL_DAMAGE);
    expect(room.state.balls.size).toBe(0);
    const hits = hitMessages(captured);
    expect(hits).toHaveLength(1);
    const body = (typeof hits[0] === "object" && hits[0] !== null ? hits[0] : {}) as Record<string, unknown>;
    expect(body["victimId"]).toBe("s2");
  });

  it("weak pre-ricochet hit deals 12.5, despawns, broadcasts once", async () => {
    const room = await playingRoom();
    const { target } = isolateDuel(room);
    const captured = captureBroadcasts(room);
    fireAs(room, "s1", { power01: 0.5, yaw: 0, pitch: 0.1, super: false });
    expect(room.state.balls.size).toBe(1);
    for (let i = 0; i < 60 && target.hp === 100; i += 1) {
      tick50(room);
    }
    expect(target.hp).toBeCloseTo(100 - WEAK_DAMAGE, 5);
    expect(room.state.balls.size).toBe(0);
    expect(hitMessages(captured)).toHaveLength(1);
  });
});

describe("4d.4 resting cap: one rest per owner, resting is harmless, fire clears", () => {
  it("second rest of the same owner despawns the older resting ball", async () => {
    const room = await playingRoom();
    isolateDuel(room);
    room.state.balls.clear();
    // Older resting ball placed directly (provenance is irrelevant to the
    // cap: enforceRestingCap evicts any older resting ball of the owner).
    const older = new BallState();
    older.ballId = "rest-old";
    older.ownerId = "s1";
    older.x = -2;
    older.y = BALL_GROUND_Y + BALL_RADIUS;
    older.z = -2;
    older.vx = 0;
    older.vy = 0;
    older.vz = 0;
    older.power01 = 1;
    older.super = false;
    older.ageMs = 9000;
    older.distM = 5;
    older.ricochet = false;
    older.resting = true;
    older.settleMs = 0;
    older.restY = BALL_GROUND_Y + BALL_RADIUS;
    room.state.balls.set(older.ballId, older);
    // A second fast ball rolls out through the roll path (planar 2 m/s entry
    // is above the settle gate, so it never takes the slow slide) then rests.
    insertProbe(room, "rest-new", "s1", -3, 0.5, -3, 2, -1, 0);
    let rested = false;
    for (let i = 0; i < 30; i += 1) {
      tick50(room);
      if (getBall(room, "rest-new")?.resting === true) {
        rested = true;
        break;
      }
    }
    expect(rested).toBe(true);
    expect(getBall(room, "rest-old")).toBeUndefined();
    expect(getBall(room, "rest-new")?.resting).toBe(true);
  });

  it("a resting ball overlapping a victim never damages", async () => {
    const room = await playingRoom();
    const { target } = isolateDuel(room);
    room.state.balls.clear();
    const captured = captureBroadcasts(room);
    // Resting core inside the 0.9m hit radius (dy = 0.52) of the victim.
    const core = new BallState();
    core.ballId = "rest-harmless";
    core.ownerId = "s1";
    core.x = target.x;
    core.y = BALL_GROUND_Y + BALL_RADIUS;
    core.z = target.z;
    core.vx = 0;
    core.vy = 0;
    core.vz = 0;
    core.power01 = 1;
    core.super = false;
    core.ageMs = 9000;
    core.distM = 5;
    core.ricochet = false;
    core.resting = true;
    core.settleMs = 0;
    core.restY = BALL_GROUND_Y + BALL_RADIUS;
    room.state.balls.set(core.ballId, core);
    for (let i = 0; i < 10; i += 1) {
      tick50(room);
    }
    expect(target.hp).toBe(100);
    expect(hitMessages(captured)).toHaveLength(0);
    expect(getBall(room, "rest-harmless")?.resting).toBe(true);
  });

  it("thrower's next fire despawns his resting ball", async () => {
    const room = await playingRoom();
    const { shooter } = isolateDuel(room);
    room.state.balls.clear();
    const core = new BallState();
    core.ballId = "rest-clear";
    core.ownerId = "s1";
    core.x = -2;
    core.y = BALL_GROUND_Y + BALL_RADIUS;
    core.z = -2;
    core.vx = 0;
    core.vy = 0;
    core.vz = 0;
    core.power01 = 1;
    core.super = false;
    core.ageMs = 9000;
    core.distM = 5;
    core.ricochet = false;
    core.resting = true;
    core.settleMs = 0;
    core.restY = BALL_GROUND_Y + BALL_RADIUS;
    room.state.balls.set(core.ballId, core);
    shooter.reloadUntil = 0;
    fireAs(room, "s1", { power01: 1, yaw: 0, pitch: 0.5, super: false });
    expect(getBall(room, "rest-clear")).toBeUndefined();
    expect(room.state.balls.size).toBe(1);
    expect(singleBall(room).resting).toBe(false);
  });
});

describe("4d.4 super balls: first contact despawns, direct hit x2 unchanged", () => {
  it("super wall contact despawns with no ricochet and no resting", async () => {
    const room = await playingRoom();
    removeBots(room);
    godmode(room);
    room.state.balls.clear();
    const captured = captureBroadcasts(room);
    insertProbe(room, "super-wall", "s1", ARENA_HALF_SIZE - 0.3, 5, 0, 15, 0, 0, true);
    tick50(room);
    expect(room.state.balls.size).toBe(0);
    expect(hitMessages(captured)).toHaveLength(0);
  });

  it("super direct hit still deals x2 (full 50)", async () => {
    const room = await playingRoom();
    const { shooter, target } = isolateDuel(room);
    const captured = captureBroadcasts(room);
    shooter.superBuff = true;
    fireAs(room, "s1", { power01: 1, yaw: 0, pitch: 0.1, super: true });
    expect(room.state.balls.size).toBe(1);
    for (let i = 0; i < 60 && target.hp === 100; i += 1) {
      tick50(room);
    }
    expect(target.hp).toBe(100 - FULL_DAMAGE * 2);
    expect(room.state.balls.size).toBe(0);
    expect(hitMessages(captured)).toHaveLength(1);
  });

  it("super direct hit still deals x2 (weak 25)", async () => {
    const room = await playingRoom();
    const { shooter, target } = isolateDuel(room);
    shooter.superBuff = true;
    fireAs(room, "s1", { power01: 0.5, yaw: 0, pitch: 0.1, super: true });
    expect(room.state.balls.size).toBe(1);
    for (let i = 0; i < 60 && target.hp === 100; i += 1) {
      tick50(room);
    }
    expect(target.hp).toBeCloseTo(100 - WEAK_DAMAGE * 2, 5);
    expect(room.state.balls.size).toBe(0);
  });
});

describe("4d.4 pool overflow + round reset clear resting balls", () => {
  function insertResting(room: ArenaRoom, ballId: string, ownerId: string, ageMs: number): void {
    const core = new BallState();
    core.ballId = ballId;
    core.ownerId = ownerId;
    core.x = -2;
    core.y = BALL_GROUND_Y + BALL_RADIUS;
    core.z = -2;
    core.vx = 0;
    core.vy = 0;
    core.vz = 0;
    core.power01 = 1;
    core.super = false;
    core.ageMs = ageMs;
    core.distM = 5;
    core.ricochet = false;
    core.resting = true;
    core.settleMs = 0;
    core.restY = BALL_GROUND_Y + BALL_RADIUS;
    room.state.balls.set(core.ballId, core);
  }

  it("MAX_LIVE_BALLS overflow evicts the oldest first, resting included", async () => {
    const room = await playingRoom();
    isolateDuel(room);
    room.state.balls.clear();
    // Three old resting balls (owner s2) + nine fresh live balls (owner s1).
    insertResting(room, "rest-a", "s2", 9000);
    insertResting(room, "rest-b", "s2", 8000);
    insertResting(room, "rest-c", "s2", 7000);
    const shooter = getPlayer(room, "s1");
    if (shooter === undefined) {
      throw new Error("missing shooter");
    }
    const now = room.testNow ?? 0;
    for (let i = 0; i < 9; i += 1) {
      shooter.reloadUntil = 0;
      room.spawnBall(shooter, 0.5, 0.3 * i, 0.5, false, now);
    }
    expect(room.state.balls.size).toBe(MAX_LIVE_BALLS);
    // One more over the cap: the oldest entry (rest-a, ageMs 9000) goes —
    // resting cores are evictable, not pinned.
    shooter.reloadUntil = 0;
    room.spawnBall(shooter, 0.5, 0.1, 0.5, false, now);
    expect(room.state.balls.size).toBe(MAX_LIVE_BALLS);
    expect(getBall(room, "rest-a")).toBeUndefined();
    expect(getBall(room, "rest-b")).toBeDefined();
    expect(getBall(room, "rest-c")).toBeDefined();
  });

  it("round start clears resting balls (nothing leaks into the round)", async () => {
    const room = new ArenaRoom();
    room.testNow = 0;
    await room.onCreate();
    await joinRoom(room, "s1", "Alpha");
    await joinRoom(room, "s2", "Beta");
    insertResting(room, "lobby-rest", "s1", 9000);
    expect(room.state.balls.size).toBe(1);
    room.testNow = 1;
    room.tickRoom();
    expect(room.state.phase).toBe("countdown");
    room.testNow = 1 + LOBBY_COUNTDOWN_MS + 1;
    room.tickRoom();
    expect(room.state.phase).toBe("playing");
    expect(room.state.balls.size).toBe(0);
  });

  it("rematch reset clears resting balls (nothing leaks across rounds)", async () => {
    const room = await playingRoom();
    expect(room.state.phase).toBe("playing");
    insertResting(room, "round-rest", "s1", 9000);
    expect(room.state.balls.size).toBe(1);
    advance(room, ROUND_DURATION_MS + 10);
    room.tickRoom();
    expect(room.state.phase).toBe("ended");
    advance(room, REMATCH_DELAY_MS + 10);
    room.tickRoom();
    expect(room.state.phase).toBe("lobby");
    expect(room.state.balls.size).toBe(0);
  });
});
