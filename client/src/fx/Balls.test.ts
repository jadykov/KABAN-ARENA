import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { BALL_MUZZLE_OFFSET, BALL_TORSO_OFFSET, LOCAL_AVATAR_COLOR, MAX_LIVE_BALLS, SELF_SPAWN_Y } from "../config";
import { directionFromYawPitch, muzzleForShot, type NetBallSnapshot } from "../net/protocol";
import { BALL_BASE, IDENTITY_LOCAL, IDENTITY_REMOTES, NEUTRAL_MOON } from "../palette";
import {
  BALL_CAP_COLOR,
  BALL_CAP_FRACTION,
  BALL_EQUATOR_BAND_PX,
  BALL_GRADIENT_STOPS,
  BALL_NEUTRAL_BASE,
  BALL_RADIUS,
  BALL_TEXTURE_SIZE,
  BallsPool,
  ENV_PUFF_COLOR,
  MAX_CACHED_BALL_SKINS,
  MUZZLE_FLASH_LIFE_S,
  SUPER_BALL_COLOR,
  SUPER_BALL_SCALE,
  SUPER_CORE_INNER_RADIUS,
  SUPER_CORE_OUTER_RADIUS,
  SUPER_INNER_COLOR,
  SuperCore,
  TRAIL_GOLD_COLOR,
  TRAIL_SUPER_COLOR,
  markingColorFor,
} from "./Balls";

function makeBall(ballId: string, superShot: boolean, color: number = BALL_CAP_COLOR): NetBallSnapshot {
  return { ballId, ownerId: "owner", x: 1, y: 1.4, z: 2, power01: 1, super: superShot, color, ricochet: false, resting: false };
}

function makeBallAt(
  ballId: string,
  x: number,
  y = 1.4,
  z = 0,
  color: number = BALL_CAP_COLOR,
): NetBallSnapshot {
  return { ballId, ownerId: "owner", x, y, z, power01: 1, super: false, color, ricochet: false, resting: false };
}

function ballGroups(scene: THREE.Scene): THREE.Group[] {
  return scene.children.filter((child): child is THREE.Group => child instanceof THREE.Group);
}

function puffSprites(scene: THREE.Scene): THREE.Sprite[] {
  return scene.children.filter((child): child is THREE.Sprite => child instanceof THREE.Sprite);
}

function skinOf(mesh: THREE.Mesh): { base: number; marking: number } {
  const material = mesh.material as THREE.MeshBasicMaterial;
  return {
    base: material.userData["base"] as number,
    marking: material.userData["marking"] as number,
  };
}

function keyOf(hex: number): string {
  return `${(hex >> 16) & 0xff},${(hex >> 8) & 0xff},${hex & 0xff}`;
}

// Texel colors present in a headless DataTexture skin (node-env tests have no
// DOM canvas, so skins fall back to 16x16 DataTextures carrying the same two
// colors). Returns an empty set for non-data textures (browser CanvasTexture
// path) — callers assert via userData there.
function texelColors(texture: THREE.Texture | null): Set<string> {
  const out = new Set<string>();
  const image = (texture as unknown as { image?: { data?: unknown } } | null)?.image;
  const data = image?.data;
  if (!(data instanceof Uint8Array)) {
    return out;
  }
  for (let i = 0; i + 4 <= data.length; i += 4) {
    out.add(`${data[i] ?? 0},${data[i + 1] ?? 0},${data[i + 2] ?? 0}`);
  }
  return out;
}

// Row-major texel grid of a headless 16x16 DataTexture skin (null when the
// texture is not a headless DataTexture, e.g. the browser CanvasTexture path).
function texelGrid(texture: THREE.Texture | null): string[][] | null {
  const image = (texture as unknown as { image?: { data?: unknown; width?: unknown; height?: unknown } } | null)?.image;
  const data = image?.data;
  if (!(data instanceof Uint8Array)) {
    return null;
  }
  const size = Math.sqrt(data.length / 4);
  if (!Number.isInteger(size) || size <= 0) {
    return null;
  }
  const rows: string[][] = [];
  for (let y = 0; y < size; y += 1) {
    const row: string[] = [];
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      row.push(`${data[i] ?? 0},${data[i + 1] ?? 0},${data[i + 2] ?? 0}`);
    }
    rows.push(row);
  }
  return rows;
}

// HSL lightness 0..1 (same derivation as palette.test.ts) for the ownership
// contrast guard below.
function lightnessOf(hex: number): number {
  const r = ((hex >> 16) & 0xff) / 255;
  const g = ((hex >> 8) & 0xff) / 255;
  const b = (hex & 0xff) / 255;
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
}

// Polished-stone balls: smooth 16x12 spheres, one mesh per core, stone base
// + subtle thrower accent (polar dot + thin ring), neutral trails.
describe("BallsPool polished-stone redesign", () => {
  it("uses BALL_RADIUS 0.38 for the shared smooth body geometry (16x12)", () => {
    expect(BALL_RADIUS).toBe(0.38);
    const scene = new THREE.Scene();
    const pool = new BallsPool(scene);
    try {
      const groups = ballGroups(scene);
      expect(groups).toHaveLength(MAX_LIVE_BALLS);
      for (const group of groups) {
        const body = group.children[0];
        expect(body).toBeInstanceOf(THREE.Mesh);
        const geometry = (body as THREE.Mesh).geometry as THREE.SphereGeometry;
        expect(geometry.parameters.radius).toBeCloseTo(0.38, 5);
        // Round read (owner: faceted look): modestly higher segments than the
        // old 10x8, still one shared geometry across all 12 pool slots.
        expect(geometry.parameters.widthSegments).toBe(16);
        expect(geometry.parameters.heightSegments).toBe(12);
      }
    } finally {
      pool.dispose();
    }
  });

  it("builds smooth single-mesh cores with pooled trail sprites + 8 puffs", () => {
    const scene = new THREE.Scene();
    const pool = new BallsPool(scene);
    try {
      const groups = ballGroups(scene);
      expect(groups).toHaveLength(MAX_LIVE_BALLS);
      for (const group of groups) {
        // ONE mesh per ball — no cap dome, no second mesh, no bump.
        expect(group.children).toHaveLength(1);
        expect(group.children[0]).toBeInstanceOf(THREE.Mesh);
        expect(group.children[0]).not.toBeInstanceOf(THREE.Sprite);
      }
      // 8 impact puffs + 2 trail sprites per ball slot (neutral/SUPER).
      expect(puffSprites(scene)).toHaveLength(8 + MAX_LIVE_BALLS * 2);
    } finally {
      pool.dispose();
    }
  });

  it("paints stone base + thrower accent, SUPER chartreuse/white, x2 scale for SUPER", () => {
    const scene = new THREE.Scene();
    const pool = new BallsPool(scene);
    try {
      // Polished-stone redesign: the base is the dark-amethyst BALL_BASE tone
      // (NOT the old NEUTRAL_MOON off-white, NOT the old BASE_BG) — the
      // thrower reads from the SUBTLE accent only.
      expect(BALL_NEUTRAL_BASE).toBe(BALL_BASE);
      expect(BALL_NEUTRAL_BASE).not.toBe(NEUTRAL_MOON);
      pool.render([makeBall("b1", false, LOCAL_AVATAR_COLOR)]);
      let groups = ballGroups(scene);
      const normalBody = groups[0]?.children[0] as THREE.Mesh | undefined;
      expect(normalBody).toBeDefined();
      if (normalBody === undefined) {
        throw new Error("expected one normal ball mesh");
      }
      expect(skinOf(normalBody).base).toBe(BALL_NEUTRAL_BASE);
      expect(skinOf(normalBody).marking).toBe(LOCAL_AVATAR_COLOR);
      expect(groups[0]?.scale.x).toBe(1);

      pool.render([makeBall("b1", false, LOCAL_AVATAR_COLOR), makeBall("b2", true)]);
      groups = ballGroups(scene);
      const superBody = groups[1]?.children[0] as THREE.Mesh | undefined;
      expect(superBody).toBeDefined();
      if (superBody === undefined) {
        throw new Error("expected one super ball mesh");
      }
      // SUPER: smooth chartreuse sphere + white painted marking (no
      // protruding white inner dome), x2 group scale for the power read.
      expect(skinOf(superBody).base).toBe(SUPER_BALL_COLOR);
      expect(skinOf(superBody).marking).toBe(SUPER_INNER_COLOR);
      expect(groups[1]?.children).toHaveLength(1);
      expect(groups[1]?.scale.x).toBe(SUPER_BALL_SCALE);
    } finally {
      pool.dispose();
    }
  });
});

// Throw-polish SuperCore: bigger shells + inner pulse, no lights added.
// The pickup orb (wireframe icosahedron + inner octahedron) is an intentional
// ITEM design — centered, fully enclosed, not the "hand" bump — left as-is.
describe("SuperCore throw-polish", () => {
  it("uses outer 1.0 / inner 0.5 shells and pulses the inner", () => {
    expect(SUPER_CORE_OUTER_RADIUS).toBe(1.0);
    expect(SUPER_CORE_INNER_RADIUS).toBe(0.5);
    const scene = new THREE.Scene();
    const core = new SuperCore(scene);
    try {
      core.render({ active: true, x: 0, z: 0, expiresAt: Date.now() + 10000, nextAt: 0 }, Date.now());
      const group = scene.children.find((child): child is THREE.Group => child instanceof THREE.Group);
      expect(group).toBeDefined();
      const meshes = group?.children.filter((child): child is THREE.Mesh => child instanceof THREE.Mesh) ?? [];
      expect(meshes).toHaveLength(2);
      const radii = meshes.map((mesh) => (mesh.geometry as THREE.IcosahedronGeometry).parameters.radius).sort();
      expect(radii[0]).toBeCloseTo(0.5, 5);
      expect(radii[1]).toBeCloseTo(1.0, 5);
      const inner = group?.children.find((child) => child instanceof THREE.Mesh && child.name === "super-core-inner");
      const before = (inner as THREE.Mesh | undefined)?.scale.x ?? 1;
      core.update(1 / 16);
      const after = (inner as THREE.Mesh | undefined)?.scale.x ?? 1;
      expect(after).not.toBe(before);
    } finally {
      core.dispose();
    }
  });
});

// Muzzle-origin sync: pool keyed by ballId, lerp smoothing, instant flash.
describe("BallsPool ballId-stable mapping", () => {
  function visibleXs(scene: THREE.Scene): number[] {
    return ballGroups(scene)
      .filter((group) => group.visible)
      .map((group) => group.position.x)
      .sort((a, b) => a - b);
  }

  it("deleting the middle ball keeps the survivors in place (no teleport)", () => {
    const scene = new THREE.Scene();
    const pool = new BallsPool(scene);
    try {
      pool.render([makeBallAt("a", 0), makeBallAt("b", 10), makeBallAt("c", 20)]);
      expect(visibleXs(scene)).toEqual([0, 10, 20]);
      // Drop the middle id, nudge the survivors: stable slots keep a at 0
      // and c at 20 until update() eases them (no snap into freed slots).
      pool.render([makeBallAt("a", 0.1), makeBallAt("c", 20.1)]);
      expect(visibleXs(scene)).toEqual([0, 20]);
    } finally {
      pool.dispose();
    }
  });

  it("order shifts keep ids (swap never snaps)", () => {
    const scene = new THREE.Scene();
    const pool = new BallsPool(scene);
    try {
      pool.render([makeBallAt("a", 0), makeBallAt("b", 50)]);
      expect(visibleXs(scene)).toEqual([0, 50]);
      // Same ids, swapped wire order: no slot changes, no snaps.
      pool.render([makeBallAt("b", 50.1), makeBallAt("a", 0.1)]);
      expect(visibleXs(scene)).toEqual([0, 50]);
    } finally {
      pool.dispose();
    }
  });

  it("lerps toward the target and snaps beyond 6m", () => {
    const scene = new THREE.Scene();
    const pool = new BallsPool(scene);
    try {
      pool.render([makeBallAt("a", 0)]);
      pool.render([makeBallAt("a", 2)]);
      // Existing ids only move the target: position holds until update().
      expect(visibleXs(scene)).toEqual([0]);
      pool.update(1 / 60);
      const stepped = visibleXs(scene)[0] ?? 0;
      expect(stepped).toBeGreaterThan(0);
      expect(stepped).toBeLessThan(2);
      // Far warp (>6m) snaps immediately instead of sliding across the arena.
      pool.render([makeBallAt("a", 100)]);
      pool.update(1 / 60);
      expect(visibleXs(scene)).toEqual([100]);
    } finally {
      pool.dispose();
    }
  });
});

describe("client muzzle math mirrors the server", () => {
  it("muzzleForShot equals bodyCenter XZ + dir*0.7, y = bodyY + torso offset", () => {
    expect(BALL_MUZZLE_OFFSET).toBeCloseTo(0.7, 10);
    expect(BALL_TORSO_OFFSET).toBeCloseTo(0.3, 10);
    const yaw = 0.7;
    const pitch = 0.3;
    // Ground equivalence: body-center 1.1 + 0.3 == old absolute 1.4.
    const muzzle = muzzleForShot(3, SELF_SPAWN_Y, -4, yaw, pitch);
    const dir = directionFromYawPitch(yaw, pitch);
    expect(muzzle.x).toBeCloseTo(3 + dir.x * BALL_MUZZLE_OFFSET, 10);
    expect(muzzle.z).toBeCloseTo(-4 + dir.z * BALL_MUZZLE_OFFSET, 10);
    expect(muzzle.y).toBeCloseTo(1.4, 10);
    expect(muzzle.y).toBeCloseTo(SELF_SPAWN_Y + BALL_TORSO_OFFSET, 10);
    expect(muzzle.dirX).toBeCloseTo(dir.x, 10);
    expect(muzzle.dirY).toBeCloseTo(dir.y, 10);
    expect(muzzle.dirZ).toBeCloseTo(dir.z, 10);
  });

  it("tracks thrower elevation: spawn y = body y + torso offset", () => {
    const yaw = 0.7;
    const pitch = 0.3;
    // Elevated thrower (platform top 2.6 + body-center 1.1 = 3.7).
    const elevated = muzzleForShot(13.8, 3.7, -8.5, yaw, pitch);
    expect(elevated.y).toBeCloseTo(3.7 + BALL_TORSO_OFFSET, 10);
    expect(elevated.y).toBeCloseTo(4.0, 10);
    // XZ offset logic is elevation-independent.
    const dir = directionFromYawPitch(yaw, pitch);
    expect(elevated.x).toBeCloseTo(13.8 + dir.x * BALL_MUZZLE_OFFSET, 10);
    expect(elevated.z).toBeCloseTo(-8.5 + dir.z * BALL_MUZZLE_OFFSET, 10);
  });
});

describe("BallsPool muzzle flash", () => {
  it("flashMuzzle pops a DOUBLE sprite at the tip, gone after 0.12s", () => {
    const scene = new THREE.Scene();
    const pool = new BallsPool(scene);
    try {
      expect(MUZZLE_FLASH_LIFE_S).toBe(0.12);
      pool.flashMuzzle(1, 1.4, 2, false);
      const lit = puffSprites(scene).filter((sprite) => sprite.visible);
      // Double flash: core + halo at the same tip.
      expect(lit.length).toBeGreaterThanOrEqual(2);
      const placed = lit.filter(
        (sprite) =>
          Math.abs(sprite.position.x - 1) < 1e-9 &&
          Math.abs(sprite.position.y - 1.4) < 1e-9 &&
          Math.abs(sprite.position.z - 2) < 1e-9,
      );
      expect(placed.length).toBeGreaterThanOrEqual(2);
      pool.update(0.2);
      expect(puffSprites(scene).filter((sprite) => sprite.visible)).toHaveLength(0);
    } finally {
      pool.dispose();
    }
  });

  it("shows neutral pale-violet trails for normal balls and chartreuse for SUPER", () => {
    const scene = new THREE.Scene();
    const pool = new BallsPool(scene);
    try {
      // Visual round: normal trails stay neutral pale violet even for a
      // reddish owner (the subtle ring/dot accent is the only ownership
      // read); SUPER stays chartreuse regardless of owner color.
      expect(LOCAL_AVATAR_COLOR).not.toBe(TRAIL_GOLD_COLOR);
      pool.render([makeBall("b1", false, LOCAL_AVATAR_COLOR), makeBall("b2", true)]);
      pool.update(1 / 60);
      const visible = puffSprites(scene).filter((sprite) => sprite.visible);
      const colors = visible.map((sprite) => (sprite.material as THREE.SpriteMaterial).color.getHex());
      expect(colors).toContain(TRAIL_GOLD_COLOR);
      expect(colors).toContain(TRAIL_SUPER_COLOR);
      expect(colors).not.toContain(LOCAL_AVATAR_COLOR);
    } finally {
      pool.dispose();
    }
  });
});

// Bug round 3 (blood only on player damage): environmental vanishes pop a
// small NEUTRAL puff, never the thrower color; marked player hits skip it.
describe("BallsPool impact differentiation (blood only on player damage)", () => {
  it("environmental vanish pops a NEUTRAL puff, never owner-red", () => {
    // The old code tinted the vanish puff with the ball color, so every wall
    // hit by the reddish local fighter read as blood.
    expect(LOCAL_AVATAR_COLOR).not.toBe(ENV_PUFF_COLOR);
    const scene = new THREE.Scene();
    const pool = new BallsPool(scene);
    try {
      pool.render([makeBall("b1", false, LOCAL_AVATAR_COLOR)]);
      pool.render([]);
      pool.update(1 / 60);
      const lit = puffSprites(scene).filter((sprite) => sprite.visible);
      expect(lit.length).toBeGreaterThan(0);
      for (const sprite of lit) {
        expect((sprite.material as THREE.SpriteMaterial).color.getHex()).toBe(ENV_PUFF_COLOR);
      }
    } finally {
      pool.dispose();
    }
  });

  it("markPlayerHit suppresses the neutral vanish puff (blood covers it)", () => {
    const scene = new THREE.Scene();
    const pool = new BallsPool(scene);
    try {
      pool.render([makeBall("b1", false, LOCAL_AVATAR_COLOR)]);
      // The server player-hit event lands ahead of the snapshot that drops
      // the ball: mark first, then vanish.
      pool.markPlayerHit("b1");
      pool.render([]);
      pool.update(1 / 60);
      expect(puffSprites(scene).filter((sprite) => sprite.visible)).toHaveLength(0);
    } finally {
      pool.dispose();
    }
  });

  it("markPlayerHit ignores garbage and never leaks", () => {
    const scene = new THREE.Scene();
    const pool = new BallsPool(scene);
    try {
      pool.markPlayerHit("");
      // Unknown ids vanish neutrally (no phantom suppression).
      pool.render([makeBall("b1", false)]);
      pool.render([]);
      pool.update(1 / 60);
      expect(puffSprites(scene).filter((sprite) => sprite.visible).length).toBeGreaterThan(0);
    } finally {
      pool.dispose();
    }
  });
});

// Stage 4d.4 (resting balls lie on the ground): the pool renders the
// authoritative y verbatim through the existing lerp/snap — no offset clamp,
// no new visuals. A resting core at ground height (ball radius 0.38) must sit
// exactly there, pinned across follow-up snapshots.
describe("BallsPool resting balls (ground y, no offset clamp)", () => {
  it("renders a resting ball at ground y and keeps it pinned", () => {
    const scene = new THREE.Scene();
    const pool = new BallsPool(scene);
    try {
      const resting: NetBallSnapshot = {
        ballId: "rest",
        ownerId: "owner",
        x: 1,
        y: 0.38,
        z: 2,
        power01: 0.5,
        super: false,
        color: BALL_CAP_COLOR,
        ricochet: false,
        resting: true,
      };
      pool.render([resting]);
      const visible = ballGroups(scene).filter((group) => group.visible);
      expect(visible).toHaveLength(1);
      // New ids snap once to the authoritative position — ground y verbatim.
      expect(visible[0]?.position.y).toBeCloseTo(0.38, 9);
      // Follow-up snapshots ease in XZ without lifting y off the ground.
      pool.render([{ ...resting, x: 1.05 }]);
      pool.update(1 / 60);
      expect(visible[0]?.position.y).toBeCloseTo(0.38, 2);
    } finally {
      pool.dispose();
    }
  });
});

// Polished-stone skins (one shared stone base, per-thrower subtle accent):
// two different thrower colors give two skins with the SAME base but
// DIFFERENT accents; the same color reuses one cached skin.
describe("BallsPool stone skins (per-color cached base + accent)", () => {
  it("paints two different thrower accents over one shared stone base", () => {
    const scene = new THREE.Scene();
    const pool = new BallsPool(scene);
    try {
      const colorA = LOCAL_AVATAR_COLOR;
      const colorB = 0x123456;
      expect(colorA).not.toBe(colorB);
      pool.render([makeBall("a", false, colorA), makeBall("b", false, colorB)]);
      const groups = ballGroups(scene);
      const bodyA = groups[0]?.children[0] as THREE.Mesh | undefined;
      const bodyB = groups[1]?.children[0] as THREE.Mesh | undefined;
      expect(bodyA).toBeDefined();
      expect(bodyB).toBeDefined();
      if (bodyA === undefined || bodyB === undefined) {
        throw new Error("expected two ball meshes");
      }
      // One shared polished-stone tone for every ball ...
      expect(skinOf(bodyA).base).toBe(BALL_BASE);
      expect(skinOf(bodyB).base).toBe(BALL_BASE);
      // ... with the thrower's identity only as the subtle accent.
      expect(skinOf(bodyA).marking).toBe(colorA);
      expect(skinOf(bodyB).marking).toBe(colorB);
      expect(bodyA.material).not.toBe(bodyB.material);
    } finally {
      pool.dispose();
    }
  });

  it("reuses one cached skin per color (zero per-frame allocs)", () => {
    const scene = new THREE.Scene();
    const pool = new BallsPool(scene);
    try {
      const color = LOCAL_AVATAR_COLOR;
      pool.render([makeBall("a", false, color), makeBall("b", false, color)]);
      const groups = ballGroups(scene);
      const bodyA = groups[0]?.children[0] as THREE.Mesh | undefined;
      const bodyB = groups[1]?.children[0] as THREE.Mesh | undefined;
      // Same color on two slots: identical shared material instance.
      expect(bodyA?.material).toBe(bodyB?.material);
      // Re-render keeps the cache (no new materials per frame).
      pool.render([makeBall("a", false, color), makeBall("b", false, color)]);
      const groupsAgain = ballGroups(scene);
      expect((groupsAgain[0]?.children[0] as THREE.Mesh | undefined)?.material).toBe(bodyA?.material);
    } finally {
      pool.dispose();
    }
  });

  it("falls back to the cap-violet accent over stone for non-finite colors (compat path)", () => {
    const scene = new THREE.Scene();
    const pool = new BallsPool(scene);
    try {
      expect(markingColorFor(Number.NaN)).toBe(BALL_CAP_COLOR);
      expect(markingColorFor(LOCAL_AVATAR_COLOR)).toBe(LOCAL_AVATAR_COLOR);
      pool.render([{ ...makeBall("c", false), color: Number.NaN }]);
      const groups = ballGroups(scene);
      const body = groups[0]?.children[0] as THREE.Mesh | undefined;
      expect(body).toBeDefined();
      if (body === undefined) {
        throw new Error("expected one ball mesh");
      }
      expect(skinOf(body).base).toBe(BALL_NEUTRAL_BASE);
      expect(skinOf(body).marking).toBe(BALL_CAP_COLOR);
    } finally {
      pool.dispose();
    }
  });

  it("headless skin texture carries both the stone base and the accent texels", () => {
    const scene = new THREE.Scene();
    const pool = new BallsPool(scene);
    try {
      pool.render([makeBall("a", false, LOCAL_AVATAR_COLOR)]);
      const groups = ballGroups(scene);
      const body = groups[0]?.children[0] as THREE.Mesh | undefined;
      const texture = (body?.material as THREE.MeshBasicMaterial | undefined)?.map ?? null;
      const texels = texelColors(texture);
      // Browser CanvasTexture path exposes no texels — the userData assert
      // above covers it; headless DataTexture path must carry both colors.
      if (texels.size > 0) {
        expect(texels.has(keyOf(BALL_NEUTRAL_BASE))).toBe(true);
        expect(texels.has(keyOf(LOCAL_AVATAR_COLOR))).toBe(true);
      } else {
        expect(body).toBeDefined();
      }
    } finally {
      pool.dispose();
    }
  });
});

// Subtle ownership accent (visual round option B: the old 1/3 cap + band at
// ~40% read garish — the polar dot + thin ring must stay small enough to be
// stylish while still identifying the thrower at a glance). Layout pins: the
// polar dot is a thin top slice, the equator ring stays thin, and the
// headless texel mirror carries the same layout.
describe("BallsPool subtle accent layout (polar dot + thin ring)", () => {
  it("keeps the polar dot small and the ring thin (combined ~12.5%)", () => {
    expect(BALL_TEXTURE_SIZE).toBe(128);
    // Polar dot is a thin top slice (1/16 = 4px on the 64px canvas).
    expect(BALL_CAP_FRACTION).toBeCloseTo(1 / 16, 10);
    // Ring is thin on the 64px-tall canvas: a stripe, not a second cap.
    const canvasHeight = BALL_TEXTURE_SIZE / 2;
    expect(BALL_EQUATOR_BAND_PX).toBe(4);
    expect(BALL_EQUATOR_BAND_PX / canvasHeight).toBeLessThanOrEqual(0.125);
    // Combined accent coverage is subtle (~12.5%: dot + thin ring) — clearly
    // below the old ~40%, within the 10-15% target band.
    const coverage = BALL_CAP_FRACTION + BALL_EQUATOR_BAND_PX / canvasHeight;
    expect(coverage).toBeCloseTo(0.125, 10);
    expect(coverage).toBeLessThanOrEqual(0.15);
    expect(coverage).toBeGreaterThanOrEqual(0.08);
  });

  it("paints the stone gradient from the exported stops (dark poles, light equator)", () => {
    // The polished-stone read is pinned here (canvas-only polish): 5 stops,
    // dark at both poles, base at the quarters, light sheen at the equator.
    expect(BALL_GRADIENT_STOPS).toHaveLength(5);
    const offsets = BALL_GRADIENT_STOPS.map((stop) => stop.offset);
    expect(offsets).toEqual([0, 0.25, 0.5, 0.75, 1]);
    const colors = BALL_GRADIENT_STOPS.map((stop) => stop.color);
    expect(colors[0]).toBe(colors[4]);
    expect(colors[1]).toBe(colors[3]);
    expect(colors[1]).toBe(BALL_NEUTRAL_BASE);
    expect(new Set(colors).size).toBe(3);
  });

  it("headless texels mirror the layout: polar row + equator row marked, all other rows stone", () => {
    const scene = new THREE.Scene();
    const pool = new BallsPool(scene);
    try {
      pool.render([makeBall("a", false, LOCAL_AVATAR_COLOR)]);
      const groups = ballGroups(scene);
      const body = groups[0]?.children[0] as THREE.Mesh | undefined;
      const texture = (body?.material as THREE.MeshBasicMaterial | undefined)?.map ?? null;
      const grid = texelGrid(texture);
      // Browser CanvasTexture path exposes no texels — userData + constant
      // asserts above cover it; headless DataTexture path pins the layout.
      if (grid === null) {
        expect(body).toBeDefined();
        return;
      }
      expect(grid).toHaveLength(16);
      const baseKey = keyOf(BALL_NEUTRAL_BASE);
      const markingKey = keyOf(LOCAL_AVATAR_COLOR);
      // Polar dot row (row 0) reads fully in the thrower color.
      for (const texel of grid[0] ?? []) {
        expect(texel).toBe(markingKey);
      }
      // Gap rows between dot and ring stay stone (dominant read: dark).
      for (let y = 1; y < 8; y += 1) {
        for (const texel of grid[y] ?? []) {
          expect(texel).toBe(baseKey);
        }
      }
      // Equator ring row reads in the thrower color.
      for (const texel of grid[8] ?? []) {
        expect(texel).toBe(markingKey);
      }
      // South rows stay stone.
      for (let y = 9; y < 16; y += 1) {
        for (const texel of grid[y] ?? []) {
          expect(texel).toBe(baseKey);
        }
      }
      // Accent texel share is subtle (2/16 = 12.5%), stone dominates.
      let markingCount = 0;
      let total = 0;
      for (const row of grid) {
        for (const texel of row) {
          total += 1;
          if (texel === markingKey) {
            markingCount += 1;
          }
        }
      }
      expect(markingCount / total).toBeCloseTo(0.125, 10);
      expect(markingCount / total).toBeLessThanOrEqual(0.15);
      expect(MAX_CACHED_BALL_SKINS).toBeGreaterThanOrEqual(8);
    } finally {
      pool.dispose();
    }
  });
});

// Contrast guard: EVERY fighter color (local + 6 remotes) must keep enough
// lightness distance from the stone base so the subtle accent reads for all
// fighters, not just the bright ones. Threshold is 0.2 per spec (the darkest
// fighter 0x7a2430 sits at exact delta ~0.208 — pinned below); the base
// choice (dark amethyst BALL_BASE) is what makes even that pair pass.
describe("BallsPool ownership contrast (all 7 fighters vs stone base)", () => {
  it("every identity accent keeps >= 0.2 lightness delta vs the stone base", () => {
    const fighters = [IDENTITY_LOCAL, ...IDENTITY_REMOTES];
    expect(fighters).toHaveLength(7);
    const baseL = lightnessOf(BALL_NEUTRAL_BASE);
    let minDelta = Number.POSITIVE_INFINITY;
    for (const fighter of fighters) {
      const delta = Math.abs(lightnessOf(fighter) - baseL);
      minDelta = Math.min(minDelta, delta);
      expect(delta).toBeGreaterThanOrEqual(0.2);
    }
    // Pin the worst pair so a future base/identity edit cannot silently erode
    // it: the dark-red remote is the floor (~0.208 vs BALL_BASE).
    expect(minDelta).toBeCloseTo(0.208, 2);
  });
});

// Stone redesign silhouette (owner: balls must be round, no bumps): every
// visible pool ball — normal AND super — is a single centered sphere mesh at
// unit scale, so nothing protrudes past BALL_RADIUS. Recycled slots reset
// rotation so a new ball starts axis-aligned.
describe("BallsPool smooth silhouette (no protrusions)", () => {
  it("normal + super cores are single centered spheres within R", () => {
    const scene = new THREE.Scene();
    const pool = new BallsPool(scene);
    try {
      pool.render([makeBall("n", false, LOCAL_AVATAR_COLOR), makeBall("s", true)]);
      const visible = ballGroups(scene).filter((group) => group.visible);
      expect(visible).toHaveLength(2);
      for (const group of visible) {
        expect(group.children).toHaveLength(1);
        const mesh = group.children[0] as THREE.Mesh | undefined;
        expect(mesh).toBeInstanceOf(THREE.Mesh);
        if (mesh === undefined) {
          throw new Error("expected one ball mesh");
        }
        const geometry = mesh.geometry as THREE.SphereGeometry;
        geometry.computeBoundingSphere();
        // Farthest surface point is exactly R, centered on the group origin;
        // the mesh itself never scales (SUPER reads via group scale only,
        // still a perfect sphere, just bigger).
        expect(geometry.boundingSphere?.radius).toBeCloseTo(BALL_RADIUS, 5);
        expect(geometry.boundingSphere?.center.length() ?? 1).toBeCloseTo(0, 5);
        expect(mesh.position.length()).toBe(0);
        expect(mesh.scale.x).toBe(1);
        expect(mesh.scale.y).toBe(1);
        expect(mesh.scale.z).toBe(1);
      }
    } finally {
      pool.dispose();
    }
  });

  it("resets recycled slot rotation so a new ball starts axis-aligned", () => {
    const scene = new THREE.Scene();
    const pool = new BallsPool(scene);
    try {
      const rolling: NetBallSnapshot = {
        ballId: "spin",
        ownerId: "owner",
        x: 1,
        y: 0.58,
        z: 2,
        power01: 0.5,
        super: false,
        color: BALL_CAP_COLOR,
        ricochet: true,
        resting: false,
        rolling: true,
        vx: 2,
        vz: 0,
      };
      pool.render([rolling]);
      pool.update(1 / 60);
      const groups = ballGroups(scene);
      const spun = groups.filter((group) => group.visible);
      expect(spun).toHaveLength(1);
      const identity = new THREE.Quaternion();
      expect(spun[0]?.quaternion.angleTo(identity)).toBeGreaterThan(0);
      // Recycle the slot (vanish, then a NEW ball id reuses it): the fresh
      // core must not inherit the previous roll orientation.
      pool.render([]);
      pool.render([makeBall("fresh", false, LOCAL_AVATAR_COLOR)]);
      const fresh = ballGroups(scene).filter((group) => group.visible);
      expect(fresh).toHaveLength(1);
      expect(fresh[0]?.quaternion.angleTo(identity)).toBe(0);
    } finally {
      pool.dispose();
    }
  });
});

// Stage 4d.4 roll spin: while ball.rolling the mesh rotates around the
// horizontal axis perpendicular to (vx, vz) at hypot(vx, vz) / BALL_RADIUS;
// resting (or zero-speed) balls never rotate. Scalar scratch only. The subtle
// ring/dot accent orbits with the mesh, so the spin reads on the smooth
// sphere without any geometric bump.
describe("BallsPool roll spin (rolling rotates, resting holds)", () => {
  function makeRollingBall(ballId: string, vx: number, vz: number, rolling: boolean): NetBallSnapshot {
    return {
      ballId,
      ownerId: "owner",
      x: 1,
      y: 0.58,
      z: 2,
      power01: 0.5,
      super: false,
      color: BALL_CAP_COLOR,
      ricochet: true,
      resting: !rolling,
      rolling,
      vx,
      vz,
    };
  }

  function visibleGroup(scene: THREE.Scene): THREE.Group {
    const visible = ballGroups(scene).filter((group) => group.visible);
    expect(visible).toHaveLength(1);
    const group = visible[0];
    if (group === undefined) {
      throw new Error("expected one visible ball");
    }
    return group;
  }

  it("rotates a rolling ball at speed/BALL_RADIUS around the velocity-perpendicular axis", () => {
    const scene = new THREE.Scene();
    const pool = new BallsPool(scene);
    try {
      // vx=2, vz=0: axis is up×v normalized = (0, 0, -1), rate 2/0.38 rad/s.
      pool.render([makeRollingBall("roll", 2, 0, true)]);
      const group = visibleGroup(scene);
      const before = group.quaternion.clone();
      const dt = 1 / 60;
      pool.update(dt);
      const after = group.quaternion.clone();
      expect(after.angleTo(before)).toBeGreaterThan(0);
      const expected = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 0, -1),
        (Math.hypot(2, 0) / BALL_RADIUS) * dt,
      );
      expect(after.angleTo(expected)).toBeLessThan(1e-6);
    } finally {
      pool.dispose();
    }
  });

  it("holds still when resting and when rolling with zero velocity", () => {
    const scene = new THREE.Scene();
    const pool = new BallsPool(scene);
    try {
      pool.render([makeRollingBall("rest", 0, 0, false)]);
      const group = visibleGroup(scene);
      const pinned = group.quaternion.clone();
      pool.update(1 / 60);
      pool.update(1 / 60);
      expect(group.quaternion.angleTo(pinned)).toBe(0);
      // Rolling flag with zero planar speed: no rotation either.
      pool.render([makeRollingBall("rest", 0, 0, true)]);
      const still = group.quaternion.clone();
      pool.update(1 / 60);
      expect(group.quaternion.angleTo(still)).toBe(0);
    } finally {
      pool.dispose();
    }
  });
});
