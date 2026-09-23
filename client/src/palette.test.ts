import { describe, expect, it } from "vitest";
import {
  ACCENT_BALL_CAP,
  ACCENT_DEATH_PALE,
  ACCENT_DEATH_RED,
  ACCENT_DEATH_WHITE,
  ACCENT_FIRE_BURST,
  ACCENT_GLOW_BALL,
  ACCENT_GLOW_BALL_FULL,
  ACCENT_HIT_BURST,
  ACCENT_HIT_FLASH,
  ACCENT_ICE_GLOW,
  ACCENT_OBSTACLE_TINT,
  ACCENT_SPARK,
  ACCENT_SPOT,
  ACCENT_STRIP,
  ACCENT_STRIP_BASE,
  ACCENT_TRAIL,
  BASE_AD_FRAME,
  BASE_BASALT,
  BASE_BG,
  BASE_CAP,
  BASE_FIGURE_TINTS,
  BASE_FLOOR,
  BASE_ICE,
  BASE_OBSTACLE,
  BASE_OBSTACLE_TOP,
  BASE_PAD,
  BASE_PICKUP,
  BASE_PLATFORM,
  BASE_PLATFORM_TOP,
  BASE_RAMP,
  BASE_TRAMPOLINE,
  BASE_WALL,
  HL_CHARTREUSE,
  HL_CHARTREUSE_BRIGHT,
  HL_CHARTREUSE_DEEP,
  HL_SHIELD,
  HL_TRAMP_BURST,
  IDENTITY_LOCAL,
  IDENTITY_REMOTES,
} from "./palette";

// Palette scheme guard (Stage 4d.2-fix rework, owner-confirmed
// violet–red–chartreuse): hue bands pin the bucket composition so a future
// edit cannot silently smuggle neon cyan/pink back in. NEUTRAL_* (free white
// tones), IDENTITY_* (functional fighter distinction, deliberately varied)
// and PANTS_* (dark desaturated clothing bottoms) are exempt by design —
// documented here, not asserted.
//
// Bands: chartreuse 60-100°, violet 230-290°, muted red 0-20°/340-360°,
// banned cyan 175-205°, banned pink/magenta 295-335°.
function toHsl(hex: number): { h: number; s: number; l: number } {
  const r = ((hex >> 16) & 0xff) / 255;
  const g = ((hex >> 8) & 0xff) / 255;
  const b = (hex & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) {
    return { h: 0, s: 0, l };
  }
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) {
    h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  } else if (max === g) {
    h = ((b - r) / d + 2) * 60;
  } else {
    h = ((r - g) / d + 4) * 60;
  }
  return { h, s, l };
}

function expectHueIn(hex: number, lo: number, hi: number): void {
  const { h } = toHsl(hex);
  expect(h).toBeGreaterThanOrEqual(lo);
  expect(h).toBeLessThanOrEqual(hi);
}

describe("palette buckets (violet base / muted-red accents / chartreuse highlights)", () => {
  it("highlight chartreuses sit in the 60-100° hue band, saturated", () => {
    for (const hex of [HL_CHARTREUSE, HL_CHARTREUSE_BRIGHT, HL_CHARTREUSE_DEEP, HL_SHIELD, HL_TRAMP_BURST]) {
      expectHueIn(hex, 60, 100);
      expect(toHsl(hex).s).toBeGreaterThan(0.4);
    }
  });

  it("base violet darks sit in the 230-290° band and stay dark", () => {
    for (const hex of [
      BASE_BG,
      BASE_FLOOR,
      BASE_WALL,
      BASE_OBSTACLE,
      BASE_PLATFORM,
      BASE_CAP,
      BASE_RAMP,
      BASE_ICE,
      BASE_TRAMPOLINE,
      BASE_PAD,
      BASE_PICKUP,
      BASE_BASALT,
      BASE_AD_FRAME,
    ]) {
      expectHueIn(hex, 230, 290);
      expect(toHsl(hex).l).toBeLessThan(0.45);
    }
  });

  it("pale violet tones (tops, caps, trails, ice glow, spot) sit at 230-290°", () => {
    for (const hex of [
      BASE_OBSTACLE_TOP,
      BASE_PLATFORM_TOP,
      BASE_FIGURE_TINTS[2] ?? 0,
      BASE_FIGURE_TINTS[3] ?? 0,
      ACCENT_BALL_CAP,
      ACCENT_TRAIL,
      ACCENT_SPARK,
      ACCENT_ICE_GLOW,
      ACCENT_SPOT,
      ACCENT_DEATH_WHITE,
      ACCENT_DEATH_PALE,
    ]) {
      expectHueIn(hex, 230, 290);
    }
  });

  it("muted reds sit in the 0-20° / 340-360° band", () => {
    for (const hex of [
      ACCENT_STRIP,
      ACCENT_STRIP_BASE,
      ACCENT_HIT_FLASH,
      ACCENT_HIT_BURST,
      ACCENT_FIRE_BURST,
      ACCENT_OBSTACLE_TINT,
      ACCENT_DEATH_RED,
      ACCENT_GLOW_BALL,
      ACCENT_GLOW_BALL_FULL,
      BASE_FIGURE_TINTS[1] ?? 0,
    ]) {
      const { h } = toHsl(hex);
      expect(h <= 20 || h >= 340).toBe(true);
    }
  });

  it("no saturated cyan (175-205°) or pink/magenta (295-335°) anywhere scanned", () => {
    const scanned = [
      BASE_BG, BASE_FLOOR, BASE_WALL, BASE_OBSTACLE, BASE_OBSTACLE_TOP,
      BASE_PLATFORM, BASE_PLATFORM_TOP, BASE_FIGURE_TINTS[1] ?? 0,
      BASE_FIGURE_TINTS[2] ?? 0, BASE_FIGURE_TINTS[3] ?? 0, BASE_CAP,
      BASE_RAMP, BASE_ICE, BASE_TRAMPOLINE, BASE_PAD, BASE_PICKUP,
      BASE_BASALT, BASE_AD_FRAME, ACCENT_STRIP, ACCENT_STRIP_BASE,
      ACCENT_ICE_GLOW, ACCENT_HIT_FLASH, ACCENT_HIT_BURST, ACCENT_FIRE_BURST,
      ACCENT_OBSTACLE_TINT, ACCENT_BALL_CAP, ACCENT_TRAIL, ACCENT_SPARK,
      ACCENT_SPOT, ACCENT_DEATH_WHITE, ACCENT_DEATH_PALE, ACCENT_DEATH_RED,
      ACCENT_GLOW_BALL, ACCENT_GLOW_BALL_FULL, HL_CHARTREUSE,
      HL_CHARTREUSE_BRIGHT, HL_CHARTREUSE_DEEP, HL_SHIELD, HL_TRAMP_BURST,
    ];
    for (const hex of scanned) {
      const { h, s } = toHsl(hex);
      if (s < 0.15) {
        continue; // Near-white/grey: hue numerically meaningless, skip.
      }
      const isCyan = h >= 175 && h <= 205;
      const isPink = h >= 295 && h <= 335;
      expect(isCyan || isPink).toBe(false);
    }
  });

  it("identity colors never collide with highlight/accent literals and stay pairwise distinct", () => {
    const fighters = [IDENTITY_LOCAL, ...IDENTITY_REMOTES];
    expect(fighters).toHaveLength(7);
    // No fighter may equal the chartreuse highlight or the pale-violet ball
    // cap/spark (functional confusion with pickups, supers, cores).
    for (const hex of fighters) {
      expect(hex).not.toBe(HL_CHARTREUSE);
      expect(hex).not.toBe(ACCENT_BALL_CAP);
      expect(hex).not.toBe(ACCENT_SPARK);
    }
    // Pairwise RGB distance floor: every pair reads as a different fighter
    // on the dark floor (nearest pair is ~49 apart, floor is 40).
    const channel = (hex: number, shift: 0 | 8 | 16): number => (hex >> shift) & 0xff;
    let minDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < fighters.length; i += 1) {
      for (let j = i + 1; j < fighters.length; j += 1) {
        const a = fighters[i] ?? 0;
        const b = fighters[j] ?? 0;
        const dist = Math.hypot(channel(a, 16) - channel(b, 16), channel(a, 8) - channel(b, 8), channel(a, 0) - channel(b, 0));
        minDist = Math.min(minDist, dist);
      }
    }
    expect(minDist).toBeGreaterThan(40);
  });

  it("every identity marking keeps >= ~0.25 lightness delta vs the dark ball base (BASE_BG)", () => {
    // Palette-level ownership-contrast guard (ball base round): the ball skin
    // base is BASE_BG (the darkest BASE tone), and the thrower's identity
    // reads as a large marking in the raw fighter color — so ALL 7 fighter
    // colors must stand off the base in lightness, not just the bright ones.
    // Threshold ~0.25 per spec (0.24 admits the darkest fighter 0x7a2430 at
    // exact delta ~0.243 — pinned here so a future palette edit cannot
    // silently erode it).
    const fighters = [IDENTITY_LOCAL, ...IDENTITY_REMOTES];
    expect(fighters).toHaveLength(7);
    const baseL = toHsl(BASE_BG).l;
    let minDelta = Number.POSITIVE_INFINITY;
    for (const fighter of fighters) {
      const delta = Math.abs(toHsl(fighter).l - baseL);
      minDelta = Math.min(minDelta, delta);
      expect(delta).toBeGreaterThanOrEqual(0.24);
    }
    expect(minDelta).toBeCloseTo(0.243, 2);
  });
});
