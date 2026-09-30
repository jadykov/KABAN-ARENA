import type * as THREE from "three";
import { PERF_DIAGNOSTIC_INTERVAL_MS } from "../config";
import type { RenderQualityProfile } from "../perf";
import type { PerformanceMonitor } from "./PerformanceMonitor";

export class PerformanceOverlay {
  private readonly element: HTMLPreElement;
  private nextUpdateMs = 0;

  public constructor(container: HTMLElement) {
    this.element = document.createElement("pre");
    this.element.dataset["performanceOverlay"] = "true";
    this.element.style.cssText = "position:fixed;left:4px;top:4px;z-index:1000;pointer-events:none;margin:0;padding:6px;background:rgba(0,0,0,.78);color:#fff;font:11px/1.4 monospace;white-space:pre-wrap;max-width:calc(100vw - 8px);";
    container.appendChild(this.element);
  }

  public update(timestamp: number, monitor: PerformanceMonitor, renderer: THREE.WebGLRenderer, profile: RenderQualityProfile, probing: boolean): void {
    if (timestamp < this.nextUpdateMs) return;
    this.nextUpdateMs = timestamp + PERF_DIAGNOSTIC_INTERVAL_MS;
    const stats = monitor.snapshot();
    const info = renderer.info;
    this.element.textContent = [
      `FPS ${stats.fps.toFixed(1)} / ${profile.targetFps} · ${profile.level}${probing ? " (проба 60)" : ""} · DPR ${renderer.getPixelRatio().toFixed(2)}`,
      `Кадр ${stats.meanMs.toFixed(1)} ms · p95 ${stats.p95Ms.toFixed(1)} · p99 ${stats.p99Ms.toFixed(1)}`,
      `JS + submit ${stats.submitMeanMs.toFixed(1)} ms (не GPU)`,
      `Кадры ≥50/100 ms: ${stats.longFrames}/${stats.veryLongFrames} · всего ${stats.frames}`,
      `Draw ${info.render.calls} · треуг. ${info.render.triangles} · тени ${profile.shadowMapSize}`,
      `Геом. ${info.memory.geometries} · текстуры ${info.memory.textures} · программы ${info.programs?.length ?? 0}`,
    ].join("\n");
  }

  public resetTiming(): void {
    this.nextUpdateMs = 0;
  }

  public dispose(): void {
    this.element.remove();
  }
}
