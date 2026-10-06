import { getShopfrontTransforms } from "../ads/AdsLoader";
import { getRamps } from "../arena/Arena";
import { ARENA_HALF_SIZE, WALL_THICKNESS, WALL_VISUAL_HEIGHT } from "../config";
import { ARENA_LAYOUT } from "../layout";

export interface WildlifePoint { x: number; z: number }
export interface BirdSurface extends WildlifePoint {
  kind: "ground" | "fence" | "roof" | "cargo";
  y: number; hx: number; hz: number;
  // Fence birds face across the rail, placing both feet along its length.
  yaw?: number;
}
interface Box extends WildlifePoint { hx: number; hz: number }
export interface RatRoute {
  source: number; destination: number;
  points: readonly WildlifePoint[];
  distances: readonly number[];
  length: number;
}

// Conservatively include the entire sloping slab and its ladder rails.
const ramps: Box[] = getRamps().map((ramp) => ({ x: ramp.x, z: ramp.z,
  hx: ramp.axis === "x" ? ramp.halfWidth : ramp.halfLength,
  hz: ramp.axis === "x" ? ramp.halfLength : ramp.halfWidth }));
const solids = [...ARENA_LAYOUT.obstacles, ...ARENA_LAYOUT.platforms];
const groundBoxes: readonly Box[] = [...solids, ...ramps];
const circles = [...ARENA_LAYOUT.trampolines,
  ...ARENA_LAYOUT.spawns.map((spawn) => ({ ...spawn, radius: 0.9 }))];

// Match Arena.buildObstacles' top lids, including the gaps between distinct
// crates/cartons. A saved solid top alone does not describe foot support.
const cargoPanels = ARENA_LAYOUT.obstacles.slice(0, 4).map((cargo, index) => {
  const panels: Box[] = [];
  const panel = (x: number, z: number, width: number, depth: number): void => {
    panels.push({ x: cargo.x + x * cargo.hx, z: cargo.z + z * cargo.hz,
      hx: width * cargo.hx / 2, hz: depth * cargo.hz / 2 });
  };
  if (index === 0) {
    for (const x of [-0.505, 0.505]) panel(x, 0, 0.99 - 0.078, 2 - 0.078);
  } else if (index === 1) {
    for (const x of [-0.505, 0.505]) {
      for (const z of [-0.505, 0.505]) panel(x, z, 0.99 - 0.018, 0.99 - 0.018);
    }
  } else if (index === 2) {
    for (const z of [-0.505, 0.505]) panel(0, z, 2 - 0.078, 0.99 - 0.078);
  } else {
    for (const x of [-0.505, 0.505]) {
      for (let row = 0; row < 3; row += 1) panel(x, -1 + (row + 0.5) * 2 / 3,
        0.99 - 0.018, 2 / 3 - 0.018 - 0.018);
    }
  }
  return { cargo, panels };
});

export function isCargoFootSupported(surface: BirdSurface, x: number, z: number, clearance = 0.055): boolean {
  for (const entry of cargoPanels) {
    if (entry.cargo.x !== surface.x || entry.cargo.z !== surface.z) continue;
    for (const panel of entry.panels) {
      if (Math.abs(x - panel.x) <= panel.hx - clearance
        && Math.abs(z - panel.z) <= panel.hz - clearance) return true;
    }
  }
  return false;
}

export function isWildlifeGroundClear(x: number, z: number, clearance = 0.32): boolean {
  if (Math.abs(x) > ARENA_HALF_SIZE - clearance || Math.abs(z) > ARENA_HALF_SIZE - clearance) return false;
  for (const box of groundBoxes) {
    if (Math.abs(x - box.x) <= box.hx + clearance && Math.abs(z - box.z) <= box.hz + clearance) return false;
  }
  for (const circle of circles) {
    if (Math.hypot(x - circle.x, z - circle.z) <= circle.radius + clearance) return false;
  }
  return true;
}

export function isBirdFlightClear(x: number, y: number, z: number, landing: BirdSurface): boolean {
  for (const box of solids) {
    if (landing.kind !== "ground" && landing.kind !== "fence"
      && box.x === landing.x && box.z === landing.z && box.topY === landing.y) continue;
    if (y < box.topY + 0.42 && Math.abs(x - box.x) < box.hx + 0.32
      && Math.abs(z - box.z) < box.hz + 0.32) return false;
  }
  if (y < 3.5) {
    for (const ramp of ramps) {
      if (Math.abs(x - ramp.x) < ramp.hx + 0.32 && Math.abs(z - ramp.z) < ramp.hz + 0.32) return false;
    }
  }
  if (y < 0.6) {
    for (const circle of circles) {
      if (Math.hypot(x - circle.x, z - circle.z) < circle.radius + 0.32) return false;
    }
  }
  return true;
}

export function getBirdSurfaces(): BirdSurface[] {
  const surfaces: BirdSurface[] = [];
  for (let x = -15; x <= 15; x += 3) {
    for (let z = -15; z <= 15; z += 3) {
      if (isWildlifeGroundClear(x, z, 0.4)) surfaces.push({ kind: "ground", x, z, y: 0, hx: 0.9, hz: 0.9 });
    }
  }
  const rail = ARENA_HALF_SIZE + WALL_THICKNESS / 2;
  for (const side of [-1, 1]) {
    for (const along of [-12, 0, 12]) {
      surfaces.push({ kind: "fence", x: along, z: side * rail, y: WALL_VISUAL_HEIGHT,
        hx: 3, hz: 0, yaw: side < 0 ? 0 : Math.PI });
      surfaces.push({ kind: "fence", x: side * rail, z: along, y: WALL_VISUAL_HEIGHT,
        hx: 0, hz: 3, yaw: side < 0 ? Math.PI / 2 : -Math.PI / 2 });
    }
  }
  for (const shop of ARENA_LAYOUT.platforms) surfaces.push({ ...shop, kind: "roof", y: shop.topY });
  // Tall central stock piles are eligible; each landing separately checks
  // their actual lid seams. Low flowerbeds never enter the landing catalog.
  for (const box of ARENA_LAYOUT.obstacles.slice(0, 4)) {
    if (box.topY > 1) surfaces.push({ ...box, kind: "cargo", y: box.topY });
  }
  return surfaces;
}

const navigationClearance = 0.5; // Includes the rat's long tail through turns.
const navigationBoxes: Box[] = [...solids, ...ramps,
  ...circles.map((circle) => ({ x: circle.x, z: circle.z, hx: circle.radius, hz: circle.radius }))];

export function isRatSegmentClear(a: WildlifePoint, b: WildlifePoint): boolean {
  for (const point of [a, b]) {
    if (Math.abs(point.x) > ARENA_HALF_SIZE - navigationClearance
      || Math.abs(point.z) > ARENA_HALF_SIZE - navigationClearance) return false;
  }
  for (const box of navigationBoxes) {
    let lower = 0;
    let upper = 1;
    for (const axis of ["x", "z"] as const) {
      const extent = (axis === "x" ? box.hx : box.hz) + navigationClearance;
      const origin = a[axis] - box[axis];
      const direction = b[axis] - a[axis];
      if (Math.abs(direction) < 1e-9) {
        if (Math.abs(origin) > extent) { lower = 2; break; }
      } else {
        const first = (-extent - origin) / direction;
        const second = (extent - origin) / direction;
        lower = Math.max(lower, Math.min(first, second));
        upper = Math.min(upper, Math.max(first, second));
      }
    }
    if (lower <= upper) return false;
  }
  return true;
}

// Construct a small visibility graph once, then keep immutable routes. No
// pathfinding, waypoint arrays, or graph work takes place in the frame loop.
export function getRatRoutes(): RatRoute[] {
  const fronts = getShopfrontTransforms();
  const nodes: WildlifePoint[] = [];
  for (const front of fronts) {
    const nx = Math.round(Math.sin(front.rotationY));
    const nz = Math.round(Math.cos(front.rotationY));
    for (const along of [-0.35, 0, 0.35]) {
      nodes.push({ x: front.x + nx * 0.85 + nz * along,
        z: front.z + nz * 0.85 - nx * along });
    }
  }
  for (const box of navigationBoxes) {
    for (const dx of [-1, 1]) {
      for (const dz of [-1, 1]) {
        const point = { x: box.x + dx * (box.hx + navigationClearance + 0.06),
          z: box.z + dz * (box.hz + navigationClearance + 0.06) };
        if (isRatSegmentClear(point, point)) nodes.push(point);
      }
    }
  }
  const edges = nodes.map(() => [] as Array<{ to: number; length: number }>);
  for (let first = 0; first < nodes.length; first += 1) {
    for (let second = first + 1; second < nodes.length; second += 1) {
      const a = nodes[first]!;
      const b = nodes[second]!;
      if (!isRatSegmentClear(a, b)) continue;
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      edges[first]!.push({ to: second, length });
      edges[second]!.push({ to: first, length });
    }
  }
  const routes: RatRoute[] = [];
  for (let source = 0; source < fronts.length; source += 1) {
    for (let variant = 0; variant < 3; variant += 1) {
      const start = source * 3 + variant;
      const cost = new Float64Array(nodes.length).fill(Number.POSITIVE_INFINITY);
      const previous = new Int16Array(nodes.length).fill(-1);
      const visited = new Uint8Array(nodes.length);
      cost[start] = 0;
      for (let step = 0; step < nodes.length; step += 1) {
        let current = -1;
        for (let index = 0; index < nodes.length; index += 1) {
          if (visited[index] === 0 && (current < 0 || cost[index]! < cost[current]!)) current = index;
        }
        if (current < 0 || !Number.isFinite(cost[current]!)) break;
        visited[current] = 1;
        for (const edge of edges[current]!) {
          // Different lane preferences also change routes around central stock.
          const next = nodes[edge.to]!;
          const lane = variant === 0 ? next.x : variant === 1 ? -next.x : next.z;
          const candidate = cost[current]! + edge.length * (1 + (lane + ARENA_HALF_SIZE) * 0.015);
          if (candidate < cost[edge.to]!) { cost[edge.to] = candidate; previous[edge.to] = current; }
        }
      }
      for (let destination = 0; destination < fronts.length; destination += 1) {
        if (destination === source) continue;
        let current = destination * 3 + (2 - variant);
        if (!Number.isFinite(cost[current]!)) continue;
        const path: number[] = [];
        while (current >= 0) { path.push(current); current = previous[current]!; }
        path.reverse();
        const points = path.map((index) => nodes[index]!);
        const distances = [0];
        for (let index = 1; index < points.length; index += 1) {
          const a = points[index - 1]!;
          const b = points[index]!;
          distances.push(distances[index - 1]! + Math.hypot(b.x - a.x, b.z - a.z));
        }
        routes.push({ source, destination, points, distances, length: distances[distances.length - 1]! });
      }
    }
  }
  return routes;
}
