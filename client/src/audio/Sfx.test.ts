// Stage 5 audio unit tests: the pure-logic SFX core (cooldown gating, voice
// cap, intensity/attenuation mapping, mute persistence parse, ricochet-onset
// detection) plus headless no-op safety — all runnable in the vitest node env
// with no AudioContext, same headless pattern as fx/Balls.ts.
import { describe, expect, it } from "vitest";
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
