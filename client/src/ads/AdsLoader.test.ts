import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { ADS_PUBLIC_BASE_PATH, FENCE_SLOT_COUNT } from "../config";
import {
  AdsManager,
  EXPECTED_FENCE_SLOTS,
  createPlaceholderTexture,
  getFenceSlotTransforms,
  resolveBannerUrls,
  resolveFenceUrls,
} from "./AdsLoader";

describe("ads slot layout (QA1-A)", () => {
  it("exposes 6 fence slots at readable height", () => {
    expect(EXPECTED_FENCE_SLOTS).toBe(FENCE_SLOT_COUNT);
    expect(FENCE_SLOT_COUNT).toBe(6);
    const slots = getFenceSlotTransforms();
    expect(slots).toHaveLength(6);
    const keys = new Set(slots.map((slot) => `${slot.x},${slot.z}`));
    expect(keys.size).toBe(6);
    for (const slot of slots) {
      expect(slot.y).toBeGreaterThan(0);
    }
  });

  it("prefers owner files and falls back to the SVG placeholder", () => {
    expect(resolveFenceUrls(0)).toEqual([
      `${ADS_PUBLIC_BASE_PATH}/fence-1.png`,
      `${ADS_PUBLIC_BASE_PATH}/fence-1.jpg`,
      `${ADS_PUBLIC_BASE_PATH}/fence-1.svg`,
    ]);
    expect(resolveFenceUrls(5, "/static")).toEqual([
      "/static/fence-6.png",
      "/static/fence-6.jpg",
      "/static/fence-6.svg",
    ]);
    expect(resolveBannerUrls()).toEqual([
      `${ADS_PUBLIC_BASE_PATH}/banner.png`,
      `${ADS_PUBLIC_BASE_PATH}/banner.jpg`,
      `${ADS_PUBLIC_BASE_PATH}/banner.svg`,
    ]);
  });

  it("generates the canvas fallback only where DOM canvas exists", () => {
    // Node has no document: this pins the fallback branch used when owner
    // files are missing (browser draws the placeholder, headless gets null).
    expect(() => createPlaceholderTexture("AD 1", 512, 256, "#22eeff")).toThrow();
  });
});

describe("AdsManager never-throws loading + fallback (B5)", () => {
  it("resolves even when no picture exists anywhere", async () => {
    const scene = new THREE.Scene();
    const ads = new AdsManager();
    ads.buildFrames(scene);
    try {
      expect(ads.fenceCount).toBe(6);
      expect(ads.isLoaded).toBe(false);
      await expect(ads.load("/definitely-missing-ads-path")).resolves.toBeUndefined();
      expect(ads.isLoaded).toBe(true);
    } finally {
      ads.dispose(scene);
      expect(scene.children).toHaveLength(0);
    }
  });
});
