import { describe, expect, it } from "vitest";
import { AdaptiveQualityController, FramePacer, getClampedPixelRatio, getInitialQuality, QUALITY_PROFILES } from "./perf";
import { PerformanceMonitor } from "./engine/PerformanceMonitor";

function feed(controller: AdaptiveQualityController, seconds: number, intervalMs: number, workMs = 4): void {
  for (let time = 0; time < seconds * 1000; time += intervalMs) controller.observe(intervalMs, workMs);
}

describe("adaptive presentation budget", () => {
  it("uses input capability for the initial budget and guards invalid DPR", () => {
    expect(getInitialQuality(true).level).toBe("balanced");
    expect(getInitialQuality(false).level).toBe("high");
    expect(getClampedPixelRatio(3, QUALITY_PROFILES.balanced)).toBe(1.25);
    expect(getClampedPixelRatio(3, QUALITY_PROFILES.low)).toBe(1);
    expect(getClampedPixelRatio(0.75, QUALITY_PROFILES.low)).toBe(0.75);
    expect(getClampedPixelRatio(Number.NaN)).toBe(1);
    expect(getClampedPixelRatio(-2)).toBe(1);
  });

  it("ignores startup and isolated stalls, but reduces sustained missed budgets", () => {
    const controller = new AdaptiveQualityController(QUALITY_PROFILES.high);
    feed(controller, 2, 100);
    expect(controller.profile.level).toBe("high");
    feed(controller, 4, 1000 / 60);
    controller.observe(500, 5);
    feed(controller, 6, 1000 / 60);
    expect(controller.profile.level).toBe("high");
    feed(controller, 7, 1000 / 25);
    expect(controller.profile.level).toBe("balanced");
    feed(controller, 7, 1000 / 25);
    expect(controller.profile.level).toBe("low");
    expect(controller.profile.targetFps).toBe(30);
  });

  it("does not interpret intentional 30 FPS as overload and tests recovery without resizing", () => {
    const controller = new AdaptiveQualityController(QUALITY_PROFILES.low);
    feed(controller, 29, 1000 / 30);
    expect(controller.profile.targetFps).toBe(30);
    feed(controller, 3, 1000 / 30);
    expect(controller.probing).toBe(true);
    expect(controller.profile).toMatchObject({ level: "low", maxPixelRatio: 1, shadowMapSize: 512, targetFps: 60 });
    feed(controller, 4.1, 1000 / 60);
    expect(controller.profile.level).toBe("balanced");
    feed(controller, 29, 1000 / 60);
    expect(controller.profile.level).toBe("balanced");
    feed(controller, 4, 1000 / 60);
    expect(controller.profile.level).toBe("high");
  });

  it("quickly abandons failed recovery and backs off further probes", () => {
    const controller = new AdaptiveQualityController(QUALITY_PROFILES.low);
    feed(controller, 33, 1000 / 30);
    // The 30 FPS stream cannot sustain the 60 FPS probe, so it returns to30.
    expect(controller.profile).toBe(QUALITY_PROFILES.low);
    feed(controller, 35, 1000 / 30);
    expect(controller.probing).toBe(false);
    feed(controller, 29, 1000 / 30);
    // A second attempt may already have failed, but resolution never rises.
    expect(controller.profile.level).toBe("low");
    expect(controller.profile.maxPixelRatio).toBe(1);
  });

  it("drops partial overload/recovery history when timing resets", () => {
    const controller = new AdaptiveQualityController(QUALITY_PROFILES.high);
    feed(controller, 7, 40);
    controller.resetTiming();
    feed(controller, 6, 1000 / 60);
    expect(controller.profile.level).toBe("high");
    feed(controller, 9, 40);
    expect(controller.profile.level).toBe("balanced");
    controller.resetTiming();
    expect(controller.profile.level).toBe("balanced");
  });

  for (const refresh of [60, 90, 120, 144]) {
    for (const target of [30, 60] as const) {
      it(`paces ${target} FPS on a ${refresh} Hz display with no catch-up burst`, () => {
        const pacer = new FramePacer();
        const controller = new AdaptiveQualityController(target === 60 ? QUALITY_PROFILES.high : QUALITY_PROFILES.low);
        const times: number[] = [];
        for (let tick = 0; tick < refresh * 12; tick++) {
          const timestamp = tick * 1000 / refresh;
          if (!pacer.take(timestamp, target)) continue;
          const previous = times.at(-1);
          if (previous !== undefined) controller.observe(timestamp - previous, 4);
          times.push(timestamp);
        }
        expect(times.length).toBeGreaterThanOrEqual(target * 12 - 1);
        expect(times.length).toBeLessThanOrEqual(target * 12 + 1);
        expect(controller.profile.targetFps).toBe(target);
        const previousCount = times.length;
        expect(pacer.take(30000, target)).toBe(true);
        expect(pacer.take(30000, target)).toBe(false);
        expect(times.length).toBe(previousCount);
        pacer.reset();
        expect(pacer.take(30001, target)).toBe(true);
      });
    }
  }
});

describe("raw frame telemetry", () => {
  it("keeps actual long intervals rather than the simulation delta clamp", () => {
    const monitor = new PerformanceMonitor();
    for (let i = 0; i < 95; i++) monitor.record(16, 4);
    for (let i = 0; i < 5; i++) monitor.record(300, 8);
    const stats = monitor.snapshot();
    expect(stats.meanMs).toBe(30.2);
    expect(stats.p95Ms).toBe(16);
    expect(stats.p99Ms).toBe(300);
    expect(stats.longFrames).toBe(5);
    expect(stats.veryLongFrames).toBe(5);
    expect(stats.submitMeanMs).toBe(4.2);
  });

  it("bounds retained samples and excludes background timing while preserving session counts", () => {
    const monitor = new PerformanceMonitor();
    monitor.record(500, 5);
    for (let i = 0; i < 1000; i++) monitor.record(20, 4);
    expect(monitor.snapshot()).toMatchObject({ samples: 360, frames: 1001, meanMs: 20, p99Ms: 20, longFrames: 1 });
    monitor.resetWindow();
    expect(monitor.snapshot()).toMatchObject({ samples: 0, fps: 0, frames: 1001, longFrames: 1 });
    monitor.record(1000 / 30, 4);
    expect(monitor.snapshot().fps).toBeCloseTo(30);
    expect(monitor.snapshot().longFrames).toBe(1);
  });
});
