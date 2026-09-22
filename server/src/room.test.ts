import { describe, expect, it } from "vitest";
import type { Client } from "colyseus";
import { SchemaSerializer } from "colyseus";
import {
  BALL_HIT_PLAYER_MESSAGE,
  BALL_MUZZLE_OFFSET,
  BALL_TORSO_OFFSET,
  BODY_CENTER_Y,
  CHARGE_MOVE_MULT,
  FULL_DAMAGE,
  HIT_SCORE,
  INVULN_MS,
  KILL_SCORE,
  LOBBY_COUNTDOWN_MS,
  MAX_LIVE_BALLS,
  MAX_PLAYERS,
  PATCH_RATE_MS,
  PLAYER_BODY_RADIUS,
  PLAYER_SPEED,
  RELOAD_MS,
  REMATCH_DELAY_MS,
  RESPAWN_DELAY_MS,
  ROUND_DURATION_MS,
  SERVER_PLATFORMS,
  SIM_TICK_MS,
  SUPER_SPAWN_S,
  SUPPORT_STICK_TOL,
  WEAK_DAMAGE,
} from "./config.js";
import {
  bodyCenterYAt,
  bodyCenterYAtExpanded,
  getSpawnForIndex,
  groundTopAt,
  isOnTrampolinePad,
  muzzleForShot,
  rampHeightAt,
  rampRunForTop,
  resolveThrowerY,
  sanitizeThrowerY,
  trampolineArcY,
} from "./hits.js";
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

  it("cannon kill respawns instantly with full HP, no buff, no reload", async () => {
    const room = await playingRoom();
    const { shooter, target } = isolateDuel(room);
    target.hp = FULL_DAMAGE;
    target.superBuff = true;
    const killfeed: unknown[] = [];
    (room as unknown as { broadcast: (type: string, message?: unknown) => void }).broadcast = (
      type: string,
      message?: unknown,
    ): void => {
      if (type === "killfeed") {
        killfeed.push(message);
      }
    };
    const scoreBefore = shooter.score;
    const fireNow = room.testNow ?? 0;
    // Deterministic spawn cycle: handlePlay/bots consume the cursor, so the
    // victim's respawn slot is whatever the cursor reads now (no other death
    // can consume it in between — bots are removed, the shooter is safe).
    const cursorBefore = (room as unknown as { spawnCursor: number }).spawnCursor;
    fireAs(room, "s1", { power01: 1, yaw: 0, pitch: 0.1, super: false });
    expect(room.state.balls.size).toBe(1);
    // Death is effectively instant (RESPAWN_DELAY_MS 100ms): the killing
    // tick registers killfeed + hit/kill score exactly as before, the dead
    // state stays visible for ~2 ticks (client death burst reads it), then
    // the scheduled respawn lands — no 3s corpse.
    for (let i = 0; i < 60 && killfeed.length === 0; i += 1) {
      advance(room, 50);
      room.tickRoom(50);
    }
    expect(killfeed.length).toBeGreaterThan(0);
    expect(shooter.score).toBe(scoreBefore + HIT_SCORE + KILL_SCORE);
    expect(target.alive).toBe(false);
    advance(room, RESPAWN_DELAY_MS + 50);
    room.tickRoom(50);
    const respawned = getPlayer(room, "s2");
    expect(respawned?.alive).toBe(true);
    expect(respawned?.hp).toBe(100);
    expect(respawned?.superBuff).toBe(false);
    expect(respawned?.reloadUntil).toBe(0);
    // Deterministic spawn cycle, invuln counted from the respawn moment.
    const spawn = getSpawnForIndex(cursorBefore % MAX_PLAYERS);
    expect(respawned?.x).toBeCloseTo(spawn.x, 9);
    expect(respawned?.z).toBeCloseTo(spawn.z, 9);
    const respawnedAt = (respawned?.invulnUntil ?? 0) - INVULN_MS;
    expect(respawnedAt).toBeGreaterThanOrEqual(fireNow);
    expect(respawnedAt).toBeLessThanOrEqual(room.testNow ?? 0);
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

// Elevation awareness (bugs 1/3a/3b + server side of bug 2): the room
// maintains player.y every tick (grounded derivation + trampoline arcs),
// XZ collision is gated by feet height, balls aim at body Y, and the fire
// pitch band reaches the full client aim range.
describe("server elevation (tower tops walkable, ground impenetrable)", () => {
  it("pins the charging slow-down mirror (bug C origin fix)", () => {
    // The client runs CHARGE_MOVE_MULT while charging (SceneManager); the
    // server must simulate the same factor or charge+walk diverges ~2.25m/s.
    expect(CHARGE_MOVE_MULT).toBe(0.5);
  });

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

  function godmode(room: ArenaRoom): void {
    room.state.players.forEach((player: PlayerState): void => {
      player.invulnUntil = 1e15;
    });
  }

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

  it("AC1: ground approaches from all 8 directions never enter the tower", async () => {
    const room = await playingRoom();
    godmode(room);
    const solids = [...SERVER_OBSTACLES, ...SERVER_PLATFORMS];
    const starts: ReadonlyArray<readonly [number, number, number, number]> = [
      [1.0, 4.8, 1, 0],
      [8.6, 4.8, -1, 0],
      [4.8, 1.0, 0, 1],
      [4.8, 8.6, 0, -1],
      [2.0, 2.0, 1, 1],
      [7.6, 2.0, -1, 1],
      [2.0, 7.6, 1, -1],
      [7.6, 7.6, -1, -1],
    ];
    for (const [sx, sz, mx, mz] of starts) {
      const player = getPlayer(room, "s1");
      if (player === undefined) {
        throw new Error("missing s1");
      }
      player.x = sx;
      player.z = sz;
      player.y = 1.1;
      sendMove(room, "s1", mx, mz);
      for (let i = 0; i < 40; i += 1) {
        tick50(room);
        expectOutsideSolids(room, solids, "s1");
      }
    }
    // And the head-on lane ends pinned at the expanded face (3.3), not inside.
    const after = getPlayer(room, "s1");
    expect(after).toBeDefined();
  });

  it("AC2: a tower-top fighter walks to the CENTER with y held", async () => {
    const room = await playingRoom();
    godmode(room);
    const player = getPlayer(room, "s1");
    if (player === undefined) {
      throw new Error("missing s1");
    }
    // East of the tower at top height, walking west: 8 ticks * 0.225 = 1.8m.
    player.x = 6.5;
    player.z = 4.8;
    player.y = 3.1;
    sendMove(room, "s1", -1, 0);
    for (let i = 0; i < 8; i += 1) {
      tick50(room);
    }
    const after = getPlayer(room, "s1");
    if (after === undefined) {
      throw new Error("missing s1");
    }
    // Past the 6.3 face (no clamp), near the 4.8 center, still on top.
    expect(after.x).toBeLessThan(6.3 - 0.2);
    expect(Math.abs(after.x - 4.8)).toBeLessThan(1.0);
    expect(after.z).toBeCloseTo(4.8, 9);
    expect(after.y).toBeCloseTo(3.1, 9);
  });

  it("AC2 journey: a pad bounce flies OVER the face and lands on top", async () => {
    const room = await playingRoom();
    removeBots(room);
    const player = getPlayer(room, "s1");
    if (player === undefined) {
      throw new Error("missing s1");
    }
    player.x = 0;
    player.z = 4.2;
    player.y = 1.1;
    player.invulnUntil = 1e15;
    // Toward the (4.8, 4.8) tower center (unit-ish dir, normalized by input).
    sendMove(room, "s1", 4.8 / 4.837, 0.6 / 4.837);
    // ~0.7s in: near the west face (x > 3.0) but ABOVE it (arc y > 3.5,
    // feet clear the 2.0 top — the flight crosses, it does not go around).
    for (let i = 0; i < 14; i += 1) {
      tick50(room);
    }
    const mid = getPlayer(room, "s1");
    if (mid === undefined) {
      throw new Error("missing s1");
    }
    expect(mid.x).toBeGreaterThan(3.0);
    expect(mid.y).toBeGreaterThan(3.5);
    // ~1.2s in: landed on top, inside the footprint, y snapped to support.
    for (let i = 0; i < 11; i += 1) {
      tick50(room);
    }
    const landed = getPlayer(room, "s1");
    if (landed === undefined) {
      throw new Error("missing s1");
    }
    expect(landed.y).toBeCloseTo(3.1, 2);
    expect(Math.abs(landed.x - 4.8)).toBeLessThan(1.5 - 1e-6);
    expect(Math.abs(landed.z - 4.8)).toBeLessThan(1.5 - 1e-6);
    expect(landed.x).toBeGreaterThan(3.3);
  });

  it("AC-B journey cont.: halt stays on top, walk-off sticks then falls", async () => {
    const room = await playingRoom();
    removeBots(room);
    const player = getPlayer(room, "s1");
    if (player === undefined) {
      throw new Error("missing s1");
    }
    player.x = 0;
    player.z = 4.2;
    player.y = 1.1;
    player.invulnUntil = 1e15;
    sendMove(room, "s1", 4.8 / 4.837, 0.6 / 4.837);
    for (let i = 0; i < 25; i += 1) {
      tick50(room);
    }
    const landed = getPlayer(room, "s1");
    if (landed === undefined) {
      throw new Error("missing s1");
    }
    expect(landed.y).toBeCloseTo(3.1, 2);
    // Halt: XZ and y freeze on top (no drift, no snap-down).
    const holdX = landed.x;
    const holdZ = landed.z;
    sendMove(room, "s1", 0, 0);
    for (let i = 0; i < 3; i += 1) {
      tick50(room);
    }
    const held = getPlayer(room, "s1");
    if (held === undefined) {
      throw new Error("missing s1");
    }
    expect(held.x).toBeCloseTo(holdX, 9);
    expect(held.z).toBeCloseTo(holdZ, 9);
    expect(held.y).toBeCloseTo(3.1, 9);
    // Walk east off the top: y sticks at 3.1 through the 0.5m ring...
    sendMove(room, "s1", 1, 0);
    for (let i = 0; i < 3; i += 1) {
      tick50(room);
    }
    const edge = getPlayer(room, "s1");
    if (edge === undefined) {
      throw new Error("missing s1");
    }
    expect(edge.x).toBeCloseTo(holdX + 0.675, 1);
    expect(edge.x).toBeLessThan(4.8 + 1.5);
    expect(edge.y).toBeCloseTo(3.1, 2);
    // ...then falls only once fully outside the expanded footprint.
    for (let i = 0; i < 3; i += 1) {
      tick50(room);
    }
    const off = getPlayer(room, "s1");
    if (off === undefined) {
      throw new Error("missing s1");
    }
    expect(off.x).toBeGreaterThan(4.8 + 1.5);
    expect(off.y).toBeCloseTo(1.1, 2);
  });

  it("AC-B control: ground beside the tower never snaps up", async () => {
    const room = await playingRoom();
    godmode(room);
    const solids = [...SERVER_OBSTACLES, ...SERVER_PLATFORMS];
    const player = getPlayer(room, "s1");
    if (player === undefined) {
      throw new Error("missing s1");
    }
    // East of the tower, outside the expanded ring, walking into the face.
    player.x = 7.5;
    player.z = 4.8;
    player.y = 1.1;
    sendMove(room, "s1", -1, 0);
    for (let i = 0; i < 20; i += 1) {
      tick50(room);
      expectOutsideSolids(room, solids, "s1");
      expect(getPlayer(room, "s1")?.y ?? 99).toBeCloseTo(1.1, 9);
    }
    // Pinned at the expanded face (6.3), made progress, never lifted.
    expect(getPlayer(room, "s1")?.x ?? 99).toBeLessThanOrEqual(6.3 + 1e-9);
    expect(getPlayer(room, "s1")?.x ?? 0).toBeGreaterThan(5.5);
  });

  it("AC-A: ground walk through the ramp mismatch band is blocked at the face", async () => {
    // Platform 4 (-x ramp, support band z in [12.7, 14.3]): z = 12.4 sits
    // OUTSIDE the support band but INSIDE the old +radius admit band — the
    // exact leak-1 geometry. Ground-level entry must clamp, never teleport.
    const room = await playingRoom();
    godmode(room);
    const solids = [...SERVER_OBSTACLES, ...SERVER_PLATFORMS];
    const player = getPlayer(room, "s1");
    if (player === undefined) {
      throw new Error("missing s1");
    }
    player.x = 2.0;
    player.z = 12.4;
    player.y = 1.1;
    sendMove(room, "s1", 1, 0);
    for (let i = 0; i < 40; i += 1) {
      tick50(room);
      expectOutsideSolids(room, solids, "s1");
      expect(getPlayer(room, "s1")?.y ?? 99).toBeCloseTo(1.1, 9);
    }
    // Pinned at the expanded min-x face (3.5), y never left the ground.
    expect(getPlayer(room, "s1")?.x ?? 99).toBeCloseTo(3.5, 9);
    expect(getPlayer(room, "s1")?.z ?? 99).toBeCloseTo(12.4, 9);
  });

  it("AC-A: lateral walk into the ramp band edge does not teleport y", async () => {
    // Northward walk at x = 2.0 meets the platform-4 ramp band edge
    // (z = 12.7, surface 1.50m there) at ground level: the wedge side must
    // hold XZ (no step-in) so y cannot jump 1.1 -> 2.6 in one tick.
    const room = await playingRoom();
    godmode(room);
    const player = getPlayer(room, "s1");
    if (player === undefined) {
      throw new Error("missing s1");
    }
    player.x = 2.0;
    player.z = 12.0;
    player.y = 1.1;
    sendMove(room, "s1", 0, 1);
    for (let i = 0; i < 20; i += 1) {
      tick50(room);
      expect(getPlayer(room, "s1")?.y ?? 99).toBeCloseTo(1.1, 9);
    }
    expect(getPlayer(room, "s1")?.z ?? 99).toBeLessThan(12.7);
    expect(getPlayer(room, "s1")?.x ?? 99).toBeCloseTo(2.0, 9);
  });

  it("AC-A control: a real ramp climb works end-to-end (no per-tick jumps)", async () => {
    // From the platform-4 ramp foot (-5.0, 13.5) straight up the ramp band:
    // feet track the slope (~0.06m/tick), the open face admits at height,
    // and the walk ends on top — with no teleport on any single tick.
    const room = await playingRoom();
    const { shooter } = isolateDuel(room);
    shooter.x = -5.0;
    shooter.z = 13.5;
    shooter.y = 1.1;
    shooter.invulnUntil = 1e15;
    sendMove(room, shooter.sessionId, 1, 0);
    let prevY = 1.1;
    for (let i = 0; i < 43; i += 1) {
      tick50(room);
      const p = getPlayer(room, shooter.sessionId);
      if (p === undefined) {
        throw new Error("missing shooter");
      }
      expect(Math.abs(p.y - prevY)).toBeLessThan(0.3);
      prevY = p.y;
    }
    const top = getPlayer(room, shooter.sessionId);
    if (top === undefined) {
      throw new Error("missing shooter");
    }
    expect(top.x).toBeCloseTo(4.675, 1);
    expect(top.z).toBeCloseTo(13.5, 9);
    expect(top.y).toBeCloseTo(3.1, 2);
  });

  it("AC3: a ball at tower-top height damages the tower-top victim", async () => {
    const room = await playingRoom();
    const { shooter, target } = isolateDuel(room);
    shooter.x = 4.8;
    shooter.z = 2.0;
    shooter.y = 3.1;
    shooter.reloadUntil = 0;
    target.x = 4.8;
    target.z = 4.8;
    target.y = 3.1;
    target.hp = 100;
    // Level shot +Z at the victim body (muzzle 3.4, ~3.5m flight, drop ~5cm).
    fireAs(room, "s1", { power01: 1, yaw: Math.PI, pitch: 0, super: false, throwerY: 3.1 });
    expect(room.state.balls.size).toBe(1);
    for (let i = 0; i < 20 && room.state.balls.size > 0; i += 1) {
      advance(room, 50);
      room.tickRoom(50);
    }
    expect(room.state.balls.size).toBe(0);
    expect(target.hp).toBe(75);
  });

  it("AC3 control: a sub-top ball into the wall despawns, victim unharmed", async () => {
    const room = await playingRoom();
    const { shooter, target } = isolateDuel(room);
    shooter.x = 1.0;
    shooter.z = 4.8;
    shooter.y = 1.1;
    shooter.reloadUntil = 0;
    target.x = 4.8;
    target.z = 4.8;
    target.y = 3.1;
    target.hp = 100;
    // Flat ground shot +X into the tower wall (muzzle 1.4 < top 2.0).
    fireAs(room, "s1", { power01: 1, yaw: -Math.PI / 2, pitch: 0, super: false, throwerY: 1.1 });
    expect(room.state.balls.size).toBe(1);
    for (let i = 0; i < 20 && room.state.balls.size > 0; i += 1) {
      advance(room, 50);
      room.tickRoom(50);
    }
    expect(room.state.balls.size).toBe(0);
    expect(target.hp).toBe(100);
    expect(shooter.hp).toBe(100);
  });

  it("server keeps steep down-aim unflattened (bug 2, server side)", async () => {
    const room = await playingRoom();
    const { shooter } = isolateDuel(room);
    shooter.reloadUntil = 0;
    fireAs(room, "s1", { power01: 1, yaw: 0, pitch: -0.4, super: false });
    expect(room.state.balls.size).toBe(1);
    let vy = 0;
    room.state.balls.forEach((ball): void => {
      vy = ball.vy;
    });
    // Full-power down-aim: sin(-0.4) * 20 = -7.79. The old [-0.15, 0.9]
    // clamp flattened this to sin(-0.15) * 20 = -2.99 (flatter than preview).
    expect(vy).toBeCloseTo(Math.sin(-0.4) * 20, 6);
    expect(vy).toBeLessThan(-5);
  });

  it("groundTopAt reads obstacle tops and ramp slopes", () => {
    expect(groundTopAt(4.8, 4.8)).toBeCloseTo(2.0, 10);
    expect(groundTopAt(10.8, 0)).toBeCloseTo(0.8, 10);
    expect(groundTopAt(0, 0)).toBe(0);
    // Platform 0 (+z ramp, edge z = -7.3, run = topY / tan14).
    const platform = SERVER_PLATFORMS[0];
    if (platform === undefined) {
      throw new Error("no server platform defined");
    }
    const run = rampRunForTop(platform.topY);
    expect(run).toBeGreaterThan(9);
    expect(run).toBeLessThan(12);
    expect(rampHeightAt(platform, platform.x, -7.3)).toBeCloseTo(platform.topY, 6);
    expect(rampHeightAt(platform, platform.x, -7.3 + run / 2)).toBeCloseTo(platform.topY / 2, 6);
    expect(rampHeightAt(platform, platform.x, -7.3 + run + 1)).toBe(0);
    expect(rampHeightAt(platform, platform.x + 99, -4)).toBe(0);
    expect(groundTopAt(platform.x, -7.3 + run / 2)).toBeCloseTo(platform.topY / 2, 6);
  });

  it("trampolineArcY launches at 1.1, apexes ~4.16, lands ~1.75s", () => {
    expect(trampolineArcY(0)).toBeCloseTo(1.1, 10);
    expect(trampolineArcY(-1)).toBeCloseTo(1.1, 10);
    expect(trampolineArcY(Number.NaN)).toBeCloseTo(1.1, 10);
    expect(trampolineArcY(0.6)).toBeGreaterThan(4.1);
    expect(trampolineArcY(0.6)).toBeLessThan(4.25);
    expect(trampolineArcY(1.17)).toBeCloseTo(3.1, 1);
    // Full ground-to-ground flight: still ~2.0 up at 1.5s, back down ~1.11
    // at 1.75s (touchdown), below ground level by 1.9s. The old "~1.2s"
    // comments confused the tower-top landing time with the full arc.
    expect(trampolineArcY(1.5)).toBeCloseTo(2.02, 1);
    expect(trampolineArcY(1.75)).toBeCloseTo(1.11, 1);
    expect(trampolineArcY(1.9)).toBeLessThan(1.1);
  });

  it("isOnTrampolinePad matches the two client pads", () => {
    expect(isOnTrampolinePad(0, 4.2)).toBe(true);
    expect(isOnTrampolinePad(0, -4.2)).toBe(true);
    expect(isOnTrampolinePad(1.0, 4.2)).toBe(true);
    expect(isOnTrampolinePad(5, 5)).toBe(false);
    expect(isOnTrampolinePad(Number.NaN, 0)).toBe(false);
  });

  it("bodyCenterYAtExpanded matches strict inside, ring, and open ground", () => {
    expect(bodyCenterYAtExpanded(4.8, 4.8, 0.5)).toBeCloseTo(3.1, 10);
    // 0.5m ring around the tower (expanded footprint, strict body box out).
    expect(bodyCenterYAtExpanded(6.0, 4.8, 0.5)).toBeCloseTo(3.1, 10);
    expect(bodyCenterYAtExpanded(7.5, 4.8, 0.5)).toBeCloseTo(1.1, 10);
    expect(bodyCenterYAtExpanded(0, 0, 0.5)).toBeCloseTo(1.1, 10);
  });
});

// Bug round 3 (blood only on player damage): the room broadcasts
// BALL_HIT_PLAYER_MESSAGE exactly on the findBallVictim damage path —
// environmental deaths (tower/block, ground/boundary, overflow) stay silent.
describe("ball-hit-player broadcast (blood only on player damage)", () => {
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

  it("pins the mirrored message name", () => {
    // Client BALL_HIT_PLAYER_MESSAGE must carry the same wire string.
    expect(BALL_HIT_PLAYER_MESSAGE).toBe("ball-hit-player");
  });

  it("broadcasts ids + impact position when a ball damages a player", async () => {
    const room = await playingRoom();
    const { target } = isolateDuel(room);
    const captured = captureBroadcasts(room);
    fireAs(room, "s1", { power01: 1, yaw: 0, pitch: 0.1, super: false });
    expect(room.state.balls.size).toBe(1);
    for (let i = 0; i < 60 && target.hp === 100; i += 1) {
      advance(room, 50);
      room.tickRoom(50);
    }
    expect(target.hp).toBe(100 - FULL_DAMAGE);
    const hits = hitMessages(captured);
    expect(hits).toHaveLength(1);
    const body = (typeof hits[0] === "object" && hits[0] !== null ? hits[0] : {}) as Record<string, unknown>;
    const ballId = body["ballId"];
    expect(typeof ballId === "string" && (ballId as string).length > 0).toBe(true);
    expect(body["victimId"]).toBe("s2");
    const hx = body["x"];
    const hy = body["y"];
    const hz = body["z"];
    expect(typeof hx === "number" && Number.isFinite(hx as number)).toBe(true);
    expect(typeof hy === "number" && Number.isFinite(hy as number)).toBe(true);
    expect(typeof hz === "number" && Number.isFinite(hz as number)).toBe(true);
    expect(body["super"]).toBe(false);
    // Impact position is at the victim: isolateDuel parks the target at
    // (0, -3) with body-center y 1.1, and the hit triggers within the 0.9m
    // ball-hit radius of that point.
    expect(Math.hypot((hx as number) - 0, (hz as number) - -3)).toBeLessThanOrEqual(0.91);
    expect(Math.abs((hy as number) - 1.1)).toBeLessThanOrEqual(0.9);
  });

  it("tower/block impact broadcasts nothing", async () => {
    // Same flat lane as the central-tower test: the doubled (4.8, 4.8) tower
    // intercepts, and godmode rules out victim hits — pure block death.
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
    const captured = captureBroadcasts(room);
    fireAs(room, "s1", { power01: 1, yaw: Math.PI, pitch: 0.05, super: false });
    expect(room.state.balls.size).toBe(1);
    for (let i = 0; i < 8; i += 1) {
      advance(room, 50);
      room.tickRoom(50);
    }
    expect(room.state.balls.size).toBe(0);
    expect(hitMessages(captured)).toHaveLength(0);
  });

  it("ground/boundary impact broadcasts nothing", async () => {
    // Open x=0 lane: the flat shot clears the low outer cube and dies on the
    // far boundary — no victim anywhere near the flight line.
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
    const captured = captureBroadcasts(room);
    fireAs(room, "s1", { power01: 1, yaw: Math.PI, pitch: 0.05, super: false });
    expect(room.state.balls.size).toBe(1);
    for (let i = 0; i < 30; i += 1) {
      advance(room, 50);
      room.tickRoom(50);
    }
    expect(room.state.balls.size).toBe(0);
    expect(target.hp).toBe(100);
    expect(shooter.hp).toBe(100);
    expect(hitMessages(captured)).toHaveLength(0);
  });
});

// Bug round 4: ramp re-climb (defect 1), lane capture (defect 2), and the
// recoil walk-back. Defect-1 guarantee, verified by probes and locked here:
// no invisible-wall trap anywhere on the walk-around -> ramp-foot -> climb ->
// center path for any of the 4 platforms (direct grounded return through a
// face stays blocked by design — these paths steer around to the foot).
describe("bug round 4: ramp-foot re-entry, lane capture, recoil walk-back", () => {
  function sendDrive(room: ArenaRoom, sessionId: string, x: number, y: number): void {
    (room as unknown as { handleInput(sessionId: string, payload: unknown): void }).handleInput(sessionId, {
      x,
      y,
      rotY: 0,
      seq: 1,
      charging: false,
    });
  }

  function tickDrive(room: ArenaRoom): void {
    room.testNow = (room.testNow ?? 0) + 50;
    room.tickRoom(50);
  }

  function parkDuel(room: ArenaRoom): { s1: PlayerState; s2: PlayerState } {
    removeBots(room);
    const s1 = getPlayer(room, "s1");
    const s2 = getPlayer(room, "s2");
    if (s1 === undefined || s2 === undefined) {
      throw new Error("duel room missing fighters");
    }
    s2.x = -14;
    s2.z = 14;
    s1.invulnUntil = 1e15;
    s2.invulnUntil = 1e15;
    s1.reloadUntil = 0;
    s1.superBuff = false;
    return { s1, s2 };
  }

  // Drives a waypoint path with per-tick homing; every leg must complete.
  // Returns the largest single-tick y jump (climbs must read smoothly).
  function drivePath(
    room: ArenaRoom,
    sessionId: string,
    waypoints: ReadonlyArray<readonly [number, number]>,
  ): number {
    const player = getPlayer(room, sessionId);
    if (player === undefined) {
      throw new Error("missing fighter");
    }
    let maxJump = 0;
    let prevY = player.y;
    for (const [wx, wz] of waypoints) {
      for (let i = 0; i < 500; i += 1) {
        const left = Math.hypot(wx - player.x, wz - player.z);
        if (left < 0.3) {
          break;
        }
        const dx = wx - player.x;
        const dz = wz - player.z;
        const d = Math.hypot(dx, dz);
        sendDrive(room, sessionId, dx / d, dz / d);
        tickDrive(room);
        maxJump = Math.max(maxJump, Math.abs(player.y - prevY));
        prevY = player.y;
      }
      expect(Math.hypot(wx - player.x, wz - player.z)).toBeLessThan(0.35);
    }
    return maxJump;
  }

  it("P0 (+z ramp): walk-around, foot climb, platform center", async () => {
    const room = await playingRoom();
    const { s1 } = parkDuel(room);
    s1.x = 13.8;
    s1.z = -11.2;
    s1.y = BODY_CENTER_Y;
    const maxJump = drivePath(room, "s1", [
      [16.6, -11.2],
      [16.6, 4.3],
      [13.8, 4.3],
      [13.8, -8.5],
    ]);
    expect(maxJump).toBeLessThan(0.3);
    const after = getPlayer(room, "s1");
    expect(Math.hypot((after?.x ?? 99) - 13.8, (after?.z ?? 99) + 8.5)).toBeLessThan(0.6);
    expect(after?.y ?? 0).toBeCloseTo(2.6 + BODY_CENTER_Y, 1);
  });

  it("P1 (-z ramp): walk-around past the outer block, foot climb, center", async () => {
    const room = await playingRoom();
    const { s1 } = parkDuel(room);
    s1.x = -13.5;
    s1.z = 12.6;
    s1.y = BODY_CENTER_Y;
    const maxJump = drivePath(room, "s1", [
      [-8.0, 12.6],
      [-8.0, 1.5],
      [-13.5, 1.5],
      [-13.5, 10.0],
    ]);
    expect(maxJump).toBeLessThan(0.3);
    const after = getPlayer(room, "s1");
    expect(Math.hypot((after?.x ?? 99) + 13.5, (after?.z ?? 99) - 10.0)).toBeLessThan(0.6);
    expect(after?.y ?? 0).toBeCloseTo(1.8 + BODY_CENTER_Y, 1);
  });

  it("P2 (+x ramp): walk-around threading the outer block, foot climb, center", async () => {
    const room = await playingRoom();
    const { s1 } = parkDuel(room);
    s1.x = -14.5;
    s1.z = -9.5;
    s1.y = BODY_CENTER_Y;
    const maxJump = drivePath(room, "s1", [
      [-14.5, -6.4],
      [0, -6.4],
      [0, -8.2],
      [-2.0, -8.2],
      [-2.0, -9.5],
      [-11.5, -9.5],
    ]);
    expect(maxJump).toBeLessThan(0.3);
    const after = getPlayer(room, "s1");
    expect(Math.hypot((after?.x ?? 99) + 11.5, (after?.z ?? 99) + 9.5)).toBeLessThan(0.6);
    expect(after?.y ?? 0).toBeCloseTo(2.2 + BODY_CENTER_Y, 1);
  });

  it("P3 (-x ramp): walk-around south of the outer block, foot climb, center", async () => {
    const room = await playingRoom();
    const { s1 } = parkDuel(room);
    s1.x = 7.6;
    s1.z = 13.5;
    s1.y = BODY_CENTER_Y;
    const maxJump = drivePath(room, "s1", [
      [7.6, 8.2],
      [-5.2, 8.2],
      [-5.2, 13.5],
      [5.0, 13.5],
    ]);
    expect(maxJump).toBeLessThan(0.3);
    const after = getPlayer(room, "s1");
    expect(Math.hypot((after?.x ?? 99) - 5.0, (after?.z ?? 99) - 13.5)).toBeLessThan(0.6);
    expect(after?.y ?? 0).toBeCloseTo(2.0 + BODY_CENTER_Y, 1);
  });

  it("a recoil-shoved off-lane drifter is re-laned at the face, climbs to top", async () => {
    // P0 centerline near the face at slope height. Recoil/knockback shoves
    // preserve y, so a shoved drifter starts the next tick off-band with
    // stale climb height — exactly the state the lane capture admits.
    const room = await playingRoom();
    const { s1 } = parkDuel(room);
    s1.x = 14.5;
    s1.z = -6.6;
    s1.y = 3.48;
    // Shove 1: fire WEST (full) -> recoil EAST 0.8m, off the band, y kept.
    fireAs(room, "s1", { power01: 1, yaw: Math.PI / 2, pitch: 0.1, super: false, throwerY: 3.48 });
    expect(s1.x).toBeCloseTo(15.3, 2);
    expect(s1.z).toBeCloseTo(-6.6, 9);
    expect(s1.y).toBeCloseTo(3.48, 9);
    // Shove 2: fire SOUTH (weak) -> recoil NORTH 0.4m toward the face. The
    // off-corridor crossing is re-laned (x -> 14.8) instead of clamped.
    s1.reloadUntil = 0;
    fireAs(room, "s1", { power01: 0.5, yaw: Math.PI, pitch: 0.1, super: false, throwerY: 3.48 });
    expect(s1.x).toBeCloseTo(14.8, 1);
    expect(s1.z).toBeCloseTo(-7.0, 1);
    // Home to the platform center from the lane edge: no clamp, no drop.
    const maxJump = drivePath(room, "s1", [[13.8, -8.5]]);
    expect(maxJump).toBeLessThan(0.3);
    const after = getPlayer(room, "s1");
    expect(Math.hypot((after?.x ?? 99) - 13.8, (after?.z ?? 99) + 8.5)).toBeLessThan(0.6);
    expect(after?.y ?? 0).toBeCloseTo(2.6 + BODY_CENTER_Y, 1);
  });

  it("recoil off the sheer edge grounds the fighter, foot walk-back reaches the top", async () => {
    // Defect-1 scenario: firing shoves the top fighter off the sheer east
    // edge; they land grounded beside the platform, then re-climb via the
    // ramp foot like a player would.
    const room = await playingRoom();
    const { s1 } = parkDuel(room);
    s1.x = 15.0;
    s1.z = -8.5;
    s1.y = 2.6 + BODY_CENTER_Y;
    // Fire WEST (full) -> recoil EAST 0.8m off the edge (y preserved).
    fireAs(room, "s1", { power01: 1, yaw: Math.PI / 2, pitch: 0.1, super: false, throwerY: 3.7 });
    expect(s1.x).toBeCloseTo(15.8, 2);
    expect(s1.y).toBeCloseTo(3.7, 9);
    // Next tick the support drops them to the ground beside the platform.
    sendDrive(room, "s1", 0, 0);
    tickDrive(room);
    expect(s1.y).toBeCloseTo(BODY_CENTER_Y, 9);
    // Walk back: clear the corner, north past the foot, climb the centerline.
    const maxJump = drivePath(room, "s1", [
      [16.6, -8.5],
      [16.6, 4.3],
      [13.8, 4.3],
      [13.8, -8.5],
    ]);
    expect(maxJump).toBeLessThan(0.3);
    const after = getPlayer(room, "s1");
    expect(Math.hypot((after?.x ?? 99) - 13.8, (after?.z ?? 99) + 8.5)).toBeLessThan(0.6);
    expect(after?.y ?? 0).toBeCloseTo(2.6 + BODY_CENTER_Y, 1);
  });
});

// Bug round 5, defect 1: invisible wall at the platform edge while STILL ON
// TOP. The elevation gate used to skip only solids within COLLISION_Y_EPS
// below the feet, while groundSupport still holds the radius-expanded top
// through the 0.5m ring for feet up to SUPPORT_STICK_TOL below the top.
// Ring moves in that TOL window OFF the ramp corridor hit the inside eject /
// face clamp pre-fix: platform walk-backs stalled at the boundary while
// tower walk-backs ejected (~hx + radius laterally) to the corner — the
// invisible wall exactly at the footprint boundary, only in the ring state.
// The gate now matches the stick band, so on-top movement is fully free
// everywhere including the ring: edge walk-back to the center always works,
// while ground entry through any face stays blocked (pinned by the
// airtightness fuzz + AC1/AC-B control tests, unchanged).
describe("bug round 5: on-top ring walk-back to the center", () => {
  function sendDrive(room: ArenaRoom, sessionId: string, x: number, y: number): void {
    (room as unknown as { handleInput(sessionId: string, payload: unknown): void }).handleInput(sessionId, {
      x,
      y,
      rotY: 0,
      seq: 1,
      charging: false,
    });
  }

  function tickDrive(room: ArenaRoom): void {
    room.testNow = (room.testNow ?? 0) + 50;
    room.tickRoom(50);
  }

  function parkDuel(room: ArenaRoom): { s1: PlayerState; s2: PlayerState } {
    removeBots(room);
    const s1 = getPlayer(room, "s1");
    const s2 = getPlayer(room, "s2");
    if (s1 === undefined || s2 === undefined) {
      throw new Error("duel room missing fighters");
    }
    s2.x = -14;
    s2.z = 14;
    s1.invulnUntil = 1e15;
    s2.invulnUntil = 1e15;
    s1.reloadUntil = 0;
    s1.superBuff = false;
    return { s1, s2 };
  }

  // One full walk-step per 50ms tick (uncharged).
  const STEP = (PLAYER_SPEED * SIM_TICK_MS) / 1000;

  interface RingCase {
    name: string;
    centerX: number;
    centerZ: number;
    topY: number;
    ringX: number;
    ringZ: number;
  }

  // Ring spots OFF the ramp corridor (|lateral| = half + 0.25, inside the
  // expanded band): the state where pre-fix the eject / face clamp fires.
  // Centerline starts are deliberately NOT used — in-lane ring moves were
  // already free pre-fix via inClimbLane, so they cannot discriminate the
  // gate fix. Both platform sides are covered (sheer side opposite the ramp
  // AND the ramp side, each off-corridor) plus the 4 central towers (sheer
  // on all sides). All starts sit 0.25m outside the strict footprint and
  // inside the 0.5m expanded ring on both axes.
  function ringCases(): RingCase[] {
    const cases: RingCase[] = [];
    SERVER_PLATFORMS.forEach((platform, index): void => {
      const lateral = platform.rampWidth / 2 + 0.25;
      const ringGap = 0.25;
      if (platform.rampSide === "+z" || platform.rampSide === "-z") {
        // corridorAxis "x": the lateral runs on x around platform.x.
        const sign = platform.rampSide === "+z" ? 1 : -1;
        for (const side of [-1, 1] as const) {
          cases.push({
            name: `P${index}${side > 0 ? "r" : "s"}`,
            centerX: platform.x,
            centerZ: platform.z,
            topY: platform.topY,
            ringX: platform.x + lateral,
            ringZ: platform.z + sign * side * (platform.hz + ringGap),
          });
        }
      } else {
        // corridorAxis "z": the lateral runs on z around platform.z.
        const sign = platform.rampSide === "+x" ? 1 : -1;
        for (const side of [-1, 1] as const) {
          cases.push({
            name: `P${index}${side > 0 ? "r" : "s"}`,
            centerX: platform.x,
            centerZ: platform.z,
            topY: platform.topY,
            ringX: platform.x + sign * side * (platform.hx + ringGap),
            ringZ: platform.z + lateral,
          });
        }
      }
    });
    SERVER_OBSTACLES.filter((block) => Math.abs(block.x) === 4.8 && Math.abs(block.z) === 4.8).forEach(
      (tower, index): void => {
        cases.push({
          name: `T${index}`,
          centerX: tower.x,
          centerZ: tower.z,
          topY: tower.topY,
          ringX: tower.x - tower.hx - 0.25,
          ringZ: tower.z,
        });
      },
    );
    return cases;
  }

  function driveHome(room: ArenaRoom, sessionId: string, centerX: number, centerZ: number): void {
    const current = getPlayer(room, sessionId);
    if (current === undefined) {
      throw new Error("missing fighter");
    }
    const dx = centerX - current.x;
    const dz = centerZ - current.z;
    const length = Math.hypot(dx, dz);
    sendDrive(room, sessionId, dx / length, dz / length);
  }

  it("off-corridor ring walk-back advances a full step with y held", async () => {
    expect(SUPPORT_STICK_TOL).toBe(0.05);
    expect(STEP).toBeCloseTo(0.225, 9);
    expect(ringCases()).toHaveLength(12);
    for (const ring of ringCases()) {
      // Feet at the top and 20mm below it: both still supported per
      // hysteresis with margin (the exact band edge top-0.05 is left out —
      // the stick equality there is float-dust sensitive by design, while
      // the gate carries COLLISION_Y_EPS slack; pipeline feet never sit
      // exactly on it).
      for (const feetBelow of [0, 0.02]) {
        const room = await playingRoom();
        const { s1 } = parkDuel(room);
        s1.x = ring.ringX;
        s1.z = ring.ringZ;
        s1.y = ring.topY - feetBelow + BODY_CENTER_Y;
        // Snapshot scalars: s1 is a live reference mutated by the tick.
        const startX = s1.x;
        const startZ = s1.z;
        const before = Math.hypot(startX - ring.centerX, startZ - ring.centerZ);
        driveHome(room, "s1", ring.centerX, ring.centerZ);
        tickDrive(room);
        const after = getPlayer(room, "s1");
        if (after === undefined) {
          throw new Error("missing s1");
        }
        const moved = Math.hypot(after.x - startX, after.z - startZ);
        const now = Math.hypot(after.x - ring.centerX, after.z - ring.centerZ);
        // Full-step progress toward the center (pre-fix: stalled by the
        // clamp or pushed away by the eject) with no teleport jump (pre-fix
        // tower Z-eject leapt ~hx + radius to the corner).
        expect(moved).toBeLessThanOrEqual(STEP + 0.05);
        expect(before - now).toBeGreaterThan(STEP - 0.075);
        expect(after.y).toBeCloseTo(ring.topY + BODY_CENTER_Y, 1);
      }
    }
  });

  it("off-corridor ring walk-back reaches the center on all platforms + towers", async () => {
    for (const ring of ringCases()) {
      const room = await playingRoom();
      const { s1 } = parkDuel(room);
      s1.x = ring.ringX;
      s1.z = ring.ringZ;
      s1.y = ring.topY - 0.02 + BODY_CENTER_Y;
      for (let i = 0; i < 120; i += 1) {
        const current = getPlayer(room, "s1");
        if (current === undefined) {
          throw new Error("missing s1");
        }
        const dist = Math.hypot(current.x - ring.centerX, current.z - ring.centerZ);
        if (dist < 0.35) {
          break;
        }
        // Snapshot scalars: getPlayer returns the live mutated reference.
        const prevX = current.x;
        const prevZ = current.z;
        driveHome(room, "s1", ring.centerX, ring.centerZ);
        tickDrive(room);
        const next = getPlayer(room, "s1");
        if (next === undefined) {
          throw new Error("missing s1");
        }
        // Every tick is one clean step home: no eject jump, no clamp stall.
        expect(Math.hypot(next.x - prevX, next.z - prevZ)).toBeLessThanOrEqual(STEP + 0.05);
        expect(dist - Math.hypot(next.x - ring.centerX, next.z - ring.centerZ)).toBeGreaterThan(
          STEP - 0.075,
        );
      }
      const after = getPlayer(room, "s1");
      expect(Math.hypot((after?.x ?? 99) - ring.centerX, (after?.z ?? 99) - ring.centerZ)).toBeLessThan(0.35);
      expect(after?.y ?? 0).toBeCloseTo(ring.topY + BODY_CENTER_Y, 1);
    }
  });
});

// Bug round 6, BUG 1: walking up a ramp near its lateral edge, then continuing
// forward/diagonally, must step onto the block top — no support drop, no
// eject, no invisible wall. Pre-fix the diagonal step leaves the strict ramp
// band + corridor laterally while the feet are still ~top - slope*outward
// (inside the expanded footprint but off-band): groundSupport drops the feet
// to 0 and the next tick ejects the fighter to the expanded corner, where
// every inward attempt re-ejects (permanent stall at the corner).
// Each platform drives S (ramp foot, edge lateral) -> A (near top, edge) ->
// B (diagonal across the band edge toward the top) -> C (center). The S->A
// climb is in-lane and works pre-fix; the A->B transition is the live owner
// repro and fails pre-fix (support drop > 0.3 + stall, never reaches B/C).
describe("bug round 6 BUG1: ramp-edge climb steps onto the top, all platforms", () => {
  function sendDrive(room: ArenaRoom, sessionId: string, x: number, y: number): void {
    (room as unknown as { handleInput(sessionId: string, payload: unknown): void }).handleInput(sessionId, {
      x,
      y,
      rotY: 0,
      seq: 1,
      charging: false,
    });
  }

  function tickDrive(room: ArenaRoom): void {
    room.testNow = (room.testNow ?? 0) + 50;
    room.tickRoom(50);
  }

  function parkDuel(room: ArenaRoom): { s1: PlayerState; s2: PlayerState } {
    removeBots(room);
    const s1 = getPlayer(room, "s1");
    const s2 = getPlayer(room, "s2");
    if (s1 === undefined || s2 === undefined) {
      throw new Error("duel room missing fighters");
    }
    s2.x = -14;
    s2.z = 14;
    s1.invulnUntil = 1e15;
    s2.invulnUntil = 1e15;
    s1.reloadUntil = 0;
    s1.superBuff = false;
    return { s1, s2 };
  }

  // Drives a waypoint path with per-tick homing; every leg must complete.
  // Returns the largest single-tick y jump (drops/ejects read as jumps).
  // Legs are driven one at a time so a stall names the failing leg.
  function driveLeg(
    room: ArenaRoom,
    sessionId: string,
    label: string,
    wx: number,
    wz: number,
  ): number {
    const player = getPlayer(room, sessionId);
    if (player === undefined) {
      throw new Error("missing fighter");
    }
    let maxJump = 0;
    let prevY = player.y;
    for (let i = 0; i < 500; i += 1) {
      const left = Math.hypot(wx - player.x, wz - player.z);
      if (left < 0.3) {
        break;
      }
      const dx = wx - player.x;
      const dz = wz - player.z;
      const d = Math.hypot(dx, dz);
      sendDrive(room, sessionId, dx / d, dz / d);
      tickDrive(room);
      maxJump = Math.max(maxJump, Math.abs(player.y - prevY));
      prevY = player.y;
    }
    const left = Math.hypot(wx - player.x, wz - player.z);
    if (left >= 0.35) {
      throw new Error(`leg ${label} stalled ${left.toFixed(3)}m from [${wx}, ${wz}] (y=${player.y.toFixed(3)})`);
    }
    return maxJump;
  }

  interface EdgeClimb {
    name: string;
    start: readonly [number, number];
    nearTop: readonly [number, number];
    across: readonly [number, number];
    center: readonly [number, number];
    topY: number;
  }

  // Edge laterals sit inside the strict band (halfW - 0.15..0.25) so the
  // S->A climb is in-lane; the A->B diagonal exits the strict band while the
  // feet are still slope-high at outward ~0.3 (pre-fix drop + eject corner).
  // B laterals sit inside band + body radius but outside the strict band, and
  // inside the expanded footprint (no snap-up path, no teleport).
  function edgeClimbs(): EdgeClimb[] {
    return [
      {
        name: "P0",
        start: [14.65, 2.5],
        nearTop: [14.65, -6.9],
        across: [15.25, -7.35],
        center: [13.8, -8.5],
        topY: 2.6,
      },
      {
        name: "P1",
        start: [-12.85, 2.3],
        nearTop: [-12.85, 8.6],
        across: [-12.3, 9.05],
        center: [-13.5, 10.0],
        topY: 1.8,
      },
      {
        name: "P2",
        start: [-2.0, -8.75],
        nearTop: [-9.7, -8.75],
        across: [-10.15, -8.15],
        center: [-11.5, -9.5],
        topY: 2.2,
      },
      {
        name: "P3",
        start: [-3.3, 14.15],
        nearTop: [3.6, 14.15],
        across: [3.98, 14.7],
        center: [5.0, 13.5],
        topY: 2.0,
      },
    ];
  }

  it("ramp-edge climb + diagonal top transition reaches the center with no drop", async () => {
    for (const climb of edgeClimbs()) {
      const room = await playingRoom();
      const { s1 } = parkDuel(room);
      s1.x = climb.start[0];
      s1.z = climb.start[1];
      s1.y = BODY_CENTER_Y;
      const climbJump = driveLeg(room, "s1", `${climb.name}:S->A`, climb.nearTop[0], climb.nearTop[1]);
      const acrossJump = driveLeg(room, "s1", `${climb.name}:A->B`, climb.across[0], climb.across[1]);
      const homeJump = driveLeg(room, "s1", `${climb.name}:B->C`, climb.center[0], climb.center[1]);
      // Pre-fix the A->B step drops the feet ~2m to the ground (support reads
      // strict) and ejects to the expanded corner: acrossJump >> 0.3 and the
      // B leg stalls at the corner (driveLeg names it).
      const maxJump = Math.max(climbJump, acrossJump, homeJump);
      expect(maxJump).toBeLessThan(0.3);
      const after = getPlayer(room, "s1");
      expect(Math.hypot((after?.x ?? 99) - climb.center[0], (after?.z ?? 99) - climb.center[1])).toBeLessThan(
        0.6,
      );
      expect(after?.y ?? 0).toBeCloseTo(climb.topY + BODY_CENTER_Y, 1);
    }
  });
});

// Bug round 6, BUG 2 (server contract): a fighter that is ON TOP (feet at the
// top) walking from the center out to the edge ring and back must move freely
// on every elevated block. This WALKED excursion (not a teleport) passes on
// the pre-fix server too — it pins the server-clean contract so a future
// regression cannot reintroduce a server-side walk-back wall. The live BUG 2
// wall at platforms was the BUG 1 aftermath (feet dropped to 0 by the
// band exit, then the eject loop blocks every inward step); the tower-top
// live wall needs the client Y-divergence heal (see SelfSync UP-snap).
describe("bug round 6 BUG2: walked on-top edge excursion + return stays free", () => {
  function sendDrive(room: ArenaRoom, sessionId: string, x: number, y: number): void {
    (room as unknown as { handleInput(sessionId: string, payload: unknown): void }).handleInput(sessionId, {
      x,
      y,
      rotY: 0,
      seq: 1,
      charging: false,
    });
  }

  function tickDrive(room: ArenaRoom): void {
    room.testNow = (room.testNow ?? 0) + 50;
    room.tickRoom(50);
  }

  function parkDuel(room: ArenaRoom): { s1: PlayerState; s2: PlayerState } {
    removeBots(room);
    const s1 = getPlayer(room, "s1");
    const s2 = getPlayer(room, "s2");
    if (s1 === undefined || s2 === undefined) {
      throw new Error("duel room missing fighters");
    }
    s2.x = -14;
    s2.z = 14;
    s1.invulnUntil = 1e15;
    s2.invulnUntil = 1e15;
    s1.reloadUntil = 0;
    s1.superBuff = false;
    return { s1, s2 };
  }

  const STEP = (PLAYER_SPEED * SIM_TICK_MS) / 1000;

  interface Excursion {
    name: string;
    centerX: number;
    centerZ: number;
    topY: number;
    edgeX: number;
    edgeZ: number;
  }

  // Edge spots: off-corridor ring (lateral halfW + 0.3, 0.3 outside the strict
  // footprint, inside the expanded ring) for platforms; the west ring for the
  // central towers. Starts are on top (feet = topY), the live steady state.
  function excursions(): Excursion[] {
    const out: Excursion[] = [
      { name: "P0", centerX: 13.8, centerZ: -8.5, topY: 2.6, edgeX: 15.1, edgeZ: -7.0 },
      { name: "P1", centerX: -13.5, centerZ: 10.0, topY: 1.8, edgeX: -12.4, edgeZ: 8.7 },
      { name: "P2", centerX: -11.5, centerZ: -9.5, topY: 2.2, edgeX: -10.0, edgeZ: -8.3 },
      { name: "P3", centerX: 5.0, centerZ: 13.5, topY: 2.0, edgeX: 3.7, edgeZ: 14.6 },
    ];
    for (const block of SERVER_OBSTACLES) {
      if (Math.abs(block.x) === 4.8 && Math.abs(block.z) === 4.8) {
        out.push({
          name: `T${block.x > 0 ? "+" : "-"}${block.z > 0 ? "+" : "-"}`,
          centerX: block.x,
          centerZ: block.z,
          topY: block.topY,
          edgeX: block.x - block.hx - 0.3,
          edgeZ: block.z,
        });
      }
    }
    return out;
  }

  it("walks center -> edge ring -> center with y held on all elevated blocks", async () => {
    expect(STEP).toBeCloseTo(0.225, 9);
    for (const trip of excursions()) {
      const room = await playingRoom();
      const { s1 } = parkDuel(room);
      s1.x = trip.centerX;
      s1.z = trip.centerZ;
      s1.y = trip.topY + BODY_CENTER_Y;
      for (const [wx, wz] of [
        [trip.edgeX, trip.edgeZ],
        [trip.centerX, trip.centerZ],
      ] as const) {
        for (let i = 0; i < 120; i += 1) {
          const current = getPlayer(room, "s1");
          if (current === undefined) {
            throw new Error("missing s1");
          }
          const dist = Math.hypot(current.x - wx, current.z - wz);
          if (dist < 0.35) {
            break;
          }
          const prevX = current.x;
          const prevZ = current.z;
          const dx = wx - current.x;
          const dz = wz - current.z;
          const length = Math.hypot(dx, dz);
          sendDrive(room, "s1", dx / length, dz / length);
          tickDrive(room);
          const next = getPlayer(room, "s1");
          if (next === undefined) {
            throw new Error("missing s1");
          }
          // Every tick is one clean step: no eject jump, no clamp stall, no
          // support drop (y must read the top throughout, both legs).
          expect(Math.hypot(next.x - prevX, next.z - prevZ)).toBeLessThanOrEqual(STEP + 0.05);
          expect(dist - Math.hypot(next.x - wx, next.z - wz)).toBeGreaterThan(STEP - 0.075);
          expect(next.y).toBeCloseTo(trip.topY + BODY_CENTER_Y, 1);
        }
        const after = getPlayer(room, "s1");
        expect(Math.hypot((after?.x ?? 99) - wx, (after?.z ?? 99) - wz)).toBeLessThan(0.35);
      }
    }
  });
});
