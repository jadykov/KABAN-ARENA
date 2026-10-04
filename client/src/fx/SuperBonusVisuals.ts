import * as THREE from "three";
import { FREEZE_MS, TURKEY_MS, getSuperBonus, isSuperBonusKind, type SuperBonusKind } from "../../../shared/super-bonuses.mjs";
import type { NetBonusEffectSnapshot, NetPlayerSnapshot } from "../net/protocol";
import { SuperBonusModels } from "./SuperBonusModels";

export const MAX_BONUS_VISUALS = 24;
export const MAX_BONUS_PLAYER_VISUALS = 24;
export const BONUS_DECAL_OFFSET = 0.065;
export const BONUS_BURST_LIFE_S = 0.32;

interface EffectVisual {
  group: THREE.Group;
  model?: THREE.Group;
  contour: THREE.Mesh;
  warning: THREE.Group;
  cloud?: THREE.Group;
  pull?: THREE.LineSegments;
}
interface EffectSlot {
  id: string | null;
  snapshot: NetBonusEffectSnapshot | null;
  variants: Map<SuperBonusKind, EffectVisual>;
  visual: EffectVisual | null;
}
interface PlayerVisual {
  group: THREE.Group;
  turkey: THREE.Group;
  turkeyModel: THREE.Group;
  frozen: THREE.Group;
  turkeyTimer: THREE.Mesh;
  frozenTimer: THREE.Mesh;
  player: NetPlayerSnapshot;
}
interface Burst {
  group: THREE.Group;
  age: number;
}

function joinedGeometry(pieces: readonly { source: THREE.BufferGeometry; position: readonly [number, number, number]; scale: readonly [number, number, number]; rotZ?: number }[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const point = new THREE.Vector3();
  const matrix = new THREE.Matrix4();
  for (const piece of pieces) {
    matrix.compose(new THREE.Vector3(...piece.position), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, piece.rotZ ?? 0)), new THREE.Vector3(...piece.scale));
    const source = piece.source.getAttribute("position");
    const index = piece.source.getIndex();
    const count = index?.count ?? source.count;
    for (let i = 0; i < count; i += 1) {
      point.fromBufferAttribute(source, index?.getX(i) ?? i).applyMatrix4(matrix);
      positions.push(point.x, point.y, point.z);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

// Everything is snapshot driven. Pools share their geometry/materials and
// never add lights; even a late join recreates the correct warnings and zones.
export class SuperBonusVisuals {
  private readonly root = new THREE.Group();
  private readonly models = new SuperBonusModels();
  private readonly resources = new Set<{ dispose(): void }>();
  private readonly circle = this.track(new THREE.CircleGeometry(1, 32));
  private readonly rim = this.track(new THREE.RingGeometry(0.97, 1, 40));
  private readonly sphere = this.track(new THREE.SphereGeometry(1, 10, 6));
  private readonly box = this.track(new THREE.BoxGeometry(1, 1, 1));
  private readonly cloudGeometry = this.track(joinedGeometry([0, 1, 2].map((i) => ({
    source: this.sphere, position: [Math.cos(i * Math.PI * 2 / 3) * 0.32, 0.55 + i * 0.09, Math.sin(i * Math.PI * 2 / 3) * 0.32] as const, scale: [0.56, 0.34, 0.56] as const,
  }))));
  private readonly boneGeometry = this.track(joinedGeometry([
    { source: this.box, position: [0, 0, 0], scale: [0.33, 0.027, 0.027] },
    ...[-0.09, 0, 0.09].map((x) => ({ source: this.box, position: [x, 0, 0] as const, scale: [0.022, 0.19, 0.02] as const, rotZ: -0.4 })),
  ]));
  private readonly frostEdges = this.track(new THREE.EdgesGeometry(this.box));
  private readonly fills = new Map<SuperBonusKind, THREE.MeshBasicMaterial>();
  private readonly contours = new Map<SuperBonusKind, THREE.MeshBasicMaterial>();
  private readonly warningMaterial = this.track(new THREE.MeshBasicMaterial({ color: 0xff3d49, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
  private readonly blushMaterial = this.track(new THREE.MeshBasicMaterial({ color: 0xff263d, transparent: true, opacity: 0.34, depthWrite: false }));
  private readonly cloudMaterial = this.track(new THREE.MeshBasicMaterial({ color: 0xa9ce70, transparent: true, opacity: 0.13, depthWrite: false }));
  private readonly boneMaterial = this.track(new THREE.MeshBasicMaterial({ color: 0xd9e9a8, transparent: true, opacity: 0.65, depthWrite: false }));
  private readonly frostMaterial = this.track(new THREE.MeshBasicMaterial({ color: 0x8edfff, transparent: true, opacity: 0.13, depthWrite: false }));
  private readonly frostLineMaterial = this.track(new THREE.LineBasicMaterial({ color: 0xa8f0ff, transparent: true, opacity: 0.78, depthWrite: false, toneMapped: false }));
  private readonly pullMaterial = this.track(new THREE.LineBasicMaterial({ color: 0xd0b3ed, transparent: true, opacity: 0.42, depthWrite: false, toneMapped: false }));
  private readonly timerMaterial = this.track(new THREE.MeshBasicMaterial({ color: 0xddf8ff, toneMapped: false }));
  private readonly timerBackMaterial = this.track(new THREE.MeshBasicMaterial({ color: 0x243746 }));
  private readonly burstMaterial = this.track(new THREE.MeshBasicMaterial({ color: 0xffc97b, transparent: true, opacity: 0.45, depthWrite: false, toneMapped: false }));
  private readonly slots: EffectSlot[] = [];
  private readonly players = new Map<string, PlayerVisual>();
  private readonly bursts: Burst[] = [];
  private readonly seen = new Set<string>();
  private readonly seenPlayers = new Set<string>();
  private disposed = false;

  public constructor(private readonly scene: THREE.Scene) {
    this.root.name = "super-bonus-effects";
    scene.add(this.root);
    for (let i = 0; i < MAX_BONUS_VISUALS; i += 1) this.slots.push({ id: null, snapshot: null, variants: new Map(), visual: null });
    for (let i = 0; i < 4; i += 1) {
      const group = new THREE.Group();
      group.name = "bonus-explosion";
      const ring = new THREE.Mesh(this.rim, this.burstMaterial);
      ring.rotation.x = -Math.PI / 2;
      group.add(ring);
      const core = new THREE.Mesh(this.sphere, this.burstMaterial);
      core.scale.set(0.32, 0.18, 0.32);
      core.position.y = 0.15;
      group.add(core);
      group.visible = false;
      this.root.add(group);
      this.bursts.push({ group, age: BONUS_BURST_LIFE_S });
    }
  }

  private track<T extends { dispose(): void }>(resource: T): T {
    this.resources.add(resource);
    return resource;
  }

  private paint(kind: SuperBonusKind, contour: boolean): THREE.MeshBasicMaterial {
    const cache = contour ? this.contours : this.fills;
    const previous = cache.get(kind);
    if (previous !== undefined) return previous;
    const color = kind === "swamp" ? 0x83994b : getSuperBonus(kind)?.color ?? 0xffffff;
    const material = this.track(new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: contour ? 0.8 : kind === "swamp" ? 0.24 : kind === "ice" ? 0.15 : 0.045,
      depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    }));
    cache.set(kind, material);
    return material;
  }

  private createEffect(kind: SuperBonusKind): EffectVisual {
    const group = new THREE.Group();
    group.name = `bonus-effect-${kind}`;
    group.userData["bonusKind"] = kind;
    const floor = new THREE.Mesh(this.circle, this.paint(kind, false));
    floor.name = "bonus-zone-fill";
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = BONUS_DECAL_OFFSET;
    group.add(floor);
    const contour = new THREE.Mesh(this.rim, this.paint(kind, true));
    contour.name = "bonus-zone-contour";
    contour.rotation.x = -Math.PI / 2;
    contour.position.y = BONUS_DECAL_OFFSET + 0.005;
    group.add(contour);
    const warning = new THREE.Group();
    warning.name = "bonus-warning";
    const danger = new THREE.Mesh(this.rim, this.warningMaterial);
    danger.rotation.x = -Math.PI / 2;
    danger.position.y = BONUS_DECAL_OFFSET + 0.012;
    warning.add(danger);
    group.add(warning);
    const visual: EffectVisual = { group, contour, warning };
    if (kind === "sheep" || kind === "soda" || kind === "vacuum" || kind === "herring") {
      const anchor = new THREE.Group();
      anchor.name = "bonus-support-model";
      anchor.position.y = kind === "sheep" ? 0.35 : kind === "soda" ? 0.32 : kind === "vacuum" ? 0.28 : 0.15;
      const model = this.models.create(kind);
      anchor.add(model);
      group.add(anchor);
      visual.model = model;
    }
    if (kind === "sheep") {
      const blush = new THREE.Mesh(this.sphere, this.blushMaterial);
      blush.name = "sheep-red-warning";
      blush.position.y = 0.39;
      blush.scale.set(0.4, 0.31, 0.31);
      warning.add(blush);
    }
    if (kind === "herring") {
      const cloud = new THREE.Group();
      cloud.name = "herring-cloud";
      const puff = new THREE.Mesh(this.cloudGeometry, this.cloudMaterial);
      cloud.add(puff);
      const bone = new THREE.Mesh(this.boneGeometry, this.boneMaterial);
      bone.name = "herring-fishbone";
      bone.position.y = 0.8;
      cloud.add(bone);
      group.add(cloud);
      visual.cloud = cloud;
    }
    if (kind === "ice" || kind === "swamp") {
      const markings = new THREE.Group();
      markings.name = kind === "ice" ? "ice-cracks" : "swamp-ripples";
      for (let i = 0; i < 3; i += 1) {
        const marking = new THREE.Mesh(kind === "ice" ? this.box : this.rim, this.paint(kind, true));
        marking.position.set((i - 1) * 0.33, BONUS_DECAL_OFFSET + 0.009, Math.sin(i * 2) * 0.25);
        if (kind === "ice") {
          marking.scale.set(0.39, 0.003, 0.01);
          marking.rotation.y = i * 1.2;
        } else {
          marking.rotation.x = -Math.PI / 2;
          marking.scale.setScalar(0.13);
        }
        markings.add(marking);
      }
      group.add(markings);
    }
    if (kind === "vacuum") {
      const points: number[] = [];
      for (let i = 0; i < 8; i += 1) {
        const angle = i * Math.PI / 4;
        for (const radius of [0.65, 0.9]) points.push(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
      }
      const geometry = this.track(new THREE.BufferGeometry());
      geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
      const pull = new THREE.LineSegments(geometry, this.pullMaterial);
      pull.name = "vacuum-pull-lines";
      pull.position.y = 0.15;
      group.add(pull);
      visual.pull = pull;
    }
    group.visible = false;
    this.root.add(group);
    return visual;
  }

  private burstAt(snapshot: NetBonusEffectSnapshot): void {
    const burst = this.bursts.find((candidate) => !candidate.group.visible);
    if (burst === undefined) return;
    burst.age = 0;
    burst.group.visible = true;
    burst.group.position.set(snapshot.x, snapshot.y + BONUS_DECAL_OFFSET, snapshot.z);
    burst.group.scale.setScalar(0.2);
  }

  private release(slot: EffectSlot, now: number, authoritativeRemoval: boolean): void {
    const previous = slot.snapshot;
    // A shot/disconnect removes a warning before its timer: it must disappear
    // quietly. Only a confirmed removal close to the explosion deadline bursts.
    if (authoritativeRemoval && previous !== null && (previous.kind === "sheep" || previous.kind === "soda") &&
        previous.phase === "warning" && previous.triggerAt > 0 && now >= previous.triggerAt && now - previous.triggerAt <= 500) {
      this.burstAt(previous);
    }
    if (slot.visual !== null) slot.visual.group.visible = false;
    slot.id = null;
    slot.snapshot = null;
    slot.visual = null;
  }

  public sync(effects: readonly NetBonusEffectSnapshot[], players: readonly NetPlayerSnapshot[], serverNow: number): void {
    if (this.disposed || !Number.isFinite(serverNow)) return;
    this.seen.clear();
    for (const effect of effects) {
      if (this.seen.size >= MAX_BONUS_VISUALS) break;
      if (!isSuperBonusKind(effect.kind) || !effect.effectId || ![effect.x, effect.y, effect.z, effect.radius, effect.expiresAt].every(Number.isFinite) || effect.expiresAt <= serverNow) continue;
      this.seen.add(effect.effectId);
    }
    for (const slot of this.slots) {
      if (slot.id !== null && !this.seen.has(slot.id)) this.release(slot, serverNow, true);
    }
    for (const effect of effects) {
      if (!this.seen.has(effect.effectId)) continue;
      if (!isSuperBonusKind(effect.kind) || ![effect.x, effect.y, effect.z, effect.radius, effect.expiresAt].every(Number.isFinite) || effect.expiresAt <= serverNow) continue;
      let slot = this.slots.find((candidate) => candidate.id === effect.effectId);
      slot ??= this.slots.find((candidate) => candidate.id === null);
      if (slot === undefined) continue;
      if (slot.visual !== null) slot.visual.group.visible = false;
      let visual = slot.variants.get(effect.kind);
      if (visual === undefined) {
        visual = this.createEffect(effect.kind);
        slot.variants.set(effect.kind, visual);
      }
      slot.id = effect.effectId;
      slot.snapshot = { ...effect };
      slot.visual = visual;
      visual.group.userData["effectId"] = effect.effectId;
      visual.group.visible = true;
      visual.group.position.set(effect.x, effect.y, effect.z);
      const radius = Math.max(0.25, Math.min(4, effect.radius));
      visual.contour.scale.setScalar(radius);
      const floor = visual.group.getObjectByName("bonus-zone-fill");
      if (floor !== undefined) floor.scale.setScalar(radius);
      visual.warning.visible = effect.phase === "warning";
      const danger = visual.warning.children[0];
      if (danger !== undefined) danger.scale.setScalar(radius);
      if (visual.cloud !== undefined) visual.cloud.scale.set(radius, 1, radius);
      const markings = visual.group.getObjectByName(effect.kind === "ice" ? "ice-cracks" : "swamp-ripples");
      if (markings !== undefined) markings.scale.set(radius, 1, radius);
    }
    this.syncPlayers(players, serverNow);
    this.animate(serverNow);
  }

  private timer(parent: THREE.Group): THREE.Mesh {
    const back = new THREE.Mesh(this.box, this.timerBackMaterial);
    back.position.y = 1.33;
    back.scale.set(0.86, 0.075, 0.045);
    parent.add(back);
    const fill = new THREE.Mesh(this.box, this.timerMaterial);
    fill.name = "bonus-status-time";
    fill.position.set(0, 1.33, 0);
    fill.scale.set(0.8, 0.045, 0.055);
    parent.add(fill);
    return fill;
  }

  private createPlayer(player: NetPlayerSnapshot): PlayerVisual {
    const group = new THREE.Group();
    group.name = "bonus-player-status";
    group.userData["sessionId"] = player.sessionId;
    const turkey = new THREE.Group();
    turkey.name = "bonus-turkey-helmet";
    const anchor = new THREE.Group();
    anchor.position.y = 0.95;
    anchor.rotation.y = Math.PI;
    const turkeyModel = this.models.create("turkey");
    anchor.add(turkeyModel);
    turkey.add(anchor);
    group.add(turkey);
    const frozen = new THREE.Group();
    frozen.name = "bonus-frozen-player";
    const shell = new THREE.Mesh(this.box, this.frostMaterial);
    shell.scale.set(1.05, 2.1, 1.05);
    frozen.add(shell);
    const edges = new THREE.LineSegments(this.frostEdges, this.frostLineMaterial);
    edges.scale.copy(shell.scale);
    frozen.add(edges);
    // Cracks expose the avatar instead of filling its view with opaque ice.
    const cracksGeometry = this.track(new THREE.BufferGeometry());
    cracksGeometry.setAttribute("position", new THREE.Float32BufferAttribute([
      -0.25, 0.85, -0.532, 0.02, 0.4, -0.532, 0.02, 0.4, -0.532, -0.12, 0.05, -0.532,
      0.02, 0.4, -0.532, 0.34, 0.28, -0.532, -0.12, 0.05, -0.532, 0.12, -0.45, -0.532,
    ], 3));
    const cracks = new THREE.LineSegments(cracksGeometry, this.frostLineMaterial);
    cracks.name = "frozen-cracks";
    frozen.add(cracks);
    group.add(frozen);
    const result: PlayerVisual = { group, turkey, turkeyModel, frozen, turkeyTimer: this.timer(turkey), frozenTimer: this.timer(frozen), player };
    this.root.add(group);
    return result;
  }

  private syncPlayers(players: readonly NetPlayerSnapshot[], now: number): void {
    this.seenPlayers.clear();
    for (const player of players) {
      if (this.seenPlayers.size >= MAX_BONUS_PLAYER_VISUALS) break;
      if (!player.alive || player.spectator || ![player.x, player.y, player.z].every(Number.isFinite) || !((player.frozenUntil ?? 0) > now || (player.turkeyUntil ?? 0) > now)) continue;
      this.seenPlayers.add(player.sessionId);
      let visual = this.players.get(player.sessionId);
      if (visual === undefined) {
        // Reassign a hidden player rig to bound objects/resources over many joins.
        const unused = [...this.players.entries()].find(([id, rig]) => !rig.group.visible && !this.seenPlayers.has(id));
        if (unused !== undefined) {
          this.players.delete(unused[0]);
          visual = unused[1];
          visual.group.userData["sessionId"] = player.sessionId;
        } else if (this.players.size < MAX_BONUS_PLAYER_VISUALS) {
          visual = this.createPlayer(player);
        }
        if (visual === undefined) continue;
        this.players.set(player.sessionId, visual);
      }
      visual.player = player;
      visual.group.visible = true;
      visual.group.position.set(player.x, player.y, player.z);
      visual.group.rotation.y = player.rotY;
    }
    for (const [id, visual] of this.players) if (!this.seenPlayers.has(id)) visual.group.visible = false;
  }

  private setTimer(mesh: THREE.Mesh, remaining: number, duration: number): void {
    const fraction = Math.max(0, Math.min(1, remaining / duration));
    mesh.scale.x = 0.8 * fraction;
    mesh.position.x = -0.4 + 0.4 * fraction;
  }

  private animate(now: number): void {
    const seconds = now / 1000;
    for (const slot of this.slots) {
      const effect = slot.snapshot;
      const visual = slot.visual;
      if (effect === null || visual === null) continue;
      const radius = Math.max(0.25, Math.min(4, effect.radius));
      if (visual.model !== undefined) {
        this.models.animate(visual.model, seconds, effect.phase, Math.hypot(effect.vx, effect.vz));
        if (effect.kind === "sheep" && Math.hypot(effect.vx, effect.vz) > 0.05) visual.model.rotation.y = Math.atan2(-effect.vx, -effect.vz);
      }
      if (visual.warning.visible) {
        const danger = visual.warning.children[0];
        if (danger !== undefined) danger.scale.setScalar(radius * (0.96 + Math.sin(seconds * 18) * 0.04));
      }
      if (effect.kind === "soda") {
        const arm = effect.armedAt > effect.createdAt ? Math.max(0, Math.min(1, (now - effect.createdAt) / (effect.armedAt - effect.createdAt))) : 1;
        visual.contour.scale.setScalar(radius * (effect.phase === "arming" ? 0.4 + 0.6 * arm : 1));
      }
      if (visual.cloud !== undefined) {
        visual.cloud.rotation.y = seconds * 0.2;
        visual.cloud.scale.y = effect.phase === "warning" ? 0.35 : 0.95 + Math.sin(seconds * 2.2) * 0.05;
      }
      if (visual.pull !== undefined) visual.pull.scale.setScalar(radius * (0.24 + (1 - (seconds * 1.2) % 1) * 0.75));
    }
    for (const visual of this.players.values()) {
      if (!visual.group.visible) continue;
      const frozenRemaining = (visual.player.frozenUntil ?? 0) - now;
      const turkeyRemaining = (visual.player.turkeyUntil ?? 0) - now;
      visual.frozen.visible = frozenRemaining > 0;
      visual.turkey.visible = turkeyRemaining > 0;
      visual.group.visible = visual.frozen.visible || visual.turkey.visible;
      if (visual.frozen.visible) this.setTimer(visual.frozenTimer, frozenRemaining, FREEZE_MS);
      if (visual.turkey.visible) {
        this.setTimer(visual.turkeyTimer, turkeyRemaining, TURKEY_MS);
        this.models.animate(visual.turkeyModel, seconds);
      }
    }
  }

  public update(dt: number, serverNow: number): void {
    if (this.disposed || !Number.isFinite(serverNow)) return;
    for (const slot of this.slots) {
      if (slot.snapshot !== null && slot.snapshot.expiresAt <= serverNow) this.release(slot, serverNow, false);
    }
    this.animate(serverNow);
    const delta = Number.isFinite(dt) ? Math.max(0, Math.min(0.25, dt)) : 0;
    for (const burst of this.bursts) {
      if (!burst.group.visible) continue;
      burst.age += delta;
      burst.group.visible = burst.age < BONUS_BURST_LIFE_S;
      burst.group.scale.setScalar(0.2 + burst.age / BONUS_BURST_LIFE_S * 1.5);
    }
  }

  public reset(): void {
    for (const slot of this.slots) this.release(slot, 0, false);
    for (const visual of this.players.values()) visual.group.visible = false;
    for (const burst of this.bursts) {
      burst.group.visible = false;
      burst.age = BONUS_BURST_LIFE_S;
    }
    this.seen.clear();
    this.seenPlayers.clear();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.reset();
    this.scene.remove(this.root);
    this.root.clear();
    this.models.dispose();
    this.resources.forEach((resource) => resource.dispose());
    this.resources.clear();
    this.players.clear();
    this.slots.length = 0;
    this.bursts.length = 0;
  }
}
