import { describe, expect, it } from "vitest";
import { MAX_PIXEL_RATIO, getClampedPixelRatio } from "./perf";

describe("client smoke", () => {
  it("boots", () => {
    expect(1 + 1).toBe(2);
  });

  it("clamps pixel ratio to the mobile budget", () => {
    expect(MAX_PIXEL_RATIO).toBe(1.5);
    expect(getClampedPixelRatio(1)).toBe(1);
    expect(getClampedPixelRatio(3)).toBe(1.5);
  });
});
