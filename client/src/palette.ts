// KABAN ARENA single source of truth for color (Stage 4d.2-fix palette
// rework, owner-confirmed): split-complementary VIOLET–RED–CHARTREUSE with
// composition ≈ 70% dark violet base / 25% muted-red accents / 5% chartreuse
// highlights reserved for must-highlight items. White and dark tints of
// these hues are free to use. Readability on phones in sunlight: floor is
// the darkest surface, obstacles/platforms readably lighter, highlights pop,
// reds stay muted (never neon).
//
// Conventions: numeric consts feed three.js materials; *_CSS strings feed
// DOM/canvas APIs (style.css mirrors them via :root custom properties with
// a comment naming the palette constant). No other production file may carry
// its own hex literal — import from here (test fixtures may keep arbitrary
// colors). IDENTITY_* colors are functional (fighter distinction), not part
// of the 70/25/5 count. Lights stay white (perf rule); moon/stars stay
// white (free tones).

// BASE 70% — dark violet family (hue ~250-265°), near-black values.
// Visual-round brightening (subtle +20-30% lightness lift, same hues): every
// surface was re-derived in HSL from the previous value (L x1.25, walls x1.15
// to preserve glass see-through contrast, BG/AD-frame x1.2). Floor stays the
// darkest gameplay surface, tops stay lighter. All hues remain in 230-290°
// with lightness under 0.45 (pinned by palette.test.ts).
export const BASE_BG = 0x100c1d;
export const BASE_BG_CSS = "#100c1d";
export const BASE_FLOOR = 0x191427;
export const BASE_WALL = 0x211837;
export const BASE_OBSTACLE = 0x2e234c;
export const BASE_OBSTACLE_TOP = 0xcfc2ee;
export const BASE_PLATFORM = 0x352855;
export const BASE_PLATFORM_TOP = 0xd9cdf5;
// Per-figure tints: white, muted red, dark violet, pale violet.
export const BASE_FIGURE_TINTS = [0xffffff, 0xb0575a, 0x4a3670, 0xc9b8ee] as const;
export const BASE_CAP = 0x4c3b73;
export const BASE_RAMP = 0x3c2e5b;
export const BASE_ICE = 0x261e46;
export const BASE_TRAMPOLINE = 0x372950;
export const BASE_PAD = 0x453562;
export const BASE_PICKUP = 0x1d1730;
export const BASE_BASALT = 0x2d2346;
export const BASE_AD_FRAME = 0x161124;
export const BASE_AD_CANVAS = "#141021";

// ACCENT 25% — muted/desaturated red family (+ dim violet for ice glow).
export const ACCENT_STRIP = 0x8e3b44;
export const ACCENT_STRIP_BASE = 0x2a1218;
export const ACCENT_ICE_GLOW = 0x5a4a8e;
export const ACCENT_HIT_FLASH = 0xd94f4f;
export const ACCENT_HIT_BURST = 0xc4504e;
export const ACCENT_FIRE_BURST = 0xcf5f4a;
export const ACCENT_OBSTACLE_TINT = 0xa34a52;
export const ACCENT_BALL_CAP = 0xd9cdf2;
export const ACCENT_TRAIL = 0xd5c6f0;
export const ACCENT_SPARK = 0xd9cdf2;
export const ACCENT_SPOT = 0xe8dcff;
export const ACCENT_HEART_FULL = "#c14e56";
export const ACCENT_HEART_HALF = "#c9b8ee";
export const ACCENT_FIRE_BUTTON = "rgba(193, 78, 86, 0.25)";
export const ACCENT_AD_BANNER = "#b0505a";
export const ACCENT_AD_FENCE = "#c9b8ee";
// SUPER badge text (pale violet, already scheme — named counterpart for the
// style.css :root mirror).
export const ACCENT_SUPER_TEXT_CSS = "#e9d5ff";
// Death burst thirds (white 10% / pale violet 30% / muted red 60%).
export const ACCENT_DEATH_WHITE = 0xf5f0ff;
export const ACCENT_DEATH_PALE = 0xb9a3e6;
export const ACCENT_DEATH_RED = 0xa8434e;
export const ACCENT_CROSSHAIR_FULL = "#c9504f";
export const ACCENT_CROSSHAIR_CHARGING = "#ffffff";
// Held-ball charge glow ramp (muted-red family, distinct from the
// full-body hit-flash spike by being ball-only with its own ramp/flicker).
export const ACCENT_GLOW_BALL = 0x93363e;
export const ACCENT_GLOW_BALL_FULL = 0xe2574f;

// HIGHLIGHT 5% — chartreuse family (~#b8e04a), ONLY for must-highlight items:
// trampoline pads + bursts, power-up pickups + bursts, super ball/core/trail,
// shield bubble + absorb, spawn rings, Play button, power + reload bars.
export const HL_CHARTREUSE = 0xb8e04a;
export const HL_CHARTREUSE_CSS = "#b8e04a";
export const HL_CHARTREUSE_BRIGHT = 0xd7f472;
export const HL_CHARTREUSE_DEEP = 0x86b32c;
export const HL_JOIN_TEXT = "#1e2407";
// Semantic aliases (same chartreuse value, named by use site).
export const HL_SHIELD = 0xb8e04a;
export const HL_TRAMP_BURST = 0xb8e04a;

// IDENTITY — functional fighter colors (excluded from the 70/25/5 count):
// 7 mutually distinct hues readable on the dark violet floor. No entry may
// equal a highlight/accent constant (identity must never read as a pickup,
// super core, or ball cap).
export const IDENTITY_LOCAL = 0xd95f66;
export const IDENTITY_REMOTES = [
  0x9a5fd0,
  0xcfc4e8,
  0x7a2430,
  0x6a5fc8,
  0x7a8c2e,
  0xe8b4b8,
] as const;

// PANTS — 6 dark violet/grey-family tints (two-tone clothing bottoms).
export const PANTS_PALETTE = [0x241c38, 0x2e2545, 0x1c1628, 0x38304e, 0x2a2136, 0x443a5c] as const;
export const PANTS_FALLBACK = 0x241c38;

// BALL — polished dark-amethyst stone for normal cores (visual round: the old
// BASE_BG base + 1/3 thrower-color cap read garish). All three sit in the
// violet 230-290° band with lightness under 0.45 (pinned by palette.test.ts
// alongside the BASE darks). BALL_BASE is the shared skin base for EVERY
// thrower (HSL lightness ~0.10: slightly lighter than the arena background so
// the core reads on the floor, still dark enough that even the darkest
// fighter keeps >= 0.2 lightness delta for the subtle accent). DARK shades
// the poles and LIGHT gives the equatorial sheen in the painted gradient;
// the thrower color appears ONLY as a thin ring + polar dot (~12.5%).
export const BALL_BASE = 0x141024;
export const BALL_BASE_DARK = 0x0e0a1c;
export const BALL_BASE_LIGHT = 0x2a2148;

// NEUTRAL — free tones (lights, moon/stars, label text, vertex-color base).
export const NEUTRAL_WHITE = 0xffffff;
export const NEUTRAL_WHITE_CSS = "#ffffff";
export const NEUTRAL_FACE_STROKE = "#1a1a1a";
export const NEUTRAL_MOON = 0xf4f1de;
