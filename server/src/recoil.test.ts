import { describe, expect, it } from "vitest";
import type { Client } from "colyseus";
import { ARENA_HALF_SIZE, BALL_RADIUS, LOBBY_COUNTDOWN_MS, PATCH_RATE_MS, RECOIL_FULL_M, RECOIL_WEAK_M } from "./config.js";
import { recoilDistanceForPower } from "./hits.js";
import { ArenaRoom } from "./rooms/ArenaRoom.js";
import { BallState, type PlayerState } from "./state.js";
import { SERVER_PLATFORMS } from "./config.js";

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

function advance(room: ArenaRoom, ms: number): void {
  room.testNow = (room.testNow ?? 0) + ms;
}

describe("recoil mapping (weak 0.4m -> full 0.8m by charge power)", () => {
  it("maps power01 0.5 to 0.4 and 1.0 to 0.8", () => {
    expect(RECOIL_WEAK_M).toBe(0.4);
    expect(RECOIL_FULL_M).toBe(0.8);
    expect(recoilDistanceForPower(0.5)).toBeCloseTo(0.4, 10);
    expect(recoilDistanceForPower(1.0)).toBeCloseTo(0.8, 10);
  });

  it("interpolates mid power linearly (0.75 -> 0.6)", () => {
    expect(recoilDistanceForPower(0.75)).toBeCloseTo(0.6, 10);
  });
});

describe("spawnBall recoil kick (opposite fire dir, clamped to arena)", () => {
  it("moves the shooter opposite the horizontal fire dir", async () => {
    const room = await playingRoom();
    const { shooter } = isolateDuel(room);
    const beforeX = shooter.x;
    const beforeZ = shooter.z;
    const now = room.testNow ?? 0;
    // yaw 0 / pitch 0.2 fires toward -Z, so recoil must push +Z.
    const ball = room.spawnBall(shooter, 1.0, 0, 0.2, false, now);
    expect(ball).not.toBe(null);
    expect(shooter.x).toBeCloseTo(beforeX, 5);
    expect(shooter.z - beforeZ).toBeCloseTo(RECOIL_FULL_M, 5);
  });

  it("clamps the kick to the arena bounds", async () => {
    const room = await playingRoom();
    const { shooter } = isolateDuel(room);
    shooter.x = ARENA_HALF_SIZE;
    shooter.z = ARENA_HALF_SIZE;
    const now = room.testNow ?? 0;
    // Same -Z shot: recoil pushes +Z, past the wall without the clamp.
    room.spawnBall(shooter, 1.0, 0, 0.2, false, now);
    expect(shooter.x).toBeLessThanOrEqual(ARENA_HALF_SIZE);
    expect(shooter.z).toBeLessThanOrEqual(ARENA_HALF_SIZE);
  });
});

describe("cannonball vs platform tops (server SERVER_PLATFORMS mirror)", () => {
  it("settles a ball inserted directly into state.balls on a platform top", async () => {
    // Stage 4d.4: up-facing hits SETTLE instead of despawning — the probe
    // slides to a stop pinned at top + BALL_RADIUS with velocity 0.
    const room = await playingRoom();
    isolateDuel(room);
    room.state.balls.clear();
    const platform = SERVER_PLATFORMS[0];
    if (platform === undefined) {
      throw new Error("no server platform defined");
    }
    const ball = new BallState();
    ball.ballId = "platform-probe";
    ball.ownerId = "s1";
    ball.x = platform.x;
    ball.y = platform.topY - 0.5;
    ball.z = platform.z;
    ball.vx = 0;
    ball.vy = 0;
    ball.vz = 0;
    ball.power01 = 1;
    ball.super = false;
    // Past the first-tick hold so the next step integrates and impacts.
    ball.ageMs = PATCH_RATE_MS;
    ball.distM = 0;
    room.state.balls.set(ball.ballId, ball);
    expect(room.state.balls.size).toBe(1);
    advance(room, 50);
    room.tickRoom(50);
    // Still live, now sliding on the surface...
    expect(room.state.balls.size).toBe(1);
    const settling = room.state.balls.get("platform-probe");
    expect(settling?.resting).toBe(false);
    expect(settling?.settleMs ?? 0).toBeGreaterThan(0);
    // ...then fully resting: pinned at the top, zero velocity.
    for (let i = 0; i < 11; i += 1) {
      advance(room, 50);
      room.tickRoom(50);
    }
    const rested = room.state.balls.get("platform-probe");
    expect(rested?.resting).toBe(true);
    expect(rested?.vx).toBe(0);
    expect(rested?.vy).toBe(0);
    expect(rested?.vz).toBe(0);
    expect(rested?.y).toBeCloseTo(platform.topY + BALL_RADIUS, 9);
  });
});
