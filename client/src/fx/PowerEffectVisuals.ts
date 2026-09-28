import * as THREE from "three";
import { HL_SHIELD, HL_CHARTREUSE_BRIGHT } from "../palette";

export type PowerEffectKind = "shield" | "speed";

const BADGE_SECONDS = 1;
const BADGE_SIZE_M = 0.36;
// The capsule crown is 1m above the rig origin. Keep the small badge just
// clear of it so the follow camera sees it without losing it near the top.
const BADGE_Y_M = 1.55;
const SHIELD_RADIUS_M = 0.88;
const SHIELD_PULSE_AMPLITUDE = 0.035;
const SHIELD_PULSE_RATE = 2.4;
const WIND_BOB_AMPLITUDE_M = 0.045;
const WIND_BOB_RATE = 5;

let shieldIconTexture: THREE.Texture | null = null;
let speedIconTexture: THREE.Texture | null = null;
let iconUsers = 0;

function acquireIcons(): void {
  iconUsers += 1;
  if (shieldIconTexture !== null && speedIconTexture !== null) return;
  // Headless scene tests have no image loader. They still exercise the effect
  // meshes; browser builds load the two real SVG assets from public/icons.
  if (typeof document === "undefined" || typeof document.createElementNS !== "function") {
    shieldIconTexture = new THREE.Texture();
    speedIconTexture = new THREE.Texture();
  } else {
    const loader = new THREE.TextureLoader();
    shieldIconTexture = loader.load("/icons/bonus-shield.svg");
    speedIconTexture = loader.load("/icons/bonus-speed.svg");
  }
  shieldIconTexture.colorSpace = THREE.SRGBColorSpace;
  speedIconTexture.colorSpace = THREE.SRGBColorSpace;
}

function releaseIcons(): void {
  iconUsers = Math.max(0, iconUsers - 1);
  if (iconUsers !== 0) return;
  shieldIconTexture?.dispose();
  speedIconTexture?.dispose();
  shieldIconTexture = null;
  speedIconTexture = null;
}

// Small shared visual vocabulary for local and remote fighters. All geometry
// is built once per avatar; update only changes transforms and visibility.
export class PowerEffectVisuals {
  private readonly parent: THREE.Object3D;
  private readonly shield: THREE.Mesh;
  private readonly wind: THREE.LineSegments;
  private readonly badge: THREE.Sprite;
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

    // A few open, offset strokes read as moving air without smoke, particles,
    // extra lights, or a flashing emissive effect.
    const strokes = new Float32Array([
      -0.87, -0.30, -0.20, -0.48, -0.30, -0.20,
      -0.98,  0.04,  0.25, -0.53,  0.04,  0.25,
      -0.81,  0.42, -0.04, -0.42,  0.42, -0.04,
       0.87, -0.18,  0.18,  0.50, -0.18,  0.18,
       0.96,  0.28, -0.24,  0.49,  0.28, -0.24,
    ]);
    const windGeometry = new THREE.BufferGeometry();
    windGeometry.setAttribute("position", new THREE.BufferAttribute(strokes, 3));
    const windMaterial = new THREE.LineBasicMaterial({
      color: HL_CHARTREUSE_BRIGHT,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
    });
    this.wind = new THREE.LineSegments(windGeometry, windMaterial);
    this.wind.name = "bonus-speed-wind";
    this.wind.visible = false;
    parent.add(this.wind);

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

  public setActive(shieldActive: boolean, speedActive: boolean): void {
    this.shield.visible = shieldActive;
    this.wind.visible = speedActive;
  }

  public reset(): void {
    this.setActive(false, false);
    this.badgeLeft = 0;
    this.badge.visible = false;
    this.badge.position.y = BADGE_Y_M;
  }

  public showPickup(kind: PowerEffectKind): void {
    const material = this.badge.material as THREE.SpriteMaterial;
    material.map = kind === "shield" ? shieldIconTexture : speedIconTexture;
    material.needsUpdate = true;
    this.badgeLeft = BADGE_SECONDS;
    this.badge.visible = true;
  }

  public update(deltaSeconds: number): void {
    if (deltaSeconds <= 0) return;
    this.phase += deltaSeconds;
    if (this.shield.visible) {
      const scale = 1 + Math.sin(this.phase * SHIELD_PULSE_RATE) * SHIELD_PULSE_AMPLITUDE;
      this.shield.scale.setScalar(scale);
      this.shield.rotation.y += deltaSeconds * 0.25;
    }
    if (this.wind.visible) {
      this.wind.position.y = Math.sin(this.phase * WIND_BOB_RATE) * WIND_BOB_AMPLITUDE_M;
      this.wind.rotation.y += deltaSeconds * 0.8;
    }
    if (this.badgeLeft > 0) {
      this.badgeLeft = Math.max(0, this.badgeLeft - deltaSeconds);
      this.badge.visible = this.badgeLeft > 0;
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.parent.remove(this.shield, this.wind, this.badge);
    this.shield.geometry.dispose();
    (this.shield.material as THREE.Material).dispose();
    this.wind.geometry.dispose();
    (this.wind.material as THREE.Material).dispose();
    (this.badge.material as THREE.Material).dispose();
    releaseIcons();
  }
}
