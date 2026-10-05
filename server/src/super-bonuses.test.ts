import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { SchemaSerializer, type Client } from "colyseus";
import { SUPER_BONUS_KINDS, SUPER_BONUS_SLOT_MS } from "../../shared/super-bonuses.mjs";
import { BODY_CENTER_Y, BOT_SPEED, LOBBY_COUNTDOWN_MS, MAX_LIVE_BALLS, PLAYER_SPEED, RELOAD_MS, ROUND_DURATION_MS, SERVER_OBSTACLES, SERVER_PLATFORMS, SUPER_LIFE_S, SUPER_SPAWN_S } from "./config.js";
import { ArenaRoom } from "./rooms/ArenaRoom.js";
import { ArenaState, BallState, BonusEffectState, PlayerState } from "./state.js";
import { rampRunForTop } from "./hits.js";
import { bonusLineOfSight, type BonusHost } from "./super-bonuses.js";

const { Decoder } = createRequire(import.meta.url)("@colyseus/schema") as typeof import("@colyseus/schema");

const client = (sessionId: string): Client => ({ sessionId, send: (): void => {} }) as unknown as Client;
async function match(): Promise<{ room: ArenaRoom; owner: PlayerState; target: PlayerState }> {
  const room = new ArenaRoom(); room.testNow = 0;
  await room.onCreate();
  for (const id of ["owner", "target"]) { await room.onJoin(client(id)); room.handlePlay(client(id), { nick: id }); }
  room.testNow = 1; room.tickRoom(); room.testNow = LOBBY_COUNTDOWN_MS + 2; room.tickRoom();
  for (const [id, player] of room.state.players) if (player.isBot) room.state.players.delete(id);
  const owner = room.state.players.get("owner")!; const target = room.state.players.get("target")!;
  Object.assign(owner, { x: 0, z: 8, y: BODY_CENTER_Y, invulnUntil: 0 });
  Object.assign(target, { x: 0, z: 7, y: BODY_CENTER_Y, invulnUntil: 0 });
  return { room, owner, target };
}
function tick(room: ArenaRoom, count = 1): void { for (let i = 0; i < count; i += 1) { room.testNow = (room.testNow ?? 0) + 50; room.tickRoom(50); } }
function give(room: ArenaRoom, owner: PlayerState, kind: string): void { owner.superKind = kind; owner.superUntil = (room.testNow ?? 0) + SUPER_BONUS_SLOT_MS; owner.superBuff = true; owner.reloadUntil = 0; }
function shoot(room: ArenaRoom, owner: PlayerState, kind: string, power = 1): string {
  give(room, owner, kind); room.handleFire(owner.sessionId, { power01: power, yaw: 0, pitch: 0 });
  return [...room.state.balls.keys()].at(-1)!;
}
function input(room: ArenaRoom, id: string, x: number, z: number, charging = false): void {
  (room as unknown as { handleInput(id: string, body: unknown): void }).handleInput(id, { x, y: z, rotY: 0, seq: 1, charging });
}
function drop(room: ArenaRoom, owner: PlayerState, kind: string, x = 0, z = 8, y = 0.15): BonusEffectState {
  const id = shoot(room, owner, kind);
  const ball = room.state.balls.get(id)!;
  Object.assign(ball, { x, z, y, vx: 0, vy: 0, vz: 0, ageMs: 50 });
  for (const player of room.state.players.values()) { player.x = 14; player.z = 14; }
  tick(room);
  const effect = [...room.state.bonusEffects.values()].at(-1);
  if (effect === undefined) throw new Error(`missing ${kind} effect`);
  return effect;
}

describe("eleven authoritative super bonuses in ArenaRoom", () => {
  it("spawns after 10s, waits 10s after pickup and grants a single 20s slot consumed only by accepted fire", async () => {
    const { room, owner } = await match();
    room.pickupRandom = () => 0.999;
    const start = room.testNow!;
    expect(SUPER_SPAWN_S).toBe(10);
    expect(room.state.superNextAt).toBe(start + SUPER_SPAWN_S * 1000);
    room.testNow = start + 9999; room.tickRoom(50);
    expect(room.state.superActive).toBe(false);
    room.testNow = room.state.superNextAt; room.tickRoom(50);
    expect(room.state.superActive).toBe(true); expect(room.state.superKind).toBe("");
    expect(room.state.superExpiresAt).toBe(room.testNow + SUPER_LIFE_S * 1000);
    owner.x = 0; owner.z = 0; owner.y = BODY_CENTER_Y;
    tick(room);
    const kind = owner.superKind;
    expect(kind).toBe("sheep");
    expect(owner.superKind).toBe(kind); expect(owner.superUntil).toBe(room.testNow! + 20000);
    const nextAt = room.testNow! + 10000;
    expect(room.state.superNextAt).toBe(nextAt); expect(room.state.superExpiresAt).toBe(0);
    input(room, owner.sessionId, 0, 0, true); input(room, owner.sessionId, 0, 0, false);
    expect(owner.superKind).toBe(kind);
    owner.reloadUntil = room.testNow! + RELOAD_MS;
    room.handleFire(owner.sessionId, { power01: 1 });
    expect(owner.superKind).toBe(kind); expect(room.state.balls.size).toBe(0);
    owner.reloadUntil = 0; room.handleFire(owner.sessionId, { power01: 1 });
    expect([...room.state.balls.values()][0]?.bonusKind).toBe(kind);
    expect(owner.superKind).toBe(""); expect(owner.superUntil).toBe(0);
    owner.x = 14; owner.z = 14;
    room.testNow = nextAt - 1; room.tickRoom(50); expect(room.state.superActive).toBe(false);
    room.testNow = nextAt; room.tickRoom(50); expect(room.state.superActive).toBe(true); expect(room.state.superKind).toBe("");
  });

  it("keeps an uncollected gift for 15s then waits a full 10s, releasing its hidden sheep reservation", async () => {
    const { room } = await match(); room.pickupRandom = () => 0.999;
    const system = (room as unknown as { bonuses: { sheepCount(): number } }).bonuses;
    room.testNow = room.state.superNextAt; room.tickRoom(50);
    const expiresAt = room.testNow + 15000;
    expect(room.state.superExpiresAt).toBe(expiresAt); expect(room.state.superKind).toBe(""); expect(system.sheepCount()).toBe(1);
    room.testNow = expiresAt - 1; room.tickRoom(50); expect(room.state.superActive).toBe(true);
    room.testNow = expiresAt; room.tickRoom(50);
    expect(room.state.superActive).toBe(false); expect(room.state.superKind).toBe(""); expect(room.state.superExpiresAt).toBe(0); expect(system.sheepCount()).toBe(0);
    expect(room.state.superNextAt).toBe(expiresAt + 10000);
    room.testNow = expiresAt + 9999; room.tickRoom(50); expect(room.state.superActive).toBe(false);
    room.testNow = expiresAt + 10000; room.tickRoom(50); expect(room.state.superActive).toBe(true);
    expect(system.sheepCount()).toBe(0);
  });

  it("encodes a hidden central gift for current and late clients, revealing its kind only on pickup and throw", async () => {
    const { room, owner } = await match(); room.pickupRandom = () => 0.999;
    room.testNow = room.state.superNextAt; room.tickRoom(50);
    await room.onJoin(client("late"));
    const serializer = new SchemaSerializer(); serializer.reset(room.state);
    const snapshot = (id: string): ArenaState => {
      // Colyseus prefixes the schema payload with its ROOM_STATE opcode.
      const decoded = new ArenaState(); new Decoder(decoded).decode(serializer.getFullState(client(id)).subarray(1));
      return decoded;
    };
    for (const id of [owner.sessionId, "late"]) {
      const json = snapshot(id).toJSON();
      expect(json).toMatchObject({ superActive: true, superKind: "" });
      expect(json).not.toHaveProperty("pendingSuperKind"); expect(json).not.toHaveProperty("hasCentralSheep");
      expect(Object.values(json["players"])).toEqual(expect.arrayContaining([expect.objectContaining({ superKind: "" })]));
      expect(JSON.stringify(json)).not.toContain("sheep");
    }
    expect(room.state.toJSON()["superKind"]).toBe("");
    owner.x = 0; owner.z = 0; tick(room);
    for (const id of [owner.sessionId, "late"]) {
      expect(snapshot(id).players.get(owner.sessionId)?.superKind).toBe("sheep");
      expect(snapshot(id).superKind).toBe("");
    }
    room.handleFire(owner.sessionId, { power01: 1 });
    expect([...room.state.balls.values()][0]?.bonusKind).toBe("sheep");
    expect([...snapshot("late").balls.values()][0]?.bonusKind).toBe("sheep");
    expect(snapshot("late").players.get(owner.sessionId)?.superKind).toBe("");
  });

  it.each(["turkey", "freeze", "jelly"])("%s weak/strong direct damage uses B + 12.5 and bypasses legacy x2", async (kind) => {
    for (const [power, hp] of [[0.799999, 75], [0.8, 62.5], [1, 62.5]]) {
      const { room, owner, target } = await match(); shoot(room, owner, kind, power); tick(room, 8);
      expect(target.hp).toBe(hp); expect(owner.score).toBe(1);
    }
  });

  it("full shield consumes contact and suppresses control; invulnerability suppresses damage and score", async () => {
    const { room, owner, target } = await match();
    target.shieldHp = 50; target.shieldUntil = room.testNow! + 5000;
    shoot(room, owner, "freeze"); tick(room, 8);
    expect(target.hp).toBe(100); expect(target.shieldHp).toBe(12.5); expect(target.frozenUntil).toBe(0); expect(owner.score).toBe(1);
    owner.x = 0; owner.z = 8; target.invulnUntil = room.testNow! + 5000;
    shoot(room, owner, "turkey"); tick(room, 8);
    expect(target.hp).toBe(100); expect(target.turkeyUntil).toBe(0); expect(owner.score).toBe(1);
  });

  it("freeze cancels charging/fire for 1s, retains gravity and protects from freeze for two more seconds", async () => {
    const { room, owner, target } = await match();
    give(room, target, "ice"); input(room, target.sessionId, 1, 0, true);
    shoot(room, owner, "freeze");
    input(room, target.sessionId, 0, 0, true); tick(room, 4);
    expect(target.frozenUntil).toBeGreaterThan(room.testNow!);
    const frozenEnd = target.frozenUntil; expect(target.controlImmuneUntil).toBe(frozenEnd + 2000);
    const held = target.superKind;
    room.handleFire(target.sessionId, { power01: 1 }); expect(target.superKind).toBe(held);
    const beforeX = target.x; input(room, target.sessionId, 1, 0, true); tick(room, 2); expect(target.x).toBe(beforeX);
    const inputState = (room as unknown as { inputs: Map<string, { charging: boolean }> }).inputs.get(target.sessionId);
    expect(inputState?.charging).toBe(false);
    room.testNow = frozenEnd + 1; room.tickRoom(50);
    owner.x = 0; owner.z = 8; target.x = 0; target.z = 7;
    shoot(room, owner, "freeze"); tick(room, 5);
    expect(target.frozenUntil).toBe(0);
  });

  it("turkey duration does not stack and jelly launches both humans and bots with bounded speed", async () => {
    const { room, owner, target } = await match();
    shoot(room, owner, "turkey"); tick(room, 4);
    const end = target.turkeyUntil; expect(end).toBeGreaterThan(room.testNow!);
    owner.x = 0; owner.z = 8; shoot(room, owner, "turkey"); tick(room, 4); expect(target.turkeyUntil).toBe(end);
    target.isBot = true; target.reloadUntil = room.testNow! + 10000;
    owner.x = 0; owner.z = 8; target.x = 0; target.z = 7; target.hp = 100;
    shoot(room, owner, "jelly"); tick(room, 5);
    expect(target.launchSeq).toBe(1); expect(target.launchVelocity).toBe(10); expect(target.y).toBeGreaterThan(BODY_CENTER_Y);
    target.frozenUntil = room.testNow! + 1000; const y = target.y; tick(room, 3); expect(target.y).not.toBe(y);
  });

  it.each([["herring", 3.6], ["swamp", 3], ["ice", 3.6], ["vacuum", 4], ["soda", 3], ["sheep", 4]] as const)("%s installs its doubled radius on a real support after direct B", async (kind, radius) => {
    const { room, owner, target } = await match(); shoot(room, owner, kind); tick(room, 4);
    expect(target.hp).toBe(75);
    const effect = [...room.state.bonusEffects.values()][0]; expect(effect?.kind).toBe(kind); expect(effect?.y).toBe(0);
    expect(effect?.radius).toBe(radius);
  });

  it("herring damages the expanded outer region and vacuum pulls there while their new outer boundaries remain safe", async () => {
    const { room, owner, target } = await match(); const cloud = drop(room, owner, "herring");
    owner.x = cloud.x + 3.61; owner.z = cloud.z; target.x = cloud.x + 3; target.z = cloud.z;
    tick(room, 20);
    expect(target.hp).toBeLessThan(100); expect(owner.hp).toBe(100);
    const { room: r, owner: p, target: q } = await match(); const vacuum = drop(r, p, "vacuum");
    p.x = vacuum.x + 4.01; p.z = vacuum.z; q.x = vacuum.x + 3; q.z = vacuum.z;
    const outside = p.x; const inside = q.x; tick(r);
    expect(q.x).toBeCloseTo(inside - 0.5 * 0.05); expect(p.x).toBe(outside);
    expect(q.hp).toBe(100); expect(p.hp).toBe(100);
  });

  it.each([["soda", 3], ["sheep", 4]] as const)("%s expands both blast damage bands and stops at its doubled radius", async (kind, radius) => {
    for (const [fraction, expectedHp] of [[0.4, 75], [0.75, 87.5]] as const) {
      const { room, owner, target } = await match(); const effect = drop(room, owner, kind);
      owner.x = effect.x + radius + 0.01; owner.z = effect.z;
      target.x = effect.x + radius * fraction; target.z = effect.z;
      effect.phase = "warning"; effect.triggerAt = room.testNow! + 50; tick(room);
      expect(target.hp).toBe(expectedHp); expect(owner.hp).toBe(100); expect(owner.score).toBe(1);
      expect(room.state.bonusEffects.has(effect.effectId)).toBe(false);
    }
  });

  it("soda's doubled trigger area warns from the former outer region, keeping the same 600ms delay", async () => {
    const { room, owner, target } = await match(); const soda = drop(room, owner, "soda");
    owner.x = 14; owner.z = 14; target.x = soda.x + 2.01; target.z = soda.z;
    tick(room, 16); expect(soda.phase).toBe("armed"); expect(soda.triggerAt).toBe(0);
    target.x = soda.x + 1.5; tick(room);
    expect(soda.phase).toBe("warning"); expect(soda.triggerAt).toBe(room.testNow! + 600);
    expect(target.hp).toBe(100);
  });

  it("herring miss never grants B, repeated entries cap each source at 25 and concurrent sources at 12.5/s", async () => {
    const { room, owner, target } = await match(); const effect = drop(room, owner, "herring");
    owner.x = 14; owner.z = 14; target.x = 0; target.z = 8;
    tick(room, 11); expect(target.hp).toBe(100); tick(room, 10); expect(target.hp).toBeCloseTo(93.75);
    target.x = 8; tick(room, 10); const leftHp = target.hp; target.x = 0; tick(room, 60);
    expect(target.hp).toBe(75); expect(owner.score).toBe(1); expect(leftHp).toBeGreaterThan(75);
    expect(room.state.bonusEffects.has(effect.effectId)).toBe(false);
    target.hp = 100; owner.x = 0; owner.z = 8;
    drop(room, owner, "herring"); owner.x = 0; owner.z = 8; drop(room, owner, "herring"); owner.x = 14; owner.z = 14;
    target.x = 0; target.z = 8; tick(room, 12); const hp = target.hp; tick(room, 20); expect(hp - target.hp).toBeCloseTo(12.5);
  });

  it("delayed effects retain a single hit score per target, kill bonus and zero self score", async () => {
    const { room, owner, target } = await match(); target.hp = 37.5;
    shoot(room, owner, "herring"); tick(room, 4); expect(target.hp).toBe(12.5); expect(owner.score).toBe(1);
    owner.x = 14; owner.z = 14; tick(room, 34); expect(owner.score).toBe(11);
    const { room: r2, owner: self, target: other } = await match(); other.x = 14; other.z = 14;
    drop(r2, self, "herring"); self.x = 0; self.z = 8; tick(r2, 60); expect(self.hp).toBe(75); expect(self.score).toBe(0);
  });

  it("soda arms, warns, explodes with only E, and normal balls safely disarm soda and sheep", async () => {
    const { room, owner, target } = await match(); const soda = drop(room, owner, "soda"); owner.x = 14; owner.z = 14;
    target.x = soda.x; target.z = soda.z; tick(room, 15); expect(soda.phase).toBe("arming"); tick(room); expect(soda.phase).toBe("warning");
    tick(room, 11); expect(target.hp).toBe(100); tick(room); expect(target.hp).toBe(75); expect(room.state.bonusEffects.size).toBe(0);
    for (const kind of ["soda", "sheep"]) {
      const { room: r, owner: p, target: q } = await match(); const effect = drop(r, p, kind); q.x = 14; q.z = 14; p.x = 14; p.z = 14;
      const normal = new BallState(); Object.assign(normal, { ballId: "disarm", ownerId: p.sessionId, x: effect.x, y: effect.y + 0.45, z: effect.z, ageMs: 50, vx: 0, vy: 0, vz: 0 }); r.state.balls.set(normal.ballId, normal);
      tick(r); expect(r.state.bonusEffects.size).toBe(0); expect(q.hp).toBe(100); expect(p.hp).toBe(100);
    }
  });

  it("sheep moves toward reachable players, warns before E-only blast and cannot pass shops", async () => {
    const { room, owner, target } = await match(); const sheep = drop(room, owner, "sheep"); owner.x = 14; owner.z = 14;
    target.x = 2; target.z = 8; const startX = sheep.x; tick(room, 4); expect(sheep.x).toBeGreaterThan(startX);
    tick(room, 10); expect(sheep.phase).toBe("warning"); expect(target.hp).toBe(100); tick(room, 20); expect(target.hp).toBe(75); expect(owner.score).toBe(1);
    const { room: r, owner: p, target: q } = await match(); const shop = SERVER_PLATFORMS[0]!;
    const pet = drop(r, p, "sheep", shop.x - shop.hx - 1, shop.z); p.x = 14; p.z = 14; q.x = shop.x + shop.hx + 1; q.z = shop.z;
    for (let i = 0; i < 40 && r.state.bonusEffects.has(pet.effectId); i += 1) { tick(r); expect(Math.abs(pet.x - shop.x) < shop.hx && Math.abs(pet.z - shop.z) < shop.hz).toBe(false); }
  });

  it("temporary surfaces override only their support, newest wins and restores previous surface", async () => {
    const { room, owner, target } = await match(); target.x = 14; target.z = 14;
    const swamp = drop(room, owner, "swamp"); owner.x = 0; owner.z = 8; input(room, owner.sessionId, 1, 0); const x = owner.x; tick(room); expect(owner.x - x).toBeCloseTo(PLAYER_SPEED * 0.61 * 0.05);
    input(room, owner.sessionId, 0, 0); const ice = drop(room, owner, "ice"); owner.x = 0; owner.z = 8;
    input(room, owner.sessionId, 1, 0); const before = owner.x; tick(room); expect(owner.x - before).toBeLessThan(PLAYER_SPEED * 0.61 * 0.05);
    ice.expiresAt = room.testNow! + 50; owner.x = 0; owner.z = 8; const previous = owner.x; tick(room); expect(owner.x - previous).toBeCloseTo(PLAYER_SPEED * 0.61 * 0.05);
    swamp.y = 2; owner.x = 0; owner.z = 8; const floorX = owner.x; tick(room); expect(owner.x - floorX).toBeCloseTo(PLAYER_SPEED * 0.05);
  });

  it.each([["swamp", 2.25, 3], ["ice", 2.7, 3.6]] as const)("%s changes motion in the newly covered region but leaves motion outside its enlarged boundary free", async (kind, inside, radius) => {
    const { room, owner } = await match(); const effect = drop(room, owner, kind);
    owner.x = effect.x + inside; owner.z = effect.z; input(room, owner.sessionId, 1, 0);
    const start = owner.x; tick(room);
    if (kind === "swamp") expect(owner.x - start).toBeCloseTo(PLAYER_SPEED * 0.61 * 0.05);
    else { expect(owner.x - start).toBeGreaterThan(0); expect(owner.x - start).toBeLessThan(PLAYER_SPEED * 0.05); }
    owner.x = effect.x + radius + 0.01; owner.z = effect.z;
    const outside = owner.x; tick(room); expect(owner.x - outside).toBeCloseTo(PLAYER_SPEED * 0.05);
    expect(owner.hp).toBe(100);
  });

  it("the fixed map swamp retains its original slowdown without an installed bonus patch", async () => {
    const { room, owner } = await match(); owner.x = -14.5; owner.z = 0;
    input(room, owner.sessionId, 1, 0); const x = owner.x; tick(room);
    expect(owner.x - x).toBeCloseTo(PLAYER_SPEED * 0.22 * 0.05);
  });

  it("a direct swamp hit installs a five-second patch with half the fixed swamp slowdown and restores free movement at expiry", async () => {
    const { room, owner, target } = await match();
    shoot(room, owner, "swamp"); tick(room, 4);
    const patch = [...room.state.bonusEffects.values()][0]!;
    expect(patch).toMatchObject({ kind: "swamp", y: 0, radius: 3 });
    expect(patch.expiresAt - patch.createdAt).toBe(5000);
    expect(target.hp).toBe(75);

    owner.x = 14; owner.z = 14;
    target.x = patch.x + 2.25; target.z = patch.z;
    input(room, target.sessionId, 1, 0);
    const insideX = target.x; tick(room);
    const bonusStep = target.x - insideX;
    expect(bonusStep).toBeCloseTo(PLAYER_SPEED * 0.61 * 0.05);

    target.x = -14.5; target.z = 0;
    const mapX = target.x; tick(room);
    const mapStep = target.x - mapX;
    expect(mapStep).toBeCloseTo(PLAYER_SPEED * 0.22 * 0.05);
    const normalStep = PLAYER_SPEED * 0.05;
    expect(normalStep - bonusStep).toBeCloseTo((normalStep - mapStep) / 2);

    target.x = patch.x; target.z = patch.z;
    const expiresX = target.x;
    room.testNow = patch.expiresAt; room.tickRoom(50);
    expect(room.state.bonusEffects.has(patch.effectId)).toBe(false);
    expect(target.x - expiresX).toBeCloseTo(normalStep);
    expect(target.hp).toBe(75);
  });

  it("vacuum has no zone damage, bounded shared pull and allows stronger opposing movement", async () => {
    const { room, owner, target } = await match(); const vacuum = drop(room, owner, "vacuum"); owner.x = 14; owner.z = 14;
    target.x = vacuum.x + 1.5; target.z = vacuum.z; const initial = target.x; tick(room, 40); expect(initial - target.x).toBeLessThanOrEqual(1.000001); expect(initial - target.x).toBeGreaterThan(0.8); expect(target.hp).toBe(100); expect(owner.score).toBe(0);
    owner.x = 0; owner.z = 8; drop(room, owner, "vacuum"); owner.x = 14; owner.z = 14; target.x = 1; target.z = 8;
    input(room, target.sessionId, 1, 0); const before = target.x; tick(room, 5); expect(target.x).toBeGreaterThan(before);
  });

  it("boomerang turns at six metres, returns, damages at most once, ends at walls and risks its owner", async () => {
    const { room, owner, target } = await match(); target.x = 14; target.z = 14;
    const id = shoot(room, owner, "boomerang"); const ball = room.state.balls.get(id)!;
    owner.x = ball.originX; owner.z = ball.originZ;
    tick(room, 9); expect(ball.returning).toBe(true); expect(ball.distM).toBeGreaterThan(6);
    let returnVelocity = false; for (let i = 0; i < 40 && room.state.balls.has(id); i += 1) { tick(room); if (ball.vz > 0) returnVelocity = true; }
    expect(returnVelocity).toBe(true); expect(room.state.balls.has(id)).toBe(false); expect(owner.hp).toBe(50); expect(owner.score).toBe(0);
    const { room: r, owner: p, target: q } = await match(); const hit = shoot(r, p, "boomerang"); tick(r, 40); expect(q.hp).toBe(50); expect(p.score).toBe(1); expect(r.state.balls.has(hit)).toBe(false);
    p.x = 0; p.z = -17.5; const wall = shoot(r, p, "boomerang"); tick(r, 4); expect(r.state.balls.has(wall)).toBe(false);
  });

  it("wall placement remains outside solid footprint, roofs preserve support and effects cannot cross floors or shops", async () => {
    const { room, owner, target } = await match(); target.x = 14; target.z = 14;
    const tower = SERVER_OBSTACLES.find((box) => box.topY === 2)!;
    const ice = drop(room, owner, "ice", tower.x, tower.z, tower.topY + 0.001); expect(ice.y).toBe(tower.topY);
    const floorEffect = new BonusEffectState(); Object.assign(floorEffect, { effectId: "floor", throwId: "floor", ownerId: owner.sessionId, kind: "herring", phase: "active", x: tower.x, z: tower.z, y: 0, radius: 1.8, armedAt: 0, createdAt: room.testNow, expiresAt: room.testNow! + 4000 }); room.state.bonusEffects.set("floor", floorEffect);
    target.x = tower.x; target.z = tower.z; target.y = tower.topY + BODY_CENTER_Y; tick(room, 20); expect(target.hp).toBe(100);
    const shop = SERVER_PLATFORMS[0]!;
    expect(bonusLineOfSight(shop.x - shop.hx - 0.1, 0.4, shop.z, shop.x + shop.hx + 0.1, BODY_CENTER_Y, shop.z)).toBe(false);
    owner.x = shop.x - shop.hx - 2; owner.z = shop.z; owner.y = BODY_CENTER_Y; give(room, owner, "swamp"); room.handleFire(owner.sessionId, { power01: 1, yaw: -Math.PI / 2, pitch: 0 }); tick(room, 5);
    const wallEffect = [...room.state.bonusEffects.values()].find((effect) => effect.kind === "swamp")!; expect(wallEffect.x).toBeLessThan(shop.x - shop.hx); expect(wallEffect.y).toBe(0);
  });

  it("reveals every bag kind once, survives rounds and has no boundary repeats", async () => {
    const { room, owner } = await match(); const seen: string[] = []; room.pickupRandom = () => 0.999;
    const bagSize = SUPER_BONUS_KINDS.length;
    for (let i = 0; i < bagSize * 2; i += 1) {
      room.state.superNextAt = room.testNow! + 50; tick(room);
      expect(room.state.superKind).toBe("");
      owner.x = 0; owner.z = 0; tick(room); seen.push(owner.superKind);
      Object.assign(owner, { superKind: "", superUntil: 0, superBuff: false, x: 14, z: 14 });
      if (i === 4) {
        (room as unknown as { endRound(id: string): void }).endRound(owner.sessionId);
        room.testNow = room.testNow! + 5000; room.tickRoom(); room.tickRoom(); room.testNow += 3000; room.tickRoom();
        for (const [id, player] of room.state.players) {
          if (player.isBot) room.state.players.delete(id);
          else Object.assign(player, { x: 14, z: 14 });
        }
      }
    }
    expect(new Set(seen.slice(0, bagSize)).size).toBe(bagSize); expect(new Set(seen.slice(bagSize)).size).toBe(bagSize); expect(seen[bagSize - 1]).not.toBe(seen[bagSize]);
    expect(new Set(seen.slice(0, bagSize))).toEqual(new Set(SUPER_BONUS_KINDS));
  });

  it("defers sheep with live+held reservations, then counts the hidden center and picked slot without exceeding two", async () => {
    const { room, owner, target } = await match(); room.pickupRandom = () => 0.999;
    const effect = drop(room, target, "sheep"); give(room, owner, "sheep");
    await room.onJoin(client("collector")); room.handlePlay(client("collector"), { nick: "collector" });
    const collector = room.state.players.get("collector")!;
    Object.assign(collector, { x: 14, z: 14, y: BODY_CENTER_Y });
    const system = (room as unknown as { bonuses: { sheepCount(): number } }).bonuses;
    const seen: string[] = [];
    for (let i = 0; i < SUPER_BONUS_KINDS.length - 1; i += 1) {
      room.state.superNextAt = room.testNow! + 50; tick(room);
      expect(room.state.superActive).toBe(true); expect(room.state.superKind).toBe(""); expect(system.sheepCount()).toBe(2);
      collector.x = 0; collector.z = 0; tick(room); seen.push(collector.superKind);
      Object.assign(collector, { superKind: "", superUntil: 0, superBuff: false, x: 14, z: 14 });
    }
    expect(new Set(seen)).toEqual(new Set(SUPER_BONUS_KINDS.filter((kind) => kind !== "sheep")));
    room.state.superNextAt = room.testNow! + 50; tick(room);
    expect(room.state.superActive).toBe(false); expect(system.sheepCount()).toBe(2);
    owner.superUntil = room.testNow! + 50; tick(room);
    expect(owner.superKind).toBe(""); expect(room.state.superActive).toBe(true); expect(room.state.superKind).toBe(""); expect(system.sheepCount()).toBe(2);
    collector.x = 0; collector.z = 0; tick(room);
    expect(collector.superKind).toBe("sheep"); expect(room.state.bonusEffects.has(effect.effectId)).toBe(true); expect(system.sheepCount()).toBe(2);
    await room.onLeave(client(collector.sessionId)); expect(system.sheepCount()).toBe(1);
    await room.onLeave(client(target.sessionId)); expect(system.sheepCount()).toBe(0);
  });

  it.each(["round end", "last human disconnect", "round restart"])("%s clears the hidden central kind and sheep reservation", async (reason) => {
    const { room, owner, target } = await match(); room.pickupRandom = () => 0.999;
    room.testNow = room.state.superNextAt; room.tickRoom(50);
    const system = (room as unknown as { bonuses: { sheepCount(): number } }).bonuses;
    expect(system.sheepCount()).toBe(1);
    if (reason === "round end") (room as unknown as { endRound(id: string): void }).endRound(owner.sessionId);
    else if (reason === "round restart") (room as unknown as { startPlaying(now: number): void }).startPlaying(room.testNow!);
    else { await room.onLeave(client(owner.sessionId)); expect(system.sheepCount()).toBe(1); await room.onLeave(client(target.sessionId)); }
    expect(room.state.superActive).toBe(false); expect(room.state.superKind).toBe(""); expect(room.state.superExpiresAt).toBe(0); expect(system.sheepCount()).toBe(0);
    expect(room.state.superNextAt).toBe(reason === "round restart" ? room.testNow! + 10000 : 0);
    if (reason === "round restart") {
      Object.assign(owner, { x: 14, z: 14 }); Object.assign(target, { x: 14, z: 14 });
      room.testNow = room.state.superNextAt; room.tickRoom(50); owner.x = 0; owner.z = 0; tick(room);
      expect(owner.superKind).toBe("turkey");
    }
  });

  it("death clears held/control state but launched effects live; disconnect/end remove objects and ledger", async () => {
    const { room, owner, target } = await match(); const effect = drop(room, owner, "herring"); give(room, owner, "sheep");
    owner.turkeyUntil = owner.frozenUntil = owner.controlImmuneUntil = room.testNow! + 1000; owner.hp = 1; target.x = 0; target.z = 9; owner.x = 0; owner.z = 8;
    give(room, target, "turkey"); room.handleFire(target.sessionId, { power01: 1, yaw: 0, pitch: 0 }); tick(room, 2);
    expect(owner.alive).toBe(false); expect(owner.superKind).toBe(""); expect(owner.turkeyUntil).toBe(0); expect(owner.frozenUntil).toBe(0); expect(room.state.bonusEffects.has(effect.effectId)).toBe(true);
    await room.onLeave(client(owner.sessionId)); expect(room.state.bonusEffects.size).toBe(0);
    give(room, target, "sheep"); const launched = room.spawnBall(target, 1, 0, 0, true, room.testNow! + RELOAD_MS)!;
    expect(launched.bonusKind).toBe("sheep"); room.testNow = LOBBY_COUNTDOWN_MS + 2 + ROUND_DURATION_MS; room.tickRoom();
    expect(room.state.balls.size).toBe(0); expect(room.state.bonusEffects.size).toBe(0); expect(target.superKind).toBe("");
  });

  it("pool eviction releases a flying sheep reservation", async () => {
    const { room, owner, target } = await match(); target.x = 14; target.z = 14;
    const id = shoot(room, owner, "sheep"); const sheep = room.state.balls.get(id)!; sheep.ageMs = 1000;
    for (let i = 0; i < MAX_LIVE_BALLS; i += 1) { owner.reloadUntil = 0; room.spawnBall(owner, 1, 0, 0, false, room.testNow!); }
    expect(room.state.balls.has(id)).toBe(false);
    const system = (room as unknown as { bonuses: { sheepCount(): number } }).bonuses; expect(system.sheepCount()).toBe(0);
  });

  it.each(["soda", "sheep"])("%s combines a direct B with later E but a missed throw receives only E", async (kind) => {
    for (const [power, expected] of [[0.5, 62.5], [1, 50]] as const) {
      const { room, owner, target } = await match(); shoot(room, owner, kind, power); tick(room, 4);
      const effect = [...room.state.bonusEffects.values()][0]!;
      owner.x = 14; owner.z = 14; tick(room, 36);
      expect(target.hp).toBe(expected); expect(owner.score).toBe(1); expect(room.state.bonusEffects.has(effect.effectId)).toBe(false);
    }
    const { room, owner, target } = await match(); const effect = drop(room, owner, kind);
    target.x = effect.x; target.z = effect.z; tick(room, 40); expect(target.hp).toBe(75);
  });

  it("shield spends the cloud budget and the same throw cannot farm points after respawn", async () => {
    const { room, owner, target } = await match(); drop(room, owner, "herring");
    target.x = 0; target.z = 8; target.shieldHp = 25; target.shieldUntil = room.testNow! + 10000;
    tick(room, 60); expect(target.hp).toBe(100); expect(target.shieldHp).toBe(0); expect(owner.score).toBe(1);
    const { room: r, owner: p, target: q } = await match(); q.hp = 25.625;
    shoot(r, p, "herring"); tick(r, 16); expect(p.score).toBe(11);
    tick(r, 2); expect(q.alive).toBe(true);
    q.invulnUntil = 0; q.x = 0; q.z = 7; q.y = BODY_CENTER_Y; q.hp = 0.625;
    tick(r); expect(p.score).toBe(11);
    tick(r, 100);
    const system = (r as unknown as { bonuses: { ledgers: Map<string, unknown> } }).bonuses;
    expect(system.ledgers.size).toBe(0);
  });

  it("cloud, blast and pull respect shop corners and floor/roof separation", async () => {
    for (const kind of ["herring", "soda", "vacuum"]) {
      const { room, owner, target } = await match(); const tower = SERVER_OBSTACLES[0]!;
      const effect = drop(room, owner, kind, tower.x - tower.hx - 0.04, tower.z);
      target.x = tower.x - 0.5; target.z = tower.z + tower.hz + 0.5; target.y = BODY_CENTER_Y;
      const x = target.x; const z = target.z;
      if (kind === "soda") { effect.phase = "warning"; effect.triggerAt = room.testNow! + 50; }
      tick(room, 40); expect(target.hp).toBe(100); expect(target.x).toBe(x); expect(target.z).toBe(z);
    }
  });

  it("roof surfaces affect humans and bots; frozen fighters keep ice drift", async () => {
    const { room, owner, target } = await match(); const tower = SERVER_OBSTACLES[0]!;
    drop(room, owner, "ice", tower.x, tower.z, tower.topY + 0.001);
    owner.x = tower.x; owner.z = tower.z; owner.y = tower.topY + BODY_CENTER_Y;
    input(room, owner.sessionId, 1, 0); const humanX = owner.x; tick(room); expect(owner.x - humanX).toBeGreaterThan(0); expect(owner.x - humanX).toBeLessThan(PLAYER_SPEED * 0.05);
    target.isBot = true; target.x = tower.x; target.z = tower.z; target.y = tower.topY + BODY_CENTER_Y; target.reloadUntil = 1e15;
    (room as unknown as { brains: Map<string, unknown> }).brains.set(target.sessionId, { targetX: tower.x + 1, targetZ: tower.z, retargetAt: 1e15, nextFireAt: 1e15, seed: 1 });
    const botX = target.x; tick(room); expect(target.x - botX).toBeGreaterThan(0); expect(target.x - botX).toBeLessThan(BOT_SPEED * 0.05);
    owner.frozenUntil = room.testNow! + 1000; input(room, owner.sessionId, 1, 0, true); const driftX = owner.x; tick(room); expect(owner.x).toBeGreaterThan(driftX);
  });

  it("sheep uses temporary swamp/ice and trampoline gravity while keeping finite lifetime", async () => {
    const { room, owner } = await match(); drop(room, owner, "swamp"); const sheep = drop(room, owner, "sheep");
    const x = sheep.x; const z = sheep.z; tick(room); expect(Math.hypot(sheep.x - x, sheep.z - z)).toBeCloseTo(3.2 * 0.61 * 0.05);
    const { room: r, owner: p } = await match(); const jumper = drop(r, p, "sheep", 0, 5); expect(jumper.vy).toBe(13.5); tick(r, 3); expect(jumper.y).toBeGreaterThan(0); expect(jumper.vy).toBeLessThan(13.5); tick(r, 120); expect(r.state.bonusEffects.size).toBe(0);
    const { room: r2, owner: p2 } = await match(); drop(r2, p2, "ice"); const slider = drop(r2, p2, "sheep"); const sx = slider.x; const sz = slider.z; tick(r2); expect(Math.hypot(slider.x - sx, slider.z - sz)).toBeLessThan(3.2 * 0.05);
  });

  it("all installed object lifetimes expire safely and release runtime records", async () => {
    for (const kind of ["sheep", "soda", "herring", "swamp", "ice", "vacuum"]) {
      const { room, owner } = await match(); const effect = drop(room, owner, kind);
      room.testNow = effect.expiresAt; room.tickRoom(50);
      expect(room.state.bonusEffects.size).toBe(0);
      const system = (room as unknown as { bonuses: { runtime: Map<string, unknown>; ledgers: Map<string, unknown>; sheepCount(): number } }).bonuses;
      expect(system.runtime.size).toBe(0); expect(system.ledgers.size).toBe(0); expect(system.sheepCount()).toBe(0);
    }
  });

  it("late join full-state encoding includes installed effects, held kind and debuffs", async () => {
    const { room, owner, target } = await match(); const effect = drop(room, owner, "soda"); give(room, owner, "jelly");
    target.frozenUntil = room.testNow! + 1000; target.launchSeq = 3; target.launchVelocity = 10;
    await room.onJoin(client("late")); const serializer = new SchemaSerializer(); serializer.reset(room.state);
    const bytes = serializer.getFullState(client("late")); expect(bytes.length).toBeGreaterThan(0);
    const json = room.state.toJSON(); expect(json["bonusEffects"][effect.effectId]).toMatchObject({ kind: "soda", phase: "arming", armedAt: effect.armedAt });
    expect(json["players"][owner.sessionId]).toMatchObject({ superKind: "jelly", superUntil: owner.superUntil });
    expect(json["players"][target.sessionId]).toMatchObject({ frozenUntil: target.frozenUntil, launchSeq: 3, launchVelocity: 10 });
  });


  it("invulnerability blocks vacuum control, weak boomerang deals 25 and shield contact consumes its single hit", async () => {
    const { room, owner, target } = await match(); const vacuum = drop(room, owner, "vacuum"); target.x = vacuum.x + 1; target.z = vacuum.z; target.invulnUntil = room.testNow! + 10000;
    const x = target.x; tick(room, 20); expect(target.x).toBe(x);
    const { room: r, owner: p, target: q } = await match(); shoot(r, p, "boomerang", 0.5); tick(r, 35); expect(q.hp).toBe(75);
    const { room: r2, owner: p2, target: q2 } = await match(); q2.shieldHp = 50; q2.shieldUntil = r2.testNow! + 5000;
    const id = shoot(r2, p2, "boomerang"); const ball = r2.state.balls.get(id)!; tick(r2, 3); expect(q2.hp).toBe(100); expect(q2.shieldHp).toBe(0); expect(ball.bonusHit).toBe(true);
    p2.x = ball.originX; p2.z = ball.originZ; tick(r2, 40); expect(p2.hp).toBe(100); expect(p2.score).toBe(1);
  });


  it("full shield allows jelly movement while blocking turkey/freeze; invulnerability blocks the launch", async () => {
    for (const kind of ["jelly", "turkey", "freeze"]) {
      const { room, owner, target } = await match();
      target.shieldHp = 50; target.shieldUntil = room.testNow! + 5000;
      shoot(room, owner, kind); tick(room, 3);
      expect(target.hp).toBe(100); expect(target.shieldHp).toBe(12.5);
      expect(target.turkeyUntil).toBe(0); expect(target.frozenUntil).toBe(0);
      if (kind === "jelly") {
        expect(target.launchSeq).toBe(1); expect(target.launchVelocity).toBe(10); expect(target.y).toBeGreaterThan(BODY_CENTER_Y);
      } else expect(target.launchSeq).toBe(0);
    }
    const { room, owner, target } = await match(); target.invulnUntil = room.testNow! + 5000;
    shoot(room, owner, "jelly"); tick(room, 8); expect(target.launchSeq).toBe(0); expect(target.y).toBe(BODY_CENTER_Y);
  });

  it.each(["soda", "sheep"])("%s never detonates after expiry or begins a warning too late to finish", async (kind) => {
    const { room, owner, target } = await match(); const effect = drop(room, owner, kind);
    target.x = effect.x; target.z = effect.z;
    room.testNow = effect.expiresAt - 400; room.tickRoom(50);
    expect(effect.phase).not.toBe("warning"); expect(effect.triggerAt).toBe(0);
    room.testNow = effect.expiresAt + 1000; room.tickRoom(50);
    expect(target.hp).toBe(100); expect(room.state.bonusEffects.size).toBe(0);
    for (const triggerOffset of [-200, 200]) {
      const { room: r, owner: p, target: q } = await match(); const late = drop(r, p, kind);
      q.x = late.x; q.z = late.z; late.phase = "warning"; late.triggerAt = late.expiresAt + triggerOffset;
      r.testNow = late.expiresAt + 1000; r.tickRoom(50);
      expect(q.hp).toBe(100); expect(r.state.bonusEffects.size).toBe(0);
    }
  });


  it.each([-1.3, 0, 1.3])("sheep climbs each reachable platform from ramp foot lateral %s", async (lateral) => {
    for (const platform of SERVER_PLATFORMS) {
      const { room, owner, target } = await match();
      const run = rampRunForTop(platform.topY) + 0.2;
      const source = { x: platform.x, z: platform.z };
      if (platform.rampSide.endsWith("z")) source.x += lateral;
      else source.z += lateral;
      if (platform.rampSide === "+z") source.z += platform.hz + run;
      if (platform.rampSide === "-z") source.z -= platform.hz + run;
      if (platform.rampSide === "+x") source.x += platform.hx + run;
      if (platform.rampSide === "-x") source.x -= platform.hx + run;
      const id = shoot(room, owner, "sheep");
      const ball = room.state.balls.get(id)!;
      Object.assign(ball, { x: source.x, y: 0.15, z: source.z, vx: 0, vy: 0, vz: 0, ageMs: 50 });
      owner.x = platform.x > 0 ? -14 : 14; owner.z = platform.z > 0 ? -14 : 14;
      target.x = platform.x; target.z = platform.z; target.y = platform.topY + BODY_CENTER_Y;
      tick(room);
      const effect = [...room.state.bonusEffects.values()][0]!;
      let climbed = false;
      for (let i = 0; i < 110 && room.state.bonusEffects.has(effect.effectId); i += 1) { tick(room); if (effect.y > platform.topY - 0.2) climbed = true; }
      expect(climbed, `ramp ${platform.rampSide} at ${platform.x},${platform.z}: sheep ended at ${effect.x},${effect.y},${effect.z}`).toBe(true);
    }
  });


  it("two sheep query six inaccessible roofs without repeating full geometry floods", async () => {
    const { room, owner } = await match();
    for (let i = 2; i < 6; i += 1) { await room.onJoin(client(`roof${i}`)); room.handlePlay(client(`roof${i}`), { nick: `roof${i}` }); }
    const first = drop(room, owner, "sheep", 0, 8); const second = drop(room, owner, "sheep", 2, 8);
    [...room.state.players.values()].forEach((player, index) => {
      const roof = SERVER_OBSTACLES[index]!;
      Object.assign(player, { x: roof.x, z: roof.z, y: roof.topY + BODY_CENTER_Y, invulnUntil: 0 });
    });
    const system = (room as unknown as { bonuses: { host: BonusHost; runtime: Map<string, { pathAt: number }> } }).bonuses;
    const move = system.host.move;
    let calls = 0; let maximumRetargetCalls = 0; let retargets = 0;
    system.host.move = (...args) => { calls += 1; return move(...args); };
    for (let i = 0; i < 72; i += 1) {
      const retarget = [...system.runtime.values()].some((runtime) => room.testNow! + 50 >= runtime.pathAt);
      calls = 0; tick(room);
      if (retarget) { retargets += 1; maximumRetargetCalls = Math.max(maximumRetargetCalls, calls); }
    }
    expect(retargets).toBe(18);
    // Counts collision queries instead of timing a shared CI machine. Old
    // reflooding made tens of thousands of geometry calls on these ticks.
    expect(maximumRetargetCalls).toBeLessThan(180);
    expect(room.state.bonusEffects.has(first.effectId)).toBe(true); expect(room.state.bonusEffects.has(second.effectId)).toBe(true);
  });

  it("cached navigation chooses nearest reachable player and repaths after 400ms", async () => {
    const { room, owner, target } = await match(); const roof = SERVER_OBSTACLES[1]!;
    const id = shoot(room, owner, "sheep"); const ball = room.state.balls.get(id)!;
    Object.assign(ball, { x: 0, y: 0.15, z: 8, vx: 0, vy: 0, vz: 0, ageMs: 50 });
    Object.assign(owner, { x: 7, z: 8 }); Object.assign(target, { x: roof.x, z: roof.z, y: roof.topY + BODY_CENTER_Y });
    tick(room); const effect = [...room.state.bonusEffects.values()][0]!;
    expect(effect.vx).toBeGreaterThan(0);
    tick(room, 4); Object.assign(target, { x: -1, z: 8, y: BODY_CENTER_Y });
    const system = (room as unknown as { bonuses: { runtime: Map<string, { pathAt: number }> } }).bonuses;
    const nextPathAt = system.runtime.get(effect.effectId)!.pathAt;
    room.testNow = nextPathAt; room.tickRoom(50);
    expect(effect.vx).toBeLessThan(0);
    expect(system.runtime.get(effect.effectId)!.pathAt).toBe(nextPathAt + 400);
  });

});
