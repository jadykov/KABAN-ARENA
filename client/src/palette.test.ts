import { describe, expect, it } from "vitest";
import {
  ACCENT_HEART_FULL,
  ACCENT_SPARK,
  ACCENT_STRIP,
  BALL_BASE,
  BASE_BG,
  BASE_BG_CSS,
  BASE_FLOOR,
  BASE_FLOOR_GROUT,
  BASE_FLOOR_STAR,
  BASE_OBSTACLE,
  BASE_OBSTACLE_TOP,
  BASE_PLATFORM,
  BASE_PLATFORM_TOP,
  BASE_RAMP,
  HL_CHARTREUSE,
  HL_CHARTREUSE_BRIGHT,
  HL_CHARTREUSE_CSS,
  IDENTITY_LOCAL,
  IDENTITY_REMOTES,
  SCENE_COOL_FILL,
  SCENE_WARM_LIGHT,
  SCENE_WARM_LIGHT_CSS,
} from "./palette";

function lightness(hex: number): number {
  const channels = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
  return (Math.max(...channels) + Math.min(...channels)) / 510;
}

function colorDistance(a: number, b: number): number {
  return Math.hypot(
    ((a >> 16) & 255) - ((b >> 16) & 255),
    ((a >> 8) & 255) - ((b >> 8) & 255),
    (a & 255) - (b & 255),
  );
}

describe("night arena palette", () => {
  it("keeps the walking floor visible and the moss volumes brighter", () => {
    expect(lightness(BASE_BG)).toBeLessThan(lightness(BASE_FLOOR_GROUT));
    expect(lightness(BASE_FLOOR_GROUT)).toBeLessThan(lightness(BASE_FLOOR));
    expect(lightness(BASE_FLOOR_STAR) - lightness(BASE_FLOOR)).toBeLessThan(0.12);
    for (const side of [BASE_OBSTACLE, BASE_PLATFORM, BASE_RAMP]) {
      expect(lightness(side) - lightness(BASE_FLOOR)).toBeGreaterThan(0.08);
    }
    expect(lightness(BASE_OBSTACLE_TOP) - lightness(BASE_OBSTACLE)).toBeGreaterThan(0.18);
    expect(lightness(BASE_PLATFORM_TOP) - lightness(BASE_PLATFORM)).toBeGreaterThan(0.18);
  });

  it("uses a warm key, cool fill, and a restrained amber trim", () => {
    expect((SCENE_WARM_LIGHT >> 16) & 255).toBeGreaterThan(SCENE_WARM_LIGHT & 255);
    expect(SCENE_COOL_FILL & 255).toBeGreaterThan((SCENE_COOL_FILL >> 16) & 255);
    expect(lightness(ACCENT_STRIP)).toBeLessThan(lightness(HL_CHARTREUSE_BRIGHT));
    expect(BASE_BG_CSS).toBe(`#${BASE_BG.toString(16).padStart(6, "0")}`);
    expect(SCENE_WARM_LIGHT_CSS).toBe(`#${SCENE_WARM_LIGHT.toString(16)}`);
    expect(HL_CHARTREUSE_CSS).toBe(`#${HL_CHARTREUSE.toString(16)}`);
  });

  it("reserves the brightest lime for action markers and keeps identities distinct", () => {
    expect(lightness(HL_CHARTREUSE)).toBeGreaterThan(lightness(BASE_FLOOR) + 0.25);
    expect(colorDistance(HL_CHARTREUSE, BASE_OBSTACLE_TOP)).toBeGreaterThan(55);
    expect(ACCENT_SPARK).not.toBe(HL_CHARTREUSE);
    expect(ACCENT_HEART_FULL).not.toBe(HL_CHARTREUSE_CSS);
    const fighters = [IDENTITY_LOCAL, ...IDENTITY_REMOTES];
    expect(fighters).toHaveLength(7);
    for (const fighter of fighters) {
      expect(fighter).not.toBe(HL_CHARTREUSE);
      expect(Math.abs(lightness(fighter) - lightness(BALL_BASE))).toBeGreaterThanOrEqual(0.2);
    }
    for (let i = 0; i < fighters.length; i += 1) {
      for (let j = i + 1; j < fighters.length; j += 1) {
        expect(colorDistance(fighters[i]!, fighters[j]!)).toBeGreaterThan(40);
      }
    }
  });
});
