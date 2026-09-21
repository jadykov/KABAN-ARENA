// Stage 4 remote avatars: one capsule + nickname sprite per replicated
// player (self excluded — the local SceneManager avatar stays authoritative
// for the local view). Max 6 draw-call pairs, inside the mobile budget.
// Positions ease through RemoteTrack (lerp/slerp); dead players hide.

import * as THREE from "three";
import { MOVE_SPEED } from "../config";
import {
  AirborneGate,
  applyClothing,
  attachAvatarVisuals,
  createHopState,
  pantsColorForSession,
  resetHopState,
  resetHopVisual,
  updateHopVisual,
  type AvatarVisualsHandle,
  type HopState,
} from "../fx/AvatarVisuals";
import { RemoteTrack, type RemoteTarget } from "./interpolation";
import { paletteForSession, type NetPlayerSnapshot } from "./protocol";
import { NEUTRAL_WHITE, NEUTRAL_WHITE_CSS } from "../palette";

export { paletteForSession as paletteFor };

function makeNameSprite(nick: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (context !== null) {
    context.font = "bold 32px system-ui, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = "rgba(0,0,0,0.55)";
    const textWidth = context.measureText(nick).width;
    context.fillRect(128 - textWidth / 2 - 10, 8, textWidth + 20, 48);
    context.fillStyle = NEUTRAL_WHITE_CSS;
    context.fillText(nick, 128, 34);
  }
  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(2.2, 0.55, 1);
  sprite.position.y = 2.3;
  return sprite;
}

interface RemoteEntry {
  group: THREE.Group;
  rig: THREE.Group;
  body: THREE.Mesh;
  label: THREE.Sprite;
  visuals: AvatarVisualsHandle;
  track: RemoteTrack;
  hop: HopState;
  // Airborne estimator: the eased Y trail's vertical speed, damped so a
  // single snapshot jitter never flips the flight gate. The server now
  // replicates body height every tick (grounded derivation + trampoline
  // arcs), so remote flight/climbing reads live here; local flight (Rapier
  // vy) is unaffected.
  vySmooth: number;
  prevY: number;
  // Two-level flight gate (shared AirborneGate): entry trips it, sustained
  // low vertical speed clears it — same apex-flutter protection as locals.
  gate: AirborneGate;
}

// Damping rate (1/s) for the remote vertical-speed estimate.
const REMOTE_VY_SMOOTH_RATE = 8;

export class RemoteAvatars {
  private readonly scene: THREE.Scene;
  // Template only: each entry clones it and bakes its own two-tone vertex
  // colors (shared geometry can't carry per-player clothing).
  private readonly templateGeometry = new THREE.CapsuleGeometry(0.5, 1.0, 6, 12);
  private readonly entries = new Map<string, RemoteEntry>();

  public constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  public get size(): number {
    return this.entries.size;
  }

  // Full refresh from the latest server snapshot; adds/removes/hides meshes
  // and eases every living remote toward its target with lerp/slerp.
  // R1: spectators (spectator || !ready) are never rendered — only ready
  // fighters appear, so pre-join watchers stay invisible with no ghost body.
  public sync(
    snapshots: readonly NetPlayerSnapshot[],
    selfId: string | null,
    deltaSeconds: number,
  ): void {
    const seen = new Set<string>();
    for (const snapshot of snapshots) {
      if (snapshot.sessionId === selfId) {
        continue;
      }
      if (snapshot.spectator || !snapshot.ready) {
        const stale = this.entries.get(snapshot.sessionId);
        if (stale !== undefined) {
          this.removeEntry(snapshot.sessionId, stale);
        }
        continue;
      }
      seen.add(snapshot.sessionId);
      let entry = this.entries.get(snapshot.sessionId);
      if (entry === undefined) {
        entry = this.createEntry(snapshot);
        this.entries.set(snapshot.sessionId, entry);
      }
      entry.rig.visible = snapshot.alive;
      entry.label.visible = snapshot.alive;
      // Idle hold bob on the remote hand-ball (no charge data replicates, so
      // remotes never swell/flick — local-only anims stay in SceneManager).
      entry.visuals.update(deltaSeconds);
      const target: RemoteTarget = { x: snapshot.x, y: snapshot.y, z: snapshot.z, rotY: snapshot.rotY };
      const prevX = entry.group.position.x;
      const prevZ = entry.group.position.z;
      entry.track.update(target, deltaSeconds);
      entry.group.position.set(entry.track.x, entry.track.y, entry.track.z);
      entry.group.rotation.y = entry.track.rotY;
      if (snapshot.alive) {
        // South Park hop from the eased displacement (same shared code path
        // as the local avatar; the rig keeps the tracked root stable).
        // Climbing/falling remotes glide instead of hopping: vertical speed
        // estimated from the eased Y trail, damped against jitter.
        const moved = Math.hypot(entry.group.position.x - prevX, entry.group.position.z - prevZ);
        const speed01 = deltaSeconds > 0 ? Math.min(1, moved / (deltaSeconds * MOVE_SPEED)) : 0;
        const rawVy = deltaSeconds > 0 ? (entry.group.position.y - entry.prevY) / deltaSeconds : 0;
        entry.prevY = entry.group.position.y;
        const smooth = 1 - Math.exp(-REMOTE_VY_SMOOTH_RATE * Math.max(0, deltaSeconds));
        entry.vySmooth += (rawVy - entry.vySmooth) * smooth;
        const airborne = entry.gate.update(Math.abs(entry.vySmooth), deltaSeconds);
        updateHopVisual(entry.rig, 0, speed01, entry.hop, deltaSeconds, airborne);
      } else {
        // Dead and hidden: clear any residual bounce/glide for the respawn.
        resetHopState(entry.hop);
        resetHopVisual(entry.rig, 0);
        entry.gate.reset();
        entry.vySmooth = 0;
        entry.prevY = entry.group.position.y;
      }
    }
    for (const [sessionId, entry] of this.entries) {
      if (!seen.has(sessionId)) {
        this.removeEntry(sessionId, entry);
      }
    }
  }

  // Living non-self positions for client-side aim assist target picking.
  // Carries the eased body-center Y (server player.y) so the assist aims at
  // the target's real height (tower tops included — bug 2 elevation fix).
  public livingPositions(
    selfId: string | null,
  ): Array<{ sessionId: string; x: number; z: number; alive: boolean; y: number }> {
    const out: Array<{ sessionId: string; x: number; z: number; alive: boolean; y: number }> = [];
    for (const [sessionId, entry] of this.entries) {
      if (sessionId === selfId || !entry.rig.visible) {
        continue;
      }
      out.push({
        sessionId,
        x: entry.group.position.x,
        z: entry.group.position.z,
        alive: true,
        y: entry.group.position.y,
      });
    }
    return out;
  }

  private createEntry(snapshot: NetPlayerSnapshot): RemoteEntry {
    const group = new THREE.Group();
    // Per-entry geometry clone: two-tone clothing is baked as vertex colors,
    // which a shared geometry could never carry per player. Base material is
    // white (identity comes from the vertex colors); disposed with the entry.
    const geometry = this.templateGeometry.clone();
    const shirt = paletteForSession(snapshot.sessionId);
    const material = new THREE.MeshStandardMaterial({ color: NEUTRAL_WHITE, roughness: 0.6, vertexColors: true });
    const body = new THREE.Mesh(geometry, material);
    body.castShadow = false;
    // Rig carries every visual (body, ball, face) so the hop bounce never
    // moves the tracked group root; the label stays outside the rig (no
    // squash on the nickname). Dead-hide on the rig hides everything visual.
    const rig = new THREE.Group();
    rig.add(body);
    applyClothing(body, shirt, pantsColorForSession(snapshot.sessionId));
    const label = makeNameSprite(snapshot.nick);
    // 4d.1: one shared-builder hand-ball + face per remote fighter. Tinted
    // with the same per-session palette color as the shirt; face variant
    // picked from the snapshot session id (stable identity).
    const visuals = attachAvatarVisuals(rig, shirt, snapshot.sessionId);
    rig.visible = snapshot.alive;
    group.add(rig);
    group.add(label);
    group.position.set(snapshot.x, snapshot.y, snapshot.z);
    this.scene.add(group);
    const entry: RemoteEntry = {
      group,
      rig,
      body,
      label,
      visuals,
      track: new RemoteTrack(snapshot.x, snapshot.y, snapshot.z, snapshot.rotY),
      hop: createHopState(snapshot.sessionId),
      vySmooth: 0,
      prevY: snapshot.y,
      gate: new AirborneGate(),
    };
    return entry;
  }

  private removeEntry(sessionId: string, entry: RemoteEntry): void {
    this.entries.delete(sessionId);
    this.scene.remove(entry.group);
    entry.visuals.dispose();
    const bodyGeometry = entry.body.geometry as THREE.BufferGeometry;
    bodyGeometry.dispose();
    const bodyMaterial = entry.body.material as THREE.Material;
    bodyMaterial.dispose();
    const labelMaterial = entry.label.material as THREE.Material;
    const labelMap = (entry.label.material as THREE.SpriteMaterial).map;
    labelMaterial.dispose();
    labelMap?.dispose();
  }

  public dispose(): void {
    for (const [sessionId, entry] of this.entries) {
      this.removeEntry(sessionId, entry);
    }
    this.templateGeometry.dispose();
  }
}
