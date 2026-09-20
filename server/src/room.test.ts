import { describe, expect, it } from "vitest";
import type { Client } from "colyseus";
import { SchemaSerializer } from "colyseus";
import {
  BALL_MUZZLE_OFFSET,
  BALL_TORSO_OFFSET,
  BODY_CENTER_Y,
  FULL_DAMAGE,
  LOBBY_COUNTDOWN_MS,
  MAX_LIVE_BALLS,
  MAX_PLAYERS,
  PATCH_RATE_MS,
  PLAYER_BODY_RADIUS,
  RELOAD_MS,
  REMATCH_DELAY_MS,
  RESPAWN_DELAY_MS,
  ROUND_DURATION_MS,
  SERVER_PLATFORMS,
  SUPER_SPAWN_S,
  WEAK_DAMAGE,
} from "./config.js";
import { bodyCenterYAt, groundTopAt, muzzleForShot, resolveThrowerY, sanitizeThrowerY } from "./hits.js";
import { ArenaRoom, SERVER_OBSTACLES } from "./rooms/ArenaRoom.js";
import type { PlayerState } from "./state.js";

function fakeClient(sessionId: string): Client {
  return {
    sessionId,
    send: (): void => {},
  } as unknown as Client;
}

async function joinRoom(room: ArenaRoom, sessionId: string, nick: string): Promise<void> {
  // R1 flow: join creates a spectator, then Play enters the arena.
  room.testNow = 0;
  const client = fakeClient(sessionId);
  await room.onJoin(client, { nick });
  (room as unknown as { handlePlay(client: Client, payload: unknown): void }).handlePlay(client, { nick });
}

async function joinAsSpectator(room: ArenaRoom, sessionId: string, nick: string): Promise<void> {
  room.testNow = 0;
  await room.onJoin(fakeClient(sessionId), { nick });
}

function playAs(room: ArenaRoom, sessionId: string, nick: string): void {
  (room as unknown as { handlePlay(client: Client, payload: unknown): void }).handlePlay(
    fakeClient(sessionId),
    { nick },
  );
}

function playerCount(room: ArenaRoom): number {
  let count = 0;
  room.state.players.forEach((): void => {
    count += 1;
  });
  return count;
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

describe("room netcode: join/leave/late-join/input replication", () => {
  it("2-6 clients join one room via guest nick, no auth", async () => {
    const room = new ArenaRoom();
    room.testNow = 0;
    await room.onCreate();
    await joinRoom(room, "s1", "Alpha");
    await joinRoom(room, "s2", "Beta");
    expect(getPlayer(room, "s1")?.nick).toBe("Alpha");
    expect(getPlayer(room, "s2")?.nick).toBe("Beta");
    expect(playerCount(room)).toBeLessThanOrEqual(MAX_PLAYERS);
  });

  it("late join mid-match works till round end", async () => {
    const room = new ArenaRoom();
    room.testNow = 0;
    await room.onCreate();
    await joinRoom(room, "s1", "Alpha");
    await joinRoom(room, "s2", "Beta");
    // Drive lobby -> countdown -> playing.
    room.testNow = 1;
    room.tickRoom();
    expect(room.state.phase).toBe("countdown");
    room.testNow = 1 + LOBBY_COUNTDOWN_MS + 1;
    room.tickRoom();
    expect(room.state.phase).toBe("playing");
    // Late joiner arrives as spectator first (no spawn, no HP drain).
    room.testNow = 5000;
    await room.onJoin(fakeClient("late"), { nick: "Late" });
    expect(getPlayer(room, "late")?.ready).toBe(false);
    expect(getPlayer(room, "late")?.alive).toBe(false);
    // Then Play enters the live round with spawn protection.
    playAs(room, "late", "Late");
    expect(getPlayer(room, "late")).toBeDefined();
    expect(getPlayer(room, "late")?.alive).toBe(true);
    expect(getPlayer(room, "late")?.ready).toBe(true);
    expect(room.state.phase).toBe("playing");
  });

  it("movement input replicates to authoritative position", async () => {
    const room = new ArenaRoom();
    room.testNow = 0;
    await room.onCreate();
    await joinRoom(room, "s1", "Alpha");
    await joinRoom(room, "s2", "Beta");
    room.testNow = 1;
    room.tickRoom(); // -> countdown
    room.testNow = 1 + LOBBY_COUNTDOWN_MS + 1;
    room.tickRoom(); // -> playing (fresh spawns)
    const before = getPlayer(room, "s1");
    const startX = before?.x ?? 0;
    // Direct-drive the private input handler like a client "input" message.
    (room as unknown as { handleInput(sessionId: string, payload: unknown): void }).handleInput("s1", {
      x: 1,
      y: 0,
      rotY: 1.5,
      seq: 7,
    });
    advance(room, 1000);
    room.tickRoom(1000);
    const after = getPlayer(room, "s1");
    expect((after?.x ?? 0)).toBeGreaterThan(startX);
    expect(after?.rotY).toBeCloseTo(1.5);
  });

  it("charging halves movement speed (aiming slow)", async () => {
    const room = await playingRoom();
    removeBots(room);
    const player = getPlayer(room, "s1");
    if (player === undefined) {
      throw new Error("missing s1");
    }
    player.x = 0;
    player.z = 0;
    (room as unknown as { handleInput(sessionId: string, payload: unknown): void }).handleInput("s1", {
      x: 1,
      y: 0,
      rotY: 0,
      seq: 1,
      charging: false,
    });
    advance(room, 1000);
    room.tickRoom(1000);
    const fullDist = (getPlayer(room, "s1")?.x ?? 0) - 0;
    const p2 = getPlayer(room, "s1");
    if (p2 !== undefined) {
      p2.x = 0;
      p2.z = 0;
    }
    (room as unknown as { handleInput(sessionId: string, payload: unknown): void }).handleInput("s1", {
      x: 1,
      y: 0,
      rotY: 0,
      seq: 2,
      charging: true,
    });
    advance(room, 1000);
    room.tickRoom(1000);
    const slowDist = getPlayer(room, "s1")?.x ?? 0;
    expect(fullDist).toBeGreaterThan(0);
    expect(slowDist).toBeCloseTo(fullDist / 2, 1);
  });

  it("join encodes state without setRoot crash (live onCreate/onJoin path)", async () => {
    // Regression for the live `setRoot of undefined` crash: the room state
    // must survive the exact serializer the live server uses
    // (Room.setState -> SchemaSerializer.reset -> full-state encode).
    // A direct `new Encoder(room.state)` import is NOT equivalent: it can
    // resolve a different @colyseus/schema build (ESM vs CJS) than core.
    const room = new ArenaRoom();
    room.testNow = 0;
    await room.onCreate();
    await joinRoom(room, "s1", "Tester");
    expect(getPlayer(room, "s1")?.nick).toBe("Tester");
    const serializer = new SchemaSerializer();
    serializer.reset(room.state);
    const bytes = serializer.getFullState(fakeClient("s1"));
    expect(bytes.length).toBeGreaterThan(0);
  });

  it("leave cleans up; last human out returns the room to lobby", async () => {
    const room = new ArenaRoom();
    room.testNow = 0;
    await room.onCreate();
    await joinRoom(room, "s1", "Alpha");
    await joinRoom(room, "s2", "Beta");
    room.testNow = 1;
    room.tickRoom();
    expect(room.state.phase).toBe("countdown");
    await room.onLeave(fakeClient("s1"));
    expect(getPlayer(room, "s1")).toBeUndefined();
    await room.onLeave(fakeClient("s2"));
    expect(room.state.phase).toBe("lobby");
  });
});

describe("round loop: score-or-timer end, respawn, clean reset", () => {
  it("round ends on 3min timer with the leader as winner, then resets", async () => {
    const room = await playingRoom();
    expect(room.state.phase).toBe("playing");
    const p1 = getPlayer(room, "s1");
    if (p1 !== undefined) {
      p1.score = 30;
    }
    advance(room, ROUND_DURATION_MS + 10);
    room.tickRoom();
    expect(room.state.phase).toBe("ended");
    expect(room.state.winner).toBe("s1");
    advance(room, REMATCH_DELAY_MS + 10);
    room.tickRoom();
    expect(room.state.phase).toBe("lobby");
    expect(getPlayer(room, "s1")?.score).toBe(0);
    expect(room.state.winner).toBe("");
  });

  it("round ends early on first-to-100, hard cap stays reachable", async () => {
    const room = await playingRoom();
    const p1 = getPlayer(room, "s1");
    if (p1 !== undefined) {
      p1.score = 100;
    }
    advance(room, 5000);
    room.tickRoom();
    expect(room.state.phase).toBe("ended");
    expect(room.state.winner).toBe("s1");
  });

  it("cannon kill respawns after 3s with full HP, no buff, no reload", async () => {
    const room = await playingRoom();
    const { shooter, target } = isolateDuel(room);
    target.hp = FULL_DAMAGE;
    target.superBuff = true;
    fireAs(room, "s1", { power01: 1, yaw: 0, pitch: 0.1, super: false });
    expect(room.state.balls.size).toBe(1);
    // Fly the ball into the victim (up to 3s of 50ms steps).
    for (let i = 0; i < 60 && target.alive; i += 1) {
      advance(room, 50);
      room.tickRoom(50);
    }
    expect(target.alive).toBe(false);
    expect(shooter.score).toBeGreaterThan(0);
    advance(room, RESPAWN_DELAY_MS + 10);
    room.tickRoom();
    const respawned = getPlayer(room, "s2");
    expect(respawned?.alive).toBe(true);
    expect(respawned?.hp).toBe(100);
    expect(respawned?.superBuff).toBe(false);
    expect(respawned?.reloadUntil).toBe(0);
  });

  it("single client fills bots and can start/finish a round vs bots", async () => {
    const room = new ArenaRoom();
    room.testNow = 0;
    await room.onCreate();
    await joinRoom(room, "solo", "Solo");
    expect(playerCount(room)).toBeGreaterThanOrEqual(2); // bots filled
    room.testNow = 1;
    room.tickRoom();
    expect(room.state.phase).toBe("countdown");
    room.testNow = 1 + LOBBY_COUNTDOWN_MS + 1;
    room.tickRoom();
    expect(room.state.phase).toBe("playing");
    advance(room, ROUND_DURATION_MS + 10);
    room.tickRoom();
    expect(room.state.phase).toBe("ended");
  });
});

describe("R2 cannon fire: balls, damage, reload, arming, cap", () => {
  it("fire spawns a ball and gates reload for 2.5s", async () => {
    const room = await playingRoom();
    isolateDuel(room);
    fireAs(room, "s1", { power01: 1, yaw: 0, pitch: 0.2, super: false });
    expect(room.state.balls.size).toBe(1);
    const shooter = getPlayer(room, "s1");
    expect(shooter?.reloadUntil).toBeGreaterThan(0);
    // Immediate second shot is blocked by the reload gate.
    fireAs(room, "s1", { power01: 1, yaw: 0, pitch: 0.2, super: false });
    expect(room.state.balls.size).toBe(1);
    // After the gate a new shot spawns.
    if (shooter !== undefined) {
      shooter.reloadUntil = 0;
    }
    fireAs(room, "s1", { power01: 0.5, yaw: 0, pitch: 0.2, super: false });
    expect(room.state.balls.size).toBe(2);
    expect(RELOAD_MS).toBe(2500);
  });

  it("full-power ball hits for 25, weak ball for 12.5", async () => {
    const room = await playingRoom();
    const { target } = isolateDuel(room);
    fireAs(room, "s1", { power01: 1, yaw: 0, pitch: 0.1, super: false });
    for (let i = 0; i < 60 && target.hp === 100; i += 1) {
      advance(room, 50);
      room.tickRoom(50);
    }
    expect(target.hp).toBe(100 - FULL_DAMAGE);

    const room2 = await playingRoom();
    const duel2 = isolateDuel(room2);
    fireAs(room2, "s1", { power01: 0.5, yaw: 0, pitch: 0.1, super: false });
    for (let i = 0; i < 60 && duel2.target.hp === 100; i += 1) {
      advance(room2, 50);
      room2.tickRoom(50);
    }
    expect(duel2.target.hp).toBeCloseTo(100 - WEAK_DAMAGE, 5);
  });

  it("point-blank fire does not insta-suicide (arming 1m / 0.3s)", async () => {
    const room = await playingRoom();
    const { shooter } = isolateDuel(room);
    // Aim straight up so the ball leaves without touching anyone: the
    // shooter must survive the first steps (self unarmed at spawn).
    fireAs(room, "s1", { power01: 1, yaw: 0, pitch: 1.4, super: false });
    expect(room.state.balls.size).toBe(1);
    advance(room, 50);
    room.tickRoom(50);
    expect(shooter.hp).toBe(100);
    expect(shooter.alive).toBe(true);
  });

  it("live balls cap at 12, oldest despawns first", async () => {
    const room = await playingRoom();
    isolateDuel(room);
    for (let i = 0; i < MAX_LIVE_BALLS + 1; i += 1) {
      const shooter = getPlayer(room, "s1");
      if (shooter !== undefined) {
        shooter.reloadUntil = 0;
      }
      fireAs(room, "s1", { power01: 0.5, yaw: 0.3 * i, pitch: 0.5, super: false });
    }
    expect(room.state.balls.size).toBeLessThanOrEqual(MAX_LIVE_BALLS);
    expect(room.state.balls.size).toBe(MAX_LIVE_BALLS);
  });

  it("spectator cannot fire and cannot be hit", async () => {
    const room = await playingRoom();
    removeBots(room);
    await joinAsSpectator(room, "watcher", "Watcher");
    fireAs(room, "watcher", { power01: 1, yaw: 0, pitch: 0.2, super: false });
    expect(room.state.balls.size).toBe(0);
    // Balls fly through spectators: park the watcher in the line of fire.
    const shooter = getPlayer(room, "s1");
    const target = getPlayer(room, "s2");
    const watcher = getPlayer(room, "watcher");
    if (shooter === undefined || target === undefined || watcher === undefined) {
      throw new Error("missing fighters");
    }
    shooter.x = 0;
    shooter.z = 0;
    shooter.invulnUntil = 0;
    shooter.reloadUntil = 0;
    target.x = 10;
    target.z = 10;
    target.invulnUntil = 0;
    watcher.x = 0;
    watcher.z = -3;
    fireAs(room, "s1", { power01: 1, yaw: 0, pitch: 0.1, super: false });
    expect(room.state.balls.size).toBe(1);
    for (let i = 0; i < 60; i += 1) {
      advance(room, 50);
      room.tickRoom(50);
    }
    expect(watcher.hp).toBe(100);
    expect(watcher.alive).toBe(false);
  });

  it("bots fire cannonballs at nearby fighters", async () => {
    const room = await playingRoom();
    const human = getPlayer(room, "s1");
    if (human === undefined) {
      throw new Error("missing s1");
    }
    // Pin a bot next to the human with a ready brain and open reload.
    let botId: string | null = null;
    room.state.players.forEach((player: PlayerState, key: string): void => {
      if (player.isBot && botId === null) {
        botId = key;
      }
    });
    expect(botId).not.toBe(null);
    if (botId === null) {
      return;
    }
    const bot = getPlayer(room, botId);
    if (bot === undefined || human === undefined) {
      throw new Error("missing bot/human");
    }
    bot.x = human.x + 3;
    bot.z = human.z;
    bot.invulnUntil = 0;
    bot.reloadUntil = 0;
    human.invulnUntil = 0;
    // Force the bot brain past its initial cooldown, then tick.
    advance(room, 8000);
    const before = room.state.balls.size;
    room.tickRoom(50);
    expect(room.state.balls.size).toBeGreaterThan(before);
  });
});

describe("R2 muzzle sync: spawn leaves the torso along aim", () => {
  it("ball spawns at chest-exit offset 0.7 along aim, ground height 1.4", async () => {
    expect(BALL_MUZZLE_OFFSET).toBeCloseTo(0.7, 10);
    expect(BALL_TORSO_OFFSET).toBeCloseTo(0.3, 10);
    expect(BODY_CENTER_Y + BALL_TORSO_OFFSET).toBeCloseTo(1.4, 10);
    const room = await playingRoom();
    const { shooter } = isolateDuel(room);
    const yaw = 0.4;
    const pitch = 0.2;
    // Recoil moves the shooter on fire: capture the pre-fire body center so
    // the muzzle expectation uses the same origin spawnBall() used.
    const preX = shooter.x;
    const preZ = shooter.z;
    // No throwerY in the payload: ground elevation derives from the open
    // footprint (0 + 1.1 body-center), spawn y == old absolute 1.4.
    fireAs(room, "s1", { power01: 1, yaw, pitch, super: false });
    expect(room.state.balls.size).toBe(1);
    let spawned: { x: number; y: number; z: number } | null = null;
    room.state.balls.forEach((ball): void => {
      spawned = { x: ball.x, y: ball.y, z: ball.z };
    });
    if (spawned === null) {
      throw new Error("no ball spawned");
    }
    const snap = spawned as { x: number; y: number; z: number };
    const cosPitch = Math.cos(pitch);
    const dirX = -Math.sin(yaw) * cosPitch;
    const dirZ = -Math.cos(yaw) * cosPitch;
    expect(snap.x).toBeCloseTo(preX + dirX * BALL_MUZZLE_OFFSET, 5);
    expect(snap.z).toBeCloseTo(preZ + dirZ * BALL_MUZZLE_OFFSET, 5);
    expect(snap.y).toBeCloseTo(1.4, 10);
  });

  it("spawn equals muzzleForShot() exactly (single origin helper)", async () => {
    const room = await playingRoom();
    const { shooter } = isolateDuel(room);
    const yaw = 1.1;
    const pitch = 0.35;
    const preX = shooter.x;
    const preZ = shooter.z;
    fireAs(room, "s1", { power01: 1, yaw, pitch, super: false });
    expect(room.state.balls.size).toBe(1);
    let spawned: { x: number; y: number; z: number } | null = null;
    room.state.balls.forEach((ball): void => {
      spawned = { x: ball.x, y: ball.y, z: ball.z };
    });
    if (spawned === null) {
      throw new Error("no ball spawned");
    }
    const snap = spawned as { x: number; y: number; z: number };
    // Same resolution spawnBall() applies: no client y -> derived footprint.
    const expected = muzzleForShot(preX, resolveThrowerY(null, preX, preZ), preZ, yaw, pitch);
    expect(snap.x).toBeCloseTo(expected.x, 10);
    expect(snap.y).toBeCloseTo(expected.y, 10);
    expect(snap.z).toBeCloseTo(expected.z, 10);
  });

  it("client throwerY wins inside the clamp band (elevated thrower)", async () => {
    const room = await playingRoom();
    isolateDuel(room);
    const yaw = 0.4;
    const pitch = 0.2;
    // Shooter on open ground (derived 1.1) throwing from platform height:
    // 3.7 sits inside [0.1, 7.1], so spawn y = 3.7 + 0.3 = 4.0.
    fireAs(room, "s1", { power01: 1, yaw, pitch, super: false, throwerY: 3.7 });
    expect(room.state.balls.size).toBe(1);
    let spawnedY: number | null = null;
    room.state.balls.forEach((ball): void => {
      spawnedY = ball.y;
    });
    expect(spawnedY).toBeCloseTo(4.0, 10);
  });

  it("derives platform-footprint elevation when the payload omits throwerY", async () => {
    const room = await playingRoom();
    const { shooter } = isolateDuel(room);
    const platform = SERVER_PLATFORMS[0];
    if (platform === undefined) {
      throw new Error("no server platform defined");
    }
    // Stand the shooter on the first platform top (2.6): derived body-center
    // is 3.7, so spawn y = 4.0 with no client elevation sent.
    shooter.x = platform.x;
    shooter.z = platform.z;
    fireAs(room, "s1", { power01: 1, yaw: 0.4, pitch: 0.2, super: false });
    expect(room.state.balls.size).toBe(1);
    let spawnedY: number | null = null;
    room.state.balls.forEach((ball): void => {
      spawnedY = ball.y;
    });
    expect(spawnedY).toBeCloseTo(platform.topY + BODY_CENTER_Y + BALL_TORSO_OFFSET, 10);
    expect(spawnedY).toBeCloseTo(4.0, 10);
  });

  it("bot path (6-arg spawnBall) derives elevation like missing throwerY", async () => {
    const room = await playingRoom();
    const { shooter } = isolateDuel(room);
    const platform = SERVER_PLATFORMS[0];
    if (platform === undefined) {
      throw new Error("no server platform defined");
    }
    // fireBots() calls spawnBall without throwerY (default null): same
    // derivation must apply, so bot throws from platforms leave the torso.
    shooter.x = platform.x;
    shooter.z = platform.z;
    const now = room.testNow ?? 0;
    const ball = room.spawnBall(shooter, 1, 0.4, 0.2, false, now);
    expect(ball).not.toBe(null);
    expect(ball?.y).toBeCloseTo(4.0, 10);
  });

  it("insane throwerY falls back to the derived footprint elevation", async () => {
    const room = await playingRoom();
    isolateDuel(room);
    // NaN sanitizes to null -> derived ground spawn 1.4.
    fireAs(room, "s1", { power01: 1, yaw: 0.4, pitch: 0.2, super: false, throwerY: Number.NaN });
    expect(room.state.balls.size).toBe(1);
    let firstY: number | null = null;
    room.state.balls.forEach((ball): void => {
      firstY = ball.y;
    });
    expect(firstY).toBeCloseTo(1.4, 10);
  });

  it("absurd-but-finite throwerY clamps to derived + 6 (no skybox spawns)", async () => {
    const room = await playingRoom();
    isolateDuel(room);
    // 999 sanitizes to 8, then clamps to derived(1.1) + 6 = 7.1.
    fireAs(room, "s1", { power01: 1, yaw: 0.4, pitch: 0.2, super: false, throwerY: 999 });
    expect(room.state.balls.size).toBe(1);
    let spawnedY: number | null = null;
    room.state.balls.forEach((ball): void => {
      spawnedY = ball.y;
    });
    expect(spawnedY).toBeCloseTo(7.1 + BALL_TORSO_OFFSET, 10);
  });

  it("first tick holds the ball at the muzzle (no downrange jump)", async () => {
    const room = await playingRoom();
    isolateDuel(room);
    // Aim up so nothing is hit on later ticks: this test only tracks origin.
    fireAs(room, "s1", { power01: 1, yaw: 0, pitch: 1.4, super: false });
    expect(room.state.balls.size).toBe(1);
    let origin: { x: number; y: number; z: number } | null = null;
    room.state.balls.forEach((ball): void => {
      origin = { x: ball.x, y: ball.y, z: ball.z };
    });
    if (origin === null) {
      throw new Error("no ball spawned");
    }
    const start = origin as { x: number; y: number; z: number };
    // First authoritative frame (one PATCH_RATE step): aged but not moved.
    advance(room, PATCH_RATE_MS);
    room.tickRoom(PATCH_RATE_MS);
    expect(room.state.balls.size).toBe(1);
    let first: { x: number; y: number; z: number } | null = null;
    room.state.balls.forEach((ball): void => {
      first = { x: ball.x, y: ball.y, z: ball.z };
    });
    if (first === null) {
      throw new Error("ball vanished on first tick");
    }
    const frame1 = first as { x: number; y: number; z: number };
    expect(frame1.x).toBeCloseTo(start.x, 10);
    expect(frame1.y).toBeCloseTo(start.y, 10);
    expect(frame1.z).toBeCloseTo(start.z, 10);
    const distM = Math.hypot(frame1.x - start.x, frame1.y - start.y, frame1.z - start.z);
    expect(distM).toBeLessThan(0.5);
  });
});

describe("thrower elevation helpers (4d.1 torso-height spawn)", () => {
  it("groundTopAt reads platform tops, 0 on open ground", () => {
    const platform = SERVER_PLATFORMS[0];
    if (platform === undefined) {
      throw new Error("no server platform defined");
    }
    expect(groundTopAt(platform.x, platform.z)).toBeCloseTo(platform.topY, 10);
    expect(groundTopAt(0, 0)).toBe(0);
    expect(groundTopAt(Number.NaN, 0)).toBe(0);
  });

  it("bodyCenterYAt is groundTop + 1.1", () => {
    expect(bodyCenterYAt(0, 0)).toBeCloseTo(1.1, 10);
    const platform = SERVER_PLATFORMS[0];
    if (platform === undefined) {
      throw new Error("no server platform defined");
    }
    expect(bodyCenterYAt(platform.x, platform.z)).toBeCloseTo(platform.topY + 1.1, 10);
  });

  it("sanitizeThrowerY clamps finite 0..8, nulls garbage", () => {
    expect(sanitizeThrowerY(3.7)).toBeCloseTo(3.7, 10);
    expect(sanitizeThrowerY(999)).toBe(8);
    expect(sanitizeThrowerY(-5)).toBe(0);
    expect(sanitizeThrowerY(Number.NaN)).toBe(null);
    expect(sanitizeThrowerY("3.7")).toBe(null);
    expect(sanitizeThrowerY(undefined)).toBe(null);
  });

  it("resolveThrowerY prefers client y in band, derives outside it", () => {
    // Ground derived 1.1, band [0.1, 7.1].
    expect(resolveThrowerY(null, 0, 0)).toBeCloseTo(1.1, 10);
    expect(resolveThrowerY(3.7, 0, 0)).toBeCloseTo(3.7, 10);
    expect(resolveThrowerY(8, 0, 0)).toBeCloseTo(7.1, 10);
    expect(resolveThrowerY(0, 0, 0)).toBeCloseTo(0.1, 10);
  });
});

describe("R2 super-core: spawn, pickup, consume-on-fire (even on miss)", () => {
  it("spawns at center every 45s and is picked up within 1.4m", async () => {
    const room = await playingRoom();
    removeBots(room);
    expect(SUPER_SPAWN_S).toBe(45);
    room.state.superActive = false;
    room.state.superNextAt = room.testNow ?? 0;
    const player = getPlayer(room, "s1");
    if (player === undefined) {
      throw new Error("missing s1");
    }
    player.x = 5;
    player.z = 5;
    player.invulnUntil = 0;
    advance(room, 10);
    room.tickRoom(50);
    expect(room.state.superActive).toBe(true);
    expect(room.state.superX).toBe(0);
    expect(room.state.superZ).toBe(0);
    // Walk into the pickup radius.
    player.x = 0.5;
    player.z = 0.5;
    advance(room, 50);
    room.tickRoom(50);
    expect(player.superBuff).toBe(true);
    expect(room.state.superActive).toBe(false);
  });

  it("super buffs the next shot x2 and is lost even on a miss", async () => {
    const room = await playingRoom();
    const { shooter } = isolateDuel(room);
    shooter.superBuff = true;
    // Aim at the sky: guaranteed miss, buff still consumed.
    fireAs(room, "s1", { power01: 1, yaw: 0, pitch: 1.4, super: true });
    expect(shooter.superBuff).toBe(false);
    let superBall = false;
    room.state.balls.forEach((ball): void => {
      if (ball.super) {
        superBall = true;
      }
    });
    expect(superBall).toBe(true);
    // Without the flag the same buff would still be consumed (NEXT shot).
    const room2 = await playingRoom();
    const duel2 = isolateDuel(room2);
    duel2.shooter.superBuff = true;
    fireAs(room2, "s1", { power01: 1, yaw: 0, pitch: 1.4, super: false });
    expect(duel2.shooter.superBuff).toBe(false);
    let plainSuper = false;
    room2.state.balls.forEach((ball): void => {
      if (ball.super) {
        plainSuper = true;
      }
    });
    expect(plainSuper).toBe(false);
  });
});

describe("R1 pre-join spectator", () => {
  it("onJoin creates a spectator only: not ready, not alive, no bots", async () => {
    const room = new ArenaRoom();
    room.testNow = 0;
    await room.onCreate();
    await joinAsSpectator(room, "s1", "Watcher");
    const player = getPlayer(room, "s1");
    expect(player).toBeDefined();
    expect(player?.ready).toBe(false);
    expect(player?.spectator).toBe(true);
    expect(player?.alive).toBe(false);
    expect(room.readyFighterCount()).toBe(0);
    expect(room.watchingCount()).toBe(1);
    // No bots spawn for spectators alone; lobby never counts down.
    expect(playerCount(room)).toBe(1);
    room.testNow = 1;
    room.tickRoom();
    expect(room.state.phase).toBe("lobby");
  });

  it("spectators are ignored by bots, inputs, and cannon fire until Play", async () => {
    const room = new ArenaRoom();
    room.testNow = 0;
    await room.onCreate();
    await joinRoom(room, "s1", "Alpha");
    await joinRoom(room, "s2", "Beta");
    await joinAsSpectator(room, "watcher", "Watcher");
    const watcher = getPlayer(room, "watcher");
    expect(watcher?.alive).toBe(false);
    // Spectator input is dropped (no movement state change possible).
    (room as unknown as { handleInput(sessionId: string, payload: unknown): void }).handleInput("watcher", {
      x: 1,
      y: 0,
      rotY: 1.5,
      seq: 7,
    });
    expect(getPlayer(room, "watcher")?.x).toBe(0);
    // Spectator can neither shoot nor be hit (cannon only).
    fireAs(room, "watcher", { power01: 1, yaw: 0, pitch: 0.2, super: false });
    expect(getPlayer(room, "s1")?.hp).toBe(100);
    fireAs(room, "s1", { power01: 1, yaw: 0, pitch: 0.2, super: false });
    expect(getPlayer(room, "watcher")?.alive).toBe(false);
    // Counters: 2 fighters + bots, 1 watching.
    expect(room.watchingCount()).toBe(1);
    expect(room.readyFighterCount()).toBeGreaterThanOrEqual(2);
  });

  it("empty Play nick falls back to Guest-XXXX and enters the arena", async () => {
    const room = new ArenaRoom();
    room.testNow = 0;
    await room.onCreate();
    await joinAsSpectator(room, "s1", "");
    playAs(room, "s1", "   ");
    const player = getPlayer(room, "s1");
    expect(player?.ready).toBe(true);
    expect(player?.spectator).toBe(false);
    expect(player?.alive).toBe(true);
    expect(player?.hp).toBe(100);
    expect(player?.nick.startsWith("Guest-")).toBe(true);
  });
});

describe("B1 capacity regression: bots must not block spectator joins", () => {
  function capturingClient(sessionId: string): { client: Client; sent: Array<{ type: string; payload: unknown }> } {
    const sent: Array<{ type: string; payload: unknown }> = [];
    const client = {
      sessionId,
      send: (type: string, payload: unknown): void => {
        sent.push({ type, payload });
      },
    } as unknown as Client;
    return { client, sent };
  }

  it("join when bots fill capacity still gets a spectator entry plus feedback", async () => {
    const room = new ArenaRoom();
    room.testNow = 0;
    await room.onCreate();
    // B1 scenario: 3 ready humans fill bots to desired = max(3, 3*2) = 6,
    // so total entities reach MAX_PLAYERS before the 4th human arrives.
    await joinRoom(room, "s1", "Alpha");
    await joinRoom(room, "s2", "Beta");
    await joinRoom(room, "s3", "Gamma");
    expect(playerCount(room)).toBe(MAX_PLAYERS);
    // 4th human passes matchmaking (only 3 connected clients) and must get
    // a spectator entry plus an explicit spectator message — never a silent
    // no-op that leaves the client stuck on the overlay.
    const fourth = capturingClient("s4");
    await room.onJoin(fourth.client, { nick: "Delta" });
    const entry = getPlayer(room, "s4");
    expect(entry).toBeDefined();
    expect(entry?.spectator).toBe(true);
    expect(entry?.ready).toBe(false);
    expect(fourth.sent.some((message) => message.type === "spectator")).toBe(true);
    expect(fourth.sent.some((message) => message.type === "room-full")).toBe(false);
    // Play must either enter the arena or get an explicit full message —
    // never a silent no-op.
    const playInbox = capturingClient("s4");
    (room as unknown as { handlePlay(client: Client, payload: unknown): void }).handlePlay(playInbox.client, {
      nick: "Delta",
    });
    const fighter = getPlayer(room, "s4");
    const gotWelcome = playInbox.sent.some((message) => message.type === "welcome");
    const gotFull = playInbox.sent.some((message) => message.type === "room-full");
    if (fighter?.ready === true && fighter.spectator === false) {
      expect(gotWelcome).toBe(true);
    } else {
      expect(gotFull).toBe(true);
    }
  });

  it("truly full room rejects with an explicit room-full message", async () => {
    const room = new ArenaRoom();
    room.testNow = 0;
    await room.onCreate();
    for (let i = 1; i <= MAX_PLAYERS; i += 1) {
      await joinAsSpectator(room, `w${i}`, `Watcher${i}`);
    }
    expect(playerCount(room)).toBe(MAX_PLAYERS);
    const extra = capturingClient("extra");
    await room.onJoin(extra.client, { nick: "Late" });
    expect(getPlayer(room, "extra")).toBeUndefined();
    expect(extra.sent.some((message) => message.type === "room-full")).toBe(true);
  });

  it("spectator flood does not let bots push entities past MAX_PLAYERS", async () => {
    const room = new ArenaRoom();
    room.testNow = 0;
    await room.onCreate();
    for (let i = 1; i <= 5; i += 1) {
      await joinAsSpectator(room, `w${i}`, `Watcher${i}`);
    }
    playAs(room, "w1", "Fighter1");
    expect(playerCount(room)).toBeLessThanOrEqual(MAX_PLAYERS);
  });
});

describe("self-sync: world-space input semantics + welcome spawn coords", () => {
  it("applies client world input as world axes (x -> +X, y -> +Z)", async () => {
    const room = await playingRoom();
    removeBots(room);
    const player = getPlayer(room, "s1");
    if (player === undefined) {
      throw new Error("missing s1");
    }
    // World +X: payload x=1 moves the authoritative x forward.
    player.x = 0;
    player.z = 0;
    (room as unknown as { handleInput(sessionId: string, payload: unknown): void }).handleInput("s1", {
      x: 1,
      y: 0,
      rotY: 0,
      seq: 1,
    });
    advance(room, 1000);
    room.tickRoom(1000);
    const afterX = getPlayer(room, "s1")?.x ?? 0;
    const afterZ = getPlayer(room, "s1")?.z ?? 0;
    expect(afterX).toBeGreaterThan(0);
    expect(afterZ).toBeCloseTo(0, 5);
    // World +Z: payload y=1 moves the authoritative z forward.
    const p2 = getPlayer(room, "s1");
    if (p2 !== undefined) {
      p2.x = 0;
      p2.z = 0;
    }
    (room as unknown as { handleInput(sessionId: string, payload: unknown): void }).handleInput("s1", {
      x: 0,
      y: 1,
      rotY: 0,
      seq: 2,
    });
    advance(room, 1000);
    room.tickRoom(1000);
    expect(getPlayer(room, "s1")?.z ?? 0).toBeGreaterThan(0);
    expect(getPlayer(room, "s1")?.x ?? 0).toBeCloseTo(0, 5);
  });

  it("reuses last input across ticks (no single-packet freeze)", async () => {
    const room = await playingRoom();
    removeBots(room);
    const player = getPlayer(room, "s1");
    if (player === undefined) {
      throw new Error("missing s1");
    }
    player.x = 0;
    player.z = 0;
    (room as unknown as { handleInput(sessionId: string, payload: unknown): void }).handleInput("s1", {
      x: 1,
      y: 0,
      rotY: 0,
      seq: 1,
    });
    advance(room, 500);
    room.tickRoom(500);
    const mid = getPlayer(room, "s1")?.x ?? 0;
    // No new packet: the stored input still drives the next tick.
    advance(room, 500);
    room.tickRoom(500);
    expect(getPlayer(room, "s1")?.x ?? 0).toBeGreaterThan(mid);
  });

  it("welcome carries the authoritative spawn x/z for client teleport", async () => {
    const room = new ArenaRoom();
    room.testNow = 0;
    await room.onCreate();
    await joinAsSpectator(room, "s1", "Alpha");
    const sent: Array<{ type: string; payload: unknown }> = [];
    const client = {
      sessionId: "s1",
      send: (type: string, payload: unknown): void => {
        sent.push({ type, payload });
      },
    } as unknown as Client;
    (room as unknown as { handlePlay(client: Client, payload: unknown): void }).handlePlay(client, {
      nick: "Alpha",
    });
    const player = getPlayer(room, "s1");
    const welcome = sent.find((message) => message.type === "welcome");
    expect(welcome).toBeDefined();
    const body = (welcome?.payload ?? {}) as { x?: unknown; z?: unknown };
    expect(typeof body.x).toBe("number");
    expect(typeof body.z).toBe("number");
    expect(body.x).toBe(player?.x);
    expect(body.z).toBe(player?.z);
  });
});

// Through-wall fix (room level): authoritative positions never enter
// geometry, so the client reconcile loop has no pass-through to chase.
// Corner block (4.8, 4.8) hx=hz=1 + 0.5 radius → faces at 3.3 / 6.3;
// platform 0 (13.8, -8.5) hx=hz=1.2 → min-x face 12.1, open ramp face +z.
describe("server movement collision (humans + bots stop/slide, never pass)", () => {
  function sendMove(room: ArenaRoom, sessionId: string, x: number, y: number): void {
    (room as unknown as { handleInput(sessionId: string, payload: unknown): void }).handleInput(sessionId, {
      x,
      y,
      rotY: 0,
      seq: 1,
      charging: false,
    });
  }

  function tick50(room: ArenaRoom): void {
    advance(room, 50);
    room.tickRoom(50);
  }

  // Undamageable fighters: balls still fly but canDamage fails, so no
  // knockback shove ever displaces the measured positions.
  function godmode(room: ArenaRoom): void {
    room.state.players.forEach((player: PlayerState): void => {
      player.invulnUntil = 1e15;
    });
  }

  // Asserts one fighter is not strictly inside any expanded solid footprint
  // (resting contact ON a face is legal — only real penetration fails).
  function expectOutsideSolids(
    room: ArenaRoom,
    solids: ReadonlyArray<{ x: number; z: number; hx: number; hz: number }>,
    sessionId: string,
  ): void {
    const fighter = getPlayer(room, sessionId);
    if (fighter === undefined) {
      throw new Error(`missing ${sessionId}`);
    }
    for (const solid of solids) {
      const insideX = Math.abs(fighter.x - solid.x) < solid.hx + PLAYER_BODY_RADIUS - 1e-6;
      const insideZ = Math.abs(fighter.z - solid.z) < solid.hz + PLAYER_BODY_RADIUS - 1e-6;
      expect(insideX && insideZ).toBe(false);
    }
  }

  it("humans stop at the obstacle face instead of walking through", async () => {
    const room = await playingRoom();
    godmode(room);
    const player = getPlayer(room, "s1");
    if (player === undefined) {
      throw new Error("missing s1");
    }
    player.x = 1.0;
    player.z = 4.8;
    sendMove(room, "s1", 1, 0);
    for (let i = 0; i < 80; i += 1) {
      tick50(room);
    }
    const after = getPlayer(room, "s1");
    // Pinned at the expanded face (3.3), made progress, never drifted in z.
    expect(after?.x ?? 99).toBeLessThanOrEqual(3.3 + 1e-9);
    expect(after?.x ?? 0).toBeGreaterThan(2.5);
    expect(after?.z ?? 99).toBeCloseTo(4.8, 9);
  });

  it("humans slide along the face on diagonal input", async () => {
    const room = await playingRoom();
    godmode(room);
    const player = getPlayer(room, "s1");
    if (player === undefined) {
      throw new Error("missing s1");
    }
    player.x = 3.2;
    player.z = 4.8;
    sendMove(room, "s1", 1, 1);
    const solids = [...SERVER_OBSTACLES, ...SERVER_PLATFORMS];
    // Short window: 8 ticks slide +z along the face (x pinned at 3.3) while
    // z is still alongside the block — longer runs legitimately round the
    // corner (x frees once z clears 6.3), which is correct wall behavior.
    for (let i = 0; i < 8; i += 1) {
      tick50(room);
      expectOutsideSolids(room, solids, "s1");
    }
    const after = getPlayer(room, "s1");
    // X stays pinned at the face while Z advances past the block.
    expect(after?.x ?? 99).toBeLessThanOrEqual(3.3 + 1e-9);
    expect(after?.z ?? 0).toBeGreaterThan(5.5);
  });

  it("platform sheer sides block, the ramp side stays walkable", async () => {
    const room = await playingRoom();
    godmode(room);
    const player = getPlayer(room, "s1");
    if (player === undefined) {
      throw new Error("missing s1");
    }
    player.x = 10;
    player.z = -8.5;
    sendMove(room, "s1", 1, 0);
    for (let i = 0; i < 40; i += 1) {
      tick50(room);
    }
    expect(getPlayer(room, "s1")?.x ?? 99).toBeLessThanOrEqual(12.1 + 1e-9);
    // Ramp side (+z of platform 0): walks in past the open face plane (-6.8).
    player.x = 13.8;
    player.z = -6.0;
    sendMove(room, "s1", 0, -1);
    for (let i = 0; i < 20; i += 1) {
      tick50(room);
    }
    expect(getPlayer(room, "s1")?.z ?? 0).toBeLessThan(-7.5);
  });

  it("bots never penetrate solids (same resolver as humans)", async () => {
    const room = await playingRoom();
    godmode(room);
    const botIds: string[] = [];
    room.state.players.forEach((player: PlayerState, key: string): void => {
      if (player.isBot) {
        botIds.push(key);
      }
    });
    expect(botIds.length).toBeGreaterThan(0);
    const solids = [...SERVER_OBSTACLES, ...SERVER_PLATFORMS];
    for (let i = 0; i < 60; i += 1) {
      // Re-pin every bot just outside the corner-block face (whatever the
      // brain chooses next — at most 0.11m per tick — the resolver must
      // keep it out of the expanded footprint).
      for (const id of botIds) {
        const bot = getPlayer(room, id);
        if (bot !== undefined) {
          bot.x = 3.0;
          bot.z = 4.8;
        }
      }
      tick50(room);
      for (const id of botIds) {
        expectOutsideSolids(room, solids, id);
      }
    }
  });

  it("ball-hit knockback stops at the block face instead of embedding", async () => {
    const room = await playingRoom();
    const { shooter, target } = isolateDuel(room);
    // Victim just outside obstacle0's min-x face (3.3 expanded); shooter
    // west of them firing +x (yaw -π/2) so the 1.2m shove pushes +x.
    shooter.x = 0;
    shooter.z = 4.8;
    target.x = 2.5;
    target.z = 4.8;
    target.hp = 100;
    fireAs(room, "s1", { power01: 1, yaw: -Math.PI / 2, pitch: 0.1, super: false });
    expect(room.state.balls.size).toBe(1);
    for (let i = 0; i < 60 && room.state.balls.size > 0; i += 1) {
      advance(room, 50);
      room.tickRoom(50);
    }
    const after = getPlayer(room, "s2");
    // Knockback fired (victim moved +x) but stopped at the expanded face —
    // without the resolver it would land at 3.7, strictly inside.
    expect(after?.x ?? 0).toBeGreaterThan(2.5);
    expect(after?.x ?? 99).toBeLessThanOrEqual(3.3 + 1e-6);
  });
});

// Stage 4d.3 central towers: the 4 blocks at +-4.8 double to topY 2.0
// (mirrors client hy 1.0). Balls arcing over at y 1.0-2.0 now impact.
describe("central towers (doubled topY intercepts mid-height shots)", () => {
  it("doubles ONLY the central 4 obstacle tops (outer untouched)", () => {
    expect(SERVER_OBSTACLES).toHaveLength(8);
    const central = SERVER_OBSTACLES.filter((b) => Math.abs(b.x) === 4.8 && Math.abs(b.z) === 4.8);
    expect(central).toHaveLength(4);
    for (const block of central) {
      expect(block.topY).toBe(2.0);
      expect(block.hx).toBe(1);
      expect(block.hz).toBe(1);
    }
    const outer = SERVER_OBSTACLES.filter((b) => !(Math.abs(b.x) === 4.8 && Math.abs(b.z) === 4.8));
    expect(outer).toHaveLength(4);
    for (const block of outer) {
      expect(block.topY).toBe(0.8);
    }
    // Positions mirror the client layout exactly (Arena.getObstacleLayout).
    expect(SERVER_OBSTACLES.map((b) => `${b.x},${b.z}`).sort()).toEqual(
      ["4.8,4.8", "-4.8,4.8", "4.8,-4.8", "-4.8,-4.8", "10.8,0", "-10.8,0", "0,10.8", "0,-10.8"].sort(),
    );
  });

  it("a flat full-power shot down the central lane dies on the tower (<=8 ticks)", async () => {
    // Muzzle y is 1.4 (body 1.1 + torso 0.3): above the OLD top 1.0 (used to
    // fly over) but below the NEW top 2.0, so the doubled tower must
    // intercept (y ~= 1.5 at the footprint). Wall/ground impact needs ~16
    // ticks, so death within 8 ticks pins the tower as the killer. Godmode
    // + off-lane parking rule out victim hits; bots are removed.
    const room = await playingRoom();
    removeBots(room);
    room.state.players.forEach((player: PlayerState): void => {
      player.invulnUntil = 1e15;
    });
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
    // yaw PI fires +Z (dir = (-sin, -cos)): straight down the x=4.8 lane
    // through the (4.8, 4.8) tower footprint.
    fireAs(room, "s1", { power01: 1, yaw: Math.PI, pitch: 0.05, super: false });
    expect(room.state.balls.size).toBe(1);
    for (let i = 0; i < 8; i += 1) {
      advance(room, 50);
      room.tickRoom(50);
    }
    expect(room.state.balls.size).toBe(0);
    expect(target.hp).toBe(100);
    expect(shooter.hp).toBe(100);
  });

  it("the same flat shot down the x=0 lane still flies (outer cubes stay low)", async () => {
    // Outer cube at (0, 10.8) tops out at 0.8: the 1.4m flat shot arcs over
    // it (y ~= 1.4 at the footprint, well above 0.8) and stays live through
    // 12 ticks — wall impact needs ~17 ticks, so survival pins the flyover.
    const room = await playingRoom();
    removeBots(room);
    room.state.players.forEach((player: PlayerState): void => {
      player.invulnUntil = 1e15;
    });
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
    fireAs(room, "s1", { power01: 1, yaw: Math.PI, pitch: 0.05, super: false });
    expect(room.state.balls.size).toBe(1);
    for (let i = 0; i < 12; i += 1) {
      advance(room, 50);
      room.tickRoom(50);
    }
    expect(room.state.balls.size).toBe(1);
    expect(target.hp).toBe(100);
    expect(shooter.hp).toBe(100);
  });
});
