import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Owner ad pictures (corrective round, variant A): the 3 owner JPEGs cycle
// 1-2-3-1-2-3 across the 6 fence frames, the top banner keeps its SVG
// placeholder (no banner.jpg/png), and the stretched wall banners are gone.
// Source of truth is client/assets/ads, delivered to public/ads by
// scripts/sync-ads.mjs (recursive merge, never deletes) — so this also pins
// that no wall-*.jpg lingers in the served directory. Tests run from the
// client workspace root; paths resolve from this file, not cwd.
const here = dirname(fileURLToPath(import.meta.url));
const publicAds = join(here, "../../public/ads");

describe("owner ad assets in public/ads (variant A)", () => {
  it("serves fence-1..6.jpg + banner.svg, no wall banners, banner stays SVG", () => {
    for (let slot = 1; slot <= 6; slot += 1) {
      expect(existsSync(join(publicAds, `fence-${slot}.jpg`))).toBe(true);
    }
    expect(existsSync(join(publicAds, "banner.svg"))).toBe(true);
    // The top banner keeps the "KABAN ARENA" placeholder: no owner file.
    expect(existsSync(join(publicAds, "banner.jpg"))).toBe(false);
    expect(existsSync(join(publicAds, "banner.png"))).toBe(false);
    const entries = readdirSync(publicAds);
    expect(entries.filter((name) => name.startsWith("wall-") && name.endsWith(".jpg"))).toEqual([]);
  });
});
