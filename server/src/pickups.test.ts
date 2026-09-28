import { describe, expect, it } from "vitest";
import type { Client } from "colyseus";
import {
  ARENA_LAYOUT,
  BOT_SPEED,
  CHARGE_DURATION_MS,
  LOBBY_COUNTDOWN_MS,
  PLAYER_SPEED,
  POWERUP_RESPAWN_MS,
  SHIELD_CAPACITY,
  SHIELD_DURATION_MS,
  SIM_TICK_MS,
  SPEED_DURATION_MS,
  SPEED_MULTIPLIER,
  SWAMP_SPEED_MULT,
} from "./config.js";
import type { BotBrain } from "./bots.js";
import { absorbShieldDamage } from "./hits.js";
import { ArenaRoom } from "./rooms/ArenaRoom.js";
import { BallState, PlayerState } from "./state.js";

function fakeClient(sessionId: string): Client {
  return { sessionId, send: (): void => {} } as unknown as Client;
}

async function playingRoom(): Promise<{ room: ArenaRoom; player: PlayerState; other: PlayerState }> {
  const room = new ArenaRoom();
  room.testNow = 0;
  await room.onCreate();
  for (const [id, nick] of [["s1", "Альфа"], ["s2", "Бета"]] as const) {
    const client = fakeClient(id);
    await room.onJoin(client, { nick });
    room.handlePlay(client, { nick });
  }
  room.testNow = 1;
  room.tickRoom();
  room.testNow = LOBBY_COUNTDOWN_MS + 2;
  room.tickRoom();
  const botIds: string[] = [];
  room.state.players.forEach((fighter: PlayerState, id: string) => {
    if (fighter.isBot) botIds.push(id);
  });
  for (const id of botIds) room.state.players.delete(id);
  const player = room.state.players.get("s1");
  const other = room.state.players.get("s2");
  if (player === undefined || other === undefined) throw new Error("missing fighters");
  other.x = -14;
  other.z = 14;
  return { room, player, other };
}

function tick(room: ArenaRoom, ms = SIM_TICK_MS): void {
  room.testNow = (room.testNow ?? 0) + ms;
  room.tickRoom(ms);
}

function setMove(room: ArenaRoom, x: number, z: number, charging = false): void {
  (room as unknown as { handleInput(id: string, input: unknown): void }).handleInput("s1", {
    x, y: z, rotY: 0, seq: 1, charging,
  });
}

describe("neutral server pickups", () => {
  it("replicates three neutral positions, chooses all three equal-range effects, and respawns each point after 30 seconds", async () => {
    expect(POWERUP_RESPAWN_MS).toBe(30_000);
    const { room, player } = await playingRoom();
    expect(room.state.pickups.size).toBe(3);
    const events: Array<{ playerId: string; slotId: number; kind: string; seq: number }> = [];
    (room as unknown as { broadcast(type: string, body?: unknown): void }).broadcast = (type, body): void => {
      if (type === "pickup-granted") events.push(body as (typeof events)[number]);
    };
    const rolls = [1 / 3 - 0.000001, 1 / 3, 2 / 3];
    const kinds = ["shield", "speed", "charge"];
    for (const [index, slot] of ARENA_LAYOUT.pickups.entries()) {
      const marker = room.state.pickups.get(String(index));
      expect(marker).toMatchObject({ x: slot.x, z: slot.z, active: true });
      room.pickupRandom = () => rolls[index]!;
      player.x = slot.x;
      player.z = slot.z;
      tick(room);
      const expected = kinds[index];
      expect(events[index]).toEqual({ playerId: "s1", slotId: index, kind: expected, seq: index + 1 });
      expect(player.pickupKind).toBe(expected);
      if (expected === "charge") {
        expect(player.chargeUntil).toBe((room.testNow ?? 0) + CHARGE_DURATION_MS);
      }
      expect(marker?.active).toBe(false);
      expect(marker?.nextAt).toBe((room.testNow ?? 0) + POWERUP_RESPAWN_MS);
    }
    expect(events).toHaveLength(3);
    player.x = 0;
    player.z = 8;
    tick(room, POWERUP_RESPAWN_MS - 2 * SIM_TICK_MS - 1);
    expect(room.state.pickups.get("0")?.active).toBe(false);
    tick(room, 1);
    expect(room.state.pickups.get("0")?.active).toBe(true);
    expect(room.state.pickups.get("1")?.active).toBe(false);
    tick(room);
    expect(room.state.pickups.get("1")?.active).toBe(true);
    expect(room.state.pickups.get("2")?.active).toBe(false);
    player.x = ARENA_LAYOUT.pickups[0]!.x;
    player.z = ARENA_LAYOUT.pickups[0]!.z;
    room.pickupRandom = () => 2 / 3 - 0.000001;
    tick(room);
    expect(events[3]).toMatchObject({ slotId: 0, kind: "speed", seq: 4 });
  });

  it("keeps fast charge through a canceled or denied shot and spends it on the next accepted fire", async () => {
    const { room, player } = await playingRoom();
    expect(CHARGE_DURATION_MS).toBe(10_000);
    player.x = ARENA_LAYOUT.pickups[0]!.x;
    player.z = ARENA_LAYOUT.pickups[0]!.z;
    room.pickupRandom = () => 0.9;
    tick(room);
    const deadline = player.chargeUntil;
    expect(deadline).toBe((room.testNow ?? 0) + CHARGE_DURATION_MS);
    player.x = 0;
    player.z = 8;
    // Canceling the client-side charge sends no fire message.
    tick(room, 500);
    expect(player.chargeUntil).toBe(deadline);
    const fire = (): void => room.handleFire(player.sessionId, { power01: 1, yaw: 0, pitch: 0.2 });
    player.reloadUntil = (room.testNow ?? 0) + 500;
    fire();
    expect(player.chargeUntil).toBe(deadline);
    expect(room.state.balls.size).toBe(0);
    player.reloadUntil = 0;
    fire();
    expect(room.state.balls.size).toBe(1);
    expect(player.chargeUntil).toBe(0);
    expect(player.reloadUntil).toBeGreaterThan(room.testNow ?? 0);
  });

  it("expires fast charge at its deadline, including a shot before the next simulation tick", async () => {
    const { room, player } = await playingRoom();
    player.x = ARENA_LAYOUT.pickups[0]!.x;
    player.z = ARENA_LAYOUT.pickups[0]!.z;
    room.pickupRandom = () => 0.9;
    tick(room);
    const deadline = player.chargeUntil;
    player.x = 0;
    player.z = 8;
    tick(room, CHARGE_DURATION_MS - 1);
    expect(player.chargeUntil).toBe(deadline);
    // The fire handler checks server time even if a scheduled tick has not run.
    room.testNow = deadline;
    room.handleFire(player.sessionId, { power01: 1, yaw: 0, pitch: 0.2 });
    expect(player.chargeUntil).toBe(0);
    expect(room.state.balls.size).toBe(1);

    player.chargeUntil = (room.testNow ?? 0) + CHARGE_DURATION_MS;
    tick(room, CHARGE_DURATION_MS - 1);
    expect(player.chargeUntil).toBeGreaterThan(room.testNow ?? 0);
    tick(room, 1);
    expect(player.chargeUntil).toBe(0);
  });

  it("spends a bot's fast charge on its next spawned ball", async () => {
    const { room } = await playingRoom();
    const bot = new PlayerState();
    bot.sessionId = "charge-bot";
    bot.isBot = true;
    bot.ready = true;
    bot.spectator = false;
    bot.alive = true;
    bot.x = 0;
    bot.z = 8;
    bot.chargeUntil = (room.testNow ?? 0) + CHARGE_DURATION_MS;
    expect(room.spawnBall(bot, 1, 0, 0.2, false, room.testNow ?? 0)).not.toBe(null);
    expect(bot.chargeUntil).toBe(0);
  });

  it("shield absorbs one heart, passes excess damage to HP, and expires after ten seconds", async () => {
    const { room, player } = await playingRoom();
    player.x = ARENA_LAYOUT.pickups[0]!.x;
    player.z = ARENA_LAYOUT.pickups[0]!.z;
    room.pickupRandom = () => 0;
    tick(room);
    expect(player.shieldHp).toBe(SHIELD_CAPACITY);
    expect(player.shieldUntil).toBe((room.testNow ?? 0) + SHIELD_DURATION_MS);
    expect(absorbShieldDamage(player, 12.5, room.testNow ?? 0)).toEqual({ absorbed: 12.5, healthDamage: 0 });
    expect(absorbShieldDamage(player, 25, room.testNow ?? 0)).toEqual({ absorbed: 12.5, healthDamage: 12.5 });
    expect(player.shieldHp).toBe(0);
    player.x = ARENA_LAYOUT.pickups[1]!.x;
    player.z = ARENA_LAYOUT.pickups[1]!.z;
    tick(room);
    const grantedAt = room.testNow ?? 0;
    player.x = 0;
    player.z = 8;
    tick(room, SHIELD_DURATION_MS - 1);
    expect(player.shieldHp).toBe(SHIELD_CAPACITY);
    expect(player.shieldUntil).toBe(grantedAt + SHIELD_DURATION_MS);
    tick(room, 1);
    expect(player.shieldHp).toBe(0);
    expect(player.shieldUntil).toBe(0);
    // The second grant's time boundary is also checked by the damage helper.
    player.shieldHp = SHIELD_CAPACITY;
    player.shieldUntil = grantedAt + SHIELD_DURATION_MS;
    expect(absorbShieldDamage(player, 25, player.shieldUntil)).toEqual({ absorbed: 0, healthDamage: 25 });
  });

  it("full shielded hits suppress blood, stronger hits spill to HP, and death clears bonuses", async () => {
    const { room, player, other } = await playingRoom();
    const messages: string[] = [];
    (room as unknown as { broadcast(type: string): void }).broadcast = (type): void => { messages.push(type); };
    player.x = 0;
    player.z = 0;
    other.x = 0;
    other.z = -3;
    other.invulnUntil = 0;
    other.shieldHp = SHIELD_CAPACITY;
    other.shieldUntil = (room.testNow ?? 0) + SHIELD_DURATION_MS;
    other.speedUntil = (room.testNow ?? 0) + SPEED_DURATION_MS;
    other.chargeUntil = (room.testNow ?? 0) + CHARGE_DURATION_MS;
    const ball = new BallState();
    ball.ownerId = player.sessionId;
    ball.power01 = 1;
    ball.x = other.x;
    ball.y = other.y;
    ball.z = other.z;
    const hit = (room as unknown as { damageVictim(ball: BallState, victim: PlayerState, id: string, now: number): void }).damageVictim.bind(room);
    hit(ball, other, "ball-1", room.testNow ?? 0);
    expect(other.hp).toBe(100);
    expect(other.shieldHp).toBe(0);
    expect(messages).not.toContain("ball-hit-player");
    other.shieldHp = SHIELD_CAPACITY;
    other.shieldUntil = (room.testNow ?? 0) + SHIELD_DURATION_MS;
    ball.super = true;
    hit(ball, other, "ball-2", room.testNow ?? 0);
    expect(other.hp).toBe(75);
    expect(messages).toContain("ball-hit-player");
    other.hp = 25;
    hit(ball, other, "ball-3", room.testNow ?? 0);
    expect(other.alive).toBe(false);
    expect(other.speedUntil).toBe(0);
    expect(other.chargeUntil).toBe(0);
    expect(other.shieldHp).toBe(0);
    tick(room, 150);
    expect(other.alive).toBe(true);
    expect(other.hp).toBe(100);
    expect(other.speedUntil).toBe(0);
    expect(other.chargeUntil).toBe(0);
  });

  it("clears fast charge on rematch reset and fresh round start", async () => {
    const { room, player } = await playingRoom();
    player.chargeUntil = (room.testNow ?? 0) + CHARGE_DURATION_MS;
    (room as unknown as { resetForRematch(): void }).resetForRematch();
    expect(player.chargeUntil).toBe(0);
    player.chargeUntil = (room.testNow ?? 0) + CHARGE_DURATION_MS;
    (room as unknown as { startPlaying(now: number): void }).startPlaying(room.testNow ?? 0);
    expect(player.chargeUntil).toBe(0);
  });

  it("speed increases both human and bot movement by 25 percent and ends at five seconds", async () => {
    const { room, player } = await playingRoom();
    expect(SPEED_MULTIPLIER).toBe(1.25);
    player.x = 0;
    player.z = 8;
    setMove(room, 1, 0);
    tick(room);
    expect(player.x).toBeCloseTo(PLAYER_SPEED * SIM_TICK_MS / 1000, 6);
    player.x = 0;
    player.z = 8;
    player.speedUntil = (room.testNow ?? 0) + SPEED_DURATION_MS;
    tick(room);
    expect(player.x).toBeCloseTo(PLAYER_SPEED * SPEED_MULTIPLIER * SIM_TICK_MS / 1000, 6);
    player.x = 0;
    player.z = 8;
    player.speedUntil = (room.testNow ?? 0) + SPEED_DURATION_MS;
    setMove(room, 1, 0, true);
    tick(room);
    expect(player.x).toBeCloseTo(PLAYER_SPEED * SPEED_MULTIPLIER * 0.5 * SIM_TICK_MS / 1000, 6);

    const bot = new PlayerState();
    bot.sessionId = "movement-bot";
    bot.isBot = true;
    bot.alive = true;
    bot.ready = true;
    bot.spectator = false;
    bot.x = 0;
    bot.z = 8;
    room.state.players.set(bot.sessionId, bot);
    (room as unknown as { brains: Map<string, BotBrain> }).brains.set(bot.sessionId, {
      targetX: 10, targetZ: 8, retargetAt: (room.testNow ?? 0) + 30000,
      nextFireAt: (room.testNow ?? 0) + 30000, seed: 1,
    });
    const moveBots = (room as unknown as { moveBots(now: number, dt: number): void }).moveBots.bind(room);
    moveBots(room.testNow ?? 0, SIM_TICK_MS / 1000);
    expect(bot.x).toBeCloseTo(BOT_SPEED * SIM_TICK_MS / 1000, 6);
    bot.x = 0;
    bot.speedUntil = (room.testNow ?? 0) + SPEED_DURATION_MS;
    moveBots(room.testNow ?? 0, SIM_TICK_MS / 1000);
    expect(bot.x).toBeCloseTo(BOT_SPEED * SPEED_MULTIPLIER * SIM_TICK_MS / 1000, 6);
    player.x = 0;
    player.z = 8;
    setMove(room, 0, 0);
    tick(room, SPEED_DURATION_MS);
    expect(player.speedUntil).toBe(0);
  });

  it("applies the speed bonus through swamp and ice movement", async () => {
    const { room, player } = await playingRoom();
    const motion = (room as unknown as { planarMotion: Map<string, unknown> }).planarMotion;
    setMove(room, 0, 1);
    player.x = 14.5;
    player.z = 0;
    tick(room);
    expect(player.z).toBeCloseTo(PLAYER_SPEED * SWAMP_SPEED_MULT * SIM_TICK_MS / 1000, 6);
    player.x = 14.5;
    player.z = 0;
    player.speedUntil = (room.testNow ?? 0) + SPEED_DURATION_MS;
    tick(room);
    expect(player.z).toBeCloseTo(PLAYER_SPEED * SPEED_MULTIPLIER * SWAMP_SPEED_MULT * SIM_TICK_MS / 1000, 6);

    const iceRun = (boosted: boolean): number => {
      motion.delete(player.sessionId);
      player.x = 0;
      player.z = 0;
      player.speedUntil = boosted ? (room.testNow ?? 0) + SPEED_DURATION_MS : 0;
      setMove(room, 1, 0);
      for (let i = 0; i < 12; i += 1) tick(room);
      return player.x;
    };
    const ordinaryIceDistance = iceRun(false);
    const boostedIceDistance = iceRun(true);
    expect(boostedIceDistance).toBeGreaterThan(ordinaryIceDistance * 1.1);
  });
});
