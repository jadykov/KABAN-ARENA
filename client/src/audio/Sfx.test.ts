// Stage 5 audio unit tests: the pure-logic SFX core (cooldown gating, voice
// cap, intensity/attenuation mapping, mute persistence parse, ricochet-onset
// detection) plus headless no-op safety — all runnable in the vitest node env
// with no AudioContext, same headless pattern as fx/Balls.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FOOTSTEP_MIN_SPEED01,
  SFX_AMBIENT_FADE_S,
  SFX_AMBIENT_GAIN,
  SFX_AMBIENT_URL,
  SFX_ATTENUATION_MIN,
  SFX_BASE_GAIN,
  SFX_CHARGE_BED_GAIN,
  SFX_COMP_RATIO,
  SFX_COMP_THRESHOLD_DB,
  SFX_COOLDOWN_MS,
  SFX_CREAK_PEAK,
  SFX_LAYER_SUM_MAX,
  SFX_MASTER_GAIN,
  SFX_REVERB_WET,
  SFX_VOICE_CAP,
  SFX_WORST_VOICE_PEAK,
  ambientAttachDecision,
  attenuationForDistance,
  chargeTickGap,
  clampIntensity,
  createSfx,
  detectRicochetOnsets,
  fmDepthForIntensity,
  intensityToGain,
  intensityToRate,
  parseStoredMute,
  pickSquealVariant,
  resolveAmbientUrl,
  squealDetune,
  SfxGate,
  VoicePool,
  type AmbientFetcher,
} from "./Sfx";

describe("clampIntensity", () => {
  it("clamps into [0, 1] and reads garbage as neutral mid strength", () => {
    expect(clampIntensity(0)).toBe(0);
    expect(clampIntensity(1)).toBe(1);
    expect(clampIntensity(-2)).toBe(0);
    expect(clampIntensity(2)).toBe(1);
    expect(clampIntensity(0.35)).toBeCloseTo(0.35, 10);
    expect(clampIntensity(Number.NaN)).toBe(0.5);
    expect(clampIntensity(undefined)).toBe(0.5);
    expect(clampIntensity("loud")).toBe(0.5);
  });
});

describe("intensityToGain", () => {
  it("is monotonic in intensity and never silent nor above base", () => {
    const base = SFX_BASE_GAIN["impact"] ?? 0.75;
    const soft = intensityToGain(base, 0);
    const mid = intensityToGain(base, 0.5);
    const full = intensityToGain(base, 1);
    expect(soft).toBeGreaterThan(0);
    expect(soft).toBeLessThan(mid);
    expect(mid).toBeLessThan(full);
    expect(full).toBeLessThanOrEqual(base);
    // Round 2 wide dynamics: weak hits read clearly thin and quiet.
    expect(soft).toBeGreaterThanOrEqual(base * 0.35);
    expect(soft).toBeLessThan(base * 0.5);
  });

  it("treats garbage intensity as mid strength", () => {
    const base = SFX_BASE_GAIN["throw"] ?? 0.22;
    expect(intensityToGain(base, Number.NaN)).toBeCloseTo(intensityToGain(base, 0.5), 10);
  });
});

describe("intensityToRate", () => {
  it("is monotonic and spans a wide non-shrill band", () => {
    const soft = intensityToRate(0);
    const mid = intensityToRate(0.5);
    const full = intensityToRate(1);
    expect(soft).toBeLessThan(mid);
    expect(mid).toBeLessThan(full);
    // Round 2 wide dynamics: weak hits sag, full hits scream (capped).
    expect(soft).toBeGreaterThanOrEqual(0.65);
    expect(soft).toBeLessThan(0.8);
    expect(full).toBeGreaterThan(1.2);
    expect(full).toBeLessThanOrEqual(1.35);
  });
});

describe("fmDepthForIntensity", () => {
  it("is monotonic in intensity and never above the base deviation", () => {
    const soft = fmDepthForIntensity(900, 0);
    const mid = fmDepthForIntensity(900, 0.5);
    const full = fmDepthForIntensity(900, 1);
    expect(soft).toBeGreaterThanOrEqual(0);
    expect(soft).toBeLessThan(mid);
    expect(mid).toBeLessThan(full);
    expect(full).toBeLessThanOrEqual(900);
    // Weak hits stay dark (a fraction of the scream), full hits open up.
    expect(soft).toBeLessThanOrEqual(900 * 0.35);
  });

  it("treats garbage as mid brightness and clamps the range", () => {
    expect(fmDepthForIntensity(900, Number.NaN)).toBeCloseTo(fmDepthForIntensity(900, 0.5), 10);
    expect(fmDepthForIntensity(-5, 1)).toBe(0);
  });
});

describe("attenuationForDistance", () => {
  it("is full volume point-blank and decays monotonically with distance", () => {
    expect(attenuationForDistance(0)).toBe(1);
    expect(attenuationForDistance(-5)).toBe(1);
    const near = attenuationForDistance(2);
    const mid = attenuationForDistance(10);
    const far = attenuationForDistance(40);
    expect(near).toBeLessThanOrEqual(1);
    expect(near).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(far);
    expect(far).toBeGreaterThanOrEqual(SFX_ATTENUATION_MIN);
  });

  it("floors far distances and treats garbage as point-blank", () => {
    expect(attenuationForDistance(10000)).toBe(SFX_ATTENUATION_MIN);
    expect(attenuationForDistance(Number.NaN)).toBe(1);
    expect(attenuationForDistance(undefined)).toBe(1);
  });
});

describe("parseStoredMute", () => {
  it("defaults to sound ON; only the exact stored flag mutes", () => {
    expect(parseStoredMute("1")).toBe(true);
    expect(parseStoredMute("0")).toBe(false);
    expect(parseStoredMute(null)).toBe(false);
    expect(parseStoredMute(undefined)).toBe(false);
    expect(parseStoredMute("true")).toBe(false);
    expect(parseStoredMute("")).toBe(false);
  });
});

describe("SfxGate", () => {
  it("blocks machine-gun repeats inside the per-event cooldown", () => {
    const gate = new SfxGate();
    const cooldown = SFX_COOLDOWN_MS["impact"] ?? 50;
    expect(gate.tryPlay("impact", 1000)).toBe(true);
    expect(gate.tryPlay("impact", 1000)).toBe(false);
    expect(gate.tryPlay("impact", 1000 + cooldown - 1)).toBe(false);
    expect(gate.tryPlay("impact", 1000 + cooldown)).toBe(true);
  });

  it("gates events independently", () => {
    const gate = new SfxGate();
    expect(gate.tryPlay("impact", 500)).toBe(true);
    expect(gate.tryPlay("ricochet", 500)).toBe(true);
    expect(gate.tryPlay("impact", 500)).toBe(false);
    expect(gate.tryPlay("ricochet", 500)).toBe(false);
  });

  it("rejects a non-finite clock without arming the cooldown", () => {
    const gate = new SfxGate();
    expect(gate.tryPlay("throw", Number.NaN)).toBe(false);
    expect(gate.tryPlay("throw", 700)).toBe(true);
  });

  it("reset re-arms every event", () => {
    const gate = new SfxGate();
    expect(gate.tryPlay("death", 100)).toBe(true);
    expect(gate.tryPlay("death", 100)).toBe(false);
    gate.reset();
    expect(gate.tryPlay("death", 100)).toBe(true);
  });
});

describe("VoicePool", () => {
  it("caps concurrent voices and re-opens on release", () => {
    const pool = new VoicePool(SFX_VOICE_CAP);
    for (let i = 0; i < SFX_VOICE_CAP; i += 1) {
      expect(pool.tryAcquire()).toBe(true);
    }
    expect(pool.activeVoices).toBe(SFX_VOICE_CAP);
    expect(pool.tryAcquire()).toBe(false);
    expect(pool.activeVoices).toBe(SFX_VOICE_CAP);
    pool.release();
    expect(pool.activeVoices).toBe(SFX_VOICE_CAP - 1);
    expect(pool.tryAcquire()).toBe(true);
  });

  it("never releases below zero", () => {
    const pool = new VoicePool(2);
    pool.release();
    expect(pool.activeVoices).toBe(0);
    expect(pool.tryAcquire()).toBe(true);
  });
});

describe("detectRicochetOnsets", () => {
  it("fires once on a false->true edge and never while the flag holds", () => {
    const first = detectRicochetOnsets(new Map(), [
      { ballId: "b1", ricochet: true, power01: 0.7 },
    ]);
    expect(first).toHaveLength(1);
    expect(first[0]?.ballId).toBe("b1");
    const held = detectRicochetOnsets(new Map([["b1", true]]), [
      { ballId: "b1", ricochet: true, power01: 0.7 },
    ]);
    expect(held).toHaveLength(0);
  });

  it("ignores balls without the flag and unknown ids stay independent", () => {
    const onsets = detectRicochetOnsets(new Map([["a", true]]), [
      { ballId: "a", ricochet: true },
      { ballId: "b", ricochet: false },
      { ballId: "c" },
      { ballId: "d", ricochet: true, vx: 10, vz: 0 },
    ]);
    expect(onsets.map((onset) => onset.ballId)).toEqual(["d"]);
  });

  it("scales intensity with authoritative speed, falling back to power01", () => {
    const prev = new Map<string, boolean>();
    const slow = detectRicochetOnsets(prev, [{ ballId: "s", ricochet: true, vx: 2, vz: 0 }]);
    const fast = detectRicochetOnsets(prev, [{ ballId: "f", ricochet: true, vx: 18, vz: 0 }]);
    expect(slow).toHaveLength(1);
    expect(fast).toHaveLength(1);
    const slowI = slow[0]?.intensity ?? 0;
    const fastI = fast[0]?.intensity ?? 0;
    expect(slowI).toBeGreaterThan(0);
    expect(fastI).toBeGreaterThan(slowI);
    const fallback = detectRicochetOnsets(prev, [{ ballId: "p", ricochet: true, power01: 0.9 }]);
    expect(fallback[0]?.intensity ?? 0).toBeGreaterThan(0.5);
  });
});

describe("SfxEngine headless safety", () => {
  it("constructs and stays a silent no-op without AudioContext", () => {
    const sfx = createSfx();
    expect(sfx.isMuted()).toBe(false);
    expect(sfx.running).toBe(false);
    expect(sfx.unlock()).toBe(false);
    expect(sfx.play("throw", { intensity: 1 })).toBe(false);
    expect(sfx.play("trampoline")).toBe(false);
    // Charge hum bookkeeping must never throw headless either.
    sfx.chargeStart();
    sfx.setChargeProgress(0.5);
    sfx.setChargeProgress(Number.NaN);
    sfx.chargeStop();
    sfx.dispose();
  });

  it("tracks mute state in memory when storage is unavailable", () => {
    const sfx = createSfx();
    expect(sfx.toggleMuted()).toBe(true);
    expect(sfx.isMuted()).toBe(true);
    expect(sfx.play("pickup")).toBe(false);
    sfx.setMuted(false);
    expect(sfx.isMuted()).toBe(false);
    sfx.dispose();
  });
});

describe("SFX tuning constants", () => {
  it("keeps the master hot but bounded and the footstep gate sane", () => {
    // Retuned 2026-09-24 (owner: first pass barely audible): master roughly
    // 2.5x up, still well below unity — the compressor is the backstop.
    expect(SFX_MASTER_GAIN).toBeGreaterThan(0.3);
    expect(SFX_MASTER_GAIN).toBeLessThanOrEqual(0.65);
    expect(SFX_VOICE_CAP).toBeGreaterThanOrEqual(4);
    expect(SFX_VOICE_CAP).toBeLessThanOrEqual(16);
    expect(FOOTSTEP_MIN_SPEED01).toBeGreaterThan(0);
    expect(FOOTSTEP_MIN_SPEED01).toBeLessThan(1);
  });
});

describe("level budget", () => {
  it("keeps the worst single voice below clipping with the limiter as backstop", () => {
    // Measured from the real table (layer-sum x death base x master), never
    // a magic number: nominal peaks pass the compressor untouched, only
    // stacked overlaps get caught, the destination never sees > 1.0.
    expect(SFX_WORST_VOICE_PEAK).toBeGreaterThan(0);
    expect(SFX_WORST_VOICE_PEAK).toBeLessThan(1);
    expect(SFX_WORST_VOICE_PEAK).toBeCloseTo(
      SFX_LAYER_SUM_MAX * (SFX_BASE_GAIN["death"] ?? 0) * SFX_MASTER_GAIN,
      10,
    );
    expect(SFX_COMP_THRESHOLD_DB).toBeLessThanOrEqual(-3);
    expect(SFX_COMP_RATIO).toBeGreaterThanOrEqual(4);
  });

  it("keeps the mix Genesis-dry (room glue, never a wash)", () => {
    expect(SFX_REVERB_WET).toBeGreaterThanOrEqual(0);
    expect(SFX_REVERB_WET).toBeLessThanOrEqual(0.1);
  });

  it("keeps footsteps clearly audible yet below the hits", () => {
    // Regression pin (owner 2026-09-24: "шагов почти не слышно"): the hop
    // tick must sit with the quiet gameplay voices, never back at the
    // inaudible floor — while hits still clearly dominate combat.
    const footstep = SFX_BASE_GAIN["footstep"] ?? 0;
    const quietest = Math.min(
      SFX_BASE_GAIN["ricochet"] ?? 1,
      SFX_BASE_GAIN["respawn"] ?? 1,
      SFX_BASE_GAIN["superSpawn"] ?? 1,
    );
    expect(footstep).toBeGreaterThanOrEqual(0.2);
    expect(footstep).toBeLessThanOrEqual(quietest);
    expect(footstep).toBeLessThan(SFX_BASE_GAIN["trampoline"] ?? 1);
    expect(footstep).toBeLessThan(SFX_BASE_GAIN["impact"] ?? 1);
  });

  it("keeps the enemy squeal under the impact thud with its own cooldown", () => {
    const squeal = SFX_BASE_GAIN["squeal"] ?? 0;
    expect(squeal).toBeGreaterThan(0);
    expect(squeal).toBeLessThan(SFX_BASE_GAIN["impact"] ?? 1);
    const cooldown = SFX_COOLDOWN_MS["squeal"] ?? 0;
    expect(cooldown).toBeGreaterThanOrEqual(100);
    expect(cooldown).toBeLessThanOrEqual(200);
  });

  it("keeps the charge tension clearly audible yet below the release", () => {
    // Regression pin (owner 2026-09-24: "заряд вообще не слышно"): the bed
    // and the loudest creak must read at normal volume — while the release
    // (full throw, worst layer stack) still lands clearly harder.
    expect(SFX_CHARGE_BED_GAIN).toBeGreaterThanOrEqual(0.1);
    expect(SFX_CREAK_PEAK).toBeGreaterThanOrEqual(0.4);
    const creakMax = SFX_CREAK_PEAK * SFX_MASTER_GAIN;
    const throwFull = SFX_LAYER_SUM_MAX * (SFX_BASE_GAIN["throw"] ?? 0) * SFX_MASTER_GAIN;
    expect(creakMax).toBeGreaterThan(0.2);
    expect(creakMax).toBeLessThan(throwFull);
  });
});

describe("charge tension ticks", () => {
  it("spaces ticks sparsely early and densely near full", () => {
    const early = chargeTickGap(0);
    const mid = chargeTickGap(0.5);
    const full = chargeTickGap(1);
    expect(early).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(full);
    expect(early).toBeCloseTo(0.2, 10);
    expect(full).toBeCloseTo(0.035, 10);
    expect(full).toBeGreaterThan(0);
    expect(chargeTickGap(Number.NaN)).toBeCloseTo(chargeTickGap(0.5), 10);
  });
});

describe("squeal variants", () => {
  it("maps rolls to the 3 chip squawks at third boundaries", () => {
    expect(pickSquealVariant(0)).toBe(0);
    expect(pickSquealVariant(0.33)).toBe(0);
    expect(pickSquealVariant(0.34)).toBe(1);
    expect(pickSquealVariant(0.66)).toBe(1);
    expect(pickSquealVariant(0.67)).toBe(2);
    expect(pickSquealVariant(0.99)).toBe(2);
    expect(pickSquealVariant(-1)).toBe(0);
    expect(pickSquealVariant(2)).toBe(2);
    expect(pickSquealVariant(Number.NaN)).toBe(1);
    expect(pickSquealVariant("yelp")).toBe(1);
  });

  it("detunes ±8% around unity so repeats never sound identical", () => {
    expect(squealDetune(0)).toBeCloseTo(0.92, 10);
    expect(squealDetune(0.5)).toBeCloseTo(1, 10);
    expect(squealDetune(1)).toBeCloseTo(1.08, 10);
    expect(squealDetune(Number.NaN)).toBe(1);
  });
});

describe("ambient music seam", () => {
  it("resolves the absolute public path that dev and prod both serve", () => {
    expect(SFX_AMBIENT_URL).toBe("/audio/ambient.mp3");
    expect(resolveAmbientUrl()).toBe("/audio/ambient.mp3");
    expect(resolveAmbientUrl("/audio")).toBe("/audio/ambient.mp3");
    expect(resolveAmbientUrl("/audio/")).toBe("/audio/ambient.mp3");
  });

  it("sits behind the SFX in level with a pop-free fade window", () => {
    // Pinned exact (owner 2026-09-24: 5% down from 0.16).
    expect(SFX_AMBIENT_GAIN).toBeCloseTo(0.15, 10);
    expect(SFX_AMBIENT_GAIN).toBeLessThan(SFX_MASTER_GAIN);
    expect(SFX_AMBIENT_FADE_S).toBeGreaterThanOrEqual(1);
    expect(SFX_AMBIENT_FADE_S).toBeLessThanOrEqual(2);
  });

  it("attaches only on OK responses (missing file stays silent)", () => {
    expect(ambientAttachDecision(true)).toBe(true);
    expect(ambientAttachDecision(false)).toBe(false);
  });

  it("stays a silent no-op headless for 404 and 200 fakes alike", () => {
    // No AudioContext in node: the fetcher never even runs, nothing throws,
    // nothing attaches. The OK/decode branches need a real browser.
    const notFound: AmbientFetcher = () =>
      Promise.resolve({ ok: false, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) });
    const found: AmbientFetcher = () =>
      Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) });
    const sfx = createSfx();
    expect(sfx.startAmbient(notFound)).toBe(false);
    expect(sfx.startAmbient(found)).toBe(false);
    expect(sfx.ambientActive).toBe(false);
    sfx.dispose();
  });
});

function pendingPromise<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function mockAudioParam() {
  return {
    value: 1,
    setValueAtTime: vi.fn(),
    setTargetAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
  };
}

function mockAudioNode() {
  return { connect: vi.fn(), disconnect: vi.fn() };
}

function mockGainNode() {
  return { ...mockAudioNode(), gain: mockAudioParam() };
}

class MockAmbientMedia extends EventTarget {
  public src = "";
  public preload = "auto";
  public loop = false;
  public paused = true;
  public currentTime = 0;
  public readonly playback = pendingPromise<void>();
  public readonly play = vi.fn(() => {
    this.paused = false;
    return this.playback.promise;
  });
  public readonly pause = vi.fn(() => { this.paused = true; });
  public readonly load = vi.fn();
  public readonly removeAttribute = vi.fn((name: string) => {
    if (name === "src") this.src = "";
  });
  public readonly addEventListener = vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
    super.addEventListener(type, listener);
  });
  public readonly removeEventListener = vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
    super.removeEventListener(type, listener);
  });
}

class MockMusicContext {
  public state: "running" | "suspended" | "closed" = "running";
  public currentTime = 4;
  public sampleRate = 1000;
  public readonly destination = mockAudioNode();
  public readonly resumePending = pendingPromise<void>();
  public readonly resume = vi.fn(() => this.resumePending.promise);
  public readonly close = vi.fn(() => {
    this.state = "closed";
    return Promise.resolve();
  });
  public readonly createGain = vi.fn(mockGainNode);
  public readonly createDynamicsCompressor = vi.fn(() => ({
    ...mockAudioNode(), threshold: mockAudioParam(), knee: mockAudioParam(),
    ratio: mockAudioParam(), attack: mockAudioParam(), release: mockAudioParam(),
  }));
  public readonly createConvolver = vi.fn(() => ({ ...mockAudioNode(), buffer: null }));
  public readonly createBuffer = vi.fn((_channels: number, length: number, rate: number) => ({
    duration: length / rate,
    getChannelData: () => new Float32Array(length),
  }));
  public readonly createMediaElementSource = vi.fn((_media: unknown) => mockAudioNode());
  public readonly createBufferSource = vi.fn(() => ({
    ...mockAudioNode(), buffer: null as { duration: number } | null,
    loop: false, start: vi.fn(), stop: vi.fn(),
  }));
  public readonly decodeAudioData = vi.fn((_data: ArrayBuffer) => Promise.resolve({ duration: 180 }));
}

function installMusicBrowser(initialState: "running" | "suspended" = "running", withDom = true) {
  const contexts: MockMusicContext[] = [];
  const media: MockAmbientMedia[] = [];
  class BrowserAudioContext extends MockMusicContext {
    public constructor() {
      super();
      this.state = initialState;
      contexts.push(this);
    }
  }
  const createElement = vi.fn((tag: string) => {
    expect(tag).toBe("audio");
    const audio = new MockAmbientMedia();
    media.push(audio);
    return audio;
  });
  const fetch = vi.fn();
  vi.stubGlobal("window", { AudioContext: BrowserAudioContext });
  vi.stubGlobal("document", withDom ? { createElement } : undefined);
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("localStorage", undefined);
  return { contexts, media, createElement, fetch };
}

async function finishMusicPromises(): Promise<void> {
  // Covers the play Promise and its rejection handler, plus the explicit
  // fetch -> arrayBuffer -> decode compatibility chain.
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

describe("streaming ambient lifecycle", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("plays in the first gesture while context resume is pending, with native looping and no full decode", async () => {
    const browser = installMusicBrowser("suspended");
    const sfx = createSfx();
    expect(browser.createElement).not.toHaveBeenCalled();
    expect(sfx.unlock()).toBe(false);
    const ctx = browser.contexts[0]!;
    const media = browser.media[0]!;
    expect(ctx.resume).toHaveBeenCalledOnce();
    expect(media.play).toHaveBeenCalledOnce();
    expect(media.src).toBe(SFX_AMBIENT_URL);
    expect(media.loop).toBe(true);
    expect(media.preload).toBe("none");
    sfx.unlock();
    expect(browser.media).toHaveLength(1);
    expect(media.play).toHaveBeenCalledOnce();
    expect(sfx.ambientActive).toBe(false);
    ctx.state = "running";
    ctx.resumePending.resolve();
    media.playback.resolve();
    await finishMusicPromises();
    expect(sfx.ambientActive).toBe(true);
    const source = ctx.createMediaElementSource.mock.results[0]!.value;
    const ambientGain = ctx.createGain.mock.results[3]!.value;
    const master = ctx.createGain.mock.results[0]!.value;
    expect(source.connect).toHaveBeenCalledWith(ambientGain);
    expect(ambientGain.connect).toHaveBeenCalledWith(master);
    expect(ambientGain.gain.setValueAtTime).toHaveBeenCalledWith(0, 4);
    expect(ambientGain.gain.linearRampToValueAtTime).toHaveBeenCalledWith(SFX_AMBIENT_GAIN, 4 + SFX_AMBIENT_FADE_S);
    expect(browser.fetch).not.toHaveBeenCalled();
    expect(ctx.decodeAudioData).not.toHaveBeenCalled();
    expect(ctx.createBufferSource).not.toHaveBeenCalled();
    sfx.dispose();
  });

  it("retains the music gain and shares master mute with sound effects", async () => {
    const browser = installMusicBrowser();
    const sfx = createSfx();
    sfx.setMuted(true);
    sfx.unlock();
    const ctx = browser.contexts[0]!;
    const master = ctx.createGain.mock.results[0]!.value;
    expect(master.gain.value).toBe(0);
    browser.media[0]!.playback.resolve();
    await finishMusicPromises();
    expect(sfx.ambientActive).toBe(true);
    sfx.setMuted(false);
    expect(master.gain.setTargetAtTime).toHaveBeenLastCalledWith(SFX_MASTER_GAIN, ctx.currentTime, 0.02);
    sfx.setMuted(true);
    expect(master.gain.setTargetAtTime).toHaveBeenLastCalledWith(0, ctx.currentTime, 0.02);
    expect(browser.media[0]!.pause).not.toHaveBeenCalled();
    sfx.dispose();
  });

  it("quietly retries a rejected or throwing play on the next gesture without another media graph", async () => {
    const browser = installMusicBrowser();
    const sfx = createSfx();
    sfx.unlock();
    const media = browser.media[0]!;
    media.playback.reject(new Error("autoplay denied"));
    await finishMusicPromises();
    expect(sfx.ambientActive).toBe(false);
    media.play.mockImplementationOnce(() => { throw new Error("blocked play"); });
    expect(() => sfx.unlock()).not.toThrow();
    const retry = pendingPromise<void>();
    media.play.mockReturnValueOnce(retry.promise);
    sfx.unlock();
    retry.resolve();
    await finishMusicPromises();
    expect(sfx.ambientActive).toBe(true);
    expect(browser.media).toHaveLength(1);
    expect(browser.contexts[0]!.createMediaElementSource).toHaveBeenCalledOnce();
    expect(browser.fetch).not.toHaveBeenCalled();
    expect(browser.contexts[0]!.decodeAudioData).not.toHaveBeenCalled();
    sfx.dispose();
  });

  it("releases a failed resource/404 and ignores its late completion while a new stream starts", async () => {
    const browser = installMusicBrowser();
    const sfx = createSfx();
    sfx.unlock();
    const first = browser.media[0]!;
    const ctx = browser.contexts[0]!;
    const source = ctx.createMediaElementSource.mock.results[0]!.value;
    const gain = ctx.createGain.mock.results[3]!.value;
    first.dispatchEvent(new Event("error"));
    expect(sfx.ambientActive).toBe(false);
    expect(first.pause).toHaveBeenCalledOnce();
    expect(first.src).toBe("");
    expect(first.load).toHaveBeenCalledOnce();
    expect(first.removeEventListener).toHaveBeenCalledWith("error", expect.any(Function));
    expect(source.disconnect).toHaveBeenCalledOnce();
    expect(gain.disconnect).toHaveBeenCalledOnce();
    sfx.unlock();
    const second = browser.media[1]!;
    first.playback.resolve();
    await finishMusicPromises();
    expect(sfx.ambientActive).toBe(false);
    expect(gain.gain.linearRampToValueAtTime).not.toHaveBeenCalled();
    // A stale removed error listener cannot tear down the replacement.
    first.dispatchEvent(new Event("error"));
    second.playback.resolve();
    await finishMusicPromises();
    expect(sfx.ambientActive).toBe(true);
    expect(browser.fetch).not.toHaveBeenCalled();
    expect(ctx.decodeAudioData).not.toHaveBeenCalled();
    sfx.dispose();
  });

  it("pauses pending playback when hidden and preserves position through a blocked visibility resume", async () => {
    const browser = installMusicBrowser();
    const sfx = createSfx();
    sfx.unlock();
    const media = browser.media[0]!;
    media.currentTime = 83;
    sfx.setAmbientPaused(true);
    expect(media.paused).toBe(true);
    expect(sfx.ambientActive).toBe(false);
    media.playback.reject(new Error("pause aborts the old play"));
    await finishMusicPromises();
    sfx.unlock();
    expect(media.play).toHaveBeenCalledOnce();
    const visiblePlay = pendingPromise<void>();
    media.play.mockReturnValueOnce(visiblePlay.promise);
    sfx.setAmbientPaused(false);
    visiblePlay.reject(new Error("resume requires gesture"));
    await finishMusicPromises();
    expect(sfx.ambientActive).toBe(false);
    expect(media.src).toBe(SFX_AMBIENT_URL);
    expect(media.currentTime).toBe(83);
    const gesturePlay = pendingPromise<void>();
    media.play.mockReturnValueOnce(gesturePlay.promise);
    sfx.unlock();
    gesturePlay.resolve();
    await finishMusicPromises();
    expect(sfx.ambientActive).toBe(true);
    expect(browser.media).toHaveLength(1);
    expect(media.currentTime).toBe(83);
    sfx.dispose();
  });

  it.each(["resolve", "reject"] as const)("cleans up on dispose and ignores a late %s after a new unlock", async (completion) => {
    const browser = installMusicBrowser();
    const sfx = createSfx();
    sfx.unlock();
    const oldMedia = browser.media[0]!;
    const oldCtx = browser.contexts[0]!;
    const oldGain = oldCtx.createGain.mock.results[3]!.value;
    sfx.dispose();
    expect(oldMedia.paused).toBe(true);
    expect(oldMedia.src).toBe("");
    expect(oldMedia.load).toHaveBeenCalledOnce();
    expect(oldCtx.close).toHaveBeenCalledOnce();
    expect(oldCtx.createMediaElementSource.mock.results[0]!.value.disconnect).toHaveBeenCalledOnce();
    expect(oldGain.disconnect).toHaveBeenCalledOnce();
    sfx.unlock();
    const fresh = browser.media[1]!;
    if (completion === "resolve") oldMedia.playback.resolve();
    else oldMedia.playback.reject(new Error("late dispose abort"));
    await finishMusicPromises();
    expect(sfx.ambientActive).toBe(false);
    expect(oldGain.gain.linearRampToValueAtTime).not.toHaveBeenCalled();
    sfx.unlock();
    expect(fresh.play).toHaveBeenCalledOnce();
    fresh.playback.resolve();
    await finishMusicPromises();
    expect(sfx.ambientActive).toBe(true);
    sfx.dispose();
    sfx.dispose();
    expect(fresh.load).toHaveBeenCalledOnce();
  });

  it("stays silent without DOM media support and only decodes via an explicitly supplied fetcher", async () => {
    const browser = installMusicBrowser("running", false);
    const sfx = createSfx();
    sfx.unlock();
    const ctx = browser.contexts[0]!;
    expect(browser.fetch).not.toHaveBeenCalled();
    expect(ctx.decodeAudioData).not.toHaveBeenCalled();
    const missing = vi.fn(() => Promise.resolve({ ok: false, arrayBuffer: vi.fn() }));
    sfx.startAmbient(missing);
    await finishMusicPromises();
    expect(ctx.decodeAudioData).not.toHaveBeenCalled();
    const oversized = vi.fn(() => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(9 * 1024 * 1024)) }));
    sfx.startAmbient(oversized);
    await finishMusicPromises();
    expect(ctx.decodeAudioData).not.toHaveBeenCalled();
    const data = new ArrayBuffer(8);
    const found = vi.fn(() => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(data) }));
    sfx.startAmbient(found);
    await finishMusicPromises();
    expect(ctx.decodeAudioData).toHaveBeenCalledWith(data);
    expect(sfx.ambientActive).toBe(true);
    const source = ctx.createBufferSource.mock.results[0]!.value;
    expect(source.loop).toBe(true);
    expect(source.buffer).not.toBeNull();
    sfx.dispose();
    expect(source.buffer).toBeNull();
    expect(source.stop).toHaveBeenCalledOnce();
  });

  it("aborts an explicit fetch and cannot attach its late decoded buffer to a new context", async () => {
    const browser = installMusicBrowser("running", false);
    const sfx = createSfx();
    sfx.unlock();
    const ctx = browser.contexts[0]!;
    const decoding = pendingPromise<{ duration: number }>();
    ctx.decodeAudioData.mockReturnValueOnce(decoding.promise);
    const found = vi.fn((_url: string, _init?: { signal?: AbortSignal }) => Promise.resolve({
      ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    }));
    sfx.startAmbient(found);
    await finishMusicPromises();
    const signal = found.mock.calls[0]![1]!.signal!;
    sfx.dispose();
    expect(signal.aborted).toBe(true);
    sfx.unlock();
    decoding.resolve({ duration: 180 });
    await finishMusicPromises();
    expect(ctx.createBufferSource).not.toHaveBeenCalled();
    expect(browser.contexts[1]!.createBufferSource).not.toHaveBeenCalled();
    expect(sfx.ambientActive).toBe(false);
    sfx.dispose();
  });
});
