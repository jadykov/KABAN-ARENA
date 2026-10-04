import { describe, expect, it } from "vitest";
import type { Client } from "colyseus";
import { INVULN_MS, LOBBY_COUNTDOWN_MS, MAX_PLAYERS } from "./config.js";
import { createBrain } from "./bots.js";
import { ArenaRoom } from "./rooms/ArenaRoom.js";
import { BallState, PlayerState, type RoundPhase } from "./state.js";
import type { SuperBonusSystem } from "./super-bonuses.js";

interface RoomRuntime {
  inputs: Map<string, unknown>;
  planarMotion: Map<string, unknown>;
  respawnAt: Map<string, number>;
  brains: Map<string, unknown>;
  airSince: Map<string, number>;
  bonusAir: Map<string, unknown>;
  bonuses: SuperBonusSystem;
  roundEndsAt: number;
  endRound(winner: string): void;
}

const phases: RoundPhase[] = ["lobby", "countdown", "playing", "ended"];
const client = (sessionId: string): Client => ({ sessionId, send: (): void => {} }) as unknown as Client;
const runtime = (room: ArenaRoom): RoomRuntime => room as unknown as RoomRuntime;
const bots = (room: ArenaRoom): PlayerState[] => [...room.state.players.values()].filter((player) => player.isBot);

async function join(room: ArenaRoom, id: string, play = false): Promise<void> {
  await room.onJoin(client(id), { nick: id });
  if (play) room.handlePlay(client(id), { nick: id });
}

async function soloRoom(phase: RoundPhase): Promise<ArenaRoom> {
  const room = new ArenaRoom();
  room.testNow = 0;
  await room.onCreate();
  await join(room, "first", true);
  if (phase !== "lobby") {
    room.testNow = 1;
    room.tickRoom();
  }
  if (phase === "playing" || phase === "ended") {
    room.testNow = LOBBY_COUNTDOWN_MS + 2;
    room.tickRoom();
  }
  if (phase === "ended") runtime(room).endRound("first");
  expect(room.state.phase).toBe(phase);
  expect(bots(room)).toHaveLength(2);
  return room;
}

function addBall(room: ArenaRoom, ownerId: string, id: string, kind = ""): BallState {
  const ball = new BallState();
  Object.assign(ball, { ballId: id, ownerId, bonusKind: kind, x: 0, y: 0.15, z: 8 });
  room.state.balls.set(id, ball);
  if (kind) runtime(room).bonuses.register(ball);
  return ball;
}

function installEffect(room: ArenaRoom, ownerId: string, id: string, kind: string): void {
  const ball = addBall(room, ownerId, id, kind);
  room.state.balls.delete(id);
  runtime(room).bonuses.install(ball, room.testNow!);
  expect(room.state.bonusEffects.has(`${id}:effect`)).toBe(true);
}

describe("bot population follows participating humans", () => {
  it.each(phases)("changes 1 -> 2 -> 1 immediately in %s without resetting the first human or round", async (phase) => {
    const room = await soloRoom(phase);
    const first = room.state.players.get("first")!;
    Object.assign(first, { hp: 63, score: 7, speedUntil: 20000, reloadUntil: 18000, superKind: "ice", superUntil: 21000, superBuff: true });
    runtime(room).inputs.set("first", { x: 1, y: 0, charging: true });
    runtime(room).planarMotion.set("first", { vx: 1, vz: 2 });
    const firstState = first.toJSON();
    const firstInput = runtime(room).inputs.get("first");
    const firstMotion = runtime(room).planarMotion.get("first");
    const roundState = {
      phase: room.state.phase,
      remainingMs: room.state.remainingMs,
      countdownMs: room.state.countdownMs,
      superNextAt: room.state.superNextAt,
      winner: room.state.winner,
      endsAt: runtime(room).roundEndsAt,
    };
    const oldIds = bots(room).map((bot) => bot.sessionId);
    await join(room, "second");
    expect(bots(room)).toHaveLength(2);
    expect(room.watchingCount()).toBe(1);
    room.handlePlay(client("second"), { nick: "second" });
    expect(bots(room)).toHaveLength(0);
    expect(room.readyFighterCount()).toBe(2);
    expect(first.toJSON()).toEqual(firstState);
    await room.onLeave(client("second"));
    expect(bots(room)).toHaveLength(2);
    expect(bots(room).every((bot) => !oldIds.includes(bot.sessionId))).toBe(true);
    expect(first.toJSON()).toEqual(firstState);
    expect(runtime(room).inputs.get("first")).toBe(firstInput);
    expect(runtime(room).planarMotion.get("first")).toBe(firstMotion);
    expect({
      phase: room.state.phase,
      remainingMs: room.state.remainingMs,
      countdownMs: room.state.countdownMs,
      superNextAt: room.state.superNextAt,
      winner: room.state.winner,
      endsAt: runtime(room).roundEndsAt,
    }).toEqual(roundState);
    if (phase === "playing") {
      expect(bots(room).every((bot) => bot.invulnUntil === room.testNow! + INVULN_MS)).toBe(true);
    }
  });

  it.each(phases)("keeps bots suppressed across %s ticks while a second human awaits respawn", async (phase) => {
    const room = await soloRoom(phase);
    await join(room, "second", true);
    const second = room.state.players.get("second")!;
    second.alive = false;
    second.hp = 0;
    runtime(room).respawnAt.set("second", room.testNow! + 200);
    room.handlePlay(client("second"), { nick: "renamed" });
    expect(second.alive).toBe(false);
    expect(second.nick).toBe("second");
    for (let tick = 0; tick < 8; tick += 1) {
      // Suppression also removes a stale bot before its next combat tick.
      const stale = new PlayerState();
      Object.assign(stale, { sessionId: "stale-bot", isBot: true, ready: true, spectator: false, alive: true });
      room.state.players.set(stale.sessionId, stale);
      runtime(room).brains.set(stale.sessionId, createBrain(0, 1));
      addBall(room, stale.sessionId, "stale-ball");
      room.testNow! += 50;
      room.tickRoom(50);
      expect(bots(room)).toHaveLength(0);
      expect(room.state.balls.has("stale-ball")).toBe(false);
      expect(runtime(room).brains.has(stale.sessionId)).toBe(false);
    }
    expect(room.readyFighterCount()).toBe(2);
    if (phase === "playing") expect(second.alive).toBe(true);
  });

  it("does not count a dead solo fighter as absent and restores bots when the other fighter leaves", async () => {
    const room = await soloRoom("playing");
    await join(room, "second", true);
    const first = room.state.players.get("first")!;
    first.alive = false;
    first.hp = 0;
    runtime(room).respawnAt.set("first", room.testNow! + 200);
    await room.onLeave(client("second"));
    expect(bots(room)).toHaveLength(2);
    expect(first.alive).toBe(false);
    room.testNow! += 200;
    room.tickRoom();
    expect(first.alive).toBe(true);
    expect(bots(room)).toHaveLength(2);
    expect(room.state.phase).toBe("playing");
  });

  it("admits spectators within the total cap and restores available solo bot slots after they leave", async () => {
    const room = await soloRoom("playing");
    for (let index = 1; index < MAX_PLAYERS; index += 1) {
      await join(room, `watcher-${index}`);
      expect(room.state.players.size).toBeLessThanOrEqual(MAX_PLAYERS);
      expect(bots(room)).toHaveLength(Math.min(2, MAX_PLAYERS - index - 1));
    }
    expect(room.watchingCount()).toBe(5);
    const messages: string[] = [];
    const extra = { sessionId: "extra", send: (type: string): void => { messages.push(type); } } as unknown as Client;
    await room.onJoin(extra);
    expect(messages).toContain("room-full");
    expect(room.state.players.has("extra")).toBe(false);
    await room.onLeave(client("watcher-5"));
    expect(bots(room)).toHaveLength(1);
    await room.onLeave(client("watcher-4"));
    expect(bots(room)).toHaveLength(2);
    room.handlePlay(client("watcher-1"), { nick: "second" });
    expect(bots(room)).toHaveLength(0);
    expect(room.watchingCount()).toBe(2);
  });

  it.each(["lobby", "playing"] as const)("cleans bot balls, bonuses, sheep reservations and runtime on second Play in %s", async (phase) => {
    const room = await soloRoom(phase);
    const [firstBot, secondBot] = bots(room);
    if (firstBot === undefined || secondBot === undefined) throw new Error("solo opponents missing");
    const oldIds = [firstBot.sessionId, secondBot.sessionId];
    const internals = runtime(room);
    const maps = [internals.inputs, internals.planarMotion, internals.respawnAt, internals.brains, internals.airSince, internals.bonusAir];
    for (const id of oldIds) {
      internals.inputs.set(id, { x: 1 });
      internals.planarMotion.set(id, { vx: 2, vz: 1 });
      internals.respawnAt.set(id, room.testNow! + 100);
      internals.airSince.set(id, room.testNow!);
      internals.bonusAir.set(id, { velocity: 10 });
    }
    firstBot.superKind = "sheep";
    addBall(room, firstBot.sessionId, "bot-regular");
    addBall(room, firstBot.sessionId, "bot-bonus", "ice");
    installEffect(room, secondBot.sessionId, "bot-effect", "sheep");
    const humanBall = addBall(room, "first", "human-regular");
    installEffect(room, "first", "human-effect", "swamp");
    const humanEffect = room.state.bonusEffects.get("human-effect:effect");
    expect(internals.bonuses.sheepCount()).toBe(2);
    await join(room, "second", true);
    expect([...room.state.balls.values()]).toEqual([humanBall]);
    expect([...room.state.bonusEffects.values()]).toEqual([humanEffect]);
    expect(internals.bonuses.sheepCount()).toBe(0);
    for (const id of oldIds) for (const map of maps) expect(map.has(id)).toBe(false);
    const bonusRuntime = internals.bonuses as unknown as { runtime: Map<string, unknown>; ledgers: Map<string, unknown> };
    expect([...bonusRuntime.runtime.keys()]).toEqual(["human-effect:effect"]);
    expect([...bonusRuntime.ledgers.keys()]).toEqual(["human-effect"]);
    expect(room.state.phase).toBe(phase);
  });

  it.each(phases)("removes all bots when the last participant leaves %s even with a spectator remaining", async (phase) => {
    const room = await soloRoom(phase);
    await join(room, "watcher");
    const botIds = bots(room).map((bot) => bot.sessionId);
    for (const id of botIds) addBall(room, id, `${id}-ball`, "ice");
    await room.onLeave(client("first"));
    expect([...room.state.players.keys()]).toEqual(["watcher"]);
    expect(room.state.balls.size).toBe(0);
    expect(room.state.bonusEffects.size).toBe(0);
    expect(runtime(room).brains.size).toBe(0);
    expect(room.state.phase).toBe("lobby");
    for (let tick = 0; tick < 3; tick += 1) {
      room.testNow! += 50;
      room.tickRoom();
      expect(bots(room)).toHaveLength(0);
      expect(room.state.phase).toBe("lobby");
    }
  });
});
