import * as THREE from "three";
import { ARENA_HALF_SIZE } from "../config";

interface BoxPart {
  x: number; y: number; z: number;
  width: number; height: number; depth: number;
  yaw: number; color: number;
}

interface House {
  x: number; z: number; width: number; depth: number; height: number;
  wall: number; roof: number; trim: number;
  roofShape: "gable" | "hip" | "shed"; roofRise: number;
  entry: number; canopy?: boolean;
  windows: Array<{ x: number; y: number; width: number; height: number; lit?: boolean }>;
  wing?: { x: number; width: number; depth: number; height: number };
  chimney?: number;
}

const HOUSE_SCALE = 0.82;

// Ground and buildings live in world space outside the arena boundary. The
// backdrop never moves with the camera, adds no colliders, casts no shadows,
// and uses the arena's existing lights/fog. Five batches cover the whole yard.
export class SuburbanEnvironment {
  private readonly group = new THREE.Group();
  private readonly resources: Array<{ dispose(): void }> = [];
  private windowGlow: THREE.InstancedMesh | null = null;
  private eveningAmount = 0;
  private built = false;

  public constructor() {
    this.group.name = "suburban-environment";
  }

  public build(scene: THREE.Scene): void {
    if (this.built) return;
    this.built = true;
    this.buildGround();
    this.buildNeighborhood();
    scene.add(this.group);
    this.setEveningLighting(this.eveningAmount);
  }

  public setEveningLighting(amount: number): void {
    this.eveningAmount = Number.isFinite(amount) ? Math.max(0, Math.min(1, amount)) : 0;
    if (this.windowGlow !== null) {
      this.windowGlow.visible = this.eveningAmount > 0;
      (this.windowGlow.material as THREE.MeshBasicMaterial).opacity = 0.68 * this.eveningAmount;
    }
  }

  public dispose(scene: THREE.Scene): void {
    scene.remove(this.group);
    this.group.clear();
    for (const resource of this.resources) resource.dispose();
    this.resources.length = 0;
    this.windowGlow = null;
    this.eveningAmount = 0;
    this.built = false;
  }

  private track<T extends { dispose(): void }>(resource: T): T {
    this.resources.push(resource);
    return resource;
  }

  private buildGround(): void {
    const positions: number[] = [];
    const colors: number[] = [];
    const half = ARENA_HALF_SIZE;
    const outer = half + 78;
    const grass = new THREE.Color(0x7c896d);
    const farGrass = new THREE.Color(0x909883);
    const path = new THREE.Color(0xb0aea0);
    const quad = (x0: number, z0: number, x1: number, z1: number, y: number, paved = false): void => {
      for (const [x, z] of [[x0, z0], [x0, z1], [x1, z0], [x1, z0], [x0, z1], [x1, z1]]) {
        positions.push(x!, y, z!);
        const fade = Math.min(1, Math.max(0, (Math.max(Math.abs(x!), Math.abs(z!)) - half) / 65));
        const color = paved ? path : grass.clone().lerp(farGrass, fade);
        colors.push(color.r, color.g, color.b);
      }
    };
    // Four strips leave a real hole beneath the arena. Their shared edges
    // are at the same height, so there is no coplanar overlap or dark seam.
    quad(-outer, -outer, outer, -half, -0.05);
    quad(-outer, half, outer, outer, -0.05);
    quad(-outer, -half, -half, half, -0.05);
    quad(half, -half, outer, half, -0.05);
    const walk = half + 3.1;
    const far = walk + 1.8;
    quad(-far, -far, far, -walk, -0.035, true);
    quad(-far, walk, far, far, -0.035, true);
    quad(-far, -walk, -walk, walk, -0.035, true);
    quad(walk, -walk, far, walk, -0.035, true);
    const geometry = this.track(new THREE.BufferGeometry());
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    const material = this.track(new THREE.MeshLambertMaterial({ vertexColors: true }));
    const ground = new THREE.Mesh(geometry, material);
    ground.name = "suburban-ground";
    this.group.add(ground);
  }

  private buildNeighborhood(): void {
    const h = ARENA_HALF_SIZE;
    const houses: House[] = [
      { x: -14, z: -h - 25, width: 8.6, depth: 6.1, height: 3.8,
        wall: 0xd5c7ad, roof: 0x7c6d61, trim: 0xe0d8c7, roofShape: "gable", roofRise: 2.1,
        entry: 0.3, chimney: -2.2, windows: [
          { x: -2.55, y: 2.1, width: 1.35, height: 1.35, lit: true },
          { x: 2.55, y: 2.1, width: 1.7, height: 1.35 },
        ] },
      { x: 17, z: -h - 29, width: 11.8, depth: 7.3, height: 6.7,
        wall: 0xb5c2bf, roof: 0x5e7478, trim: 0xd6d7cc, roofShape: "hip", roofRise: 1.7,
        entry: 3.9, canopy: true, windows: [
          { x: -3.4, y: 1.9, width: 2, height: 1.45 },
          { x: 0.2, y: 1.9, width: 2, height: 1.45, lit: true },
          { x: -3.4, y: 4.85, width: 1.35, height: 1.6, lit: true },
          { x: 0.2, y: 4.85, width: 1.35, height: 1.6 },
          { x: 3.9, y: 4.85, width: 1.35, height: 1.6 },
        ] },
      { x: -h - 25, z: -14, width: 7.8, depth: 7.1, height: 6.3,
        wall: 0xbfc3b4, roof: 0x687368, trim: 0xdbddce, roofShape: "gable", roofRise: 1.85,
        entry: -2.3, windows: [
          { x: 1.25, y: 1.95, width: 2.15, height: 1.4 },
          { x: -2.1, y: 4.75, width: 1.1, height: 1.6 },
          { x: 1.25, y: 4.75, width: 1.55, height: 1.6, lit: true },
        ] },
      { x: -h - 29, z: 20, width: 10.1, depth: 6.6, height: 4.1,
        wall: 0xc2a58f, roof: 0x8c7568, trim: 0xd8c8b6, roofShape: "hip", roofRise: 1.4,
        entry: -3.45, canopy: true, wing: { x: 6.4, width: 3.1, depth: 5.1, height: 2.8 }, windows: [
          { x: -0.8, y: 2.2, width: 1.6, height: 1.35, lit: true },
          { x: 2.75, y: 2.2, width: 2.1, height: 1.35 },
        ] },
      { x: h + 27, z: -17, width: 10.7, depth: 7.2, height: 6.5,
        wall: 0xc3c4bb, roof: 0x637479, trim: 0xe1dfd2, roofShape: "shed", roofRise: 1.05,
        entry: 0, canopy: true, windows: [
          { x: -3.4, y: 1.9, width: 1.7, height: 1.4, lit: true },
          { x: 3.4, y: 1.9, width: 1.7, height: 1.4 },
          { x: -3.4, y: 4.75, width: 1.7, height: 1.4 },
          { x: 0, y: 4.75, width: 1.25, height: 1.4 },
          { x: 3.4, y: 4.75, width: 1.7, height: 1.4, lit: true },
        ] },
      { x: h + 23, z: 16, width: 7.1, depth: 6.1, height: 3.65,
        wall: 0xd7c9b1, roof: 0x89776a, trim: 0xe5ddcd, roofShape: "gable", roofRise: 1.5,
        entry: 2.15, wing: { x: -4.6, width: 2.6, depth: 4.5, height: 2.55 }, windows: [
          { x: -1.55, y: 2, width: 2.25, height: 1.25, lit: true },
        ] },
      { x: -17, z: h + 28, width: 11.4, depth: 7.7, height: 6.8,
        wall: 0xb9c4bd, roof: 0x697975, trim: 0xdde1d5, roofShape: "hip", roofRise: 1.2,
        entry: -0.35, canopy: true, windows: [
          { x: -3.6, y: 2, width: 1.6, height: 1.55 },
          { x: 3.5, y: 2, width: 1.9, height: 1.55, lit: true },
          { x: -3.6, y: 4.95, width: 1.6, height: 1.55, lit: true },
          { x: -0.35, y: 4.95, width: 1.25, height: 1.55 },
          { x: 3.5, y: 4.95, width: 1.9, height: 1.55 },
        ] },
      { x: 16, z: h + 24, width: 9.8, depth: 6.4, height: 4.5,
        wall: 0xbba78f, roof: 0x7f6d65, trim: 0xdbd0bd, roofShape: "shed", roofRise: 0.85,
        entry: -3.5, chimney: 2.7, windows: [
          { x: -0.8, y: 2.35, width: 1.3, height: 1.65 },
          { x: 2.65, y: 2.35, width: 1.8, height: 1.65, lit: true },
        ] },
    ];
    const parts: BoxPart[] = [];
    const windows: BoxPart[] = [];
    const roofPositions: number[] = [];
    const roofColors: number[] = [];
    for (const house of houses) {
      const yaw = Math.atan2(-house.x, -house.z);
      const add = (x: number, y: number, z: number, width: number, height: number, depth: number, color: number): BoxPart => {
        const part = {
          x: house.x + (x * Math.cos(yaw) + z * Math.sin(yaw)) * HOUSE_SCALE,
          y: y * HOUSE_SCALE, z: house.z + (-x * Math.sin(yaw) + z * Math.cos(yaw)) * HOUSE_SCALE,
          width: width * HOUSE_SCALE, height: height * HOUSE_SCALE, depth: depth * HOUSE_SCALE, yaw, color,
        };
        parts.push(part);
        return part;
      };
      add(0, house.height / 2, 0, house.width, house.height, house.depth, house.wall);
      add(0, 0.17, 0, house.width + 0.12, 0.34, house.depth + 0.12, 0x8a8e84);
      add(0, house.height - 0.08, 0, house.width + 0.2, 0.16, house.depth + 0.2, house.trim);
      // Entries occupy a real gap in each window rhythm. Wider living-room
      // panes, narrower upstairs windows and occasional wings vary the facade.
      for (const window of house.windows) {
        const { x, y, width, height } = window;
        add(x, y, house.depth / 2 + 0.04, width + 0.24, height + 0.24, 0.12, house.trim);
        const pane = add(x, y, house.depth / 2 + 0.115, width, height, 0.035, 0x465d63);
        add(x, y - height / 2 - 0.13, house.depth / 2 + 0.15, width + 0.32, 0.09, 0.3, house.trim);
        if (width >= 1.9) add(x, y, house.depth / 2 + 0.17, 0.065, height, 0.045, house.trim);
        if (window.lit) windows.push({ ...pane, depth: 0.01 * HOUSE_SCALE,
          z: pane.z + 0.025 * HOUSE_SCALE * Math.cos(yaw), x: pane.x + 0.025 * HOUSE_SCALE * Math.sin(yaw),
          color: windows.length % 3 === 0 ? 0xfff2d8 : 0xeedab8 });
      }
      add(house.entry, 1.04, house.depth / 2 + 0.07, 1.05, 2.08, 0.10, 0x68746e);
      add(house.entry, 0.13, house.depth / 2 + 0.38, 1.55, 0.26, 0.8, 0x98998c);
      if (house.canopy) add(house.entry, 2.27, house.depth / 2 + 0.45, 1.75, 0.13, 1.05, house.roof);
      if (house.height > 6) add(0, 3.25, house.depth / 2 + 0.035, house.width, 0.10, 0.10, house.trim);
      if (house.chimney !== undefined) {
        add(house.chimney, house.height + house.roofRise * 0.8, -house.depth * 0.18,
          0.6, 1.5, 0.55, 0x968b7c);
      }
      this.appendRoof(roofPositions, roofColors, house, yaw);
      if (house.wing !== undefined) {
        const wing = house.wing;
        add(wing.x, wing.height / 2, 0, wing.width, wing.height, wing.depth, house.wall);
        add(wing.x, 0.17, 0, wing.width + 0.12, 0.34, wing.depth + 0.12, 0x8a8e84);
        add(wing.x, wing.height - 0.05, 0, wing.width + 0.25, 0.15, wing.depth + 0.2, house.trim);
        add(wing.x, 1.4, wing.depth / 2 + 0.05, wing.width * 0.67, 2.05, 0.12, 0x8a9188);
        this.appendRoof(roofPositions, roofColors, {
          ...house, x: house.x + wing.x * Math.cos(yaw), z: house.z - wing.x * Math.sin(yaw),
          width: wing.width, depth: wing.depth, height: wing.height, roofShape: "shed", roofRise: 0.5,
        }, yaw, house);
      }
    }
    const trees = [
      [-h - 11, -24, 6.5], [-h - 17, -7, 7.3], [-h - 13, 11, 5.9], [-h - 17, 29, 7.0],
      [h + 12, -26, 6.8], [h + 16, -4, 7.6], [h + 11, 10, 5.8], [h + 16, 29, 6.6],
      [-25, -h - 12, 6.9], [-5, -h - 16, 5.9], [25, -h - 13, 7.2],
      [-27, h + 13, 6.1], [-3, h + 17, 7.1], [27, h + 12, 6.4],
    ];
    trees.forEach(([x, z, height]) => parts.push({
      x: x!, y: height! * 0.32, z: z!, width: 0.24, height: height! * 0.64,
      depth: 0.26, yaw: 0, color: 0x756b58,
    }));
    const boxGeometry = this.track(new THREE.BoxGeometry(1, 1, 1));
    const surface = this.track(new THREE.MeshLambertMaterial({ color: 0xffffff }));
    const boxes = this.makeInstances(boxGeometry, surface, parts);
    boxes.name = "suburban-houses-and-trunks";
    this.group.add(boxes);

    // Different roof forms share one static batch rather than extra draw calls.
    const roofGeometry = this.track(new THREE.BufferGeometry());
    roofGeometry.setAttribute("position", new THREE.Float32BufferAttribute(roofPositions, 3));
    roofGeometry.setAttribute("color", new THREE.Float32BufferAttribute(roofColors, 3));
    roofGeometry.computeVertexNormals();
    const roofMaterial = this.track(new THREE.MeshLambertMaterial({ vertexColors: true }));
    const roofs = new THREE.Mesh(roofGeometry, roofMaterial);
    roofs.name = "suburban-roofs";
    this.group.add(roofs);

    const leafGeometry = this.track(new THREE.SphereGeometry(1, 7, 5));
    const leafParts: BoxPart[] = [];
    trees.forEach(([x, z, height], index) => {
      leafParts.push({ x: x!, y: height! * 0.69, z: z!, width: 2.1, height: height! * 0.34,
        depth: 1.95, yaw: index * 0.73, color: index % 3 === 0 ? 0x879873 : 0x71856a });
      leafParts.push({ x: x! + (index % 2 === 0 ? 0.8 : -0.6), y: height! * 0.59, z: z! + 0.4,
        width: 1.65, height: height! * 0.23, depth: 1.55, yaw: index * 0.93, color: 0x667c63 });
    });
    const leaves = this.makeInstances(leafGeometry, surface, leafParts);
    leaves.name = "suburban-trees";
    this.group.add(leaves);
    const glow = this.track(new THREE.MeshBasicMaterial({
      color: 0xffcf8d, transparent: true, opacity: 0, depthWrite: false, toneMapped: false,
    }));
    this.windowGlow = this.makeInstances(boxGeometry, glow, windows);
    this.windowGlow.name = "suburban-window-glow";
    this.group.add(this.windowGlow);
  }

  private makeInstances(geometry: THREE.BufferGeometry, material: THREE.Material, parts: readonly BoxPart[]): THREE.InstancedMesh {
    const mesh = this.track(new THREE.InstancedMesh(geometry, material, parts.length));
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const axis = new THREE.Vector3(0, 1, 0);
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const color = new THREE.Color();
    parts.forEach((part, index) => {
      quaternion.setFromAxisAngle(axis, part.yaw);
      matrix.compose(position.set(part.x, part.y, part.z), quaternion,
        scale.set(part.width, part.height, part.depth));
      mesh.setMatrixAt(index, matrix);
      mesh.setColorAt(index, color.set(part.color));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    return mesh;
  }

  private appendRoof(positions: number[], colors: number[], house: House, yaw: number,
    anchor: Pick<House, "x" | "z"> = house): void {
    const vertices = [[-0.5, 0, -0.5], [0.5, 0, -0.5], [0.5, 0, 0.5], [-0.5, 0, 0.5]];
    let triangles: number[];
    if (house.roofShape === "gable") {
      vertices.push([0, 1, -0.5], [0, 1, 0.5]);
      triangles = [0, 4, 1, 3, 2, 5, 0, 3, 5, 0, 5, 4, 1, 4, 5, 1, 5, 2];
    } else if (house.roofShape === "hip") {
      vertices.push([-0.25, 1, 0], [0.25, 1, 0]);
      triangles = [0, 4, 5, 0, 5, 1, 3, 2, 5, 3, 5, 4, 0, 3, 4, 1, 5, 2];
    } else {
      vertices[0]![1] = 0.75;
      vertices[1]![1] = 0.75;
      vertices.push([-0.5, 1, -0.5], [0.5, 1, -0.5], [0.5, 0.25, 0.5], [-0.5, 0.25, 0.5]);
      triangles = [4, 7, 6, 4, 6, 5, 0, 1, 2, 0, 2, 3,
        0, 4, 5, 0, 5, 1, 3, 2, 6, 3, 6, 7, 0, 3, 7, 0, 7, 4, 1, 5, 6, 1, 6, 2];
    }
    const color = new THREE.Color(house.roof);
    for (const index of triangles) {
      const vertex = vertices[index]!;
      const x = vertex[0]! * (house.width + 0.6);
      const z = vertex[2]! * (house.depth + 0.6);
      positions.push(anchor.x + (house.x - anchor.x + x * Math.cos(yaw) + z * Math.sin(yaw)) * HOUSE_SCALE,
        (house.height + vertex[1]! * house.roofRise) * HOUSE_SCALE,
        anchor.z + (house.z - anchor.z - x * Math.sin(yaw) + z * Math.cos(yaw)) * HOUSE_SCALE);
      colors.push(color.r, color.g, color.b);
    }
  }
}
