import { PERF_LONG_FRAME_MS, PERF_SAMPLE_CAPACITY, PERF_VERY_LONG_FRAME_MS } from "../config";

export interface FrameStatistics {
  readonly fps: number;
  readonly meanMs: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly submitMeanMs: number;
  readonly samples: number;
  readonly frames: number;
  readonly longFrames: number;
  readonly veryLongFrames: number;
}

// A bounded ring and preallocated sort workspace: recording a frame creates
// no arrays/objects. A snapshot is only requested at diagnostic frequency.
export class PerformanceMonitor {
  private readonly intervals = new Float64Array(PERF_SAMPLE_CAPACITY);
  private readonly submitTimes = new Float64Array(PERF_SAMPLE_CAPACITY);
  private readonly sorted = new Float64Array(PERF_SAMPLE_CAPACITY);
  private index = 0;
  private samples = 0;
  private intervalSum = 0;
  private submitSum = 0;
  private frames = 0;
  private longFrames = 0;
  private veryLongFrames = 0;

  public record(rawDeltaMs: number, submitMs: number): void {
    if (!Number.isFinite(rawDeltaMs) || rawDeltaMs <= 0 || !Number.isFinite(submitMs) || submitMs < 0) return;
    if (this.samples === PERF_SAMPLE_CAPACITY) {
      this.intervalSum -= this.intervals[this.index]!;
      this.submitSum -= this.submitTimes[this.index]!;
    } else this.samples++;
    this.intervals[this.index] = rawDeltaMs;
    this.submitTimes[this.index] = submitMs;
    this.intervalSum += rawDeltaMs;
    this.submitSum += submitMs;
    this.index = (this.index + 1) % PERF_SAMPLE_CAPACITY;
    this.frames++;
    if (rawDeltaMs >= PERF_LONG_FRAME_MS) this.longFrames++;
    if (rawDeltaMs >= PERF_VERY_LONG_FRAME_MS) this.veryLongFrames++;
  }

  public resetWindow(): void {
    this.index = 0;
    this.samples = 0;
    this.intervalSum = 0;
    this.submitSum = 0;
  }

  public snapshot(): FrameStatistics {
    this.sorted.fill(Number.POSITIVE_INFINITY);
    for (let i = 0; i < this.samples; i++) this.sorted[i] = this.intervals[i]!;
    this.sorted.sort();
    const percentile = (fraction: number): number => this.samples === 0 ? 0 : this.sorted[Math.ceil(this.samples * fraction) - 1]!;
    return {
      fps: this.intervalSum > 0 ? this.samples * 1000 / this.intervalSum : 0,
      meanMs: this.samples === 0 ? 0 : this.intervalSum / this.samples,
      p95Ms: percentile(0.95),
      p99Ms: percentile(0.99),
      submitMeanMs: this.samples === 0 ? 0 : this.submitSum / this.samples,
      samples: this.samples,
      frames: this.frames,
      longFrames: this.longFrames,
      veryLongFrames: this.veryLongFrames,
    };
  }
}
