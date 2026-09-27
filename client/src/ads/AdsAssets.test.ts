import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Three softened owner JPEGs dress four shopfronts: Krasnoe & Beloe (2)
// repeats on the diagonal, Magnit (3) and Pyaterochka (1) appear once.
// Source of truth is client/assets/ads, delivered to public/ads by
// scripts/sync-ads.mjs (recursive merge, never deletes) — so this also pins
// that no wall-*.jpg lingers in the served directory. Tests run from the
// client workspace root; paths resolve from this file, not cwd.
const here = dirname(fileURLToPath(import.meta.url));
const publicAds = join(here, "../../public/ads");

describe("owner shop signs in public/ads", () => {
  it("serves all three brand JPEGs", () => {
    for (let slot = 1; slot <= 3; slot += 1) {
      expect(existsSync(join(publicAds, `fence-${slot}.jpg`))).toBe(true);
    }
    const entries = readdirSync(publicAds);
    expect(entries.filter((name) => name.startsWith("wall-") && name.endsWith(".jpg"))).toEqual([]);
  });
});
