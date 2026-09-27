// Runtime validation shared by the editor, browser game, and server. Keep the
// map's dimensions here so all three reject the same out-of-bounds edits.
export const ARENA_HALF_SIZE = 16.8;
export const RAMP_SLOPE_DEG = 14;
export const PICKUP_VISUAL_Y = 1.1;

export function rampRunForTop(topY) {
  if (!Number.isFinite(topY) || topY <= 0) return 0;
  const tan = Math.tan((RAMP_SLOPE_DEG * Math.PI) / 180);
  return tan > 0 ? topY / tan : 0;
}

export function rampHeightAt(platform, x, z, extraBand = 0) {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return 0;
  const run = rampRunForTop(platform.topY);
  if (!(run > 0)) return 0;
  const band = platform.rampWidth / 2 + (extraBand > 0 ? extraBand : 0);
  let lateral = 0;
  let outward = -1;
  switch (platform.rampSide) {
    case "+z": lateral = x - platform.x; outward = z - (platform.z + platform.hz); break;
    case "-z": lateral = x - platform.x; outward = platform.z - platform.hz - z; break;
    case "+x": lateral = z - platform.z; outward = x - (platform.x + platform.hx); break;
    case "-x": lateral = z - platform.z; outward = platform.x - platform.hx - x; break;
    default: return 0;
  }
  if (Math.abs(lateral) > band || outward < 0 || outward > run) return 0;
  return platform.topY * (1 - outward / run);
}
const RAMP_SIDES = new Set(["+x", "-x", "+z", "-z"]);
const PICKUP_KINDS = new Set(["speed", "shield", "impulse"]);

function fail(path, reason) {
  throw new Error(`${path}: ${reason}`);
}

function objectAt(value, path, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "expected an object");
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, "missing field");
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) fail(`${path}.${key}`, "unknown field");
  }
  return value;
}

function numberAt(value, path, positive = false) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(path, "expected a finite number");
  }
  if (positive && value <= 0) fail(path, "must be greater than zero");
  return value;
}

function arrayAt(value, path, read) {
  if (!Array.isArray(value)) fail(path, "expected an array");
  if (value.length > 256) fail(path, "too many objects (maximum 256)");
  value.forEach((item, index) => read(item, `${path}[${index}]`));
  return value;
}

function pointAt(value, path, keys = ["x", "z"]) {
  const point = objectAt(value, path, keys);
  numberAt(point.x, `${path}.x`);
  numberAt(point.z, `${path}.z`);
  return point;
}

function insideAxis(center, radius, path) {
  if (Math.abs(center) + radius > ARENA_HALF_SIZE + 1e-9) {
    fail(path, `object must fit inside ±${ARENA_HALF_SIZE} m`);
  }
}

function solidAt(value, path, platform) {
  const keys = platform
    ? ["x", "z", "hx", "hz", "topY", "rampSide", "rampWidth"]
    : ["x", "z", "hx", "hz", "topY"];
  const solid = pointAt(value, path, keys);
  numberAt(solid.hx, `${path}.hx`, true);
  numberAt(solid.hz, `${path}.hz`, true);
  numberAt(solid.topY, `${path}.topY`, true);
  insideAxis(solid.x, solid.hx, `${path}.x`);
  insideAxis(solid.z, solid.hz, `${path}.z`);
  if (platform) {
    if (!RAMP_SIDES.has(solid.rampSide)) {
      fail(`${path}.rampSide`, "expected +x, -x, +z, or -z");
    }
    numberAt(solid.rampWidth, `${path}.rampWidth`, true);
    const alongX = solid.rampSide.endsWith("x");
    const crossHalf = alongX ? solid.hz : solid.hx;
    if (solid.rampWidth > crossHalf * 2 + 1e-9) {
      fail(`${path}.rampWidth`, "ramp must fit across the platform face");
    }
    const run = rampRunForTop(solid.topY);
    const lowEdge = alongX
      ? solid.x + (solid.rampSide === "+x" ? 1 : -1) * (solid.hx + run)
      : solid.z + (solid.rampSide === "+z" ? 1 : -1) * (solid.hz + run);
    // The half-meter capsule must be able to stand at the ramp's low edge.
    insideAxis(lowEdge, 0.5, `${path}.rampSide`);
  }
}

function zoneAt(value, path) {
  const zone = pointAt(value, path, ["x", "z", "radius"]);
  numberAt(zone.radius, `${path}.radius`, true);
  insideAxis(zone.x, zone.radius, `${path}.x`);
  insideAxis(zone.z, zone.radius, `${path}.z`);
}

function spawnAt(value, path) {
  const point = pointAt(value, path);
  insideAxis(point.x, 0.5, `${path}.x`);
  insideAxis(point.z, 0.5, `${path}.z`);
}

function pickupAt(value, path) {
  const point = pointAt(value, path, ["kind", "x", "z"]);
  if (!PICKUP_KINDS.has(point.kind)) {
    fail(`${path}.kind`, "expected speed, shield, or impulse");
  }
  insideAxis(point.x, 0, `${path}.x`);
  insideAxis(point.z, 0, `${path}.z`);
}

function rampFootprint(platform) {
  const run = rampRunForTop(platform.topY);
  const sign = platform.rampSide.startsWith("+") ? 1 : -1;
  if (platform.rampSide.endsWith("x")) {
    return {
      x: platform.x + sign * (platform.hx + run / 2), z: platform.z,
      hx: run / 2, hz: platform.rampWidth / 2,
    };
  }
  return {
    x: platform.x, z: platform.z + sign * (platform.hz + run / 2),
    hx: platform.rampWidth / 2, hz: run / 2,
  };
}

function circleTouchesBox(point, radius, box) {
  const dx = Math.max(Math.abs(point.x - box.x) - box.hx, 0);
  const dz = Math.max(Math.abs(point.z - box.z) - box.hz, 0);
  return dx * dx + dz * dz <= radius * radius;
}

function rejectBlockedPoint(point, radius, path, layout, includeRamps) {
  for (const [index, block] of [...layout.obstacles, ...layout.platforms].entries()) {
    if (circleTouchesBox(point, radius, block)) {
      const group = index < layout.obstacles.length ? "obstacles" : "platforms";
      fail(path, `overlaps ${group}[${index < layout.obstacles.length ? index : index - layout.obstacles.length}]`);
    }
  }
  if (includeRamps) {
    for (const [index, platform] of layout.platforms.entries()) {
      if (circleTouchesBox(point, radius, rampFootprint(platform))) {
        fail(path, `overlaps platforms[${index}] ramp`);
      }
    }
  }
}

export function validateArenaLayout(input) {
  const layout = objectAt(input, "layout", [
    "version", "obstacles", "platforms", "swampZones", "iceZones",
    "trampolines", "spawns", "pickups",
  ]);
  if (layout.version !== 1) fail("version", "expected version 1");
  arrayAt(layout.obstacles, "obstacles", (item, path) => solidAt(item, path, false));
  arrayAt(layout.platforms, "platforms", (item, path) => solidAt(item, path, true));
  arrayAt(layout.swampZones, "swampZones", zoneAt);
  arrayAt(layout.iceZones, "iceZones", zoneAt);
  arrayAt(layout.trampolines, "trampolines", zoneAt);
  arrayAt(layout.spawns, "spawns", spawnAt);
  if (layout.spawns.length < 6) fail("spawns", "at least six spawns are required for a full room");
  const spawnKeys = new Set();
  layout.spawns.forEach((spawn, index) => {
    const key = `${spawn.x},${spawn.z}`;
    if (spawnKeys.has(key)) fail(`spawns[${index}]`, "duplicate spawn position");
    spawnKeys.add(key);
    // The authoritative server places fighters at ground body height.
    // Spawning inside a solid would trap them immediately.
    rejectBlockedPoint(spawn, 0.5, `spawns[${index}]`, layout, false);
  });
  arrayAt(layout.pickups, "pickups", pickupAt);
  const kinds = new Set();
  layout.pickups.forEach((pickup, index) => {
    if (kinds.has(pickup.kind)) fail(`pickups[${index}].kind`, "duplicate pickup kind");
    kinds.add(pickup.kind);
    // Pickup meshes sit at a fixed floor height. A marker inside a taller
    // solid would render under its top surface even if XZ pickup still fires.
    for (const block of [...layout.obstacles, ...layout.platforms]) {
      if (block.topY < PICKUP_VISUAL_Y) continue;
      if (Math.abs(pickup.x - block.x) <= block.hx && Math.abs(pickup.z - block.z) <= block.hz) {
        fail(`pickups[${index}]`, "marker is buried inside a tall solid");
      }
    }
    for (const platform of layout.platforms) {
      if (rampHeightAt(platform, pickup.x, pickup.z) >= PICKUP_VISUAL_Y) {
        fail(`pickups[${index}]`, "marker is buried inside a ramp");
      }
    }
  });
  layout.trampolines.forEach((pad, index) => {
    // A pad on a solid or ramp cannot launch (the server only launches at
    // ground level), so keep the whole trigger disc on open ground.
    rejectBlockedPoint(pad, pad.radius, `trampolines[${index}]`, layout, true);
  });
  return layout;
}
