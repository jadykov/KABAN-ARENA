import {
  PERF_BAD_WINDOWS,
  PERF_BALANCED_PIXEL_RATIO,
  PERF_DECISION_WINDOW_MS,
  PERF_LOW_PIXEL_RATIO,
  PERF_MAX_PIXEL_RATIO,
  PERF_MAX_PROBE_INTERVAL_MS,
  PERF_OVERLOAD_RATIO,
  PERF_PACING_TOLERANCE_MS,
  PERF_PROBE_DURATION_MS,
  PERF_PROBE_SETTLE_MS,
  PERF_RECOVERY_MS,
  PERF_REDUCED_SHADOW_SIZE,
  PERF_STARTUP_GRACE_MS,
  SHADOW_MAP_SIZE,
} from "./config";

export type QualityLevel = "high" | "balanced" | "low";

export interface RenderQualityProfile {
  readonly level: QualityLevel;
  readonly maxPixelRatio: number;
  readonly shadowMapSize: number;
  readonly ambientHz: number;
  readonly targetFps: 60 | 30;
}

export const MAX_PIXEL_RATIO = PERF_MAX_PIXEL_RATIO;
export const QUALITY_PROFILES: Readonly<Record<QualityLevel, RenderQualityProfile>> = Object.freeze({
  high: Object.freeze({
    level: "high", maxPixelRatio: MAX_PIXEL_RATIO, shadowMapSize: SHADOW_MAP_SIZE, ambientHz: 60, targetFps: 60,
  }),
  balanced: Object.freeze({
    level: "balanced", maxPixelRatio: PERF_BALANCED_PIXEL_RATIO,
    shadowMapSize: PERF_REDUCED_SHADOW_SIZE, ambientHz: 30, targetFps: 60,
  }),
  low: Object.freeze({
    level: "low", maxPixelRatio: PERF_LOW_PIXEL_RATIO,
    shadowMapSize: PERF_REDUCED_SHADOW_SIZE, ambientHz: 15, targetFps: 30,
  }),
});
// Recovery tries 60 Hz at the SAME low resolution before raising quality.
const LOW_PROBE_PROFILE: RenderQualityProfile = Object.freeze({ ...QUALITY_PROFILES.low, targetFps: 60 });

export function getClampedPixelRatio(devicePixelRatio: number, profile: RenderQualityProfile = QUALITY_PROFILES.high): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.min(dpr, profile.maxPixelRatio);
}

export function getInitialQuality(coarsePointer: boolean): RenderQualityProfile {
  return coarsePointer ? QUALITY_PROFILES.balanced : QUALITY_PROFILES.high;
}

// Deadline accumulation preserves the correct average on 90/120/144 Hz
// displays without rendering catch-up frames or assuming the refresh rate.
export class FramePacer {
  private nextTimestamp = Number.NaN;
  private targetFps = 0;

  public take(timestamp: number, targetFps: 60 | 30): boolean {
    const interval = 1000 / targetFps;
    if (!Number.isFinite(this.nextTimestamp) || this.targetFps !== targetFps) {
      this.targetFps = targetFps;
      this.nextTimestamp = timestamp + interval;
      return true;
    }
    if (timestamp < this.nextTimestamp - PERF_PACING_TOLERANCE_MS) return false;
    this.nextTimestamp += interval * Math.max(1, Math.floor((timestamp - this.nextTimestamp + PERF_PACING_TOLERANCE_MS) / interval) + 1);
    return true;
  }

  public reset(): void {
    this.nextTimestamp = Number.NaN;
    this.targetFps = 0;
  }
}

// Raw presented-frame spacing is the primary signal. Submit JS time supplies
// recovery headroom; it is never a GPU measurement. Windows are time-based.
export class AdaptiveQualityController {
  private current: RenderQualityProfile;
  private activeTimeMs = 0;
  private windowTimeMs = 0;
  private windowWorkMs = 0;
  private windowFrames = 0;
  private badWindows = 0;
  private healthyTimeMs = 0;
  private qualityTimeMs = 0;
  private probeTimeMs = 0;
  private probeSamplesMs = 0;
  private probeWorkMs = 0;
  private probeFrames = 0;
  private probeIntervalMs = PERF_RECOVERY_MS;

  public constructor(initial: RenderQualityProfile) {
    this.current = initial;
  }

  public get profile(): RenderQualityProfile {
    return this.current;
  }

  public get probing(): boolean {
    return this.current === LOW_PROBE_PROFILE;
  }

  public resetTiming(): void {
    if (this.probing) this.current = QUALITY_PROFILES.low;
    this.activeTimeMs = 0;
    this.qualityTimeMs = 0;
    this.healthyTimeMs = 0;
    this.badWindows = 0;
    this.resetWindow();
    this.resetProbe();
  }

  public observe(rawDeltaMs: number, workMs: number): boolean {
    if (!Number.isFinite(rawDeltaMs) || rawDeltaMs <= 0 || !Number.isFinite(workMs) || workMs < 0) return false;
    this.activeTimeMs += rawDeltaMs;
    this.qualityTimeMs += rawDeltaMs;
    if (this.probing) return this.observeProbe(rawDeltaMs, workMs);
    if (this.activeTimeMs < PERF_STARTUP_GRACE_MS) return false;
    this.windowTimeMs += rawDeltaMs;
    this.windowWorkMs += workMs;
    this.windowFrames++;
    if (this.windowTimeMs < PERF_DECISION_WINDOW_MS) return false;
    const frameMs = this.windowTimeMs / this.windowFrames;
    const workMean = this.windowWorkMs / this.windowFrames;
    const overloaded = frameMs > (1000 / this.current.targetFps) * PERF_OVERLOAD_RATIO;
    const healthy = frameMs <= (1000 / this.current.targetFps) * 1.08 && workMean < 10;
    this.badWindows = overloaded ? this.badWindows + 1 : 0;
    this.healthyTimeMs = healthy ? this.healthyTimeMs + this.windowTimeMs : 0;
    this.resetWindow();
    if (this.current.level !== "low" && this.badWindows >= PERF_BAD_WINDOWS) {
      this.change(this.current.level === "high" ? QUALITY_PROFILES.balanced : QUALITY_PROFILES.low);
      return true;
    }
    if (this.current.level === "low" && healthy && this.qualityTimeMs >= this.probeIntervalMs) {
      this.current = LOW_PROBE_PROFILE;
      this.resetProbe();
      return true;
    }
    if (this.current.level === "balanced" && this.healthyTimeMs >= PERF_RECOVERY_MS && this.qualityTimeMs >= PERF_RECOVERY_MS) {
      this.change(QUALITY_PROFILES.high);
      return true;
    }
    return false;
  }

  private observeProbe(rawDeltaMs: number, workMs: number): boolean {
    this.probeTimeMs += rawDeltaMs;
    if (this.probeTimeMs > PERF_PROBE_SETTLE_MS) {
      this.probeSamplesMs += rawDeltaMs;
      this.probeWorkMs += workMs;
      this.probeFrames++;
    }
    const mean = this.probeSamplesMs / Math.max(1, this.probeFrames);
    const failed = this.probeSamplesMs >= 1000 && mean > (1000 / 60) * PERF_OVERLOAD_RATIO;
    if (!failed && this.probeTimeMs < PERF_PROBE_DURATION_MS) return false;
    const recovered = !failed && this.probeFrames > 0 && mean <= (1000 / 60) * 1.08 && this.probeWorkMs / this.probeFrames < 10;
    this.probeIntervalMs = recovered ? PERF_RECOVERY_MS : Math.min(this.probeIntervalMs * 2, PERF_MAX_PROBE_INTERVAL_MS);
    this.change(recovered ? QUALITY_PROFILES.balanced : QUALITY_PROFILES.low);
    return true;
  }

  private change(profile: RenderQualityProfile): void {
    this.current = profile;
    this.qualityTimeMs = 0;
    this.healthyTimeMs = 0;
    this.badWindows = 0;
    this.resetWindow();
    this.resetProbe();
  }
  private resetWindow(): void {
    this.windowTimeMs = 0;
    this.windowWorkMs = 0;
    this.windowFrames = 0;
  }

  private resetProbe(): void {
    this.probeTimeMs = 0;
    this.probeSamplesMs = 0;
    this.probeWorkMs = 0;
    this.probeFrames = 0;
  }
}
