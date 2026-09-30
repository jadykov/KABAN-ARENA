import * as THREE from "three";
import { HL_SHIELD } from "../palette";

export type PowerEffectKind = "shield" | "speed" | "charge";

export const BADGE_SECONDS = 1.5;
const BADGE_SIZE_M = 0.36;
// The capsule crown is 1m above the rig origin. Keep the small badge just
// clear of it so the follow camera sees it without losing it near the top.
const BADGE_Y_M = 1.55;
const SHIELD_RADIUS_M = 0.88;
const SHIELD_PULSE_AMPLITUDE = 0.035;
const SHIELD_PULSE_RATE = 2.4;
const WIND_BOB_AMPLITUDE_M = 0.015;
const WIND_BOB_RATE = 4;
const WIND_SECTIONS = 12;
const WIND_WIDTH_STEPS = 4;
const WIND_RUN_THRESHOLD = 0.25;
const CHARGE_ORB_RADIUS_M = 0.11;
const CHARGE_ORBIT_RADIUS_M = 0.76;
const CHARGE_ORBIT_RATE = 1.6;

let shieldIconTexture: THREE.Texture | null = null;
let speedIconTexture: THREE.Texture | null = null;
let chargeIconTexture: THREE.Texture | null = null;
let iconUsers = 0;

function acquireIcons(): void {
  iconUsers += 1;
  if (shieldIconTexture !== null && speedIconTexture !== null && chargeIconTexture !== null) return;
  // Headless scene tests have no image loader. They still exercise the effect
  // meshes; browser builds load the three real SVG assets from public/icons.
  if (typeof document === "undefined" || typeof document.createElementNS !== "function") {
    shieldIconTexture = new THREE.Texture();
    speedIconTexture = new THREE.Texture();
    chargeIconTexture = new THREE.Texture();
  } else {
    const loader = new THREE.TextureLoader();
    shieldIconTexture = loader.load("/icons/bonus-shield.svg");
    speedIconTexture = loader.load("/icons/bonus-speed.svg");
    chargeIconTexture = loader.load("/icons/bonus-charge.svg");
  }
  shieldIconTexture.colorSpace = THREE.SRGBColorSpace;
  speedIconTexture.colorSpace = THREE.SRGBColorSpace;
  chargeIconTexture.colorSpace = THREE.SRGBColorSpace;
}

function releaseIcons(): void {
  iconUsers = Math.max(0, iconUsers - 1);
  if (iconUsers !== 0) return;
  shieldIconTexture?.dispose();
  speedIconTexture?.dispose();
  chargeIconTexture?.dispose();
  shieldIconTexture = null;
  speedIconTexture = null;
  chargeIconTexture = null;
}

// Two quiet, curved ribbons share one mesh. Their width tapers at both ends;
// vertex alpha feathers the edges and fades the tail without a texture or
// particles. Build the small buffers once, then animate only the transform.
function makeSpeedWakeGeometry(): THREE.BufferGeometry {
  const rowSize = WIND_WIDTH_STEPS + 1;
  const ribbonSize = (WIND_SECTIONS + 1) * rowSize;
  const positions = new Float32Array(2 * ribbonSize * 3);
  const colors = new Float32Array(2 * ribbonSize * 4);
  const indices: number[] = [];
  const color = new THREE.Color(0xcff4e5);
  for (let ribbon = 0; ribbon < 2; ribbon += 1) {
    const side = ribbon === 0 ? -1 : 1;
    const length = ribbon === 0 ? 1.25 : 1.04;
    const startY = ribbon === 0 ? 0.18 : -0.12;
    for (let section = 0; section <= WIND_SECTIONS; section += 1) {
      const t = section / WIND_SECTIONS;
      const curve = Math.sin(t * Math.PI);
      const centerX = side * (0.48 + 0.16 * curve - 0.12 * t);
      const centerY = startY + 0.11 * curve - 0.08 * t;
      const z = -0.3 - length * t;
      const halfWidth = 0.085 * curve * (1 - 0.3 * t);
      const alpha = curve * (1 - 0.65 * t);
      for (let edge = 0; edge < rowSize; edge += 1) {
        const across = 2 * edge / WIND_WIDTH_STEPS - 1;
        const vertex = ribbon * ribbonSize + section * rowSize + edge;
        positions[vertex * 3] = centerX + side * across * halfWidth * 0.35;
        positions[vertex * 3 + 1] = centerY + across * halfWidth;
        positions[vertex * 3 + 2] = z;
        colors[vertex * 4] = color.r;
        colors[vertex * 4 + 1] = color.g;
        colors[vertex * 4 + 2] = color.b;
        colors[vertex * 4 + 3] = alpha * (1 - across * across);
        if (section < WIND_SECTIONS && edge < WIND_WIDTH_STEPS) {
          const next = vertex + rowSize;
          indices.push(vertex, next, vertex + 1, vertex + 1, next, next + 1);
        }
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 4));
  geometry.setIndex(indices);
  return geometry;
}

// Small shared visual vocabulary for local and remote fighters. All geometry
// is built once per avatar; update only changes transforms and visibility.
export class PowerEffectVisuals {
  private readonly parent: THREE.Object3D;
  private readonly shield: THREE.Mesh;
  private readonly runTrail: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private readonly chargeOrb: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>;
  private readonly badge: THREE.Sprite;
  private speedActive = false;
  private runningSpeed = 0;
  private badgeLeft = 0;
  private phase = 0;
  private disposed = false;

  public constructor(parent: THREE.Object3D) {
    this.parent = parent;
    const shieldGeometry = new THREE.SphereGeometry(SHIELD_RADIUS_M, 14, 10);
    const shieldMaterial = new THREE.MeshBasicMaterial({
      color: HL_SHIELD,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
      side: THREE.BackSide,
    });
    this.shield = new THREE.Mesh(shieldGeometry, shieldMaterial);
    this.shield.name = "bonus-shield";
    this.shield.visible = false;
    parent.add(this.shield);

    // The rig faces local +Z. Both ribbons stay behind it through turns and
    // replace the old ordinary-run strips and rotating bonus wind together.
    const trailMaterial = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.58,
      depthWrite: false,
      side: THREE.DoubleSide,
      forceSinglePass: true,
    });
    this.runTrail = new THREE.Mesh(makeSpeedWakeGeometry(), trailMaterial);
    this.runTrail.name = "run-wind-trail";
    this.runTrail.visible = false;
    parent.add(this.runTrail);

    // One small ball circles the waist independently of movement. Shading
    // and a modest emissive base keep it legible at night without a light,
    // pulsing brightness, particles or another trail.
    this.chargeOrb = new THREE.Mesh(
      new THREE.SphereGeometry(CHARGE_ORB_RADIUS_M, 12, 8),
      new THREE.MeshStandardMaterial({
        color: 0xd8ea70,
        emissive: 0xd8ea70,
        emissiveIntensity: 0.22,
        roughness: 0.45,
      }),
    );
    this.chargeOrb.name = "bonus-charge-orb";
    this.chargeOrb.position.set(CHARGE_ORBIT_RADIUS_M, 0, 0);
    this.chargeOrb.visible = false;
    parent.add(this.chargeOrb);

    acquireIcons();
    const badgeMaterial = new THREE.SpriteMaterial({
      map: shieldIconTexture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.badge = new THREE.Sprite(badgeMaterial);
    this.badge.name = "bonus-badge";
    this.badge.position.y = BADGE_Y_M;
    this.badge.scale.set(BADGE_SIZE_M, BADGE_SIZE_M, 1);
    this.badge.renderOrder = 20;
    this.badge.visible = false;
    parent.add(this.badge);
  }

  public setActive(shieldActive: boolean, speedActive: boolean, chargeActive: boolean = false): void {
    this.shield.visible = shieldActive;
    this.speedActive = speedActive;
    this.chargeOrb.visible = chargeActive;
    this.refreshSpeedWake();
  }

  public setRunning(speed01: number): void {
    this.runningSpeed = Number.isFinite(speed01) ? Math.max(0, Math.min(1, speed01)) : 0;
    this.refreshSpeedWake();
  }

  private refreshSpeedWake(): void {
    this.runTrail.visible = this.speedActive && this.runningSpeed > WIND_RUN_THRESHOLD;
    this.runTrail.material.opacity = 0.38 + 0.2 * this.runningSpeed;
  }

  public reset(): void {
    this.setActive(false, false);
    this.setRunning(0);
    this.badgeLeft = 0;
    this.phase = 0;
    this.chargeOrb.position.set(CHARGE_ORBIT_RADIUS_M, 0, 0);
    this.badge.visible = false;
    this.badge.position.y = BADGE_Y_M;
  }

  public showPickup(kind: PowerEffectKind, durationSeconds: number = BADGE_SECONDS): void {
    const material = this.badge.material as THREE.SpriteMaterial;
    material.map = kind === "shield" ? shieldIconTexture
      : kind === "speed" ? speedIconTexture : chargeIconTexture;
    material.needsUpdate = true;
    this.badgeLeft = Math.max(0, Math.min(BADGE_SECONDS, durationSeconds));
    this.badge.visible = this.badgeLeft > 0;
  }

  public update(deltaSeconds: number): void {
    if (deltaSeconds <= 0) return;
    this.phase += deltaSeconds;
    if (this.shield.visible) {
      const scale = 1 + Math.sin(this.phase * SHIELD_PULSE_RATE) * SHIELD_PULSE_AMPLITUDE;
      this.shield.scale.setScalar(scale);
      this.shield.rotation.y += deltaSeconds * 0.25;
    }
    if (this.runTrail.visible) {
      this.runTrail.position.y = Math.sin(this.phase * WIND_BOB_RATE) * WIND_BOB_AMPLITUDE_M;
      this.runTrail.scale.z = 1 + 0.045 * Math.sin(this.phase * 6);
    }
    if (this.chargeOrb.visible) {
      const angle = this.phase * CHARGE_ORBIT_RATE;
      this.chargeOrb.position.set(
        Math.cos(angle) * CHARGE_ORBIT_RADIUS_M,
        0,
        Math.sin(angle) * CHARGE_ORBIT_RADIUS_M,
      );
    }
    if (this.badgeLeft > 0) {
      this.badgeLeft = Math.max(0, this.badgeLeft - deltaSeconds);
      if (this.badgeLeft < 0.000001) this.badgeLeft = 0;
      this.badge.visible = this.badgeLeft > 0;
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.parent.remove(this.shield, this.runTrail, this.chargeOrb, this.badge);
    this.shield.geometry.dispose();
    (this.shield.material as THREE.Material).dispose();
    this.runTrail.geometry.dispose();
    (this.runTrail.material as THREE.Material).dispose();
    this.chargeOrb.geometry.dispose();
    this.chargeOrb.material.dispose();
    (this.badge.material as THREE.Material).dispose();
    releaseIcons();
  }
}
