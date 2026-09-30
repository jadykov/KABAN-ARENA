// Shared scene and UI palette. Hex colors supplied to three.js are converted
// to linear space by THREE.Color; procedural DataTextures declare sRGB.
// CSS mirrors are named here so HUD colors follow the world art direction.

// Round sky palette: warm pale morning, clear day, muted sunset, deep night.
// Fog tracks the sky so the arena fades into each phase without a hard seam.
export const BASE_BG = 0x0b1829;
export const BASE_BG_CSS = "#0b1829";
export const SKY_DAWN_BG = 0xa1bfd9;
export const SKY_DAWN_FOG = 0xc3ccd0;
export const SKY_DAY_BG = 0x80c3ed;
export const SKY_DAY_FOG = 0xa9d2e9;
export const SKY_SUNSET_BG = 0x936b70;
export const SKY_SUNSET_FOG = 0xaa857c;
export const SKY_SUN_DISC = 0xffe6ad;
export const SKY_SUNSET_DISC = 0xffaa7a;
export const SKY_CLOUD_DAY = 0xf4f8f7;
export const SKY_CLOUD_SUNSET = 0xf3c8a6;
// Cool slate walking surface. The grout and faint floor stars add scale
// without competing with players, pickups, or aim feedback.
export const BASE_FLOOR = 0x536b7b;
export const BASE_FLOOR_GROUT = 0x344d5e;
export const BASE_FLOOR_LIGHT = 0x617b87;
export const BASE_FLOOR_STAR = 0x69868c;

// Evergreen masonry is brighter than the floor on its playable faces. Tops
// are painted directly into vertex colors, with cooler shade-facing sides.
export const BASE_WALL = 0x4a9276;
export const BASE_WALL_PLINTH = 0x315d59;
export const BASE_FENCE_NET_DAY = 0x667a70;
export const BASE_FENCE_NET_NIGHT = 0x39463f;
export const BASE_OBSTACLE = 0x739879;
export const BASE_OBSTACLE_TOP = 0xc6dcaa;
export const BASE_OBSTACLE_EDGE = 0xd4dda9;
export const BASE_PLATFORM = 0x6d9475;
export const BASE_PLATFORM_TOP = 0xbedc9b;
export const BASE_FIGURE_TINTS = [0xffffff, 0xe5ebcc, 0xd4e7dc, 0xf2dfbc] as const;
export const BASE_CAP = 0xa9c18e;
export const BASE_RAMP = 0x91a690;
export const BASE_RAMP_MARK = 0xcad9ae;
export const BASE_ICE = 0x83c2d5;
export const BASE_ICE_EDGE = 0x4f98ad;
export const BASE_ICE_FACET = 0xb5e3e4;
export const BASE_TRAMPOLINE = 0x3f665c;
export const BASE_PAD = 0x678e61;
export const BASE_PAD_RIM = 0x476d5d;
export const BASE_PICKUP = 0x16333d;
export const BASE_BASALT = 0x526e67;
export const BASE_AD_FRAME = 0x263e42;
export const BASE_AD_CANVAS = "#102b35";

// Warm key light and restrained amber architectural accents. Cool ambient
// fill keeps the unlit side readable instead of falling to black.
export const SCENE_WARM_LIGHT = 0xffe0ab;
export const SCENE_WARM_LIGHT_CSS = "#ffe0ab";
export const SCENE_COOL_FILL = 0x8299b4;
export const SCENE_DAWN_KEY = 0xffd997;
export const SCENE_DAWN_FILL = 0xe5c9b5;
export const SCENE_DAY_KEY = 0xfff8e4;
export const SCENE_DAY_FILL = 0xb4d1df;
export const SCENE_SUNSET_KEY = 0xffaa70;
export const SCENE_SUNSET_FILL = 0x977f91;
export const ACCENT_STRIP = 0xd9a161;
export const ACCENT_STRIP_BASE = 0x514638;
export const ACCENT_ICE_GLOW = 0x9bdbea;
export const ACCENT_SWAMP_MUD = 0x465b45;
export const ACCENT_SWAMP_MUD_LIGHT = 0x637950;
export const ACCENT_SWAMP_MUD_EDGE = 0x2c4947;
export const ACCENT_SWAMP_BUBBLE = 0xa3bd79;
export const ACCENT_SWAMP_BUBBLE_LIGHT = 0xd3d9a0;
export const ACCENT_HIT_FLASH = 0xe87568;
export const ACCENT_HIT_BURST = 0xdd7766;
export const ACCENT_FIRE_BURST = 0xe89962;
export const ACCENT_OBSTACLE_TINT = 0xd2e2c7;
export const ACCENT_BALL_CAP = 0xe9e5d3;
export const ACCENT_TRAIL = 0xc5dce2;
export const ACCENT_SPARK = 0xffe5a4;
export const ACCENT_HEART_FULL = "#e87568";
export const ACCENT_HEART_HALF = "#f3c5aa";
export const ACCENT_FIRE_BUTTON = "rgba(232, 117, 104, 0.28)";
export const ACCENT_AD_FENCE = "#d8e2c8";
export const ACCENT_SUPER_TEXT_CSS = "#f9e4b0";
export const ACCENT_DEATH_WHITE = 0xfff5db;
export const ACCENT_DEATH_PALE = 0xf4cf9e;
export const ACCENT_DEATH_RED = 0xd46c5e;
export const ACCENT_CROSSHAIR_FULL = "#e87568";
export const ACCENT_CROSSHAIR_CHARGING = "#ffffff";
export const ACCENT_GLOW_BALL = 0xa75347;
export const ACCENT_GLOW_BALL_FULL = 0xf18a63;

// Functional markers retain a distinct, high-value lime. These few bright
// elements carry pickup, spawn, trampoline, shield, and action affordances.
export const HL_CHARTREUSE = 0xd8ea70;
export const HL_CHARTREUSE_CSS = "#d8ea70";
export const HL_CHARTREUSE_BRIGHT = 0xeff59b;
export const HL_CHARTREUSE_DEEP = 0x9ab84c;
export const HL_JOIN_TEXT = "#243117";
export const HL_SHIELD = HL_CHARTREUSE;
export const HL_TRAMP_BURST = HL_CHARTREUSE;

// Fighter colors are identity markers and stay mutually distinct. Their
// clothing may vary while the arena palette remains coherent.
export const IDENTITY_LOCAL = 0xd95f66;
export const IDENTITY_REMOTES = [
  0x9a5fd0,
  0xcfc4e8,
  0x7a2430,
  0x6a5fc8,
  0x7a8c2e,
  0xe8b4b8,
] as const;

export const PANTS_PALETTE = [0x243442, 0x32434d, 0x1b2a34, 0x46545b, 0x2d3b3e, 0x485765] as const;
export const PANTS_FALLBACK = 0x243442;

// Dark normal balls keep the thrower's colored ring clearly visible.
export const BALL_BASE = 0x0e1723;
export const BALL_BASE_DARK = 0x08101b;
export const BALL_BASE_LIGHT = 0x2c4352;

export const NEUTRAL_WHITE = 0xffffff;
export const NEUTRAL_WHITE_CSS = "#ffffff";
export const NEUTRAL_FACE_STROKE = "#1a1a1a";
export const NEUTRAL_MOON = 0xffe9bd;
