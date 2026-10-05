import {
  CONTROL_IMMUNITY_MS, directBonusDamage, FREEZE_MS, MAX_SHEEP,
  GRENADE_BURST_MS, GRENADE_FRAGMENT_DAMAGE, GRENADE_FRAGMENT_RADIUS,
  SUPER_BONUS_KINDS, SUPER_BONUS_SLOT_MS, TEMPORARY_SWAMP_SPEED_MULT, TURKEY_MS, VACUUM_ACTIVE_MS,
  type SuperBonusKind,
} from "../../shared/super-bonuses.mjs";
import {
  ARENA_HALF_SIZE, BODY_CENTER_Y, HIT_SCORE, KILL_SCORE,
  SERVER_OBSTACLES, SERVER_PLATFORMS, TRAMPOLINE_AIR_DAMPING,
  TRAMPOLINE_GRAVITY, TRAMPOLINE_IMPULSE,
} from "./config.js";
import { absorbShieldDamage, bodyCenterYForFighterAt, canDamage, damageForPower, isOnTrampolinePad, rampHeightAt } from "./hits.js";
import { ArenaState, BallState, BonusEffectState, PlayerState } from "./state.js";

interface ThrowLedger {
  direct: Set<string>;
  scored: Set<string>;
  killed: Set<string>;
  cloudDamage: Map<string, number>;
}
interface NavigationNode { x: number; z: number; feet: number; edges: number[] }
interface NavigationGraph { nodes: NavigationNode[]; cells: Map<string, number[]> }
interface PathSearch { parents?: Int32Array }
interface EffectRuntime {
  pull: Map<string, number>;
  path: { x: number; z: number }[];
  pathAt: number;
  airVelocity: number;
  airborne: boolean;
}
export interface BonusHost {
  state: ArenaState;
  hasCentralSheep(): boolean;
  move(fromX: number, fromZ: number, x: number, z: number, radius: number, feet: number): { x: number; z: number };
  die(victim: PlayerState, owner: PlayerState | undefined, now: number): void;
  launch(victim: PlayerState, velocity: number, now: number): void;
  cancelCharge(victim: PlayerState): void;
  broadcastHit(throwId: string, victim: PlayerState, x: number, y: number, z: number): void;
  surface(x: number, bodyY: number, z: number): "ice" | "swamp" | "temporary-swamp" | "normal";
}

const BONUS_SOLIDS = [...SERVER_OBSTACLES, ...SERVER_PLATFORMS];
const SHEEP_GRID_SPACING = 0.75;
const SHEEP_RADIUS = 0.28;
// The saved room geometry is immutable for the lifetime of this process.
// Build navigation once during room creation, before a round can start.
// Runtime queries only traverse cached edges; they never reflood collision
// geometry for every sheep and every inaccessible rooftop target.
let sheepNavigation: NavigationGraph | undefined;
const cellKey = (x: number, z: number): string => `${x},${z}`;

function walkSheep(host: BonusHost, fromX: number, fromZ: number, feet: number, toX: number, toZ: number): number | null {
  const count = Math.max(1, Math.ceil(Math.hypot(toX - fromX, toZ - fromZ) / (SHEEP_GRID_SPACING / 4)));
  let x = fromX; let z = fromZ;
  for (let step = 1; step <= count; step += 1) {
    const nextX = fromX + (toX - fromX) * step / count;
    const nextZ = fromZ + (toZ - fromZ) * step / count;
    const moved = host.move(x, z, nextX, nextZ, SHEEP_RADIUS, feet);
    const support = bodyCenterYForFighterAt(nextX, nextZ, feet, SHEEP_RADIUS) - BODY_CENTER_Y;
    if (Math.hypot(moved.x - nextX, moved.z - nextZ) > 0.02 || Math.abs(support - feet) > 0.4) return null;
    x = nextX; z = nextZ; feet = support;
  }
  return feet;
}

function navigationFor(host: BonusHost): NavigationGraph {
  if (sheepNavigation !== undefined) return sheepNavigation;
  const graph: NavigationGraph = { nodes: [], cells: new Map() };
  const limit = Math.floor((ARENA_HALF_SIZE - 0.3) / SHEEP_GRID_SPACING);
  for (let gx = -limit; gx <= limit; gx += 1) {
    for (let gz = -limit; gz <= limit; gz += 1) {
      const x = gx * SHEEP_GRID_SPACING; const z = gz * SHEEP_GRID_SPACING;
      const levels = new Set([
        bodyCenterYForFighterAt(x, z, 0, SHEEP_RADIUS) - BODY_CENTER_Y,
        bodyCenterYForFighterAt(x, z, 8, SHEEP_RADIUS) - BODY_CENTER_Y,
      ]);
      const ids: number[] = [];
      for (const feet of levels) {
        const moved = host.move(x, z, x, z, SHEEP_RADIUS, feet);
        if (Math.hypot(moved.x - x, moved.z - z) > 0.02) continue;
        ids.push(graph.nodes.length);
        graph.nodes.push({ x, z, feet, edges: [] });
      }
      if (ids.length > 0) graph.cells.set(cellKey(gx, gz), ids);
    }
  }
  for (const node of graph.nodes) {
    const gx = Math.round(node.x / SHEEP_GRID_SPACING); const gz = Math.round(node.z / SHEEP_GRID_SPACING);
    for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]] as const) {
      const candidates = graph.cells.get(cellKey(gx + dx, gz + dz));
      if (candidates === undefined) continue;
      const feet = walkSheep(host, node.x, node.z, node.feet, (gx + dx) * SHEEP_GRID_SPACING, (gz + dz) * SHEEP_GRID_SPACING);
      if (feet === null) continue;
      const target = candidates.find((id) => Math.abs((graph.nodes[id]?.feet ?? -100) - feet) < 0.001);
      if (target !== undefined) node.edges.push(target);
    }
  }
  sheepNavigation = graph;
  return graph;
}


// A sampled swept segment against the same solid boxes used by movement.
// The short sample length also catches thin entry faces and prevents effects
// behind a shop or below a roof. Endpoints stand above their support plane.
export function bonusLineOfSight(
  ax: number, ay: number, az: number, bx: number, by: number, bz: number,
): boolean {
  const distance = Math.hypot(bx - ax, by - ay, bz - az);
  const steps = Math.max(1, Math.ceil(distance / 0.1));
  for (let i = 1; i < steps; i += 1) {
    const t = i / steps;
    const x = ax + (bx - ax) * t;
    const y = ay + (by - ay) * t;
    const z = az + (bz - az) * t;
    for (const box of BONUS_SOLIDS) {
      if (y > 0.01 && y < box.topY - 0.01 && Math.abs(x - box.x) < box.hx && Math.abs(z - box.z) < box.hz) return false;
    }
    for (const ramp of SERVER_PLATFORMS) {
      const top = rampHeightAt(ramp, x, z);
      if (top > 0 && y < top - 0.01 && y > top - 0.25) return false;
    }
  }
  return true;
}

// Support is selected BELOW the collision point; a package cannot teleport
// up a shop wall. Side contacts are projected outside by ArenaRoom first.
export function bonusSupportBelow(x: number, y: number, z: number): number | null {
  if (!Number.isFinite(x + y + z) || Math.abs(x) > ARENA_HALF_SIZE || Math.abs(z) > ARENA_HALF_SIZE) return null;
  let support = 0;
  for (const box of BONUS_SOLIDS) {
    if (Math.abs(x - box.x) <= box.hx && Math.abs(z - box.z) <= box.hz) {
      if (box.topY > y + 0.05) return null;
      support = Math.max(support, box.topY);
    }
  }
  for (const ramp of SERVER_PLATFORMS) {
    const top = rampHeightAt(ramp, x, z);
    if (top > 0 && top <= y + 0.05) support = Math.max(support, top);
  }
  return support;
}

export class SuperBonusSystem {
  private readonly ledgers = new Map<string, ThrowLedger>();
  private readonly parentThrows = new Map<string, string>();
  private readonly runtime = new Map<string, EffectRuntime>();
  private bag: SuperBonusKind[] = [];
  private lastKind: SuperBonusKind | "" = "";
  private readonly navigation: NavigationGraph;
  constructor(private readonly host: BonusHost, private readonly random: () => number) {
    this.navigation = navigationFor(host);
  }

  public sheepCount(): number {
    const state = this.host.state;
    let count = this.host.hasCentralSheep() ? 1 : 0;
    state.players.forEach((player) => { if (player.superKind === "sheep") count += 1; });
    state.balls.forEach((ball) => { if (ball.bonusKind === "sheep") count += 1; });
    state.bonusEffects.forEach((effect) => { if (effect.kind === "sheep") count += 1; });
    return count;
  }

  public nextKind(): SuperBonusKind | null {
    if (this.bag.length === 0) {
      this.bag = [...SUPER_BONUS_KINDS];
      for (let i = this.bag.length - 1; i > 0; i -= 1) {
        const j = Math.max(0, Math.min(i, Math.floor(this.random() * (i + 1))));
        [this.bag[i], this.bag[j]] = [this.bag[j] as SuperBonusKind, this.bag[i] as SuperBonusKind];
      }
      if (this.bag[0] === this.lastKind && this.bag.length > 1) [this.bag[0], this.bag[1]] = [this.bag[1] as SuperBonusKind, this.bag[0] as SuperBonusKind];
    }
    const canUseSheep = this.sheepCount() < MAX_SHEEP;
    let index = this.bag.findIndex((kind) => kind !== "sheep" || canUseSheep);
    if (this.bag.length === SUPER_BONUS_KINDS.length && this.bag[index] === this.lastKind) {
      const alternative = this.bag.findIndex((kind) => kind !== this.lastKind && (kind !== "sheep" || canUseSheep));
      if (alternative >= 0) index = alternative;
    }
    if (index < 0) return null;
    const kind = this.bag.splice(index, 1)[0] as SuperBonusKind;
    this.lastKind = kind;
    return kind;
  }

  public give(player: PlayerState, kind: string, now: number): void {
    player.superKind = kind;
    player.superUntil = now + SUPER_BONUS_SLOT_MS;
    player.superBuff = true;
  }
  public clearPlayer(player: PlayerState): void {
    player.superKind = "";
    player.superUntil = 0;
    player.superBuff = false;
    player.frozenUntil = 0;
    player.turkeyUntil = 0;
    player.controlImmuneUntil = 0;
    player.launchVelocity = 0;
  }
  public expirePlayer(player: PlayerState, now: number): void {
    if (player.superKind && now >= player.superUntil) {
      player.superKind = "";
      player.superUntil = 0;
      player.superBuff = false;
    }
    if (player.frozenUntil && now >= player.frozenUntil) player.frozenUntil = 0;
    if (player.turkeyUntil && now >= player.turkeyUntil) player.turkeyUntil = 0;
    if (player.controlImmuneUntil && now >= player.controlImmuneUntil) player.controlImmuneUntil = 0;
  }
  public register(ball: BallState): void {
    const throwId = ball.grenadeParentId || ball.ballId;
    if (ball.grenadeParentId) this.parentThrows.set(ball.ballId, throwId);
    this.ledger(throwId);
  }
  public forgetBall(ballId: string): void {
    const throwId = this.parentThrows.get(ballId) ?? ballId;
    this.parentThrows.delete(ballId);
    this.releaseLedger(throwId);
  }
  private ledger(throwId: string): ThrowLedger {
    let ledger = this.ledgers.get(throwId);
    if (ledger === undefined) {
      ledger = { direct: new Set(), scored: new Set(), killed: new Set(), cloudDamage: new Map() };
      this.ledgers.set(throwId, ledger);
    }
    return ledger;
  }
  private releaseLedger(throwId: string): void {
    for (const ball of this.host.state.balls.values()) if ((ball.grenadeParentId || ball.ballId) === throwId) return;
    for (const effect of this.host.state.bonusEffects.values()) if (effect.throwId === throwId) return;
    this.ledgers.delete(throwId);
    for (const [ballId, parentId] of this.parentThrows) if (parentId === throwId) this.parentThrows.delete(ballId);
  }
  public clear(): void {
    this.host.state.bonusEffects.clear();
    this.runtime.clear();
    this.ledgers.clear();
    this.parentThrows.clear();
    this.host.state.players.forEach((player) => this.clearPlayer(player));
    this.host.state.superKind = "";
    this.host.state.superActive = false;
  }
  public removeOwner(ownerId: string): void {
    for (const [id, ball] of this.host.state.balls) if (ball.ownerId === ownerId && ball.bonusKind) {
      this.host.state.balls.delete(id);
      this.forgetBall(id);
    }
    for (const [id, effect] of this.host.state.bonusEffects) if (effect.ownerId === ownerId) this.removeEffect(id);
    for (const id of this.ledgers.keys()) this.releaseLedger(id);
  }

  private damage(throwId: string, ownerId: string, victim: PlayerState, amount: number, now: number, x: number, y: number, z: number): number {
    if (!(amount > 0) || !victim.ready || victim.spectator || !canDamage(victim, now)) return 0;
    const ledger = this.ledger(throwId);
    const owner = this.host.state.players.get(ownerId);
    const { healthDamage } = absorbShieldDamage(victim, amount, now);
    if (owner !== undefined && ownerId !== victim.sessionId && !ledger.scored.has(victim.sessionId)) {
      ledger.scored.add(victim.sessionId);
      owner.score += HIT_SCORE;
    }
    victim.hp = Math.max(0, victim.hp - healthDamage);
    if (healthDamage > 0) this.host.broadcastHit(throwId, victim, x, y, z);
    if (victim.hp <= 0) {
      if (owner !== undefined && ownerId !== victim.sessionId && !ledger.killed.has(victim.sessionId)) {
        ledger.killed.add(victim.sessionId);
        owner.score += KILL_SCORE;
      }
      victim.alive = false;
      this.host.die(victim, owner, now);
    }
    return healthDamage;
  }

  public directHit(ball: BallState, victim: PlayerState, now: number): void {
    const ledger = this.ledger(ball.ballId);
    if (ledger.direct.has(victim.sessionId) || !canDamage(victim, now)) return;
    ledger.direct.add(victim.sessionId);
    const amount = damageForPower(ball.power01, false) + directBonusDamage(ball.bonusKind, ball.power01);
    const healthDamage = this.damage(ball.ballId, ball.ownerId, victim, amount, now, ball.x, ball.y, ball.z);
    if (!victim.alive) return;
    if (ball.bonusKind === "jelly") {
      victim.launchSeq += 1;
      victim.launchVelocity = 10;
      this.host.launch(victim, 10, now);
      return;
    }
    if (healthDamage <= 0) return;
    if (ball.bonusKind === "turkey" && victim.turkeyUntil <= now) victim.turkeyUntil = now + TURKEY_MS;
    if (ball.bonusKind === "freeze" && victim.frozenUntil <= now && victim.controlImmuneUntil <= now) {
      victim.frozenUntil = now + FREEZE_MS;
      victim.controlImmuneUntil = now + FREEZE_MS + CONTROL_IMMUNITY_MS;
      this.host.cancelCharge(victim);
    }
  }
  public alreadyHit(ball: BallState, player: PlayerState): boolean { return this.ledgers.get(ball.ballId)?.direct.has(player.sessionId) ?? false; }

  // A main contact is a visual burst only. A child contact deals exactly
  // half a heart once, with no ordinary projectile damage and no timer.
  public grenadeBurst(ball: BallState, now: number): void {
    const effect = new BonusEffectState();
    effect.effectId = `${ball.ballId}:burst`;
    effect.throwId = ball.grenadeParentId || ball.ballId;
    effect.ownerId = ball.ownerId;
    effect.kind = "grenade";
    effect.phase = "burst";
    effect.x = ball.x; effect.y = ball.y; effect.z = ball.z;
    effect.radius = ball.grenadeFragment ? GRENADE_FRAGMENT_RADIUS : 0.6;
    effect.createdAt = now;
    effect.expiresAt = now + GRENADE_BURST_MS;
    this.host.state.bonusEffects.set(effect.effectId, effect);
    if (!ball.grenadeFragment) return;
    for (const player of this.host.state.players.values()) {
      // Distance to the fighter's vertical body preserves the one-metre
      // floor radius while excluding targets on a different support level.
      const closestY = Math.max(player.y - BODY_CENTER_Y, Math.min(player.y + 0.6, effect.y));
      if (Math.hypot(player.x - effect.x, closestY - effect.y, player.z - effect.z) > effect.radius
        || !bonusLineOfSight(effect.x, effect.y, effect.z, player.x, player.y, player.z)) continue;
      this.damage(effect.throwId, effect.ownerId, player, GRENADE_FRAGMENT_DAMAGE, now, effect.x, effect.y, effect.z);
    }
  }

  public install(ball: BallState, now: number, x = ball.x, y = ball.y, z = ball.z): void {
    if (!["sheep", "herring", "swamp", "ice", "soda", "vacuum"].includes(ball.bonusKind)) return;
    const support = bonusSupportBelow(x, y, z);
    if (support === null) return;
    const effect = new BonusEffectState();
    effect.effectId = `${ball.ballId}:effect`;
    effect.throwId = ball.ballId;
    effect.ownerId = ball.ownerId;
    effect.kind = ball.bonusKind;
    effect.x = x;
    effect.y = support;
    effect.z = z;
    effect.createdAt = now;
    effect.phase = "active";
    if (effect.kind === "herring") { effect.radius = 3.6; effect.expiresAt = now + 4000; effect.armedAt = now + 600; effect.phase = "warning"; }
    if (effect.kind === "swamp") { effect.radius = 3; effect.expiresAt = now + 5000; }
    if (effect.kind === "ice") { effect.radius = 3.6; effect.expiresAt = now + 5000; }
    if (effect.kind === "vacuum") { effect.radius = 4; effect.expiresAt = now + VACUUM_ACTIVE_MS; }
    if (effect.kind === "soda") { effect.radius = 3; effect.expiresAt = now + 6000; effect.armedAt = now + 800; effect.phase = "arming"; }
    if (effect.kind === "sheep") { effect.radius = 4; effect.expiresAt = now + 6000; effect.phase = "chase"; }
    this.host.state.bonusEffects.set(effect.effectId, effect);
    this.runtime.set(effect.effectId, { pull: new Map(), path: [], pathAt: 0, airVelocity: 0, airborne: false });
  }

  private reachable(effect: BonusEffectState, player: PlayerState, radius = effect.radius): boolean {
    if (!player.alive || !player.ready || player.spectator) return false;
    if (Math.abs(player.y - BODY_CENTER_Y - effect.y) > 0.65) return false;
    return Math.hypot(player.x - effect.x, player.z - effect.z) <= radius &&
      bonusLineOfSight(effect.x, effect.y + 0.4, effect.z, player.x, player.y, player.z);
  }
  private removeEffect(id: string): void {
    const effect = this.host.state.bonusEffects.get(id);
    this.host.state.bonusEffects.delete(id);
    this.runtime.delete(id);
    if (effect !== undefined) this.releaseLedger(effect.throwId);
  }
  public disarmAt(ball: BallState): boolean {
    if (ball.bonusKind || ball.super || ball.resting || ball.rolling) return false;
    for (const effect of this.host.state.bonusEffects.values()) {
      if (effect.kind !== "soda" && effect.kind !== "sheep") continue;
      if (Math.hypot(ball.x - effect.x, ball.y - (effect.y + 0.45), ball.z - effect.z) <= 0.65 &&
        bonusLineOfSight(ball.x, ball.y, ball.z, effect.x, effect.y + 0.4, effect.z)) {
        this.removeEffect(effect.effectId);
        return true;
      }
    }
    return false;
  }

  public tick(now: number, dt: number): void {
    const cloudRemaining = new Map<string, number>();
    const pullRemaining = new Map<string, number>();
    for (const effect of this.host.state.bonusEffects.values()) {
      // Expiry wins over a delayed detonation tick. The object cannot cause
      // damage after its lifetime, including an interrupted warning.
      if (now >= effect.expiresAt) { this.removeEffect(effect.effectId); continue; }
      if (effect.triggerAt > 0 && now >= effect.triggerAt) {
        this.explode(effect, now);
        this.removeEffect(effect.effectId);
        continue;
      }
      if (effect.kind === "sheep") this.stepSheep(effect, now, dt);
      if (effect.kind === "soda" && now >= effect.armedAt && effect.phase !== "warning") {
        effect.phase = "armed";
        for (const player of this.host.state.players.values()) {
          if (this.reachable(effect, player, 2) && now + 600 < effect.expiresAt) { effect.phase = "warning"; effect.triggerAt = now + 600; break; }
        }
      }
      if (effect.kind === "herring" && now >= effect.armedAt) {
        effect.phase = "active";
        const ledger = this.ledger(effect.throwId);
        for (const player of this.host.state.players.values()) {
          if (!this.reachable(effect, player) || !canDamage(player, now)) continue;
          const used = ledger.cloudDamage.get(player.sessionId) ?? 0;
          const sharedRemaining = cloudRemaining.get(player.sessionId) ?? 12.5 * dt;
          const amount = Math.min(25 - used, sharedRemaining);
          if (amount <= 1e-9) continue;
          ledger.cloudDamage.set(player.sessionId, used + amount);
          cloudRemaining.set(player.sessionId, sharedRemaining - amount);
          this.damage(effect.throwId, effect.ownerId, player, amount, now, effect.x, effect.y + 0.4, effect.z);
        }
      }
      if (effect.kind === "vacuum") this.pullPlayers(effect, dt, pullRemaining);
    }
  }
  private explode(effect: BonusEffectState, now: number): void {
    for (const player of this.host.state.players.values()) {
      if (!this.reachable(effect, player)) continue;
      const distance = Math.hypot(player.x - effect.x, player.z - effect.z);
      const amount = distance <= effect.radius * 0.5 ? 25 : 12.5;
      this.damage(effect.throwId, effect.ownerId, player, amount, now, effect.x, effect.y + 0.4, effect.z);
    }
  }
  private pullPlayers(effect: BonusEffectState, dt: number, shared: Map<string, number>): void {
    const runtime = this.runtime.get(effect.effectId);
    if (runtime === undefined) return;
    for (const player of this.host.state.players.values()) {
      if (!this.reachable(effect, player) || !canDamage(player, this.host.state.serverNow)) continue;
      const used = runtime.pull.get(player.sessionId) ?? 0;
      const distance = Math.hypot(effect.x - player.x, effect.z - player.z);
      const amount = Math.min(1 - used, shared.get(player.sessionId) ?? 0.5 * dt, Math.max(0, distance - 0.25));
      if (amount <= 0 || distance <= 0) continue;
      const moved = this.host.move(player.x, player.z, player.x + (effect.x - player.x) / distance * amount,
        player.z + (effect.z - player.z) / distance * amount, 0.5, player.y - BODY_CENTER_Y);
      const actual = Math.hypot(moved.x - player.x, moved.z - player.z);
      player.x = moved.x;
      player.z = moved.z;
      runtime.pull.set(player.sessionId, used + actual);
      shared.set(player.sessionId, (shared.get(player.sessionId) ?? 0.5 * dt) - actual);
    }
  }

  private nearbyNavigation(x: number, z: number): number[] {
    const gx = Math.round(x / SHEEP_GRID_SPACING); const gz = Math.round(z / SHEEP_GRID_SPACING);
    const candidates: number[] = [];
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dz = -1; dz <= 1; dz += 1) {
        const ids = this.navigation.cells.get(cellKey(gx + dx, gz + dz));
        if (ids !== undefined) candidates.push(...ids);
      }
    }
    return candidates.sort((a, b) => {
      const left = this.navigation.nodes[a]!; const right = this.navigation.nodes[b]!;
      return Math.hypot(left.x - x, left.z - z) - Math.hypot(right.x - x, right.z - z) || a - b;
    });
  }

  private reachableNavigation(effect: BonusEffectState): Int32Array {
    const nodes = this.navigation.nodes;
    const parents = new Int32Array(nodes.length).fill(-1);
    const queue = new Int32Array(nodes.length);
    let count = 0;
    for (const id of this.nearbyNavigation(effect.x, effect.z)) {
      const node = nodes[id]!;
      if (Math.abs(node.feet - effect.y) > 0.4) continue;
      const support = walkSheep(this.host, effect.x, effect.z, effect.y, node.x, node.z);
      if (support === null || Math.abs(support - node.feet) >= 0.001) continue;
      parents[id] = -2;
      queue[count++] = id;
    }
    for (let cursor = 0; cursor < count; cursor += 1) {
      const id = queue[cursor]!;
      for (const next of nodes[id]!.edges) {
        if (parents[next] !== -1) continue;
        parents[next] = id;
        queue[count++] = next;
      }
    }
    return parents;
  }

  private pathTo(effect: BonusEffectState, target: PlayerState, search: PathSearch): { x: number; z: number }[] | null {
    const targetFeet = target.y - BODY_CENTER_Y;
    if (Math.abs(targetFeet - (bodyCenterYForFighterAt(target.x, target.z, targetFeet, 0.5) - BODY_CENTER_Y)) > 0.2) return null;
    if (Math.abs(effect.y - targetFeet) <= 0.2 && bonusLineOfSight(effect.x, effect.y + 0.35, effect.z, target.x, targetFeet + 0.35, target.z)) {
      const support = walkSheep(this.host, effect.x, effect.z, effect.y, target.x, target.z);
      if (support !== null && Math.abs(support - targetFeet) < 0.25) return [{ x: target.x, z: target.z }];
    }
    const parents = search.parents ??= this.reachableNavigation(effect);
    for (const id of this.nearbyNavigation(target.x, target.z)) {
      const node = this.navigation.nodes[id]!;
      if (parents[id] === -1 || Math.abs(node.feet - targetFeet) >= 0.25) continue;
      const support = walkSheep(this.host, node.x, node.z, node.feet, target.x, target.z);
      if (support === null || Math.abs(support - targetFeet) >= 0.25) continue;
      const path = [{ x: target.x, z: target.z }];
      let cursor = id;
      while (cursor >= 0) {
        const current = this.navigation.nodes[cursor]!;
        path.push({ x: current.x, z: current.z });
        cursor = parents[cursor]!;
      }
      return path.reverse();
    }
    return null;
  }

  private stepSheep(effect: BonusEffectState, now: number, dt: number): void {
    const runtime = this.runtime.get(effect.effectId);
    if (runtime === undefined) return;
    if (effect.phase === "warning") {
      effect.vx = 0; effect.vz = 0;
      this.stepSheepVertical(effect, runtime, dt);
      return;
    }
    if (now >= runtime.pathAt && !runtime.airborne) {
      runtime.pathAt = now + 400;
      runtime.path = [];
      const targets = [...this.host.state.players.values()].filter((player) => player.alive && player.ready && !player.spectator)
        .sort((a, b) => Math.hypot(a.x - effect.x, a.z - effect.z) - Math.hypot(b.x - effect.x, b.z - effect.z) || a.sessionId.localeCompare(b.sessionId));
      const search: PathSearch = {};
      for (const target of targets) {
        const path = this.pathTo(effect, target, search);
        if (path !== null) { runtime.path = path; break; }
      }
    }
    let waypoint = runtime.path[0];
    if (waypoint !== undefined && Math.hypot(waypoint.x - effect.x, waypoint.z - effect.z) < 0.2) { runtime.path.shift(); waypoint = runtime.path[0]; }
    const dx = waypoint !== undefined ? waypoint.x - effect.x : 0;
    const dz = waypoint !== undefined ? waypoint.z - effect.z : 0;
    const length = Math.hypot(dx, dz);
    const surface = runtime.airborne ? "normal" : this.host.surface(effect.x, effect.y + BODY_CENTER_Y, effect.z);
    const speed = 3.2 * (surface === "swamp" ? 0.22 : surface === "temporary-swamp" ? TEMPORARY_SWAMP_SPEED_MULT : 1);
    const vx = length > 0 ? dx / length * speed : 0; const vz = length > 0 ? dz / length * speed : 0;
    if (surface === "ice") {
      const acceleration = Math.min(1, 4 * dt);
      effect.vx += (vx * 0.65 - effect.vx) * acceleration;
      effect.vz += (vz * 0.65 - effect.vz) * acceleration;
    } else { effect.vx = vx; effect.vz = vz; }
    const moved = this.host.move(effect.x, effect.z, effect.x + effect.vx * dt, effect.z + effect.vz * dt, 0.28, effect.y);
    effect.vx = (moved.x - effect.x) / dt; effect.vz = (moved.z - effect.z) / dt;
    effect.x = moved.x; effect.z = moved.z;
    this.stepSheepVertical(effect, runtime, dt);
    for (const player of this.host.state.players.values()) {
      if (this.reachable(effect, player, 0.7) && now + 1000 < effect.expiresAt) { effect.phase = "warning"; effect.triggerAt = now + 1000; break; }
    }
  }
  private stepSheepVertical(effect: BonusEffectState, runtime: EffectRuntime, dt: number): void {
    if (runtime.airborne) {
      const support = bonusSupportBelow(effect.x, effect.y, effect.z) ?? 0;
      runtime.airVelocity = (runtime.airVelocity - TRAMPOLINE_GRAVITY * dt) * Math.exp(-TRAMPOLINE_AIR_DAMPING * dt);
      effect.y += runtime.airVelocity * dt;
      effect.vy = runtime.airVelocity;
      if (runtime.airVelocity <= 0 && effect.y <= support) { effect.y = support; effect.vy = 0; runtime.airborne = false; }
    } else {
      const support = bodyCenterYForFighterAt(effect.x, effect.z, effect.y, 0.28) - BODY_CENTER_Y;
      effect.y = support;
      if (effect.phase !== "warning" && support === 0 && isOnTrampolinePad(effect.x, effect.z)) {
        runtime.airborne = true; runtime.airVelocity = TRAMPOLINE_IMPULSE; effect.vy = TRAMPOLINE_IMPULSE;
      }
    }
  }

}
