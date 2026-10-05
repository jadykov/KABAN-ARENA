import * as THREE from "three";
import { getSuperBonus, type SuperBonusKind } from "../../../shared/super-bonuses.mjs";

type Shape = "sphere" | "box" | "cylinder" | "cone" | "ring" | "sausage";
type Paint = "wool" | "dark" | "red" | "brown" | "orange" | "silver" | "blue" | "ice" | "green" | "mud" | "jelly" | "purple" | "olive";
type Triple = readonly [number, number, number];
interface Part {
  shape: Shape;
  paint: Paint;
  position: Triple;
  scale: Triple;
  rotation?: Triple;
  name: string;
  moving?: boolean;
}

const PAINTS: Record<Paint, number> = {
  wool: 0xfff7e7, dark: 0x28313a, red: 0xf1434b, brown: 0x995236,
  orange: 0xffa443, silver: 0xd5e4ea, blue: 0x349ac7, ice: 0xb3f0ff,
  green: 0xb3d873, mud: 0x657844, jelly: 0xf0bf67, purple: 0xad85dd,
  olive: 0x7a9859,
};

const part = (name: string, shape: Shape, paint: Paint, position: Triple, scale: Triple, rotation?: Triple, moving = false): Part =>
  ({ name, shape, paint, position, scale, rotation, moving });

// Local models are centred on the flight position. Support visuals raise the
// same models by their measured lower bound. Static pieces with the same paint
// are merged once, keeping each item to a handful of draw calls.
function partsFor(kind: SuperBonusKind): Part[] {
  switch (kind) {
    case "sheep": return [
      part("fleece", "sphere", "wool", [0, 0.04, 0], [0.38, 0.27, 0.26]),
      ...[-1, 1].flatMap((side) => [-1, 1].map((end) =>
        part("fleece-tuft", "sphere", "wool", [side * 0.23, 0.16, end * 0.14], [0.18, 0.18, 0.16]))),
      part("head", "sphere", "dark", [0, 0.08, -0.31], [0.18, 0.19, 0.16]),
      ...[-1, 1].map((side) => part("ear", "sphere", "dark", [side * 0.19, 0.13, -0.29], [0.12, 0.06, 0.055])),
      ...[-1, 1].flatMap((side) => [-1, 1].map((end) =>
        part("leg", "box", "dark", [side * 0.21, -0.25, end * 0.17], [0.075, 0.19, 0.075]))),
      ...[-1, 1].map((side) => part("bow", "cone", "red", [side * 0.12, 0.29, -0.11], [0.11, 0.19, 0.1], [0, 0, side * Math.PI / 2])),
      part("bow-knot", "sphere", "red", [0, 0.29, -0.11], [0.075, 0.075, 0.075]),
      ...[-1, 1].map((side) => part("eye", "sphere", "wool", [side * 0.07, 0.12, -0.445], [0.026, 0.036, 0.02])),
    ];
    case "turkey": return [
      part("body", "sphere", "brown", [0, -0.04, 0.03], [0.3, 0.26, 0.25]),
      part("head", "sphere", "red", [0, 0.25, -0.15], [0.12, 0.14, 0.12]),
      part("beak", "cone", "orange", [0, 0.23, -0.32], [0.07, 0.15, 0.07], [-Math.PI / 2, 0, 0]),
      ...[-1, 1].map((side) => part(`wing-${side}`, "sphere", "orange", [side * 0.29, 0, 0.02], [0.08, 0.23, 0.21], [0, 0, side * 0.3], true)),
      ...[-1, 0, 1].map((side) => part("tail-feather", "sphere", "orange", [side * 0.16, 0.12, 0.25], [0.09, 0.28, 0.055], [side * 0.3, 0, -side * 0.4])),
      ...[-1, 1].map((side) => part("foot", "box", "orange", [side * 0.12, -0.29, -0.06], [0.11, 0.06, 0.18])),
      ...[-1, 1].map((side) => part("eye", "sphere", "dark", [side * 0.07, 0.28, -0.24], [0.025, 0.03, 0.025])),
    ];
    case "freeze": return [
      part("ice-brick", "box", "blue", [0, 0, 0], [0.77, 0.44, 0.37]),
      part("ice-face", "box", "ice", [0, 0.015, -0.19], [0.69, 0.35, 0.016]),
      part("crack", "box", "wool", [-0.04, 0.04, -0.202], [0.025, 0.29, 0.015], [0, 0, -0.46]),
      part("crack-branch", "box", "wool", [0.04, -0.015, -0.203], [0.16, 0.024, 0.015], [0, 0, 0.3]),
    ];
    case "boomerang": return [
      part("sausage-horseshoe", "sausage", "red", [0, -0.03, 0], [1, 1, 1]),
      ...[-1, 1].map((side) => part("sausage-end", "sphere", "brown", [side * 0.29, -0.03, 0], [0.125, 0.125, 0.125])),
      ...[-1, 1].map((side) => part("sausage-tie", "cone", "wool", [side * 0.39, -0.03, 0], [0.055, 0.12, 0.055], [0, 0, side * Math.PI / 2])),
    ];
    case "jelly": return [
      part("jelly-mould", "cylinder", "jelly", [0, 0.015, 0], [0.32, 0.44, 0.32]),
      part("jelly-top", "sphere", "jelly", [0, 0.22, 0], [0.28, 0.10, 0.28]),
      part("plate", "cylinder", "silver", [0, -0.23, 0], [0.4, 0.045, 0.4]),
      ...[-1, 1].map((side) => part("carrot", "box", "orange", [side * 0.12, 0.14, -0.26], [0.09, 0.06, 0.03])),
      part("herb", "box", "green", [0.02, 0.24, 0.04], [0.12, 0.015, 0.07], [0, 0.6, 0]),
    ];
    case "herring": return [
      part("herring-tin", "cylinder", "silver", [0, -0.025, 0], [0.34, 0.23, 0.25]),
      part("tin-label", "box", "blue", [0, -0.025, -0.25], [0.41, 0.13, 0.017]),
      part("tin-lid", "cylinder", "wool", [0, 0.1, 0], [0.31, 0.015, 0.225]),
      part("fish-body", "sphere", "blue", [-0.035, 0.12, 0], [0.17, 0.02, 0.063]),
      part("fish-tail", "cone", "blue", [0.16, 0.12, 0], [0.062, 0.11, 0.04], [0, 0, -Math.PI / 2]),
      part("pull-tab", "ring", "dark", [-0.16, 0.13, 0.1], [0.075, 0.075, 0.075], [-Math.PI / 2, 0, 0]),
    ];
    case "swamp": return [
      part("mud-package", "box", "mud", [0, -0.01, 0], [0.47, 0.57, 0.26], [0, 0, -0.07]),
      part("package-fold", "box", "green", [0, 0.31, 0], [0.44, 0.085, 0.08], [0, 0, -0.07]),
      part("mud-label", "box", "wool", [0, 0, -0.14], [0.3, 0.26, 0.016]),
      part("mud-droplet", "sphere", "mud", [0, 0.01, -0.16], [0.075, 0.095, 0.025]),
      part("mud-drop-tip", "cone", "mud", [0, 0.11, -0.16], [0.068, 0.12, 0.023]),
    ];
    case "ice": return [
      part("thermos", "cylinder", "silver", [0, -0.015, 0], [0.18, 0.6, 0.18]),
      part("thermos-sleeve", "cylinder", "blue", [0, -0.03, 0], [0.19, 0.36, 0.19]),
      part("thermos-cap", "cylinder", "ice", [0, 0.31, 0], [0.20, 0.10, 0.20]),
      part("thermos-handle", "ring", "dark", [0.2, 0.06, 0], [0.14, 0.21, 0.14], [0, Math.PI / 2, 0]),
      part("snow-mark", "box", "wool", [0, -0.03, -0.198], [0.028, 0.2, 0.02]),
      part("snow-mark-cross", "box", "wool", [0, -0.03, -0.199], [0.15, 0.025, 0.02]),
    ];
    case "soda": return [
      part("soda-bottle", "cylinder", "orange", [0, -0.06, 0], [0.2, 0.49, 0.2]),
      part("bottle-shoulder", "sphere", "orange", [0, 0.19, 0], [0.2, 0.16, 0.2]),
      part("bottle-neck", "cylinder", "orange", [0, 0.31, 0], [0.075, 0.19, 0.075]),
      part("bottle-cap", "cylinder", "red", [0, 0.42, 0], [0.1, 0.065, 0.1], undefined, true),
      part("bottle-label", "cylinder", "wool", [0, -0.045, 0], [0.205, 0.20, 0.205]),
      part("bottle-warning", "cone", "red", [0, -0.02, -0.21], [0.077, 0.12, 0.022]),
    ];
    case "vacuum": return [
      part("vacuum-body", "sphere", "purple", [0, 0.015, 0], [0.34, 0.23, 0.26]),
      part("vacuum-top", "box", "silver", [0, 0.2, 0.02], [0.32, 0.065, 0.22]),
      ...[-1, 1].map((side) => part("wheel", "cylinder", "dark", [side * 0.28, -0.15, 0.1], [0.12, 0.1, 0.12], [0, 0, Math.PI / 2])),
      part("vacuum-hose", "sausage", "dark", [0, 0.06, -0.1], [0.6, 0.65, 0.6], [Math.PI / 2, 0, 0]),
      part("vacuum-nozzle", "box", "silver", [0.17, -0.2, -0.27], [0.24, 0.10, 0.17]),
      part("vacuum-light", "sphere", "green", [-0.12, 0.225, -0.06], [0.03, 0.02, 0.03]),
    ];
    case "grenade": return [
      part("grenade-shell", "sphere", "olive", [0, -0.04, 0], [0.26, 0.32, 0.26]),
      part("grenade-shell-band", "cylinder", "dark", [0, -0.03, 0], [0.265, 0.035, 0.265]),
      part("grenade-neck", "cylinder", "dark", [0, 0.27, 0], [0.12, 0.10, 0.12]),
      part("grenade-metal-cap", "box", "silver", [0, 0.34, 0], [0.23, 0.07, 0.13]),
      part("grenade-lever", "box", "silver", [0.22, 0.12, 0], [0.055, 0.43, 0.10], [0, 0, 0.32]),
      part("grenade-pin", "ring", "silver", [-0.17, 0.32, 0], [0.085, 0.085, 0.085]),
    ];
  }
}

export class SuperBonusModels {
  private readonly geometries = new Set<THREE.BufferGeometry>();
  private readonly materials = new Map<Paint, THREE.MeshStandardMaterial>();
  private readonly templates = new Map<SuperBonusKind, THREE.Group>();
  private readonly primitives: Record<Shape, THREE.BufferGeometry>;

  public constructor() {
    this.primitives = {
      sphere: new THREE.SphereGeometry(1, 10, 6), box: new THREE.BoxGeometry(1, 1, 1),
      cylinder: new THREE.CylinderGeometry(0.9, 1, 1, 10), cone: new THREE.ConeGeometry(1, 1, 8),
      ring: new THREE.TorusGeometry(1, 0.16, 5, 12), sausage: new THREE.TorusGeometry(0.29, 0.12, 6, 14, Math.PI),
    };
    Object.values(this.primitives).forEach((geometry) => this.geometries.add(geometry));
  }

  private material(paint: Paint): THREE.MeshStandardMaterial {
    const previous = this.materials.get(paint);
    if (previous !== undefined) return previous;
    const color = PAINTS[paint];
    const material = new THREE.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: 0.38, roughness: paint === "silver" ? 0.32 : 0.68,
      metalness: paint === "silver" ? 0.35 : 0, flatShading: true,
      transparent: paint === "jelly", opacity: paint === "jelly" ? 0.86 : 1,
      depthWrite: paint !== "jelly",
    });
    material.name = `bonus-paint-${paint}`;
    this.materials.set(paint, material);
    return material;
  }

  private geometry(parts: readonly Part[]): THREE.BufferGeometry {
    const positions: number[] = [];
    const normals: number[] = [];
    const matrix = new THREE.Matrix4();
    const normalMatrix = new THREE.Matrix3();
    const vector = new THREE.Vector3();
    for (const piece of parts) {
      const source = this.primitives[piece.shape].toNonIndexed();
      matrix.compose(new THREE.Vector3(...piece.position), new THREE.Quaternion().setFromEuler(new THREE.Euler(...(piece.rotation ?? [0, 0, 0]))), new THREE.Vector3(...piece.scale));
      normalMatrix.getNormalMatrix(matrix);
      const position = source.getAttribute("position");
      const normal = source.getAttribute("normal");
      for (let i = 0; i < position.count; i += 1) {
        vector.fromBufferAttribute(position, i).applyMatrix4(matrix);
        positions.push(vector.x, vector.y, vector.z);
        vector.fromBufferAttribute(normal, i).applyNormalMatrix(normalMatrix);
        normals.push(vector.x, vector.y, vector.z);
      }
      source.dispose();
    }
    const result = new THREE.BufferGeometry();
    result.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    result.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    result.computeBoundingBox();
    result.computeBoundingSphere();
    this.geometries.add(result);
    return result;
  }

  public create(kind: SuperBonusKind): THREE.Group {
    let template = this.templates.get(kind);
    if (template === undefined) {
      template = new THREE.Group();
      template.name = `bonus-model-${kind}`;
      template.userData["bonusKind"] = kind;
      template.userData["bonusName"] = getSuperBonus(kind)?.name ?? kind;
      const pieces = partsFor(kind);
      const paints = new Set(pieces.filter((piece) => !piece.moving).map((piece) => piece.paint));
      for (const paint of paints) {
        const merged = pieces.filter((piece) => !piece.moving && piece.paint === paint);
        const mesh = new THREE.Mesh(this.geometry(merged), this.material(paint));
        mesh.name = merged.map((piece) => piece.name).join("+");
        template.add(mesh);
      }
      for (const piece of pieces.filter((piece) => piece.moving)) {
        const mesh = new THREE.Mesh(this.primitives[piece.shape], this.material(piece.paint));
        mesh.name = piece.name;
        mesh.position.set(...piece.position);
        mesh.scale.set(...piece.scale);
        mesh.rotation.set(...(piece.rotation ?? [0, 0, 0]));
        mesh.userData["restY"] = piece.position[1];
        template.add(mesh);
      }
      this.templates.set(kind, template);
    }
    return template.clone(true);
  }

  public animate(model: THREE.Group, seconds: number, phase = "", speed = 0): void {
    const kind = model.userData["bonusKind"] as SuperBonusKind;
    model.position.y = 0;
    model.rotation.x = 0;
    model.rotation.z = 0;
    model.scale.setScalar(1);
    if (kind === "sheep" && phase !== "warning" && speed > 0.1) {
      model.position.y = Math.abs(Math.sin(seconds * 14)) * 0.055;
      model.rotation.z = Math.sin(seconds * 14) * 0.05;
    }
    if (kind === "jelly") {
      const wobble = Math.sin(seconds * 7) * 0.06;
      model.scale.set(1 + wobble, 1 - wobble, 1 + wobble);
      model.rotation.z = Math.sin(seconds * 6) * 0.025;
    }
    if (kind === "turkey") {
      for (const side of [-1, 1]) {
        const wing = model.getObjectByName(`wing-${side}`);
        if (wing !== undefined) wing.rotation.z = side * (0.3 + Math.sin(seconds * 15) * 0.6);
      }
    }
    if (kind === "soda") {
      const cap = model.getObjectByName("bottle-cap");
      if (cap !== undefined) cap.position.y = 0.42 + (phase === "warning" ? 0.1 + Math.abs(Math.sin(seconds * 18)) * 0.09 : 0);
      if (phase === "warning") model.rotation.z = Math.sin(seconds * 35) * 0.08;
    }
    if (kind === "vacuum") model.rotation.z = Math.sin(seconds * 30) * 0.025;
  }

  public dispose(): void {
    this.geometries.forEach((geometry) => geometry.dispose());
    this.materials.forEach((material) => material.dispose());
    this.geometries.clear();
    this.materials.clear();
    this.templates.clear();
  }
}
