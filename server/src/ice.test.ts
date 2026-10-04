import { describe, expect, it } from "vitest";
import type { Client } from "colyseus";
import type { BotBrain } from "./bots.js";
import {
  BOT_SPEED, CHARGE_MOVE_MULT, ICE_INPUT_THRESHOLD, ICE_RADIUS, ICE_SPEED_MULT, ICE_ZONES,
  isOnIce, isOnSwamp, LOBBY_COUNTDOWN_MS, PLAYER_SPEED, SIM_TICK_MS,
  SWAMP_RADIUS, SWAMP_SPEED_MULT, SWAMP_ZONES,
} from "./config.js";
import { ArenaRoom } from "./rooms/ArenaRoom.js";
import { PlayerState } from "./state.js";

const TICK_S = SIM_TICK_MS / 1000;

function fakeClient(sessionId: string): Client {
  return { sessionId, send: (): void => {} } as unknown as Client;
}

async function playingRoom(solo = false): Promise<{ room: ArenaRoom; player: PlayerState }> {
  const room = new ArenaRoom();
  room.testNow = 0;
  await room.onCreate();
  for (const [id, nick] of [["s1", "Alpha"], ["s2", "Beta"]] as const) {
    const client = fakeClient(id);
    await room.onJoin(client, { nick });
    if (!solo || id === "s1") {
      (room as unknown as { handlePlay(client: Client, payload: unknown): void }).handlePlay(client, { nick });
    }
  }
  room.testNow = 1;
  room.tickRoom();
  room.testNow = 1 + LOBBY_COUNTDOWN_MS + 1;
  room.tickRoom();
  const botIds: string[] = [];
  room.state.players.forEach((fighter: PlayerState, id: string): void => {
    if (fighter.isBot) botIds.push(id);
  });
  for (const id of botIds) room.state.players.delete(id);
  const player = room.state.players.get("s1");
  if (player === undefined) throw new Error("missing test player");
  return { room, player };
}

function input(room: ArenaRoom, x: number, z: number, charging = false): void {
  (room as unknown as { handleInput(sessionId: string, payload: unknown): void }).handleInput("s1", {
    x, y: z, rotY: 0, seq: 1, charging,
  });
}

function tick(room: ArenaRoom, count = 1): void {
  for (let i = 0; i < count; i += 1) {
    room.testNow = (room.testNow ?? 0) + SIM_TICK_MS;
    room.tickRoom(SIM_TICK_MS);
  }
}

function addBot(room: ArenaRoom, x: number, z: number): PlayerState {
  const bot = new PlayerState();
  bot.sessionId = "surface-bot";
  bot.isBot = true;
  bot.alive = true;
  bot.ready = true;
  bot.spectator = false;
  bot.x = x;
  bot.z = z;
  bot.y = 1.1;
  room.state.players.set(bot.sessionId, bot);
  (room as unknown as { brains: Map<string, BotBrain> }).brains.set(bot.sessionId, {
    targetX: x + 20, targetZ: z,
    retargetAt: (room.testNow ?? 0) + 30000,
    nextFireAt: (room.testNow ?? 0) + 30000,
    seed: 1,
  });
  return bot;
}

describe("authoritative swamp and ice movement", () => {
  it("uses the saved map's zones and inclusive circle boundaries", () => {
    expect(SWAMP_ZONES.length).toBeGreaterThan(0);
    expect(ICE_ZONES.length).toBeGreaterThan(0);
    expect(SWAMP_RADIUS).toBe(SWAMP_ZONES[0]?.radius);
    expect(ICE_RADIUS).toBe(ICE_ZONES[0]?.radius);
    const cases = [
      { zones: SWAMP_ZONES, contains: isOnSwamp },
      { zones: ICE_ZONES, contains: isOnIce },
    ];
    for (const { zones, contains } of cases) {
      for (const zone of zones) {
        for (const offset of [-0.001, 0, 0.001]) {
          const x = zone.x + zone.radius + offset;
          const expected = zones.some((other) =>
            (x - other.x) ** 2 + (zone.z - other.z) ** 2 <= other.radius ** 2,
          );
          expect(contains(x, zone.z)).toBe(expected);
        }
      }
    }
  });

  it("walks at 22% speed in swamp and cancels momentum on release", async () => {
    const { room, player } = await playingRoom();
    const zone = SWAMP_ZONES[0];
    player.x = zone.x - SWAMP_RADIUS - 0.1;
    player.z = zone.z;
    input(room, 1, 0);
    tick(room); // enter with full ground speed
    expect(isOnSwamp(player.x, player.z)).toBe(true);
    const before = player.x;
    tick(room);
    expect((player.x - before) / TICK_S).toBeCloseTo(PLAYER_SPEED * SWAMP_SPEED_MULT, 5);
    input(room, 0, 0);
    const stopped = player.x;
    tick(room, 4);
    expect(player.x).toBe(stopped);
  });

  it("can leave swamp from rest and retains charging speed scale", async () => {
    const { room, player } = await playingRoom();
    const zone = SWAMP_ZONES[0];
    player.x = zone.x;
    player.z = zone.z;
    // Leave toward the perimeter; the saved map places a ramp just inside
    // this swamp, so moving inward would correctly hit its low side.
    input(room, -1, 0, true);
    tick(room);
    expect((player.x - zone.x) / TICK_S).toBeCloseTo(-PLAYER_SPEED * SWAMP_SPEED_MULT * CHARGE_MOVE_MULT, 5);
    input(room, -1, 0);
    for (let i = 0; i < 90 && isOnSwamp(player.x, player.z); i += 1) tick(room);
    expect(isOnSwamp(player.x, player.z)).toBe(false);
    const before = player.x;
    tick(room);
    expect((player.x - before) / TICK_S).toBeCloseTo(-PLAYER_SPEED, 5);
  });

  it("settles near the much milder 65% ice speed", async () => {
    const { room, player } = await playingRoom();
    const zone = ICE_ZONES[0];
    player.x = zone.x;
    player.z = zone.z;
    input(room, 1, 0);
    for (let i = 0; i < 40; i += 1) {
      tick(room);
      player.x = zone.x; // isolate sustained surface speed from edge exit
    }
    const before = player.x;
    tick(room);
    const speed = (player.x - before) / TICK_S;
    expect(speed).toBeGreaterThan(PLAYER_SPEED * ICE_SPEED_MULT * 0.75);
    expect(speed).toBeLessThan(PLAYER_SPEED * ICE_SPEED_MULT * 1.1);
    expect(speed).toBeGreaterThan(PLAYER_SPEED * SWAMP_SPEED_MULT * 2);
  });

  it("moves farther on ice than in swamp from rest at 0.25s and 0.5s", async () => {
    async function distances(zone: { x: number; z: number }): Promise<[number, number]> {
      const { room, player } = await playingRoom();
      player.x = zone.x;
      player.z = zone.z;
      input(room, 1, 0);
      tick(room, 5);
      const quarter = player.x - zone.x;
      tick(room, 5);
      return [quarter, player.x - zone.x];
    }
    const [iceQuarter, iceHalf] = await distances(ICE_ZONES[0]);
    const [swampQuarter, swampHalf] = await distances(SWAMP_ZONES[0]);
    expect(iceQuarter).toBeGreaterThan(swampQuarter * 1.1);
    expect(iceHalf).toBeGreaterThan(swampHalf * 1.5);
  });

  it("coasts on ice after releasing input", async () => {
    const { room, player } = await playingRoom();
    const zone = ICE_ZONES[0];
    player.x = zone.x - ICE_RADIUS - 0.1;
    player.z = zone.z;
    input(room, 1, 0);
    tick(room); // enter with ordinary-ground momentum
    expect(isOnIce(player.x, player.z)).toBe(true);
    input(room, 0, 0);
    const before = player.x;
    tick(room);
    const firstCoastStep = player.x - before;
    tick(room, 5);
    expect(firstCoastStep).toBeGreaterThan(0.1);
    expect(player.x - before).toBeGreaterThan(firstCoastStep * 2);
    const beforeLast = player.x;
    tick(room);
    expect(player.x - beforeLast).toBeGreaterThan(firstCoastStep * 0.6);
  });

  it("uses coast behavior for tiny raw input, preserving larger analog steering", async () => {
    const zone = ICE_ZONES[0];
    async function coastWithInput(amount: number): Promise<{ endX: number; traveled: number }> {
      const { room, player } = await playingRoom();
      player.x = zone.x - ICE_RADIUS - 0.1;
      player.z = zone.z;
      input(room, 1, 0);
      tick(room); // enter ice with ground momentum
      const start = player.x;
      input(room, amount, 0);
      tick(room, 4);
      return { endX: player.x, traveled: player.x - start };
    }
    expect(ICE_INPUT_THRESHOLD).toBe(0.06);
    const released = await coastWithInput(0);
    const tiny = await coastWithInput(ICE_INPUT_THRESHOLD / 2);
    expect(Math.abs(tiny.endX - released.endX)).toBeLessThan(0.001);
    expect(tiny.traveled).toBeGreaterThan(0.3);

    const { room, player } = await playingRoom();
    player.x = zone.x;
    player.z = zone.z;
    input(room, ICE_INPUT_THRESHOLD * 1.5, 0);
    tick(room, 5);
    expect(player.x - zone.x).toBeGreaterThan(0.03);
  });

  it("can escape ice from rest, then returns to ordinary speed", async () => {
    const { room, player } = await playingRoom();
    const zone = ICE_ZONES[0];
    player.x = zone.x;
    player.z = zone.z;
    input(room, 0, 0);
    tick(room, 5);
    expect(player.x).toBe(zone.x);
    input(room, -1, 0);
    tick(room);
    expect(player.x).toBeLessThan(zone.x);
    for (let i = 0; i < 90 && isOnIce(player.x, player.z); i += 1) tick(room);
    expect(isOnIce(player.x, player.z)).toBe(false);
    const before = player.x;
    tick(room);
    expect((before - player.x) / TICK_S).toBeCloseTo(PLAYER_SPEED, 5);
  });

  it("does not slow an airborne fighter above the floor puddle", async () => {
    const { room, player } = await playingRoom();
    const zone = ICE_ZONES[0];
    player.x = zone.x;
    player.z = zone.z;
    player.y = 1.5;
    (room as unknown as { airSince: Map<string, number> }).airSince.set("s1", room.testNow ?? 0);
    input(room, 1, 0);
    tick(room);
    expect(player.y).toBeGreaterThan(1.1);
    expect(player.x - zone.x).toBeGreaterThan(0);
    expect((player.x - zone.x) / TICK_S).toBeCloseTo(PLAYER_SPEED, 5);
  });

  it("makes bots coast on ice but stop immediately in swamp", async () => {
    const { room } = await playingRoom(true);
    const ice = ICE_ZONES[0];
    const swamp = SWAMP_ZONES[0];
    const bot = addBot(room, ice.x, ice.z);
    const brain = (room as unknown as { brains: Map<string, BotBrain> }).brains.get(bot.sessionId)!;
    for (let i = 0; i < 30; i += 1) {
      tick(room);
      bot.x = ice.x;
    }
    const beforeIce = bot.x;
    tick(room);
    expect((bot.x - beforeIce) / TICK_S).toBeGreaterThan(BOT_SPEED * ICE_SPEED_MULT * 0.7);
    brain.targetX = bot.x;
    brain.targetZ = bot.z;
    const iceRelease = bot.x;
    tick(room);
    expect(bot.x - iceRelease).toBeGreaterThan(0);

    bot.x = swamp.x;
    bot.z = swamp.z;
    brain.targetX = swamp.x + 20;
    brain.targetZ = swamp.z;
    brain.retargetAt = (room.testNow ?? 0) + 30000;
    tick(room);
    expect((bot.x - swamp.x) / TICK_S).toBeCloseTo(BOT_SPEED * SWAMP_SPEED_MULT, 5);
    brain.targetX = bot.x;
    brain.targetZ = bot.z;
    const swampRelease = bot.x;
    tick(room);
    expect(bot.x).toBe(swampRelease);
  });
});
