import * as THREE from "three";
import { ARENA_HALF_SIZE } from "../config";

interface BoxPart {
  x: number; y: number; z: number;
  width: number; height: number; depth: number;
  yaw: number; color: number;
}

interface House {
  x: number; z: number; width: number; depth: number; height: number;
  wall: number; roof: number;
}

// Ground and buildings live in world space outside the glass boundary. The
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
      (this.windowGlow.material as THREE.MeshBasicMaterial).opacity = 0.36 * this.eveningAmount;
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
      { x: -14, z: -h - 25, width: 10, depth: 6, height: 5.6, wall: 0xd5c7ad, roof: 0x7c6d61 },
      { x: 17, z: -h - 29, width: 12, depth: 7, height: 7.2, wall: 0xb5c2bf, roof: 0x5e7478 },
      { x: -h - 25, z: -14, width: 9, depth: 6.5, height: 6.7, wall: 0xbfc3b4, roof: 0x687368 },
      { x: -h - 29, z: 20, width: 11, depth: 7, height: 5.8, wall: 0xd0bca6, roof: 0x8c7568 },
      { x: h + 27, z: -17, width: 11, depth: 7, height: 6.8, wall: 0xc3c4bb, roof: 0x637479 },
      { x: h + 23, z: 16, width: 8.5, depth: 6, height: 5.3, wall: 0xd7c9b1, roof: 0x89776a },
      { x: -17, z: h + 28, width: 11, depth: 7, height: 7, wall: 0xb9c4bd, roof: 0x697975 },
      { x: 16, z: h + 24, width: 10, depth: 6, height: 5.8, wall: 0xc8b8a5, roof: 0x7f6d65 },
    ];
    const parts: BoxPart[] = [];
    const windows: BoxPart[] = [];
    const roofTransforms: Array<{ house: House; yaw: number }> = [];
    for (const house of houses) {
      const yaw = Math.atan2(-house.x, -house.z);
      const add = (x: number, y: number, z: number, width: number, height: number, depth: number, color: number): BoxPart => {
        const part = {
          x: house.x + x * Math.cos(yaw) + z * Math.sin(yaw),
          y, z: house.z - x * Math.sin(yaw) + z * Math.cos(yaw),
          width, height, depth, yaw, color,
        };
        parts.push(part);
        return part;
      };
      add(0, house.height / 2, 0, house.width, house.height, house.depth, house.wall);
      add(0, 0.17, 0, house.width + 0.12, 0.34, house.depth + 0.12, 0x8a8e84);
      add(0, house.height - 0.12, 0, house.width + 0.2, 0.20, house.depth + 0.2, 0xd5d1c4);
      // Larger dark glazing and slender pale surrounds read as contemporary
      // houses, without tiny posters/objects competing with the arena.
      const levels = house.height > 6 ? [1.9, 4.55] : [2.7];
      for (const y of levels) {
        for (const x of [-house.width * 0.3, 0, house.width * 0.3]) {
          add(x, y, house.depth / 2 + 0.04, 1.55, 1.65, 0.12, 0xd9d8cb);
          const pane = add(x, y, house.depth / 2 + 0.11, 1.28, 1.38, 0.035, 0x51656a);
          // A few quiet windows glow in the last minute. Their thin overlay
          // shares one material and cannot illuminate or shadow gameplay.
          if (x !== 0) windows.push({ ...pane, z: pane.z + 0.025 * Math.cos(yaw), x: pane.x + 0.025 * Math.sin(yaw) });
        }
      }
      add(house.width * 0.10, 1.02, house.depth / 2 + 0.07, 1.1, 2.04, 0.10, 0x6f7d79);
      add(house.width * 0.10, 2.14, house.depth / 2 + 0.42, 1.8, 0.12, 0.95, 0x9b9d91);
      roofTransforms.push({ house, yaw });
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

    const roofGeometry = this.track(this.makeRoofGeometry());
    const roofParts = roofTransforms.map(({ house, yaw }) => ({
      x: house.x, y: house.height, z: house.z, width: house.width + 0.6,
      height: 1.45, depth: house.depth + 0.6, yaw, color: house.roof,
    }));
    const roofs = this.makeInstances(roofGeometry, surface, roofParts);
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
      color: 0xe9c28e, transparent: true, opacity: 0, depthWrite: false,
    }));
    this.windowGlow = this.makeInstances(boxGeometry, glow, windows.map((part) => ({ ...part, color: 0xffffff })));
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

  private makeRoofGeometry(): THREE.BufferGeometry {
    const vertices = [
      [-0.5, 0, -0.5], [0.5, 0, -0.5], [0.5, 0, 0.5], [-0.5, 0, 0.5],
      [0, 1, -0.5], [0, 1, 0.5],
    ];
    const triangles = [0, 4, 1, 3, 2, 5, 0, 3, 5, 0, 5, 4, 1, 4, 5, 1, 5, 2];
    const positions = triangles.flatMap((index) => vertices[index]!);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    return geometry;
  }
}
