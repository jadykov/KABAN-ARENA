import * as THREE from "three";
import { CAMERA_FOV } from "../config";
import { MAX_PIXEL_RATIO, getClampedPixelRatio } from "../perf";

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
  private animationFrameId = 0;
  private lastTimestamp = 0;
  private running = false;
  private disposed = false;

  private readonly handleResize = (): void => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    // Perf rule: always clamp pixel ratio for mobile GPUs.
    this.renderer.setPixelRatio(getClampedPixelRatio(window.devicePixelRatio));
    this.renderer.setSize(width, height);
  };

  private readonly handleFrame = (timestamp: number): void => {
    if (!this.running || this.disposed) {
      return;
    }
    const deltaSeconds = this.lastTimestamp === 0
      ? 0
      : Math.min((timestamp - this.lastTimestamp) / 1000, 0.1);
    this.lastTimestamp = timestamp;
    for (const callback of this.callbacks) {
      callback(deltaSeconds);
    }
    this.renderer.render(this.scene, this.camera);
    this.animationFrameId = window.requestAnimationFrame(this.handleFrame);
  };

  public constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(getClampedPixelRatio(window.devicePixelRatio));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.canvas = this.renderer.domElement;
    this.container.appendChild(this.canvas);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      CAMERA_FOV,
      window.innerWidth / window.innerHeight,
      0.1,
      200,
    );

    window.addEventListener("resize", this.handleResize);
  }

  public get maxPixelRatio(): number {
    return MAX_PIXEL_RATIO;
  }

  public onUpdate(callback: UpdateCallback): () => void {
    this.callbacks.add(callback);
    return (): void => {
      this.callbacks.delete(callback);
    };
  }

  public start(): void {
    if (this.running || this.disposed) {
      return;
    }
    this.running = true;
    this.lastTimestamp = 0;
    this.animationFrameId = window.requestAnimationFrame(this.handleFrame);
  }

  public stop(): void {
    this.running = false;
    if (this.animationFrameId !== 0) {
      window.cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = 0;
    }
  }

  public reset(): void {
    this.lastTimestamp = 0;
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.stop();
    this.callbacks.clear();
    window.removeEventListener("resize", this.handleResize);
    if (this.canvas.parentElement === this.container) {
      this.container.removeChild(this.canvas);
    }
    this.renderer.dispose();
  }
}
