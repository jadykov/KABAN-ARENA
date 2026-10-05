import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { SchemaSerializer, type Client } from "colyseus";
import { GRENADE_FRAGMENT_COUNT, GRENADE_FRAGMENT_DAMAGE, GRENADE_FRAGMENT_RADIUS, SUPER_BONUS_KINDS, SUPER_BONUS_SLOT_MS, getSuperBonus } from "../../shared/super-bonuses.mjs";
import { ARENA_HALF_SIZE, BALL_GROUND_Y, BODY_CENTER_Y, LOBBY_COUNTDOWN_MS, MAX_LIVE_BALLS, SERVER_OBSTACLES, SERVER_PLATFORMS } from "./config.js";
import { rampHeightAt, rampRunForTop } from "./hits.js";
import { ArenaRoom } from "./rooms/ArenaRoom.js";
import { ArenaState, BallState, PlayerState } from "./state.js";
import { SuperBonusSystem } from "./super-bonuses.js";

const { Decoder } = createRequire(import.meta.url)("@colyseus/schema") as typeof import("@colyseus/schema");
const client = (sessionId: string): Client => ({ sessionId, send: (): void => {} }) as unknown as Client;
async function match(): Promise<{ room: ArenaRoom; owner: PlayerState; target: PlayerState }> {
  const room = new ArenaRoom(); room.testNow = 0; await room.onCreate();
  for (const id of ["owner", "target"]) { await room.onJoin(client(id)); room.handlePlay(client(id), { nick: id }); }
  room.testNow = 1; room.tickRoom(); room.testNow = LOBBY_COUNTDOWN_MS + 2; room.tickRoom();
  const owner = room.state.players.get("owner")!; const target = room.state.players.get("target")!;
  Object.assign(owner, { x: 0, z: 8, y: BODY_CENTER_Y, invulnUntil: 0 });
  Object.assign(target, { x: 0, z: 7, y: BODY_CENTER_Y, invulnUntil: 0 });
  return { room, owner, target };
}
function tick(room: ArenaRoom, count = 1): void {
  for (let i = 0; i < count; i += 1) { room.testNow = (room.testNow ?? 0) + 50; room.tickRoom(50); }
}
function shoot(room: ArenaRoom, owner: PlayerState, power = 1): BallState {
  Object.assign(owner, { superKind: "grenade", superUntil: room.testNow! + SUPER_BONUS_SLOT_MS, superBuff: true, reloadUntil: 0 });
  room.handleFire(owner.sessionId, { power01: power, yaw: 0, pitch: 0 });
  return [...room.state.balls.values()].at(-1)!;
}
function far(room: ArenaRoom): void { for (const player of room.state.players.values()) Object.assign(player, { x: 14, z: 14, y: BODY_CENTER_Y }); }
function fragments(room: ArenaRoom): BallState[] { return [...room.state.balls.values()].filter((ball) => ball.grenadeFragment); }
function system(room: ArenaRoom): SuperBonusSystem { return (room as unknown as { bonuses: SuperBonusSystem }).bonuses; }
function neighbour(room: ArenaRoom, x: number, z: number): PlayerState {
  const player = new PlayerState();
  Object.assign(player, { sessionId: "neighbour", nick: "neighbour", ready: true, spectator: false, alive: true, x, z, y: BODY_CENTER_Y });
  room.state.players.set(player.sessionId, player); return player;
}
async function split(): Promise<{ room: ArenaRoom; owner: PlayerState; target: PlayerState; original: BallState; children: BallState[] }> {
  const { room, owner, target } = await match();
  const original = shoot(room, owner); far(room);
  Object.assign(original, { x: 0, y: 0.21, z: 8, vx: 0, vy: -1, vz: 0, ageMs: 50 });
  tick(room); return { room, owner, target, original, children: fragments(room) };
}
function floorContact(ball: BallState, x = 0, z = 8): void { Object.assign(ball, { x, y: 0.21, z, vx: 0, vy: -1, vz: 0, ageMs: 50 }); }

describe("central grenade and three contact-detonated fragments", () => {
  it("registers an eleventh central bonus with one-heart direct extra damage", () => {
    expect(SUPER_BONUS_KINDS).toHaveLength(11);
    expect(getSuperBonus("grenade")).toMatchObject({ id: "31", directWeak: 25, directStrong: 25 });
    expect(GRENADE_FRAGMENT_COUNT).toBe(3); expect(GRENADE_FRAGMENT_DAMAGE).toBe(12.5); expect(GRENADE_FRAGMENT_RADIUS).toBe(1);
  });

  it.each([[0.5, 62.5], [0.799999, 62.5], [0.8, 50], [1, 50]])("direct power %s applies ordinary B + 25 only to the contact target", async (power, hp) => {
    const { room, owner, target } = await match();
    const nearby = neighbour(room, 0.8, 7);
    const main = shoot(room, owner, power); tick(room, 2);
    expect(target.hp).toBe(hp); expect(nearby.hp).toBe(100); expect(owner.hp).toBe(100); expect(owner.score).toBe(1);
    expect(room.state.balls.has(main.ballId)).toBe(false); expect(fragments(room)).toHaveLength(0);
    expect([...room.state.bonusEffects.values()]).toEqual([expect.objectContaining({ kind: "grenade", phase: "burst", radius: 0.6 })]);
    tick(room, 6); expect(room.state.bonusEffects.size).toBe(0); expect(nearby.hp).toBe(100);
  });

  it("accepts charge-boost fire, consumes the held slot, and retains the base damage threshold", async () => {
    const { room, owner, target } = await match(); owner.chargeUntil = room.testNow! + 5000;
    shoot(room, owner, 0.8);
    expect(owner.superKind).toBe(""); expect(owner.superUntil).toBe(0); expect(owner.superBuff).toBe(false); expect(owner.chargeUntil).toBe(0);
    tick(room, 2); expect(target.hp).toBe(50);
  });

  it("a rejected reloading shot preserves the grenade slot", async () => {
    const { room, owner } = await match();
    Object.assign(owner, { superKind: "grenade", superUntil: room.testNow! + 20000, superBuff: true, reloadUntil: room.testNow! + 1000 });
    room.handleFire(owner.sessionId, { power01: 1 });
    expect(room.state.balls.size).toBe(0); expect(owner.superKind).toBe("grenade");
    room.testNow = owner.superUntil; room.tickRoom(50); expect(owner.superKind).toBe("");
  });

  it("the full shield absorbs B + 25 and consumes the main contact without fragments", async () => {
    const { room, owner, target } = await match(); target.shieldHp = 100; target.shieldUntil = room.testNow! + 5000;
    shoot(room, owner, 0.5); tick(room, 2);
    expect(target.hp).toBe(100); expect(target.shieldHp).toBe(62.5); expect(owner.score).toBe(1); expect(room.state.balls.size).toBe(0);
  });

  it("a main contact with an invulnerable fighter bursts without damage, score, or fragments", async () => {
    const { room, owner, target } = await match(); target.invulnUntil = room.testNow! + 5000;
    const main = shoot(room, owner); tick(room, 2);
    expect(target.hp).toBe(100); expect(owner.score).toBe(0); expect(room.state.balls.has(main.ballId)).toBe(false); expect(fragments(room)).toHaveLength(0);
    expect([...room.state.bonusEffects.values()][0]?.phase).toBe("burst");
  });

  it("a missed floor contact creates exactly three finite, smaller, outward-moving children and skips same-tick simulation", async () => {
    const { room, original, children } = await split();
    expect(room.state.balls.has(original.ballId)).toBe(false); expect(children).toHaveLength(3); expect(room.state.bonusEffects.size).toBe(0);
    expect(new Set(children.map((ball) => `${ball.vx},${ball.vz}`)).size).toBe(3);
    for (const ball of children) {
      expect(ball).toMatchObject({ bonusKind: "grenade", grenadeFragment: true, grenadeParentId: original.ballId, ageMs: 0, ricochet: false, rolling: false, resting: false });
      expect(ball.y).toBeGreaterThan(BALL_GROUND_Y); expect(ball.vy).toBeGreaterThan(0);
      expect([ball.x, ball.y, ball.z, ball.vx, ball.vy, ball.vz].every(Number.isFinite)).toBe(true);
    }
    tick(room, 2); expect(fragments(room)).toHaveLength(3); expect(children.every((ball) => ball.distM > 0)).toBe(true);
  });

  it.each(["east", "corner", "shop wall", "exact shop face", "shop roof", "ramp", "ramp underside"])("a missed %s contact creates three children outside the touched geometry", async (surface) => {
    const { room, owner } = await match(); const main = shoot(room, owner); far(room);
    const shop = SERVER_PLATFORMS[0]!;
    if (surface === "east") Object.assign(main, { x: ARENA_HALF_SIZE - 0.01, y: 1, z: 8, vx: 4, vy: 0, vz: 0 });
    if (surface === "corner") Object.assign(main, { x: ARENA_HALF_SIZE - 0.01, y: 1, z: ARENA_HALF_SIZE - 0.01, vx: 4, vy: 0, vz: 4 });
    if (surface === "shop wall") Object.assign(main, { x: shop.x - shop.hx - 0.01, y: 1, z: shop.z, vx: 4, vy: 0, vz: 0 });
    if (surface === "exact shop face") Object.assign(main, { x: shop.x - shop.hx, y: 1, z: shop.z, vx: 4, vy: 0, vz: 0 });
    if (surface === "shop roof") Object.assign(main, { x: shop.x, y: shop.topY + 0.01, z: shop.z, vx: 0, vy: -4, vz: 0 });
    if (surface === "ramp" || surface === "ramp underside") {
      const x = shop.x; const z = shop.z + shop.hz + rampRunForTop(shop.topY) * 0.5;
      const height = rampHeightAt(shop, x, z);
      expect(height).toBeGreaterThan(0);
      Object.assign(main, { x, y: surface === "ramp" ? height + 0.01 : height - 0.26, z, vx: 0, vy: surface === "ramp" ? -4 : 4, vz: 0 });
    }
    main.ageMs = 50; tick(room);
    expect(room.state.balls.has(main.ballId)).toBe(false); const children = fragments(room); expect(children).toHaveLength(3);
    expect(children.every((ball) => [ball.x, ball.y, ball.z, ball.vx, ball.vy, ball.vz].every(Number.isFinite))).toBe(true);
    expect(children.every((ball) => Math.abs(ball.x) < ARENA_HALF_SIZE && Math.abs(ball.z) < ARENA_HALF_SIZE)).toBe(true);
    tick(room, 2); expect(fragments(room)).toHaveLength(3);
  });

  it("reserves all three children when the twelve-ball pool is full", async () => {
    const { room, owner } = await match(); const main = shoot(room, owner); far(room);
    for (let i = 0; i < MAX_LIVE_BALLS - 1; i += 1) {
      const decoration = new BallState(); Object.assign(decoration, { ballId: `old${i}`, resting: true, ageMs: 1000 + i }); room.state.balls.set(decoration.ballId, decoration);
    }
    floorContact(main); tick(room);
    expect(room.state.balls.size).toBe(MAX_LIVE_BALLS); expect(fragments(room)).toHaveLength(3);
    expect(room.state.balls.has("old10")).toBe(false); expect(room.state.balls.has("old9")).toBe(false);
  });

  it("children have no one-second fuse and the finite lifetime only cleans up without a blast", async () => {
    const { room, children } = await split();
    for (const ball of children) Object.assign(ball, { x: 0, y: 8, z: 8, vx: 0, vy: 0, vz: 0, ageMs: 50 });
    tick(room, 20); expect(fragments(room)).toHaveLength(3); expect(room.state.bonusEffects.size).toBe(0);
    for (const ball of children) ball.ageMs = 3950;
    tick(room); expect(fragments(room)).toHaveLength(0); expect(room.state.bonusEffects.size).toBe(0);
    expect((system(room) as unknown as { ledgers: Map<string, unknown>; parentThrows: Map<string, string> }).ledgers.size).toBe(0);
    expect((system(room) as unknown as { parentThrows: Map<string, string> }).parentThrows.size).toBe(0);
  });

  it("an overdue main projectile is cleaned up without splitting or causing timed damage", async () => {
    const { room, owner } = await match(); const main = shoot(room, owner); far(room);
    Object.assign(main, { x: 0, y: 30, z: 8, vx: 0, vy: 0, vz: 0, ageMs: 7950 }); tick(room);
    expect(room.state.balls.size).toBe(0); expect(room.state.bonusEffects.size).toBe(0);
  });

  it("each child contact deals exactly half a heart, with one hit score for the original throw", async () => {
    const { room, owner, target, original, children } = await split();
    Object.assign(target, { x: 0, z: 8, y: BODY_CENTER_Y });
    for (const ball of children) floorContact(ball);
    tick(room);
    expect(target.hp).toBe(62.5); expect(owner.hp).toBe(100); expect(owner.score).toBe(1); expect(fragments(room)).toHaveLength(0);
    expect([...room.state.bonusEffects.values()]).toHaveLength(3);
    for (const effect of room.state.bonusEffects.values()) expect(effect).toMatchObject({ kind: "grenade", phase: "burst", radius: 1, throwId: original.ballId });
    tick(room, 6); expect(target.hp).toBe(62.5); expect(room.state.bonusEffects.size).toBe(0);
  });

  it("fragment shield contacts spend only 12.5 each, and killing gives one hit plus one kill score", async () => {
    const { room, owner, target, children } = await split();
    Object.assign(target, { x: 0, z: 8, shieldHp: 25, shieldUntil: room.testNow! + 5000, hp: 12.5 });
    for (const ball of children) floorContact(ball); tick(room);
    expect(target.shieldHp).toBe(0); expect(target.hp).toBe(0); expect(target.alive).toBe(false); expect(owner.score).toBe(11);
  });

  it("the parent ledger prevents a later child farming hit or kill points after the same target respawns", async () => {
    const { room, owner, target, children } = await split();
    Object.assign(target, { x: 0, z: 8, hp: 12.5 });
    for (const ball of children) Object.assign(ball, { x: 0, y: 8, z: 8, vx: 0, vy: 0, vz: 0, ageMs: 50 });
    floorContact(children[0]!); tick(room); expect(target.alive).toBe(false); expect(owner.score).toBe(11);
    Object.assign(target, { x: 0, y: BODY_CENTER_Y, z: 8, hp: 12.5, alive: true, invulnUntil: 0 });
    floorContact(children[1]!); tick(room); expect(target.hp).toBe(0); expect(owner.score).toBe(11);
  });

  it("each target receives a separate score while self blasts remove health without self score", async () => {
    const { room, owner, target, children } = await split();
    Object.assign(owner, { x: 0.4, z: 8 }); Object.assign(target, { x: 0, z: 8 }); const nearby = neighbour(room, 0.8, 8);
    for (const ball of children) floorContact(ball); tick(room);
    expect(owner.hp).toBe(62.5); expect(target.hp).toBe(62.5); expect(nearby.hp).toBe(62.5); expect(owner.score).toBe(2);
  });

  it("a fragment player contact has no base damage and never splits recursively", async () => {
    const { room, target, children } = await split(); Object.assign(target, { x: 0, z: 8 });
    for (const ball of children.slice(1)) Object.assign(ball, { x: 8, y: 8, z: 8, vx: 0, vy: 0, vz: 0 });
    const child = children[0]!; Object.assign(child, { x: 0, y: BODY_CENTER_Y, z: 8.6, vx: 0, vy: 0, vz: 0, ageMs: 50 });
    tick(room); expect(target.hp).toBe(87.5); expect(fragments(room)).toHaveLength(2); expect(room.state.balls.has(child.ballId)).toBe(false);
  });

  it("an invulnerable player consumes a fragment contact while a vulnerable neighbour receives the blast", async () => {
    const { room, owner, target, children } = await split(); Object.assign(target, { x: 0, z: 8, invulnUntil: room.testNow! + 5000 });
    const nearby = neighbour(room, 0.8, 8.6);
    for (const ball of children.slice(1)) Object.assign(ball, { x: 8, y: 8, z: 8, vx: 0, vy: 0, vz: 0 });
    const child = children[0]!; Object.assign(child, { x: 0, y: BODY_CENTER_Y, z: 8.6, vx: 0, vy: 0, vz: 0, ageMs: 50 });
    tick(room); expect(target.hp).toBe(100); expect(nearby.hp).toBe(87.5); expect(owner.score).toBe(1); expect(room.state.balls.has(child.ballId)).toBe(false);
  });

  it("a fragment blast includes the one-metre edge, excludes beyond it, and excludes spectators", async () => {
    const { room, owner, target, children } = await split();
    Object.assign(target, { x: 1, z: 8 }); const outside = neighbour(room, 1.00001, 8);
    const spectator = new PlayerState(); Object.assign(spectator, { sessionId: "spectator", x: 0, z: 8, alive: true, ready: false, spectator: true }); room.state.players.set(spectator.sessionId, spectator);
    for (const ball of children) floorContact(ball); tick(room);
    expect(target.hp).toBe(62.5); expect(outside.hp).toBe(100); expect(spectator.hp).toBe(100); expect(owner.score).toBe(1);
  });

  it("blasts cannot cross a solid wall or hit a roof fighter from the floor", async () => {
    const { room, target, children } = await split(); const box = SERVER_OBSTACLES.find((solid) => solid.topY >= 1)!;
    const child = children[0]!; Object.assign(child, { x: box.x - box.hx - 0.04, y: 0.24, z: box.z });
    Object.assign(target, { x: box.x - box.hx + 0.1, y: BODY_CENTER_Y, z: box.z });
    system(room).grenadeBurst(child, room.testNow!); expect(target.hp).toBe(100);
    Object.assign(target, { x: child.x, y: box.topY + BODY_CENTER_Y, z: child.z });
    system(room).grenadeBurst(child, room.testNow!); expect(target.hp).toBe(100);
  });

  it("disconnects and round transitions clear all children, burst effects, and parent ledgers", async () => {
    for (const reason of ["disconnect", "round end", "round restart"]) {
      const { room, owner, children } = await split(); system(room).grenadeBurst(children[0]!, room.testNow!);
      if (reason === "disconnect") await room.onLeave(client(owner.sessionId));
      else if (reason === "round end") (room as unknown as { endRound(id: string): void }).endRound(owner.sessionId);
      else (room as unknown as { startPlaying(now: number): void }).startPlaying(room.testNow!);
      expect(fragments(room)).toHaveLength(0); expect(room.state.bonusEffects.size).toBe(0);
      expect((system(room) as unknown as { ledgers: Map<string, unknown>; parentThrows: Map<string, string> }).ledgers.size).toBe(0);
      expect((system(room) as unknown as { parentThrows: Map<string, string> }).parentThrows.size).toBe(0);
    }
  });

  it("a late-client schema snapshot includes child flags and bursts while excluding the parent ledger field", async () => {
    const { room, owner, children } = await split(); system(room).grenadeBurst(children[0]!, room.testNow!);
    const serializer = new SchemaSerializer(); serializer.reset(room.state); const decoded = new ArenaState();
    new Decoder(decoded).decode(serializer.getFullState(client(owner.sessionId)).subarray(1));
    expect([...decoded.balls.values()]).toHaveLength(3);
    for (const ball of decoded.balls.values()) {
      expect(ball.grenadeFragment).toBe(true); expect(ball.bonusKind).toBe("grenade"); expect(ball.toJSON()).not.toHaveProperty("grenadeParentId");
    }
    const burst = [...decoded.bonusEffects.values()][0]!;
    expect(burst).toMatchObject({ phase: "burst", radius: 1 }); expect(burst.y).toBeCloseTo(children[0]!.y, 6);
  });
});
