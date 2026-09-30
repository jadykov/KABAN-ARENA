import * as THREE from "three";
import { CAMERA_FOV, PERF_WARMUP_TIMEOUT_MS } from "../config";
import { AdaptiveQualityController, FramePacer, getClampedPixelRatio, getInitialQuality } from "../perf";
import type { RenderQualityProfile } from "../perf";
import { PerformanceMonitor } from "./PerformanceMonitor";
import type { FrameStatistics } from "./PerformanceMonitor";
import { PerformanceOverlay } from "./PerformanceOverlay";

// Thin renderer/scene/loop owner. Scene content lives in SceneManager;
// this class only owns the canvas, the render loop, resize handling,
// and full cleanup (used on dispose / room leave / scene reset).
export type UpdateCallback = (deltaSeconds: number) => void;

export class Engine {
  public readonly renderer: THREE.WebGLRenderer;
  public readonly scene: THREE.Scene;
  public readonly camera: THREE.PerspectiveCamera;

  private readonly container: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly callbacks = new Set<UpdateCallback>();
  private readonly qualityListeners = new Set<(profile: RenderQualityProfile) => void>();
  private readonly qualityController: AdaptiveQualityController;
  private readonly pacer = new FramePacer();
  private readonly monitor = new PerformanceMonitor();
  private readonly overlay: PerformanceOverlay | null;
  private animationFrameId = 0;
  private lastTimestamp = Number.NaN;
  private running = false;
  private disposed = false;
  private preparation: Promise<void> | null = null;
  private cancelPreparation: (() => void) | null = null;

  private readonly handleResize = (): void => {
    const width = window.innerWidth;
    const height = Math.max(1, window.innerHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    // Keep the selected profile on resize/orientation and browser zoom.
    this.applyPixelRatio();
    this.renderer.setSize(width, height);
  };

  private readonly handleVisibility = (): void => {
    this.cancelFrame();
    this.reset();
    if (this.running && !this.disposed && !document.hidden) this.scheduleFrame();
  };

  private readonly handleFrame = (timestamp: number): void => {
    this.animationFrameId = 0;
    if (!this.running || this.disposed || document.hidden) return;
    if (!this.pacer.take(timestamp, this.qualityProfile.targetFps)) {
      this.scheduleFrame();
      return;
    }
    const rawDeltaMs = Number.isFinite(this.lastTimestamp) ? Math.max(0, timestamp - this.lastTimestamp) : 0;
    const deltaSeconds = Math.min(rawDeltaMs / 1000, 0.1);
    this.lastTimestamp = timestamp;
    const workStart = performance.now();
    for (const callback of this.callbacks) callback(deltaSeconds);
    if (!this.running || this.disposed) return;
    this.renderer.render(this.scene, this.camera);
    const workMs = Math.max(0, performance.now() - workStart);
    this.monitor.record(rawDeltaMs, workMs);
    if (this.qualityController.observe(rawDeltaMs, workMs)) this.notifyQualityChange();
    this.overlay?.update(timestamp, this.monitor, this.renderer, this.qualityProfile, this.qualityController.probing);
    this.scheduleFrame();
  };

  public constructor(container: HTMLElement) {
    this.container = container;
    const coarsePointer = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
    this.qualityController = new AdaptiveQualityController(getInitialQuality(coarsePointer));
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.applyPixelRatio();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.canvas = this.renderer.domElement;
    this.container.appendChild(this.canvas);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      CAMERA_FOV,
      window.innerWidth / Math.max(1, window.innerHeight),
      0.1,
      200,
    );
    this.overlay = new URLSearchParams(window.location.search).get("perf") === "1" ? new PerformanceOverlay(container) : null;
    window.addEventListener("resize", this.handleResize);
    document.addEventListener("visibilitychange", this.handleVisibility);
  }

  public get maxPixelRatio(): number {
    return this.qualityProfile.maxPixelRatio;
  }

  public get qualityProfile(): RenderQualityProfile {
    return this.qualityController.profile;
  }

  public get performanceSnapshot(): FrameStatistics {
    return this.monitor.snapshot();
  }

  public onQualityChange(listener: (profile: RenderQualityProfile) => void): () => void {
    if (this.disposed) return (): void => {};
    this.qualityListeners.add(listener);
    listener(this.qualityProfile);
    return (): void => { this.qualityListeners.delete(listener); };
  }

  public onUpdate(callback: UpdateCallback): () => void {
    if (this.disposed) return (): void => {};
    this.callbacks.add(callback);
    return (): void => {
      this.callbacks.delete(callback);
    };
  }

  public prepare(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.preparation !== null) return this.preparation;
    this.preparation = this.prepareResources();
    return this.preparation;
  }

  private async prepareResources(): Promise<void> {
    const renderer = this.renderer;
    // compile in r169 traverses hidden meshes as well. No force-visible pass
    // is necessary for the already-created shield/pickup/particle materials.
    // Upload texture assets here, before the first shot/bonus can need them.
    const textures = new Set<THREE.Texture>();
    this.scene.traverse((object): void => {
      const material = (object as THREE.Mesh).material;
      if (material === undefined) return;
      const materials = Array.isArray(material) ? material : [material];
      for (const item of materials) {
        for (const value of Object.values(item)) {
          if (value instanceof THREE.Texture) textures.add(value);
        }
      }
    });
    try {
      for (const texture of textures) renderer.initTexture(texture);
      if (typeof renderer.compileAsync !== "function" || !renderer.extensions.has("KHR_parallel_shader_compile")) {
        renderer.compile(this.scene, this.camera);
      } else {
        const ready = await new Promise<boolean>((resolve): void => {
          let settled = false;
          let pendingMaterials: Set<THREE.Material> | null = null;
          const finish = (completed: boolean): void => {
            if (settled) return;
            settled = true;
            // r169 compileAsync polls the Set returned by compile. Emptying
            // that wait-list safely ends polling even if dispose/timeout occurs
            // before the driver reports shader completion; materials survive.
            pendingMaterials?.clear();
            window.clearTimeout(timeout);
            this.cancelPreparation = null;
            resolve(completed);
          };
          const timeout = window.setTimeout((): void => { finish(false); }, PERF_WARMUP_TIMEOUT_MS);
          this.cancelPreparation = (): void => { finish(false); };
          const compile = renderer.compile;
          renderer.compile = (scene, camera, target): Set<THREE.Material> => {
            pendingMaterials = compile.call(renderer, scene, camera, target);
            return pendingMaterials;
          };
          try {
            void renderer.compileAsync(this.scene, this.camera).then(
              (): void => { finish(true); },
              (): void => { finish(false); },
            );
          } catch {
            finish(false);
          } finally {
            renderer.compile = compile;
          }
        });
        if (!ready) return;
      }
      // compile prepares color programs, whereas the first submission also
      // creates shadow targets/depth programs and visible geometry buffers.
      // Do that once during loading, with no update callbacks or GPU barrier.
      if (!this.disposed) renderer.render(this.scene, this.camera);
    } catch {
      // Shader/texture warmup is best-effort; regular rendering can retry a
      // transient upload/compilation failure. Never leave boot awaiting it.
    }
  }

  public start(): void {
    if (this.running || this.disposed) {
      return;
    }
    this.running = true;
    this.reset();
    if (!document.hidden) this.scheduleFrame();
  }

  public stop(): void {
    this.running = false;
    this.cancelFrame();
  }

  public reset(): void {
    this.lastTimestamp = Number.NaN;
    this.pacer.reset();
    const profile = this.qualityProfile;
    this.qualityController.resetTiming();
    this.monitor.resetWindow();
    this.overlay?.resetTiming();
    if (profile !== this.qualityProfile) this.notifyQualityChange();
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.stop();
    this.cancelPreparation?.();
    this.callbacks.clear();
    this.qualityListeners.clear();
    window.removeEventListener("resize", this.handleResize);
    document.removeEventListener("visibilitychange", this.handleVisibility);
    this.overlay?.dispose();
    if (this.canvas.parentElement === this.container) {
      this.container.removeChild(this.canvas);
    }
    this.renderer.dispose();
  }

  private notifyQualityChange(): void {
    this.applyPixelRatio();
    for (const listener of this.qualityListeners) listener(this.qualityProfile);
  }

  private applyPixelRatio(): void {
    const ratio = getClampedPixelRatio(window.devicePixelRatio, this.qualityProfile);
    if (this.renderer.getPixelRatio() !== ratio) this.renderer.setPixelRatio(ratio);
  }

  private scheduleFrame(): void {
    if (this.running && !this.disposed && !document.hidden && this.animationFrameId === 0) {
      this.animationFrameId = window.requestAnimationFrame(this.handleFrame);
    }
  }

  private cancelFrame(): void {
    if (this.animationFrameId !== 0) window.cancelAnimationFrame(this.animationFrameId);
    this.animationFrameId = 0;
  }
}
