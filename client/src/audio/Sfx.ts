// Stage 5 audio: procedural (synthesized, zero asset files) SFX engine.
//
// Design contract (owner brief): stylized low-poly arena feel, NOT annoying
// (no harsh highs, per-event cooldowns + a hard voice cap so spam can never
// machine-gun), rubbery-but-restrained trampoline (low pitch-bend, fast
// decay, no cartoon slide-whistle), and impact strength expressed through
// volume AND pitch/filter scaling. Owner playtest 2026-09-24 round 2: fatter,
// Sega-16-bit (YM2612 FM chip) character — square/pulse bodies, FM-modulated
// punch, hard transients, wide dynamics, dry mix; LESS polyphony (no
// tetris-like melodic arpeggios: at most ~2 oscillators and ~2 sequential
// hits per event). Footstep stays a subtle detail, never a blaster.
//
// Hybrid future (confirmed plan): the owner's neural-generated samples will
// later replace these one-by-one through the SAME per-event API — call sites
// use sfx.play('trampoline', { intensity }) and never touch WebAudio nodes,
// so swapping a synth render for a sample buffer changes only this module.
//
// Headless safety (vitest node env, no AudioContext — same pattern as
// fx/Balls.ts makeGlowTexture): the engine constructs without DOM/audio and
// every method degrades to a silent no-op returning false. The small
// pure-logic core (SfxGate, VoicePool, level-mapping helpers, mute parse,
// ricochet-onset detection, ambient URL/fetcher seam) is exported for unit
// tests that need no audio.

import { BALL_MAX_SPEED } from "../config";

// Per-event sound names — the stable API that future file-based samples will
// implement one-by-one. Call sites only ever use these strings.
export type SfxEventName =
  | "footstep"
  | "charge"
  | "throw"
  | "impact"
  | "death"
  | "ricochet"
  | "pickup"
  | "trampoline"
  | "roundStart"
  | "roundEnd"
  | "respawn"
  | "superSpawn"
  | "superPickup"
  // Enemy hit squeal: short chip squawk riding on top of the impact thud,
  // 3 variants picked per-play (see pickSquealVariant).
  | "squeal";

export interface SfxPlayOptions {
  // Normalized hit strength / charge power in [0, 1] (non-finite reads as
  // 0.5). Scales gain and, where the brief asks for it, pitch/filter.
  intensity?: number;
  // Meters from the local camera/avatar for remote events (non-finite or
  // missing reads as 0 = full volume). Simple 1/(1+k*d) rolloff.
  distanceM?: number;
}

// Level budget (retuned 2026-09-24: the first pass peaked ≈ −21 dBFS and was
// barely audible on phones). Master output level (linear gain ≈ −5 dBFS
// nominal) plus hotter per-voice bases land single loud voices around
// −9..−6 dBFS — roughly 6x the old amplitude. Clipping headroom is honest:
// the loudest single voice (death, full intensity, point-blank) sums at most
// SFX_LAYER_SUM_MAX × base × master ≈ 1.35 × 0.75 × 0.55 ≈ 0.56 pre-master,
// and a DynamicsCompressorNode (fast safety limiter, threshold −6 dB) sits
// between master and destination to catch multi-voice overlaps — the
// destination can never see > 1.0 no matter how the 8 capped voices stack.
// Pinned by the "level budget" test below via SFX_WORST_VOICE_PEAK.
export const SFX_MASTER_GAIN = 0.55;
// Maximum summed layer-peak factor of any single render() voice, as a
// multiple of its computed gain (impact/death hit it: 0.6 + 0.4 + 0.35).
// Kept as a named constant so the peak-budget test measures the real design
// instead of a magic number.
export const SFX_LAYER_SUM_MAX = 1.35;
// Worst-case single-voice peak at the master input — defined just below the
// base-gain table from the real death base (SFX_WORST_VOICE_PEAK). Must stay
// < 1.0 — the compressor is only the backstop for overlaps, never the
// nominal path.
// Master safety limiter (not a loudness effect): fast attack, high ratio,
// threshold just below clipping so nominal voices pass untouched and only
// stacked overlaps get caught.
export const SFX_COMP_THRESHOLD_DB = -6;
export const SFX_COMP_KNEE_DB = 6;
export const SFX_COMP_RATIO = 12;
export const SFX_COMP_ATTACK_S = 0.002;
export const SFX_COMP_RELEASE_S = 0.15;
// Shared generated ambience: one convolver with a tiny synthesized impulse
// response (stereo decaying noise, allocated once at init, never per play).
// Genesis-dry mix (round 2): the wet send sits at 0.08 — barely a room glue,
// never a wash. Every voice feeds it uniformly; negligible phone CPU.
export const SFX_REVERB_SECONDS = 0.45;
export const SFX_REVERB_WET = 0.08;
// Hard cap on concurrent voices: a new play while the cap is held is dropped
// (returns false), so event storms can never stack into a wall of noise.
export const SFX_VOICE_CAP = 8;
// localStorage key for the mute choice (default ON = sound enabled).
export const SFX_MUTE_STORAGE_KEY = "kaban-arena:sfx-muted";
// Local hop-tick gate (SceneManager footstep events): only emit while the
// avatar actually moves (speed01 above this), never while standing/gliding.
export const FOOTSTEP_MIN_SPEED01 = 0.25;
// Distance rolloff steepness for remote events.
export const SFX_ATTENUATION_K = 0.12;
export const SFX_ATTENUATION_MIN = 0.08;
// Drawn-slingshot tension bed (round 3 — the saw drone read as a DRILL and
// is gone; round 4 — owner "заряд вообще не слышно"): a clearly present low
// rumble bed while holding, plus short creak ticks whose rate and pitch rise
// with charge progress (see setChargeProgress + chargeTickGap). The creaks
// carry phone audibility (body in the 400-2000 Hz band — the sub bed alone
// would die in phone-speaker rolloff); both sit below throw/impact so the
// release still lands harder (pinned by test).
export const SFX_CHARGE_BED_HZ = 48;
export const SFX_CHARGE_BED_GAIN = 0.12;
export const SFX_CHARGE_GAIN = 0.14;
// Creak tick voice: bandpass noise burst + woody knock, center pitch
// sweeping up with progress (rope-tension read, not machinery).
export const SFX_CREAK_BASE_HZ = 800;
export const SFX_CREAK_TOP_HZ = 2400;
export const SFX_CREAK_PEAK = 0.45;
export const SFX_CREAK_DUR_S = 0.045;
// Progress-domain tick spacing (round 3): sparse early, dense near full —
// for a constant charge speed this reads as ticks accelerating ~2/s → ~12/s.
export function chargeTickGap(progress01: number): number {
  return 0.2 - 0.165 * clampIntensity(progress01);
}

// Per-event minimum interval between plays (ms wall clock). The machine-gun
// guard: footsteps ride the ~2-4 Hz hop cadence, impacts/ricochets can arrive
// in bursts from several balls, round stingers must never double-fire.
export const SFX_COOLDOWN_MS: Record<SfxEventName, number> = {
  footstep: 120,
  charge: 0,
  throw: 80,
  impact: 50,
  death: 150,
  ricochet: 80,
  pickup: 100,
  trampoline: 200,
  roundStart: 500,
  roundEnd: 500,
  respawn: 200,
  superSpawn: 300,
  superPickup: 200,
  // Squeal rides multi-hit ticks (ricochet-style bursts into a crowd): long
  // enough to never machine-gun, short enough to fire per victim.
  squeal: 130,
};

// Per-event base peak gain (linear, pre-master): the TOTAL voice budget —
// layered renders split it across sub + body + noise layers whose peaks sum
// to at most SFX_LAYER_SUM_MAX × base (see each render arm). Single loud
// voices land around −9..−6 dBFS at the destination; the compressor catches
// only stacked overlaps.
export const SFX_BASE_GAIN: Record<SfxEventName, number> = {
  // Footstep rides the ~2-4 Hz hop cadence through a 120 ms cooldown, so its
  // ceiling is the cadence itself; base sits with the quiet gameplay voices
  // (ricochet/respawn/superSpawn ≈ 0.3) — clearly audible, still well below
  // hits (impact 0.75, trampoline 0.5) so combat dominates. Retuned
  // 2026-09-24 (owner: "шагов почти не слышно"): 0.14 → 0.28, plus a
  // mid-range body (phone speakers roll off the old low sine).
  footstep: 0.28,
  charge: SFX_CHARGE_GAIN,
  throw: 0.45,
  impact: 0.75,
  death: 0.8,
  ricochet: 0.3,
  pickup: 0.35,
  trampoline: 0.5,
  roundStart: 0.45,
  roundEnd: 0.45,
  respawn: 0.3,
  superSpawn: 0.28,
  superPickup: 0.38,
  // Squeal sits clearly under the impact thud it rides on (0.75): audible
  // character, never the dominant transient.
  squeal: 0.45,
};

// Worst-case single-voice peak at the master input (death, full intensity,
// point-blank): LAYER_SUM_MAX × death base × master — measured from the real
// table above, never a magic number. Stays < 1.0 by construction.
export const SFX_WORST_VOICE_PEAK =
  SFX_LAYER_SUM_MAX * (SFX_BASE_GAIN["death"] ?? 0.75) * SFX_MASTER_GAIN;

// Ambient music file (owner drops client/public/audio/ambient.mp3; Vite
// copies public/ verbatim into dist/, and the prod single-container serves
// dist/ via express.static — so this absolute path resolves in BOTH dev
// (:5173) and prod. A missing file is silent either way: prod answers a clean
// 404 (the SPA fallback only handles extensionless paths — verified against
// server/src/index.ts), dev answers the HTML fallback, which then fails
// decodeAudioData — both paths are silent no-ops, zero console spam.
export const SFX_AMBIENT_URL = "/audio/ambient.mp3";
// Ambient loop level (absolute gain into master): 5% under the previous
// 0.16 (owner request 2026-09-24) — still clearly behind the SFX, routed
// through master so the mute button kills it too.
export const SFX_AMBIENT_GAIN = 0.15;
// Ambient fade-in after the loop starts (seconds): no audible pop on join.
export const SFX_AMBIENT_FADE_S = 1.5;

// Normalized intensity in [0, 1]; garbage reads as a neutral mid strength.
export function clampIntensity(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0.5;
  }
  return Math.max(0, Math.min(1, value));
}

// Strength -> loudness (round 2, wide Genesis dynamics): weak hits read thin
// and quiet (0.35 floor), full-power hits slam (full base). Monotonic, never
// silent, never above the base peak.
export function intensityToGain(baseGain: number, intensity: number): number {
  const base = Number.isFinite(baseGain) ? Math.max(0, baseGain) : 0;
  const clamped = clampIntensity(intensity);
  return base * (0.35 + 0.65 * clamped);
}

// Strength -> pitch multiplier (round 2, wide): 0.7x..1.3x so weak hits
// sag audibly and full hits scream — the FM brightness follows the same
// contrast via fmDepthForIntensity below. Monotonic in intensity.
export function intensityToRate(intensity: number): number {
  return 0.7 + 0.6 * clampIntensity(intensity);
}

// FM brightness (modulator deviation in Hz) tracks hit strength: weak hits
// stay dark and thuddy, full hits go brassy — the Genesis-drum contrast.
// Monotonic in intensity, never above the base deviation.
export function fmDepthForIntensity(baseDepth: number, intensity: number): number {
  const base = Number.isFinite(baseDepth) ? Math.max(0, baseDepth) : 0;
  return base * (0.3 + 0.7 * clampIntensity(intensity));
}

// Enemy squeal variant pick (pure, tested): a uniform roll in [0, 1) maps to
// 3 distinct chip squawks (down-then-up yelp / falling squawk / rising chirp
// + snap). Garbage rolls read as the middle variant; the render calls this
// with Math.random() per play (event-driven, never the hot path — documented
// randomness, not gameplay logic).
export type SquealVariant = 0 | 1 | 2;

export function pickSquealVariant(roll: unknown): SquealVariant {
  if (typeof roll !== "number" || !Number.isFinite(roll)) {
    return 1;
  }
  const clamped = Math.max(0, Math.min(0.9999, roll));
  if (clamped < 1 / 3) {
    return 0;
  }
  return clamped < 2 / 3 ? 1 : 2;
}

// Per-play detune so squeal repeats never sound identical: ±8% around 1.0.
// Pure, tested; garbage reads as no detune.
export function squealDetune(roll: unknown): number {
  if (typeof roll !== "number" || !Number.isFinite(roll)) {
    return 1;
  }
  return 1 + (Math.max(0, Math.min(1, roll)) - 0.5) * 0.16;
}

// Cheap distance rolloff for remote events: 1 at zero distance, decaying
// toward SFX_ATTENUATION_MIN far away. Monotonic non-increasing, always
// finite, garbage distance reads as point-blank.
export function attenuationForDistance(distanceM: unknown): number {
  if (typeof distanceM !== "number" || !Number.isFinite(distanceM) || distanceM <= 0) {
    return 1;
  }
  const rolled = 1 / (1 + distanceM * SFX_ATTENUATION_K);
  return Math.max(SFX_ATTENUATION_MIN, Math.min(1, rolled));
}

// Mute persistence parse: only the exact stored "1" means muted; everything
// else (missing key, "0", garbage) means sound ON (the default).
export function parseStoredMute(raw: unknown): boolean {
  return raw === "1";
}

// Per-event cooldown gate (pure logic, injectable clock for tests): tryPlay
// returns true and arms the cooldown, or false when the event fired too
// recently. Zero-cooldown events (charge bookkeeping) always pass.
export class SfxGate {
  private readonly lastPlayedMs = new Map<SfxEventName, number>();

  public tryPlay(name: SfxEventName, nowMs: number): boolean {
    if (!Number.isFinite(nowMs)) {
      return false;
    }
    const cooldown = SFX_COOLDOWN_MS[name] ?? 0;
    if (cooldown <= 0) {
      return true;
    }
    const last = this.lastPlayedMs.get(name) ?? Number.NEGATIVE_INFINITY;
    if (nowMs - last < cooldown) {
      return false;
    }
    this.lastPlayedMs.set(name, nowMs);
    return true;
  }

  public reset(): void {
    this.lastPlayedMs.clear();
  }
}

// Concurrent-voice tracker behind the SFX_VOICE_CAP hard cap. Pure logic:
// tryAcquire fails (no state change) while the cap is held.
export class VoicePool {
  private active = 0;

  public constructor(private readonly cap: number = SFX_VOICE_CAP) {}

  public get activeVoices(): number {
    return this.active;
  }

  public tryAcquire(): boolean {
    if (this.active >= this.cap) {
      return false;
    }
    this.active += 1;
    return true;
  }

  public release(): void {
    if (this.active > 0) {
      this.active -= 1;
    }
  }

  public reset(): void {
    this.active = 0;
  }
}

// Minimal ball view for ricochet-onset detection (structural, so NetworkManager
// snapshots satisfy it without this module importing the net layer).
export interface RicochetBallView {
  readonly ballId: string;
  readonly ricochet?: boolean;
  readonly power01?: number;
  readonly vx?: number;
  readonly vz?: number;
}

export interface RicochetOnset {
  ballId: string;
  intensity: number;
}

// Ricochet tick edges: a ball whose snapshot flag reads true while the
// previous snapshot did NOT (missing id counts as false — a fresh snapshot
// with the flag already set still ticks once, never silently). Intensity
// prefers the authoritative planar speed (|v| / BALL_MAX_SPEED); snapshots
// without velocity fall back to power01, then to neutral mid strength.
export function detectRicochetOnsets(
  prev: ReadonlyMap<string, boolean>,
  balls: readonly RicochetBallView[],
): RicochetOnset[] {
  const onsets: RicochetOnset[] = [];
  for (const ball of balls) {
    if (ball.ricochet !== true) {
      continue;
    }
    if (prev.get(ball.ballId) === true) {
      continue;
    }
    let intensity = 0.5;
    const vx = ball.vx;
    const vz = ball.vz;
    if (typeof vx === "number" && Number.isFinite(vx) && typeof vz === "number" && Number.isFinite(vz)) {
      const speed01 = Math.hypot(vx, vz) / BALL_MAX_SPEED;
      intensity = speed01 > 0.05 ? Math.max(0, Math.min(1, speed01)) : clampIntensity(ball.power01);
    } else {
      intensity = clampIntensity(ball.power01);
    }
    onsets.push({ ballId: ball.ballId, intensity });
  }
  return onsets;
}

function readStoredMute(): boolean {
  try {
    if (typeof localStorage === "undefined") {
      return false;
    }
    return parseStoredMute(localStorage.getItem(SFX_MUTE_STORAGE_KEY));
  } catch {
    // Storage blocked (private mode): fall back to sound ON.
    return false;
  }
}

function writeStoredMute(muted: boolean): void {
  try {
    if (typeof localStorage === "undefined") {
      return;
    }
    localStorage.setItem(SFX_MUTE_STORAGE_KEY, muted ? "1" : "0");
  } catch {
    // Storage blocked: the in-memory flag still applies for the session.
  }
}

function getAudioConstructor(): typeof AudioContext | null {
  if (typeof window === "undefined") {
    return null;
  }
  const candidate = window.AudioContext;
  if (typeof candidate === "function") {
    return candidate;
  }
  const prefixed = (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext;
  return typeof prefixed === "function" ? (prefixed as typeof AudioContext) : null;
}

function makeNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const channel = buffer.getChannelData(0);
  // Deterministic pseudo-noise (mulberry-ish LCG): stable across sessions so
  // the whoosh/click timbre never depends on Math.random at init.
  let seed = 0x9e3779b9;
  for (let i = 0; i < channel.length; i += 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    channel[i] = (seed / 0xffffffff) * 2 - 1;
  }
  return buffer;
}

// Generated reverb impulse response: short stereo decaying noise (arena
// small-room feel, subtle by design). Allocated once at init, never per play.
function makeImpulseResponse(ctx: AudioContext): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * SFX_REVERB_SECONDS));
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  let seed = 0x51ed270b;
  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const noise = (seed / 0xffffffff) * 2 - 1;
      // Exponential decay over the IR length: early reflections carry the
      // space, the tail dies before it can muddy fast gameplay.
      data[i] = noise * Math.exp((-4 * i) / data.length);
    }
  }
  return buffer;
}

// Ambient URL resolver (pure, tested): absolute path by default (works from
// any route in dev and prod); a custom base only ever prefixes the fixed
// filename, so call sites cannot point it at gameplay assets.
export function resolveAmbientUrl(basePath?: string): string {
  if (typeof basePath === "string" && basePath.length > 0) {
    const trimmed = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
    return `${trimmed}/ambient.mp3`;
  }
  return SFX_AMBIENT_URL;
}

// Ambient fetch decision (pure, tested): only an OK response proceeds to
// decode+attach — a missing file (clean 404) stays a silent no-op.
export function ambientAttachDecision(responseOk: boolean): boolean {
  return responseOk === true;
}

// Minimal fetch seam for the ambient loop (structural, so the global fetch
// satisfies it without importing DOM networking types, and unit tests can
// inject 404/200 fakes). Mirrors only what startAmbient uses.
export interface AmbientFetchResult {
  readonly ok: boolean;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface AmbientFetcher {
  (url: string, init?: { signal?: AbortSignal }): Promise<AmbientFetchResult>;
}

function defaultAmbientFetch(): AmbientFetcher | null {
  try {
    if (typeof fetch === "undefined") {
      return null;
    }
    return fetch;
  } catch {
    return null;
  }
}

interface ToneSpec {
  freq: number;
  freqEnd?: number;
  type?: OscillatorType;
  dur: number;
  gain: number;
  delay?: number;
  attack?: number;
  lowpass?: number;
}

// Shared release scope for one play(): every scheduled node increments
// pending and decrements on end; the voice returns to the pool once the last
// node finishes (or immediately when the render scheduled nothing, e.g. the
// charge bookkeeping event). releaseScope is idempotent — render throws and
// node ends can never double-release.
interface VoiceScope {
  pending: number;
  released: boolean;
}

interface NoiseSpec {
  dur: number;
  gain: number;
  type?: BiquadFilterType;
  freq?: number;
  freqEnd?: number;
  q?: number;
  delay?: number;
  attack?: number;
}

// FM stab voice (the YM2612 trick): a square carrier whose frequency is
// modulated by a sine modulator. The carrier pitch-drop gives the punch, the
// decaying modulator deviation (depth -> depthEnd) gives the brassy attack
// that collapses into a dark thump — Genesis drums and bass in one voice.
// modRatio tracks the carrier (1 = drum-like, 2 = hollower); depth values
// come from fmDepthForIntensity so brightness follows hit strength.
interface FmSpec {
  carrierFreq: number;
  carrierEnd?: number;
  modRatio?: number;
  depth: number;
  depthEnd?: number;
  dur: number;
  gain: number;
  delay?: number;
  attack?: number;
  lowpass?: number;
}

// Procedural SFX engine: lazily created AudioContext (unlocked/resumed on the
// first user gesture — iOS requirement, no autoplay), pooled voices with a
// hard cap + per-event cooldowns, master gain into a safety-limiter
// compressor, plus a shared generated reverb both SFX and ambience feed. All
// sounds are synthesized from layered oscillators/noise scheduled on the
// audio clock; the 1s noise buffer and the reverb impulse are preallocated at
// init and reused — no AudioBuffer is ever created per play. Event-driven
// only: nothing runs on the render hot path.
export class SfxEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private comp: DynamicsCompressorNode | null = null;
  private verbSend: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private muted: boolean;
  private readonly gate = new SfxGate();
  private readonly pool = new VoicePool();
  private chargeNodes: { bed: OscillatorNode; gain: GainNode } | null = null;
  private chargeNextTick = 0;
  // Next progress-domain tick threshold for the tension creaks (see
  // setChargeProgress): reset on every chargeStart.
  // Ambient loop state (owner's /audio/ambient.mp3 when present, silent
  // otherwise): fetch-once flags, abort handle for teardown, live nodes.
  private ambientStarting = false;
  private ambientStarted = false;
  private ambientAbort: AbortController | null = null;
  private ambientNodes: { source: AudioBufferSourceNode; gain: GainNode } | null = null;

  public constructor() {
    // muted is in-memory until storage is readable; readStoredMute is itself
    // headless-safe (no localStorage in node -> sound ON default).
    this.muted = readStoredMute();
  }

  public isMuted(): boolean {
    return this.muted;
  }

  public setMuted(muted: boolean): void {
    this.muted = muted === true;
    writeStoredMute(this.muted);
    if (this.ctx !== null && this.master !== null) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : SFX_MASTER_GAIN, this.ctx.currentTime, 0.02);
    }
  }

  public toggleMuted(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  // Idempotent unlock for user-gesture handlers (pointerdown/keydown/touch):
  // creates the context lazily and resumes it when suspended. Returns true
  // once the context runs; false headless or when the browser has no WebAudio.
  public unlock(): boolean {
    const AC = getAudioConstructor();
    if (AC === null) {
      return false;
    }
    if (this.ctx === null) {
      let ctx: AudioContext;
      try {
        ctx = new AC();
      } catch {
        // Context-limit exhaustion (or a throwing shim): stay in the silent
        // no-op state instead of throwing into the window gesture handler.
        return false;
      }
      this.ctx = ctx;
      // Master chain: mute gain -> safety-limiter compressor -> destination.
      // The compressor threshold sits just below clipping so nominal voices
      // pass untouched and only stacked overlaps get caught (never > 1.0).
      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : SFX_MASTER_GAIN;
      this.comp = ctx.createDynamicsCompressor();
      this.comp.threshold.value = SFX_COMP_THRESHOLD_DB;
      this.comp.knee.value = SFX_COMP_KNEE_DB;
      this.comp.ratio.value = SFX_COMP_RATIO;
      this.comp.attack.value = SFX_COMP_ATTACK_S;
      this.comp.release.value = SFX_COMP_RELEASE_S;
      this.master.connect(this.comp);
      this.comp.connect(ctx.destination);
      // Shared generated ambience: voices feed verbSend dry-through into the
      // convolver, whose wet output returns into master (so mute kills the
      // tails too). One IR buffer, allocated once here.
      this.verbSend = ctx.createGain();
      this.verbSend.gain.value = 1;
      const verb = ctx.createConvolver();
      verb.buffer = makeImpulseResponse(ctx);
      const wet = ctx.createGain();
      wet.gain.value = SFX_REVERB_WET;
      this.verbSend.connect(verb);
      verb.connect(wet);
      wet.connect(this.master);
      this.noiseBuf = makeNoiseBuffer(ctx);
    }
    if (this.ctx.state === "suspended") {
      // Resume races (rapid lock/unlock on iOS) must never surface an
      // unhandled rejection into the gesture handler.
      void this.ctx.resume().catch((): void => {
        // Still suspended — the next gesture retries; plays stay dropped
        // cleanly until the context actually runs (see play()).
      });
    }
    if (this.ctx.state === "running") {
      // First running gesture kicks off the ambient loop fetch (fire and
      // forget — missing file is a silent no-op, see startAmbient).
      this.startAmbient();
      return true;
    }
    return false;
  }

  public get running(): boolean {
    return this.ctx !== null && this.ctx.state === "running";
  }

  // Main per-event API (the future sample-swap seam): cooldown-gated,
  // voice-capped, distance-attenuated. Silent no-op (false) while muted,
  // before the first unlock, while the context is suspended, or headless.
  public play(name: SfxEventName, options: SfxPlayOptions = {}): boolean {
    if (this.muted) {
      return false;
    }
    if (this.ctx === null || this.master === null || this.noiseBuf === null) {
      return false;
    }
    // iOS screen-lock guard: while the context is suspended (not running),
    // drop the play cleanly instead of scheduling voices that would all
    // fire at once on resume. Checked before the cooldown gate so a
    // suspended storm neither arms cooldowns nor consumes voices.
    if (this.ctx.state !== "running") {
      return false;
    }
    if (!this.gate.tryPlay(name, Date.now())) {
      return false;
    }
    if (!this.pool.tryAcquire()) {
      return false;
    }
    const intensity = clampIntensity(options.intensity);
    const atten = attenuationForDistance(options.distanceM);
    const base = SFX_BASE_GAIN[name] ?? 0.15;
    const gain = intensityToGain(base, intensity) * atten;
    const rate = intensityToRate(intensity);
    // One play() holds exactly one voice no matter how many nodes the render
    // schedules: the shared scope counts scheduled nodes and releases the
    // voice once the LAST one ends (never double-releases).
    const scope: VoiceScope = { pending: 0, released: false };
    try {
      this.render(name, gain, rate, intensity, scope);
    } catch {
      this.releaseScope(scope);
      return false;
    }
    if (scope.pending === 0) {
      this.releaseScope(scope);
    }
    return true;
  }

  // Drawn-slingshot tension (round 3 — the saw drone read as a DRILL): a
  // barely-felt sub rumble bed while holding, plus short creak ticks whose
  // rate and pitch rise with charge progress (see setChargeProgress). Start
  // on charge start; every stop path (release/cancel/leave/reset/room-full)
  // funnels through chargeStop. One pool voice while held.
  public chargeStart(): void {
    if (this.muted || this.chargeNodes !== null) {
      return;
    }
    if (this.ctx === null || this.master === null) {
      return;
    }
    // Same screen-lock guard as play(): never start the bed on a suspended
    // context (it would blare on resume).
    if (this.ctx.state !== "running") {
      return;
    }
    if (!this.pool.tryAcquire()) {
      return;
    }
    try {
      const ctx = this.ctx;
      const t0 = ctx.currentTime;
      const bed = ctx.createOscillator();
      bed.type = "sine";
      bed.frequency.value = SFX_CHARGE_BED_HZ;
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 200;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(SFX_CHARGE_BED_GAIN, t0 + 0.2);
      bed.connect(filter);
      filter.connect(gain);
      gain.connect(this.master);
      bed.start(t0);
      this.chargeNodes = { bed, gain };
      this.chargeNextTick = 0.06;
    } catch {
      this.pool.release();
      this.chargeNodes = null;
    }
  }

  // Per-frame charge progress feed (scalar write from main.ts, zero allocs,
  // no-op unless a charge is live): fires one tension creak per threshold
  // crossing. Thresholds bunch up near full (chargeTickGap), so for a steady
  // charge the ticks accelerate ~2/s → ~12/s with rising pitch — the
  // slingshot-draw read. Thresholds always advance, even while suspended, so
  // no creak burst can queue for the resume moment; creaks never touch the
  // voice pool (they belong to the held charge voice).
  public setChargeProgress(progress01: number): void {
    if (this.chargeNodes === null || this.ctx === null) {
      return;
    }
    if (typeof progress01 !== "number" || !Number.isFinite(progress01)) {
      return;
    }
    const p = Math.max(0, Math.min(1, progress01));
    let guard = 0;
    while (this.chargeNextTick <= p && guard < 64) {
      const at = this.chargeNextTick;
      this.chargeNextTick += chargeTickGap(at);
      guard += 1;
      if (this.ctx.state === "running" && !this.muted) {
        this.scheduleCreak(at);
      }
    }
  }

  // One tension creak: bandpass noise burst + woody knock in the
  // 400-2000 Hz band, center pitch rising with progress. Detached by design
  // (no pool voice, no scope) — ≤60 ms nodes that decay on their own;
  // chargeStop only owns the bed.
  private scheduleCreak(progress01: number): void {
    const ctx = this.ctx;
    const master = this.master;
    const buffer = this.noiseBuf;
    if (ctx === null || master === null || buffer === null) {
      return;
    }
    try {
      const t0 = ctx.currentTime;
      const peak = Math.max(0.0001, SFX_CREAK_PEAK * (0.5 + 0.5 * progress01));
      const center = SFX_CREAK_BASE_HZ + (SFX_CREAK_TOP_HZ - SFX_CREAK_BASE_HZ) * progress01;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.value = center;
      filter.Q.value = 6;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(peak * 0.65, t0 + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + SFX_CREAK_DUR_S);
      // Woody knock body (triangle, mid band — survives phone speakers).
      const knock = ctx.createOscillator();
      knock.type = "triangle";
      const knockFreq = 500 + 900 * progress01;
      knock.frequency.setValueAtTime(knockFreq, t0);
      knock.frequency.exponentialRampToValueAtTime(Math.max(50, knockFreq * 0.7), t0 + SFX_CREAK_DUR_S);
      const knockGain = ctx.createGain();
      knockGain.gain.setValueAtTime(0, t0);
      knockGain.gain.linearRampToValueAtTime(peak * 0.35, t0 + 0.005);
      knockGain.gain.exponentialRampToValueAtTime(0.0001, t0 + SFX_CREAK_DUR_S);
      source.connect(filter);
      filter.connect(gain);
      gain.connect(master);
      knock.connect(knockGain);
      knockGain.connect(master);
      if (this.verbSend !== null) {
        gain.connect(this.verbSend);
        knockGain.connect(this.verbSend);
      }
      const stopAt = t0 + SFX_CREAK_DUR_S + 0.05;
      knock.onended = (): void => {
        try {
          source.disconnect();
          filter.disconnect();
          gain.disconnect();
          knock.disconnect();
          knockGain.disconnect();
        } catch {
          // Torn down via dispose mid-creak — safe to ignore.
        }
      };
      source.start(t0);
      knock.start(t0);
      source.stop(stopAt);
      knock.stop(stopAt);
    } catch {
      // A single failed creak never kills the charge.
    }
  }

  public chargeStop(): void {
    const nodes = this.chargeNodes;
    this.chargeNodes = null;
    if (nodes === null || this.ctx === null) {
      return;
    }
    try {
      const t0 = this.ctx.currentTime;
      nodes.gain.gain.cancelScheduledValues(t0);
      nodes.gain.gain.setTargetAtTime(0, t0, 0.03);
      nodes.bed.stop(t0 + 0.15);
      nodes.bed.onended = (): void => {
        try {
          nodes.bed.disconnect();
          nodes.gain.disconnect();
        } catch {
          // Already torn down via dispose — nothing to disconnect.
        }
        this.pool.release();
      };
    } catch {
      this.pool.release();
    }
  }

  // Ambient music loop (owner's file at SFX_AMBIENT_URL when present):
  // fetch + decode once after the first running unlock, loop with a fade-in,
  // routed through master so mute kills it too. Missing file (404) or a
  // decode failure is a silent no-op — zero console spam. Always-on once
  // started (simplest honest behavior; documented). The fetcher is injectable
  // for unit tests (404 fake -> false, 200 fake -> attached-or-false without
  // a context). Returns true once the loop is live.
  public startAmbient(fetchImpl?: AmbientFetcher): boolean {
    if (this.ambientStarted || this.ambientStarting) {
      return this.ambientStarted;
    }
    if (this.ctx === null || this.master === null) {
      return false;
    }
    const impl = fetchImpl ?? defaultAmbientFetch();
    if (impl === null) {
      return false;
    }
    this.ambientStarting = true;
    let abort: AbortController | null = null;
    try {
      abort = new AbortController();
    } catch {
      abort = null;
    }
    this.ambientAbort = abort;
    const signal = abort !== null ? abort.signal : undefined;
    void impl(resolveAmbientUrl(), signal !== undefined ? { signal } : undefined)
      .then((response) => {
        if (!ambientAttachDecision(response.ok)) {
          // No file dropped yet (clean 404): stay silent, allow a later
          // retry (a fresh unlock after the owner adds the file).
          this.ambientStarting = false;
          return null;
        }
        return response.arrayBuffer();
      })
      .then((data) => {
        if (data === null || this.ctx === null || this.master === null) {
          this.ambientStarting = false;
          return;
        }
        void this.ctx
          .decodeAudioData(data)
          .then((buffer) => {
            if (this.ctx === null || this.master === null) {
              this.ambientStarting = false;
              return;
            }
            const source = this.ctx.createBufferSource();
            source.buffer = buffer;
            source.loop = true;
            const gain = this.ctx.createGain();
            const t0 = this.ctx.currentTime;
            gain.gain.setValueAtTime(0, t0);
            gain.gain.linearRampToValueAtTime(SFX_AMBIENT_GAIN, t0 + SFX_AMBIENT_FADE_S);
            source.connect(gain);
            gain.connect(this.master);
            source.start(t0);
            this.ambientNodes = { source, gain };
            this.ambientStarting = false;
            this.ambientStarted = true;
          })
          .catch((): void => {
            // Undecodable file: silent no-op, retry allowed later.
            this.ambientStarting = false;
          });
      })
      .catch((): void => {
        // Fetch aborted at teardown or network failure: silent.
        this.ambientStarting = false;
      });
    return false;
  }

  public get ambientActive(): boolean {
    return this.ambientStarted;
  }

  public dispose(): void {
    const nodes = this.chargeNodes;
    this.chargeNodes = null;
    if (nodes !== null) {
      try {
        nodes.bed.stop();
      } catch {
        // Never started or already stopped — safe to ignore.
      }
      try {
        nodes.bed.disconnect();
        nodes.gain.disconnect();
      } catch {
        // Already disconnected — safe to ignore.
      }
    }
    // Ambient teardown: abort a pending fetch, fade-stop a live loop.
    const abort = this.ambientAbort;
    this.ambientAbort = null;
    if (abort !== null) {
      try {
        abort.abort();
      } catch {
        // Already aborted — safe to ignore.
      }
    }
    const ambient = this.ambientNodes;
    this.ambientNodes = null;
    this.ambientStarting = false;
    this.ambientStarted = false;
    if (ambient !== null && this.ctx !== null) {
      try {
        const t0 = this.ctx.currentTime;
        ambient.gain.gain.cancelScheduledValues(t0);
        ambient.gain.gain.setTargetAtTime(0, t0, 0.1);
        ambient.source.stop(t0 + 0.4);
      } catch {
        // Already stopped — safe to ignore.
      }
      try {
        ambient.source.disconnect();
        ambient.gain.disconnect();
      } catch {
        // Already disconnected — safe to ignore.
      }
    }
    this.pool.reset();
    this.gate.reset();
    const ctx = this.ctx;
    this.ctx = null;
    this.master = null;
    this.comp = null;
    this.verbSend = null;
    this.noiseBuf = null;
    if (ctx !== null) {
      void ctx.close().catch((): void => {
        // Close races during teardown are best-effort only.
      });
    }
  }

  private releaseScope(scope: VoiceScope): void {
    if (!scope.released) {
      scope.released = true;
      this.pool.release();
    }
  }

  private finishVoiceNode(scope: VoiceScope): void {
    scope.pending -= 1;
    if (scope.pending <= 0) {
      this.releaseScope(scope);
    }
  }

  private render(
    name: SfxEventName,
    gain: number,
    rate: number,
    intensity: number,
    scope: VoiceScope,
  ): void {
    // Sega-16-bit character (round 2): square/pulse bodies, FM-modulated
    // punch, hard fast transients, dry mix. Anti-tetris rule: at most ~2
    // simultaneous oscillators and ~2 sequential hits per event — no melodic
    // arpeggios, no chord/glitter stacks. Layer peaks sum to at most
    // SFX_LAYER_SUM_MAX × gain (the documented level budget). Footstep is the
    // quiet detail voice (mid-range body so it reads on phones); hits dominate.
    switch (name) {
      case "footstep":
        // Hop tick, clearly audible but never a blaster: mid-range triangle
        // thump (reads on phone speakers, unlike the old low sine) + bandpass
        // click for the contact transient. Still the lowest-priority voice.
        this.tone({ freq: 220, freqEnd: 140, type: "triangle", dur: 0.08, gain: gain * 0.65, lowpass: 1400 }, scope);
        this.noise({ dur: 0.05, gain: gain * 0.35, type: "bandpass", freq: 1200, q: 1.5 }, scope);
        break;
      case "throw":
        // Cannon launch (round 4 — the old zap read "empty"): low FM thoomp
        // with a longer sub tail for weight (never boomy mud — the pitch
        // keeps falling through the decay), dense noise crack (band body +
        // front clank), whoosh subordinate behind. Intensity scales power.
        this.fm(
          {
            carrierFreq: 180 * rate,
            carrierEnd: 45,
            modRatio: 1,
            depth: fmDepthForIntensity(1400, intensity),
            depthEnd: 70,
            dur: 0.32,
            gain: gain * 0.5,
            attack: 0.003,
            lowpass: 900,
          },
          scope,
        );
        this.tone({ freq: 90 * rate, freqEnd: 38, type: "sine", dur: 0.38, gain: gain * 0.3, lowpass: 500 }, scope);
        this.noise({ dur: 0.14, gain: gain * 0.25, type: "bandpass", freq: 900 * rate, q: 0.8, attack: 0.002 }, scope);
        this.tone({ freq: 2400 * rate, freqEnd: 1500, type: "square", dur: 0.035, gain: gain * 0.15, attack: 0.002, lowpass: 6000 }, scope);
        this.noise({ dur: 0.3, gain: gain * 0.15, type: "bandpass", freq: 500 * rate, freqEnd: 2400 * rate, q: 1.2, delay: 0.04 }, scope);
        break;
      case "impact":
        // The rubber thud, fatter (round 4): same Genesis-drum FM drop with a
        // longer sub tail for body, denser crack (low knock + mid band);
        // rubber character kept, thinness gone.
        this.fm(
          {
            carrierFreq: 160 * rate,
            carrierEnd: 55,
            modRatio: 1,
            depth: fmDepthForIntensity(900, intensity),
            depthEnd: 60,
            dur: 0.26,
            gain: gain * 0.55,
            attack: 0.003,
            lowpass: 1800,
          },
          scope,
        );
        this.tone({ freq: 65 * rate, freqEnd: 35, type: "sine", dur: 0.38, gain: gain * 0.4, lowpass: 550 }, scope);
        this.noise({ dur: 0.08, gain: gain * 0.25, type: "lowpass", freq: 750 * rate, attack: 0.002 }, scope);
        this.noise({ dur: 0.12, gain: gain * 0.15, type: "bandpass", freq: 500 * rate, q: 1, attack: 0.002 }, scope);
        break;
      case "death":
        // Heavier, longer read of the same drum: deeper carrier, longer sub.
        this.fm(
          {
            carrierFreq: 110 * rate,
            carrierEnd: 38,
            modRatio: 1,
            depth: fmDepthForIntensity(700, intensity),
            depthEnd: 50,
            dur: 0.4,
            gain: gain * 0.6,
            attack: 0.003,
            lowpass: 1400,
          },
          scope,
        );
        this.tone({ freq: 60 * rate, freqEnd: 32, type: "sine", dur: 0.45, gain: gain * 0.4, lowpass: 500 }, scope);
        this.noise({ dur: 0.2, gain: gain * 0.35, type: "lowpass", freq: 480 }, scope);
        break;
      case "ricochet":
        // Dry metallic chip-tick: square blip + short FM ping, no ring tail.
        this.tone({ freq: 700 * rate, freqEnd: 480, type: "square", dur: 0.06, gain: gain * 0.6, attack: 0.002, lowpass: 2800 }, scope);
        this.fm(
          {
            carrierFreq: 1800 * rate,
            modRatio: 1,
            depth: fmDepthForIntensity(1200, intensity),
            depthEnd: 100,
            dur: 0.05,
            gain: gain * 0.3,
            attack: 0.002,
            lowpass: 4200,
          },
          scope,
        );
        break;
      case "pickup":
        // Single two-layer punch (anti-tetris): one square note + one quick
        // octave blip. No melody, no third sparkle.
        this.tone({ freq: 659.25, type: "square", dur: 0.09, gain: gain * 0.7, attack: 0.004, lowpass: 3200 }, scope);
        this.tone({ freq: 1318.51, type: "square", dur: 0.07, gain: gain * 0.4, delay: 0.05, attack: 0.003, lowpass: 4200 }, scope);
        break;
      case "trampoline":
        // Fat but restrained boing: FM rubber drop (NOT cartoonish — low,
        // fast decay, no wobble) + felt sub body. No whistle, no shimmer.
        this.fm(
          {
            carrierFreq: 150,
            carrierEnd: 80,
            modRatio: 1,
            depth: fmDepthForIntensity(500, intensity),
            depthEnd: 80,
            dur: 0.24,
            gain: gain * 0.6,
            attack: 0.004,
            lowpass: 1100,
          },
          scope,
        );
        this.tone({ freq: 75, freqEnd: 55, type: "sine", dur: 0.2, gain: gain * 0.4, lowpass: 600 }, scope);
        this.noise({ dur: 0.1, gain: gain * 0.25, type: "lowpass", freq: 500 }, scope);
        break;
      case "roundStart":
        // Single chip-fanfare hit: low square root + one brief fifth stab.
        this.tone({ freq: 110, type: "square", dur: 0.35, gain: gain * 0.45, attack: 0.006, lowpass: 1200 }, scope);
        this.tone({ freq: 165, type: "square", dur: 0.12, gain: gain * 0.45, delay: 0.06, attack: 0.004, lowpass: 2000 }, scope);
        break;
      case "roundEnd":
        // Companion hit, falling: stab first, root answers.
        this.tone({ freq: 165, type: "square", dur: 0.12, gain: gain * 0.45, attack: 0.004, lowpass: 2000 }, scope);
        this.tone({ freq: 110, type: "square", dur: 0.35, gain: gain * 0.45, delay: 0.08, attack: 0.006, lowpass: 1200 }, scope);
        break;
      case "respawn":
        // FM warp zap upward + a breath of air. One gesture, no shimmer stack.
        this.fm(
          {
            carrierFreq: 300,
            carrierEnd: 720,
            modRatio: 1,
            depth: fmDepthForIntensity(600, intensity),
            depthEnd: 100,
            dur: 0.14,
            gain: gain * 0.7,
            attack: 0.004,
            lowpass: 3200,
          },
          scope,
        );
        this.noise({ dur: 0.1, gain: gain * 0.25, type: "highpass", freq: 3000 }, scope);
        break;
      case "superSpawn":
        // One distinct saturated hit: high FM stab over a warm sub.
        this.fm(
          {
            carrierFreq: 660,
            carrierEnd: 1320,
            modRatio: 2,
            depth: fmDepthForIntensity(1500, intensity),
            depthEnd: 200,
            dur: 0.22,
            gain: gain * 0.7,
            attack: 0.005,
            lowpass: 4800,
          },
          scope,
        );
        this.tone({ freq: 330, type: "sine", dur: 0.22, gain: gain * 0.35, lowpass: 1400 }, scope);
        break;
      case "superPickup":
        // Brighter twin: FM punch up + one octave blip. Two hits, no glitter.
        this.fm(
          {
            carrierFreq: 440,
            carrierEnd: 880,
            modRatio: 1,
            depth: fmDepthForIntensity(1000, intensity),
            depthEnd: 150,
            dur: 0.18,
            gain: gain * 0.7,
            attack: 0.004,
            lowpass: 3600,
          },
          scope,
        );
        this.tone({ freq: 880, type: "square", dur: 0.08, gain: gain * 0.4, delay: 0.06, attack: 0.003, lowpass: 4200 }, scope);
        break;
      case "squeal": {
        // Enemy hit squeal (round 3): 3 chip variants picked per-play via
        // Math.random (event-driven, never the hot path) + a small random
        // detune so repeats never sound identical. Square voice, exaggerated
        // bend, at most 2 sequential hits — rides on top of the impact thud.
        const variant = pickSquealVariant(Math.random());
        const detune = squealDetune(Math.random());
        // Thickener: a detuned shadow (+1%, ~17 cents) behind each variant's
        // lead bend — saturated double-square read, pitch-bend character kept.
        const shadow = detune * 1.01;
        if (variant === 0) {
          // Down-then-up yelp.
          this.tone({ freq: 900 * detune, freqEnd: 400 * detune, type: "square", dur: 0.09, gain: gain * 0.6, attack: 0.004, lowpass: 3400 }, scope);
          this.tone({ freq: 900 * shadow, freqEnd: 400 * shadow, type: "square", dur: 0.09, gain: gain * 0.25, attack: 0.004, lowpass: 3400 }, scope);
          this.tone({ freq: 400 * detune, freqEnd: 1200 * detune, type: "square", dur: 0.1, gain: gain * 0.45, delay: 0.09, attack: 0.004, lowpass: 3400 }, scope);
        } else if (variant === 1) {
          // Falling squawk, slightly longer.
          this.tone({ freq: 1200 * detune, freqEnd: 280 * detune, type: "square", dur: 0.24, gain: gain * 0.75, attack: 0.004, lowpass: 3200 }, scope);
          this.tone({ freq: 1200 * shadow, freqEnd: 280 * shadow, type: "square", dur: 0.24, gain: gain * 0.25, attack: 0.004, lowpass: 3200 }, scope);
        } else {
          // Rising chirp + snap down.
          this.tone({ freq: 500 * detune, freqEnd: 1500 * detune, type: "square", dur: 0.12, gain: gain * 0.55, attack: 0.004, lowpass: 3800 }, scope);
          this.tone({ freq: 500 * shadow, freqEnd: 1500 * shadow, type: "square", dur: 0.12, gain: gain * 0.25, attack: 0.004, lowpass: 3800 }, scope);
          this.tone({ freq: 1500 * detune, freqEnd: 700 * detune, type: "square", dur: 0.08, gain: gain * 0.35, delay: 0.1, attack: 0.003, lowpass: 3800 }, scope);
        }
        break;
      }
      case "charge":
        // Charge has no one-shot: chargeStart/setChargeProgress/chargeStop
        // own the tension bed + creaks.
        break;
    }
  }

  // One enveloped oscillator voice through an optional lowpass into master
  // (dry) plus the shared reverb send (wet). Joins the play's shared scope
  // (released once the last node ends).
  private tone(spec: ToneSpec, scope: VoiceScope): void {
    const ctx = this.ctx;
    const master = this.master;
    if (ctx === null || master === null) {
      return;
    }
    const delay = spec.delay !== undefined && Number.isFinite(spec.delay) && spec.delay > 0 ? spec.delay : 0;
    const dur = spec.dur > 0.02 ? spec.dur : 0.02;
    const attack =
      spec.attack !== undefined && Number.isFinite(spec.attack) && spec.attack > 0
        ? Math.min(spec.attack, dur / 2)
        : 0.008;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = spec.type ?? "sine";
    const freq = spec.freq > 0 ? spec.freq : 100;
    osc.frequency.setValueAtTime(freq, t0);
    if (spec.freqEnd !== undefined && spec.freqEnd > 0 && spec.freqEnd !== freq) {
      osc.frequency.exponentialRampToValueAtTime(spec.freqEnd, t0 + dur);
    }
    const gain = ctx.createGain();
    const peak = Math.max(0.0001, spec.gain);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    if (spec.lowpass !== undefined && spec.lowpass > 0) {
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = spec.lowpass;
      osc.connect(filter);
      filter.connect(gain);
    } else {
      osc.connect(gain);
    }
    gain.connect(master);
    if (this.verbSend !== null) {
      gain.connect(this.verbSend);
    }
    scope.pending += 1;
    osc.onended = (): void => {
      try {
        osc.disconnect();
        gain.disconnect();
      } catch {
        // Torn down via dispose mid-voice — safe to ignore.
      }
      this.finishVoiceNode(scope);
    };
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  // One enveloped filtered-noise voice from the shared preallocated buffer
  // (dry into master, wet into the shared reverb send).
  private noise(spec: NoiseSpec, scope: VoiceScope): void {
    const ctx = this.ctx;
    const master = this.master;
    const buffer = this.noiseBuf;
    if (ctx === null || master === null || buffer === null) {
      return;
    }
    const delay = spec.delay !== undefined && Number.isFinite(spec.delay) && spec.delay > 0 ? spec.delay : 0;
    const dur = spec.dur > 0.02 ? spec.dur : 0.02;
    const attack =
      spec.attack !== undefined && Number.isFinite(spec.attack) && spec.attack > 0
        ? Math.min(spec.attack, dur / 2)
        : 0.01;
    const t0 = ctx.currentTime + delay;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = spec.type ?? "lowpass";
    const freq = spec.freq !== undefined && spec.freq > 0 ? spec.freq : 800;
    filter.frequency.setValueAtTime(freq, t0);
    if (spec.freqEnd !== undefined && spec.freqEnd > 0 && spec.freqEnd !== freq) {
      filter.frequency.exponentialRampToValueAtTime(spec.freqEnd, t0 + dur);
    }
    filter.Q.value = spec.q !== undefined && Number.isFinite(spec.q) && spec.q > 0 ? spec.q : 0.8;
    const gain = ctx.createGain();
    const peak = Math.max(0.0001, spec.gain);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    if (this.verbSend !== null) {
      gain.connect(this.verbSend);
    }
    scope.pending += 1;
    source.onended = (): void => {
      try {
        source.disconnect();
        filter.disconnect();
        gain.disconnect();
      } catch {
        // Torn down via dispose mid-voice — safe to ignore.
      }
      this.finishVoiceNode(scope);
    };
    source.start(t0);
    source.stop(t0 + dur + 0.05);
  }

  // FM stab voice (see FmSpec): square carrier + sine modulator into the
  // carrier frequency, one shared decay envelope. Dry into master, wet into
  // the shared reverb send; one scope voice for both oscillators (the
  // carrier's end releases it, the modulator only disconnects).
  private fm(spec: FmSpec, scope: VoiceScope): void {
    const ctx = this.ctx;
    const master = this.master;
    if (ctx === null || master === null) {
      return;
    }
    const delay = spec.delay !== undefined && Number.isFinite(spec.delay) && spec.delay > 0 ? spec.delay : 0;
    const dur = spec.dur > 0.02 ? spec.dur : 0.02;
    const attack =
      spec.attack !== undefined && Number.isFinite(spec.attack) && spec.attack > 0
        ? Math.min(spec.attack, dur / 2)
        : 0.005;
    const t0 = ctx.currentTime + delay;
    const carrierFreq = spec.carrierFreq > 0 ? spec.carrierFreq : 100;
    const carrierEnd =
      spec.carrierEnd !== undefined && spec.carrierEnd > 0 && spec.carrierEnd !== carrierFreq
        ? spec.carrierEnd
        : null;
    const ratio = spec.modRatio !== undefined && Number.isFinite(spec.modRatio) && spec.modRatio > 0 ? spec.modRatio : 1;
    const carrier = ctx.createOscillator();
    carrier.type = "square";
    carrier.frequency.setValueAtTime(carrierFreq, t0);
    if (carrierEnd !== null) {
      carrier.frequency.exponentialRampToValueAtTime(carrierEnd, t0 + dur);
    }
    const mod = ctx.createOscillator();
    mod.type = "sine";
    mod.frequency.setValueAtTime(carrierFreq * ratio, t0);
    if (carrierEnd !== null) {
      mod.frequency.exponentialRampToValueAtTime(carrierEnd * ratio, t0 + dur);
    }
    const modGain = ctx.createGain();
    const depth = Math.max(0, spec.depth);
    modGain.gain.setValueAtTime(depth, t0);
    const depthEnd = spec.depthEnd !== undefined && Number.isFinite(spec.depthEnd) ? Math.max(0, spec.depthEnd) : depth * 0.08;
    // Exponential ramps cannot start at 0 — skip the ramp on a silent
    // modulator (callers always pass depth > 0; this is belt and braces).
    if (depthEnd !== depth && depth > 0) {
      modGain.gain.exponentialRampToValueAtTime(Math.max(0.001, depthEnd), t0 + dur);
    }
    mod.connect(modGain);
    modGain.connect(carrier.frequency);
    const gain = ctx.createGain();
    const peak = Math.max(0.0001, spec.gain);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    if (spec.lowpass !== undefined && spec.lowpass > 0) {
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = spec.lowpass;
      carrier.connect(filter);
      filter.connect(gain);
    } else {
      carrier.connect(gain);
    }
    gain.connect(master);
    if (this.verbSend !== null) {
      gain.connect(this.verbSend);
    }
    scope.pending += 1;
    carrier.onended = (): void => {
      try {
        carrier.disconnect();
        mod.disconnect();
        modGain.disconnect();
        gain.disconnect();
      } catch {
        // Torn down via dispose mid-voice — safe to ignore.
      }
      this.finishVoiceNode(scope);
    };
    carrier.start(t0);
    mod.start(t0);
    carrier.stop(t0 + dur + 0.05);
    mod.stop(t0 + dur + 0.05);
  }
}

// Factory (keeps call sites free of `new` + audio imports).
export function createSfx(): SfxEngine {
  return new SfxEngine();
}
