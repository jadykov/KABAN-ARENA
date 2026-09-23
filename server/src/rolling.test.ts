import { describe, expect, it } from "vitest";
import type { Client } from "colyseus";
import {
  ARENA_HALF_SIZE,
  BALL_GROUND_Y,
  BALL_HIT_PLAYER_MESSAGE,
  BALL_RADIUS,
  BALL_ROLL_CLIMB_MAX,
  BALL_ROLL_FRICTION,
  BALL_ROLL_MIN_SPEED,
  BALL_ROLL_STOP_SPEED,
  BALL_ROLL_WALL_KEEP,
  CENTER_ITEM_NAMES,
  LOBBY_COUNTDOWN_MS,
  PATCH_RATE_MS,
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

function getBall(room: ArenaRoom, ballId: string): BallState | undefined {
  return room.state.balls.get(ballId);
}

function captureBroadcasts(room: ArenaRoom): Array<{ type: string; message: unknown }> {
  const out: Array<{ type: string; message: unknown }> = [];
  const recorder = (type: string, message?: unknown): void => {
    out.push({ type, message });
  };
  (room as unknown as { broadcast: (type: string, message?: unknown) => void }).broadcast = recorder;
  return out;
}

function killfeedMessages(captured: Array<{ type: string; message: unknown }>): string[] {
  return captured
    .filter((entry) => entry.type === "killfeed")
    .map((entry) => {
      const body = (typeof entry.message === "object" && entry.message !== null ? entry.message : {}) as Record<
        string,
        unknown
      >;
      return typeof body["message"] === "string" ? (body["message"] as string) : "";
    });
}

function hitMessages(captured: Array<{ type: string; message: unknown }>): unknown[] {
  return captured
    .filter((entry) => entry.type === BALL_HIT_PLAYER_MESSAGE)
    .map((entry) => entry.message);
}

// Direct-insert probe (same shape as ricochet.test.ts): bypasses the muzzle +
// first-tick hold so the next step integrates immediately. Rolling defaults
// to false explicitly — every roll in these tests is entered honestly through
// a floor/top contact, never pre-seeded.
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
  ball.super = false;
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

// Owner 4d.4 rolling: fast ground/top touchdowns keep inertia (friction-damped
// planar motion glued to the live support) instead of freezing plasticky.
describe("4d.4 rolling: friction decays speed until the ball comes to rest", () => {
  it("fast floor arrival rolls, slows down, and rests (early travel > late travel)", async () => {
    expect(BALL_ROLL_MIN_SPEED).toBe(1.5);
    expect(BALL_ROLL_FRICTION).toBe(2.2);
    expect(BALL_ROLL_STOP_SPEED).toBe(0.3);
    const room = await playingRoom();
    isolateDuel(room);
    room.state.balls.clear();
    // Open ground lane (z=-2): falls with horizontal speed 8, well above the
    // roll threshold, so the touchdown enters ROLL (no settleMs).
    insertProbe(room, "friction", "s1", -8, 0.5, -2, 8, -1, 0);
    let rolledAt = -1;
    for (let i = 0; i < 10; i += 1) {
      tick50(room);
      const ball = getBall(room, "friction");
      if (ball?.rolling === true) {
        rolledAt = i;
        break;
      }
    }
    expect(rolledAt).toBeGreaterThanOrEqual(0);
    const entered = getBall(room, "friction");
    expect(entered?.settleMs ?? 0).toBe(0);
    expect(entered?.resting).toBe(false);
    // Track the roll: per-tick travel must shrink under friction until rest.
    const xs: number[] = [entered?.x ?? 0];
    let restedAt = -1;
    for (let i = 0; i < 120; i += 1) {
      tick50(room);
      const ball = getBall(room, "friction");
      if (ball === undefined) {
        throw new Error("rolling ball vanished mid-roll");
      }
      xs.push(ball.x);
      if (ball.resting === true) {
        restedAt = i;
        break;
      }
    }
    expect(restedAt).toBeGreaterThanOrEqual(0);
    const final = getBall(room, "friction");
    expect(final?.rolling).toBe(false);
    expect(final?.vx).toBe(0);
    expect(final?.vz).toBe(0);
    expect(final?.y).toBeCloseTo(BALL_GROUND_Y + BALL_RADIUS, 9);
    // Reduced travel per tick over time: the first 5 rolling ticks cover
    // strictly more ground than the last 5 before rest.
    const earlyTravel = Math.abs((xs[5] ?? 0) - (xs[0] ?? 0));
    const lateTravel = Math.abs((xs[xs.length - 1] ?? 0) - (xs[xs.length - 6] ?? 0));
    expect(earlyTravel).toBeGreaterThan(0);
    expect(lateTravel).toBeGreaterThanOrEqual(0);
    expect(earlyTravel).toBeGreaterThan(lateTravel);
  });
});

describe("4d.4 rolling: tower roll-off ends on the ground, never hovering", () => {
  it("rolling ball sliding off the tower footprint rests at ground support", async () => {
    const room = await playingRoom();
    isolateDuel(room);
    room.state.balls.clear();
    const tower = SERVER_OBSTACLES.find((block) => block.x === 4.8 && block.z === 4.8);
    if (tower === undefined) {
      throw new Error("no central tower defined");
    }
    // On the tower top at rest height with fast horizontal speed: the first
    // tick touches down into ROLL, which carries the ball off the +x edge.
    insertProbe(room, "rolloff", "s1", tower.x, tower.topY + BALL_RADIUS, tower.z, 6, 0, 0);
    let sawRolling = false;
    let rested = false;
    for (let i = 0; i < 120; i += 1) {
      tick50(room);
      const ball = getBall(room, "rolloff");
      if (ball === undefined) {
        throw new Error("rolling ball vanished mid-roll");
      }
      if (ball.rolling === true) {
        sawRolling = true;
      }
      if (ball.resting === true) {
        rested = true;
        break;
      }
    }
    expect(sawRolling).toBe(true);
    expect(rested).toBe(true);
    const final = getBall(room, "rolloff");
    // The roll must have actually cleared the footprint edge — otherwise the
    // ground-support assertion below cannot discriminate a hover.
    expect((final?.x ?? 0)).toBeGreaterThan(tower.x + tower.hx);
    const expected = Math.max(BALL_GROUND_Y, groundTopAt(final?.x ?? 0, final?.z ?? 0)) + BALL_RADIUS;
    expect(expected).toBeCloseTo(BALL_GROUND_Y + BALL_RADIUS, 9);
    expect(final?.restY).toBeCloseTo(expected, 9);
    expect(final?.y).toBeCloseTo(expected, 9);
    // Discriminating: hovering at tower-top height fails this.
    expect(final?.y ?? 0).toBeLessThan(tower.topY);
  });
});

describe("4d.4 rolling: low outer-block step climbs onto the block top", () => {
  it("rolling into the block footprint ends on the block top (0.65 step clears)", async () => {
    expect(BALL_ROLL_CLIMB_MAX).toBe(0.65);
    const room = await playingRoom();
    isolateDuel(room);
    room.state.balls.clear();
    const block = SERVER_OBSTACLES.find((entry) => entry.x === 10.8 && entry.z === 0);
    if (block === undefined) {
      throw new Error("no outer block defined");
    }
    // Floor support 0.58 -> block-top support 1.18: a 0.6 step, inside the
    // 0.65 climb budget. Fast open-floor approach from the -x side.
    insertProbe(room, "climb", "s1", 7.5, 0.5, 0, 8, -1, 0);
    let sawRolling = false;
    let rested = false;
    for (let i = 0; i < 150; i += 1) {
      tick50(room);
      const ball = getBall(room, "climb");
      if (ball === undefined) {
        throw new Error("rolling ball vanished mid-roll");
      }
      if (ball.rolling === true) {
        sawRolling = true;
      }
      if (ball.resting === true) {
        rested = true;
        break;
      }
    }
    expect(sawRolling).toBe(true);
    expect(rested).toBe(true);
    const final = getBall(room, "climb");
    // The roll must have ended INSIDE the block footprint — otherwise the
    // top-height assertion below is vacuous.
    expect(Math.abs((final?.x ?? 0) - block.x)).toBeLessThanOrEqual(block.hx);
    expect(Math.abs((final?.z ?? 0) - block.z)).toBeLessThanOrEqual(block.hz);
    expect(final?.y).toBeCloseTo(block.topY + BALL_RADIUS, 9);
    expect(final?.restY).toBeCloseTo(block.topY + BALL_RADIUS, 9);
    // Discriminating: a floor rest would sit at 0.58, embedded would sit
    // below the top — the ball cleared the step onto the top.
    expect(final?.y ?? 0).toBeGreaterThan(block.topY);
  });
});

describe("4d.4 rolling: boundary wall flip keeps the roll alive but damped", () => {
  it("axis flip at BALL_ROLL_WALL_KEEP, still rolling, not resting", async () => {
    expect(BALL_ROLL_WALL_KEEP).toBe(0.55);
    const room = await playingRoom();
    isolateDuel(room);
    room.state.balls.clear();
    // Open lane (z=-2) toward the +x wall with fast speed: rolls ~1.4m, then
    // the wall tick clamps + flips vx at the damped keep factor.
    insertProbe(room, "wallroll", "s1", ARENA_HALF_SIZE - 1.8, 0.5, -2, 6, -1, 0);
    const dampStep = Math.exp(-BALL_ROLL_FRICTION * 0.05);
    let flipped = false;
    let preFlip = 0;
    for (let i = 0; i < 40; i += 1) {
      const before = getBall(room, "wallroll")?.vx ?? 0;
      tick50(room);
      const ball = getBall(room, "wallroll");
      if (ball === undefined) {
        throw new Error("rolling ball vanished mid-roll");
      }
      if (before > 0 && ball.vx < 0) {
        flipped = true;
        preFlip = before;
        // Same-tick order is damp-then-flip: post == -(pre * damp) * KEEP.
        expect(ball.x).toBeCloseTo(ARENA_HALF_SIZE, 9);
        expect(ball.vx).toBeCloseTo(-(preFlip * dampStep) * BALL_ROLL_WALL_KEEP, 6);
        // Damped, not elastic: strictly slower than before the wall.
        expect(Math.abs(ball.vx)).toBeLessThan(Math.abs(preFlip));
        expect(ball.rolling).toBe(true);
        expect(ball.resting).toBe(false);
        break;
      }
    }
    expect(flipped).toBe(true);
  });
});

describe("4d.4 rolling: victim contact deals no damage", () => {
  it("0 damage, no knockback, no ball-hit broadcast, ball survives", async () => {
    const room = await playingRoom();
    const { target } = isolateDuel(room);
    room.state.balls.clear();
    const captured = captureBroadcasts(room);
    // Rolling +z from open ground straight at the damageable victim at
    // (0, -3): no godmode here, so 0 damage is a real (non-vacuous) result.
    insertProbe(room, "rollvictim", "s1", 0, 0.5, -6, 0, -1, 6);
    const victimX = target.x;
    const victimZ = target.z;
    let minPlanarDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 40; i += 1) {
      tick50(room);
      const ball = getBall(room, "rollvictim");
      if (ball === undefined) {
        throw new Error("rolling ball vanished on victim contact");
      }
      const planar = Math.hypot(ball.x - target.x, ball.z - target.z);
      if (planar < minPlanarDist) {
        minPlanarDist = planar;
      }
    }
    // The ball genuinely reached the victim (inside the 0.9m hit radius in
    // the planar sense) — the 0-damage result below is not a near-miss.
    expect(minPlanarDist).toBeLessThan(0.9);
    expect(target.hp).toBe(100);
    expect(target.x).toBeCloseTo(victimX, 9);
    expect(target.z).toBeCloseTo(victimZ, 9);
    expect(hitMessages(captured)).toHaveLength(0);
    expect(getBall(room, "rollvictim")).toBeDefined();
  });
});

describe("4d.4 event feed: join broadcast", () => {
  it('handlePlay broadcasts "<nick> joined the fight" on the killfeed channel', async () => {
    const room = new ArenaRoom();
    room.testNow = 0;
    await room.onCreate();
    const captured = captureBroadcasts(room);
    const client = fakeClient("s9");
    await room.onJoin(client, { nick: "Gamma" });
    (room as unknown as { handlePlay(client: Client, payload: unknown): void }).handlePlay(client, { nick: "Gamma" });
    const feeds = killfeedMessages(captured);
    expect(feeds).toHaveLength(1);
    expect(feeds[0]).toBe("Gamma joined the fight");
  });
});

describe("4d.4 event feed: super-core pickup names the item from config", () => {
  it("pickup killfeed text reads the display name from CENTER_ITEM_NAMES", async () => {
    expect(CENTER_ITEM_NAMES.super).toBe("SUPER core");
    const room = await playingRoom();
    const { shooter } = isolateDuel(room);
    room.state.balls.clear();
    // Shooter sits at the center; force an active core under his feet.
    shooter.x = 0;
    shooter.z = 0;
    const captured = captureBroadcasts(room);
    room.state.superActive = true;
    room.state.superX = 0;
    room.state.superZ = 0;
    room.state.superExpiresAt = (room.testNow ?? 0) + 60000;
    tick50(room);
    expect(shooter.superBuff).toBe(true);
    const feeds = killfeedMessages(captured);
    expect(feeds).toContain(`${shooter.nick} grabbed ${CENTER_ITEM_NAMES.super} (x2 next shot)`);
  });
});
