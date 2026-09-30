import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Engine } from "./Engine";

const rendererState = vi.hoisted(() => ({
  extensionsSupported: false,
  asyncMode: "ready" as "ready" | "pending" | "reject" | "throw",
  instances: [] as Array<{
    render: ReturnType<typeof vi.fn>;
    setPixelRatio: ReturnType<typeof vi.fn>;
    setSize: ReturnType<typeof vi.fn>;
    compile: ReturnType<typeof vi.fn>;
    compileAsync: ReturnType<typeof vi.fn>;
    initTexture: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal<typeof import("three")>();
  class RendererStub {
    public readonly domElement = { parentElement: null };
    public readonly shadowMap = { enabled: false, type: 0 };
    public readonly extensions = { has: (): boolean => rendererState.extensionsSupported };
    public readonly info = { render: { calls: 42, triangles: 1234 }, memory: { geometries: 12, textures: 7 }, programs: [1, 2] };
    private pixelRatio = 1;
    public readonly setPixelRatio = vi.fn((ratio: number): void => { this.pixelRatio = ratio; });
    public readonly getPixelRatio = (): number => this.pixelRatio;
    public readonly setSize = vi.fn();
    public readonly render = vi.fn();
    public compile = vi.fn((_scene: THREE.Scene, _camera: THREE.Camera) => new Set<THREE.Material>([new actual.MeshBasicMaterial()]));
    public readonly compileAsync = vi.fn((scene: THREE.Scene, camera: THREE.Camera): Promise<THREE.Scene> => {
      const materials = this.compile(scene, camera);
      if (rendererState.asyncMode === "throw") throw new Error("driver failure");
      if (rendererState.asyncMode === "reject") return Promise.reject(new Error("driver failure"));
      return new Promise((resolve): void => {
        const poll = (): void => {
          if (materials.size === 0 || rendererState.asyncMode === "ready") resolve(scene);
          else setTimeout(poll, 10);
        };
        setTimeout(poll, 10);
      });
    });
    public readonly initTexture = vi.fn();
    public readonly dispose = vi.fn();
    public constructor() { rendererState.instances.push(this); }
  }
  return { ...actual, WebGLRenderer: RendererStub };
});

class ElementStub {
  public parentElement: ElementStub | null = null;
  public readonly children: ElementStub[] = [];
  public readonly dataset: Record<string, string> = {};
  public readonly style = { cssText: "" };
  public textContent = "";
  public appendChild(child: ElementStub): void { child.parentElement = this; this.children.push(child); }
  public removeChild(child: ElementStub): void {
    child.parentElement = null;
    this.children.splice(this.children.indexOf(child), 1);
  }
  public remove(): void { this.parentElement?.removeChild(this); }
}

function environment(coarse = false, search = ""): {
  container: HTMLElement;
  windowTarget: EventTarget;
  documentTarget: EventTarget;
  documentState: { hidden: boolean };
  advance: (timestamp: number) => void;
  queued: () => number;
} {
  const container = new ElementStub();
  const windowTarget = new EventTarget();
  const documentTarget = new EventTarget();
  const documentState = {
    hidden: false,
    addEventListener: documentTarget.addEventListener.bind(documentTarget),
    removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
    createElement: (): ElementStub => new ElementStub(),
  };
  const rafs = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  vi.stubGlobal("window", {
    innerWidth: 390, innerHeight: 844, devicePixelRatio: 3,
    location: { search },
    matchMedia: (): { matches: boolean } => ({ matches: coarse }),
    addEventListener: windowTarget.addEventListener.bind(windowTarget),
    removeEventListener: windowTarget.removeEventListener.bind(windowTarget),
    requestAnimationFrame: (callback: FrameRequestCallback): number => { const id = nextId++; rafs.set(id, callback); return id; },
    cancelAnimationFrame: (id: number): void => { rafs.delete(id); },
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  });
  vi.stubGlobal("document", documentState);
  return {
    container: container as unknown as HTMLElement,
    windowTarget, documentTarget, documentState,
    advance: (timestamp): void => {
      const callbacks = [...rafs.values()];
      rafs.clear();
      for (const callback of callbacks) callback(timestamp);
    },
    queued: (): number => rafs.size,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  rendererState.instances.length = 0;
  rendererState.extensionsSupported = false;
  rendererState.asyncMode = "ready";
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Engine lifecycle and pacing", () => {
  it("notifies the initial profile and unsubscribes cleanly", () => {
    const env = environment(true);
    const engine = new Engine(env.container);
    const listener = vi.fn();
    const unsubscribe = engine.onQualityChange(listener);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ level: "balanced", maxPixelRatio: 1.25 }));
    unsubscribe();
    engine.dispose();
    expect(env.container.children).toHaveLength(0);
    expect(env.queued()).toBe(0);
    expect(rendererState.instances[0]!.dispose).toHaveBeenCalledOnce();
    engine.dispose();
    expect(rendererState.instances[0]!.dispose).toHaveBeenCalledOnce();
  });

  it("caps high refresh rendering at60 and records unclamped stalls", () => {
    const env = environment();
    const engine = new Engine(env.container);
    const update = vi.fn();
    engine.onUpdate(update);
    engine.start();
    for (let i = 0; i < 240; i++) env.advance(i * 1000 / 120);
    expect(rendererState.instances[0]!.render).toHaveBeenCalledTimes(120);
    env.advance(4000);
    expect(update.mock.calls.at(-1)?.[0]).toBe(0.1);
    expect(engine.performanceSnapshot.p99Ms).toBeLessThan(100);
    expect(engine.performanceSnapshot.veryLongFrames).toBe(1);
    expect(engine.performanceSnapshot.longFrames).toBe(1);
    engine.dispose();
  });

  it("pauses hidden pages, resets return timing and preserves selected quality on resize", () => {
    const env = environment(true);
    const engine = new Engine(env.container);
    const update = vi.fn();
    engine.onUpdate(update);
    engine.start();
    for (let time = 0; time <= 11000; time += 40) env.advance(time);
    expect(engine.qualityProfile.level).toBe("low");
    const pixelRatioWrites = rendererState.instances[0]!.setPixelRatio.mock.calls.length;
    env.windowTarget.dispatchEvent(new Event("resize"));
    expect(engine.maxPixelRatio).toBe(1);
    expect(rendererState.instances[0]!.setPixelRatio).toHaveBeenCalledTimes(pixelRatioWrites);
    env.documentState.hidden = true;
    env.documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(env.queued()).toBe(0);
    const rendered = rendererState.instances[0]!.render.mock.calls.length;
    env.advance(30000);
    expect(rendererState.instances[0]!.render).toHaveBeenCalledTimes(rendered);
    env.documentState.hidden = false;
    env.documentTarget.dispatchEvent(new Event("visibilitychange"));
    env.advance(31000);
    expect(update.mock.calls.at(-1)?.[0]).toBe(0);
    expect(engine.performanceSnapshot.samples).toBe(0);
    expect(engine.qualityProfile.level).toBe("low");
    engine.dispose();
    env.windowTarget.dispatchEvent(new Event("resize"));
    env.documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(env.queued()).toBe(0);
  });

  it("does not schedule twice or restart after dispose; stop during an update prevents submission", () => {
    const env = environment();
    const engine = new Engine(env.container);
    engine.start(); engine.start();
    expect(env.queued()).toBe(1);
    engine.onUpdate((): void => { engine.stop(); });
    env.advance(0);
    expect(rendererState.instances[0]!.render).not.toHaveBeenCalled();
    expect(env.queued()).toBe(0);
    engine.dispose(); engine.start();
    expect(env.queued()).toBe(0);
  });

  it("tests recovery at60 without reallocating the low-resolution framebuffer", () => {
    const env = environment(true);
    const engine = new Engine(env.container);
    engine.start();
    for (let time = 0; time <= 11000; time += 40) env.advance(time);
    expect(engine.qualityProfile.level).toBe("low");
    const writes = rendererState.instances[0]!.setPixelRatio.mock.calls.length;
    let timestamp = 11000;
    for (let i = 0; i < 2400 && engine.qualityProfile.targetFps === 30; i++) {
      timestamp += 1000 / 60; env.advance(timestamp);
    }
    expect(engine.qualityProfile).toMatchObject({ level: "low", targetFps: 60, maxPixelRatio: 1 });
    expect(rendererState.instances[0]!.setPixelRatio).toHaveBeenCalledTimes(writes);
    for (let i = 0; i < 120; i++) { timestamp += 1000 / 60; env.advance(timestamp); }
    expect(engine.qualityProfile).toMatchObject({ level: "low", targetFps: 60 });
    expect(rendererState.instances[0]!.setPixelRatio).toHaveBeenCalledTimes(writes);
    engine.dispose();
  });

  it("updates the explicit debug overlay infrequently and removes it on dispose", () => {
    const env = environment(false, "?perf=1");
    const engine = new Engine(env.container);
    expect(env.container.children).toHaveLength(2);
    engine.start(); env.advance(0);
    const overlay = env.container.children[1] as unknown as ElementStub;
    expect(overlay.textContent).toContain("JS + submit");
    expect(overlay.textContent).toContain("не GPU");
    expect(overlay.textContent).toContain("Draw 42");
    const text = overlay.textContent;
    env.advance(16.67);
    expect(overlay.textContent).toBe(text);
    env.advance(1001);
    expect(overlay.textContent).not.toBe(text);
    engine.dispose();
    expect(env.container.children).toHaveLength(0);
  });
});

describe("Engine shader preparation", () => {
  it("uploads invisible effect textures and uses synchronous compile when the extension is absent", async () => {
    const env = environment();
    const engine = new Engine(env.container);
    const texture = new THREE.Texture();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ map: texture }));
    mesh.visible = false; engine.scene.add(mesh);
    const first = engine.prepare();
    expect(engine.prepare()).toBe(first);
    await first;
    expect(rendererState.instances[0]!.initTexture).toHaveBeenCalledWith(texture);
    expect(rendererState.instances[0]!.compile).toHaveBeenCalledOnce();
    expect(rendererState.instances[0]!.compileAsync).not.toHaveBeenCalled();
    expect(rendererState.instances[0]!.render).toHaveBeenCalledOnce();
    expect(engine.performanceSnapshot.frames).toBe(0);
    expect(env.queued()).toBe(0);
    engine.dispose(); mesh.geometry.dispose(); mesh.material.dispose(); texture.dispose();
  });

  it("completes asynchronous preparation before a caller starts frames", async () => {
    rendererState.extensionsSupported = true;
    const env = environment();
    const engine = new Engine(env.container);
    const update = vi.fn();
    engine.onUpdate(update);
    const prepared = engine.prepare();
    expect(rendererState.instances[0]!.render).not.toHaveBeenCalled();
    expect(env.queued()).toBe(0);
    await vi.advanceTimersByTimeAsync(10);
    await prepared;
    expect(rendererState.instances[0]!.compileAsync).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(rendererState.instances[0]!.render).toHaveBeenCalledOnce();
    expect(rendererState.instances[0]!.render).toHaveBeenCalledWith(engine.scene, engine.camera);
    expect(update).not.toHaveBeenCalled();
    expect(engine.performanceSnapshot.frames).toBe(0);
    await engine.prepare();
    expect(rendererState.instances[0]!.render).toHaveBeenCalledOnce();
    expect(env.queued()).toBe(0);
    engine.dispose();
  });

  it("falls back when the async API is unavailable, and resolves after disposal", async () => {
    const env = environment();
    const engine = new Engine(env.container);
    Object.defineProperty(engine.renderer, "compileAsync", { value: undefined });
    await engine.prepare();
    expect(rendererState.instances[0]!.compile).toHaveBeenCalledOnce();
    engine.dispose();
    await engine.prepare();
    expect(rendererState.instances[0]!.compile).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not draw if disposal wins the shader-completion microtask race", async () => {
    rendererState.extensionsSupported = true;
    const env = environment();
    const engine = new Engine(env.container);
    const prepared = engine.prepare();
    vi.advanceTimersByTime(10);
    engine.dispose();
    await prepared;
    expect(rendererState.instances[0]!.render).not.toHaveBeenCalled();
    expect(rendererState.instances[0]!.dispose).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("continues to normal frames if the loading preview submission fails", async () => {
    const env = environment();
    const engine = new Engine(env.container);
    rendererState.instances[0]!.render.mockImplementationOnce((): void => { throw new Error("transient upload"); });
    await engine.prepare();
    expect(rendererState.instances[0]!.render).toHaveBeenCalledOnce();
    expect(env.queued()).toBe(0);
    engine.start();
    env.advance(0);
    expect(rendererState.instances[0]!.render).toHaveBeenCalledTimes(2);
    expect(env.queued()).toBe(1);
    engine.dispose();
  });

  for (const reason of ["dispose", "timeout"] as const) {
    it(`drains native-style pending shader polling after ${reason}`, async () => {
      rendererState.extensionsSupported = true; rendererState.asyncMode = "pending";
      const env = environment();
      const engine = new Engine(env.container);
      const prepared = engine.prepare();
      await vi.advanceTimersByTimeAsync(20);
      expect(rendererState.instances[0]!.render).not.toHaveBeenCalled();
      if (reason === "dispose") engine.dispose();
      else await vi.advanceTimersByTimeAsync(5000);
      await prepared;
      await vi.advanceTimersByTimeAsync(20);
      expect(rendererState.instances[0]!.render).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(vi.isMockFunction(rendererState.instances[0]!.compile)).toBe(true);
      expect(rendererState.instances[0]!.render).not.toHaveBeenCalled();
      if (reason === "timeout") engine.dispose();
      expect(rendererState.instances[0]!.dispose).toHaveBeenCalledOnce();
      expect(env.queued()).toBe(0);
    });
  }

  for (const mode of ["reject", "throw"] as const) {
    it(`does not block boot after a shader ${mode}`, async () => {
      rendererState.extensionsSupported = true; rendererState.asyncMode = mode;
      const env = environment(); const engine = new Engine(env.container);
      await engine.prepare();
      expect(vi.getTimerCount()).toBe(0);
      expect(vi.isMockFunction(rendererState.instances[0]!.compile)).toBe(true);
      engine.start(); expect(env.queued()).toBe(1);
      engine.dispose();
    });
  }
});
