// Stage 4 remote avatars: one capsule + nickname sprite per replicated
// player (self excluded — the local SceneManager avatar stays authoritative
// for the local view). Max 6 draw-call pairs, inside the mobile budget.
// Positions ease through RemoteTrack (lerp/slerp); dead players hide.
// Remote deaths pop the shared pixel death burst at the victim's last
// tracked position (bug round 5): the alive true→false edge per entry fires
// the onRemoteDeath callback once — players and bots share this path, and
// spectators see it too (particles render in the spectate path).

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
import { HitFlash } from "../fx/CameraShake";
import { RemoteTrack, type RemoteTarget } from "./interpolation";
import { paletteForSession, type NetPlayerSnapshot } from "./protocol";
import { ACCENT_HIT_FLASH, NEUTRAL_WHITE, NEUTRAL_WHITE_CSS } from "../palette";

export { paletteForSession as paletteFor };

// Death-burst seam (bug round 5): fired once per remote alive→false edge
// with the victim's last tracked position + identity color. Scalar numbers
// only — zero per-frame allocation (fires on transitions, never per frame).
export type RemoteDeathHandler = (x: number, y: number, z: number, color: number) => void;

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
  // Per-remote victim hit-flash (Stage 4d.4): own HitFlash timer ticked in
  // sync() against the body's material (emissive ACCENT_HIT_FLASH, 2.5 -> 0
  // over 0.18s — the same wiring as the local avatar). Scalar only, zero
  // per-frame allocs; vertex-colored clothing is unaffected (emissive is
  // independent of diffuse).
  flash: HitFlash;
  material: THREE.MeshStandardMaterial;
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
  // Identity color baked at creation (same paletteForSession value the rig's
  // shirt/hand-ball use) so the death burst reads as THIS fighter.
  color: number;
  // Last seen alive flag (init = first snapshot's alive): the true→false
  // edge fires the death burst exactly once. First sighting of an
  // already-dead remote (late join, respawn window) never bursts.
  wasAlive: boolean;
}

// Damping rate (1/s) for the remote vertical-speed estimate.
const REMOTE_VY_SMOOTH_RATE = 8;

export class RemoteAvatars {
  private readonly scene: THREE.Scene;
  private readonly onRemoteDeath: RemoteDeathHandler | null;
  // Template only: each entry clones it and bakes its own two-tone vertex
  // colors (shared geometry can't carry per-player clothing).
  private readonly templateGeometry = new THREE.CapsuleGeometry(0.5, 1.0, 6, 12);
  private readonly entries = new Map<string, RemoteEntry>();

  public constructor(scene: THREE.Scene, onRemoteDeath: RemoteDeathHandler | null = null) {
    this.scene = scene;
    this.onRemoteDeath = onRemoteDeath;
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
      // Victim hit-flash tick (Stage 4d.4): fades a triggered flash back to
      // emissiveIntensity 0 over 0.18s; idle entries rewrite 0 (scalar, no
      // alloc). Runs for dead entries too so a lethal hit still fades out.
      entry.flash.update(deltaSeconds, entry.material);
      // Death-burst edge (bug round 5): capture the last tracked position
      // BEFORE easing toward the new snapshot — a death snapshot carries no
      // meaningful position; the avatar was last seen alive HERE. Self never
      // reaches this code (skipped above), so the local burst can't double.
      const lastX = entry.group.position.x;
      const lastY = entry.group.position.y;
      const lastZ = entry.group.position.z;
      const died = entry.wasAlive && !snapshot.alive;
      entry.wasAlive = snapshot.alive;
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
        // Fresh kill: burst once at the last tracked position with the
        // entry's identity color, then hide like before. Fires for players
        // and bots alike, playing or spectating (particles render in both
        // paths); removals (leave/reset) go through removeEntry, never here.
        if (died && this.onRemoteDeath !== null) {
          this.onRemoteDeath(lastX, lastY, lastZ, entry.color);
        }
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

  private createEntry(snapshot: NetPlayerSnapshot): RemoteEntry {
    const group = new THREE.Group();
    // Per-entry geometry clone: two-tone clothing is baked as vertex colors,
    // which a shared geometry could never carry per player. Base material is
    // white (identity comes from the vertex colors); disposed with the entry.
    // Emissive is the shared hit-flash red at rest intensity 0 (same wiring
    // as the local avatar in SceneManager) so flashVictim can spike it.
    const geometry = this.templateGeometry.clone();
    const shirt = paletteForSession(snapshot.sessionId);
    const material = new THREE.MeshStandardMaterial({
      color: NEUTRAL_WHITE,
      emissive: ACCENT_HIT_FLASH,
      emissiveIntensity: 0,
      roughness: 0.6,
      vertexColors: true,
    });
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
      flash: new HitFlash(),
      material,
      vySmooth: 0,
      prevY: snapshot.y,
      gate: new AirborneGate(),
      color: shirt,
      wasAlive: snapshot.alive,
    };
    return entry;
  }

  // Remote victim hit-flash (Stage 4d.4): spikes THAT remote's body emissive
  // (visible to all viewers — the flash lives on the replicated avatar, not
  // on the local camera). Unknown ids are a no-op (leave/reset races).
  public flashVictim(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry === undefined) {
      return;
    }
    entry.flash.trigger();
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
