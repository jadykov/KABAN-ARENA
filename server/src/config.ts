// Stage 4 authoritative-server tuning (single source of truth for the
// server room; the client mirrors display-only copies in its config).
// C2 round loop timings 3/3/2 confirmed 2026-09-11 (see MAP.md Stage 4).

// Room capacity (FFA every-man-for-himself, 2-6 per room).
export const MAX_PLAYERS = 6;
// Solo newcomers learn against bots: fill empty slots so a round can start
// and finish with a single human client.
export const MAX_BOTS = 4;
export const MIN_TOTAL_PLAYERS = 3;

// Netcode: inputs-only from clients, delta patches to clients.
export const PATCH_RATE_MS = 50; // 20 ticks/s (inputs-only 20-30/s band)
export const SIM_TICK_MS = 50; // fixed server simulation step
export const PLAYER_SPEED = 4.5; // mirrors client MOVE_SPEED
export const ARENA_HALF_SIZE = 16.8; // mirrors client ARENA_HALF_SIZE (+20%)
export const SPAWN_INSET = 2.4; // mirrors client SPAWN_INSET (scaled)
// Player body radius for server-side movement collision (mirrors the client
// Rapier capsule radius 0.5 in World.ts): the authoritative XZ position is
// the body CENTER, so solid faces stop it one radius out.
export const PLAYER_BODY_RADIUS = 0.5;

// Short-round loop C2: lobby countdown 3s, respawn 3s, invuln 2s.
export const LOBBY_COUNTDOWN_MS = 3000;
export const RESPAWN_DELAY_MS = 3000;
export const INVULN_MS = 2000;
// First to WIN_SCORE points OR ROUND_DURATION_MS timer, whichever first.
// Hard cap ROUND_HARD_CAP_MS stays under 5 minutes (300000ms).
export const WIN_SCORE = 100;
export const ROUND_DURATION_MS = 180000; // 3 min
export const ROUND_HARD_CAP_MS = 290000; // <5min hard cap incl. countdown
export const REMATCH_DELAY_MS = 5000; // ended -> clean reset delay

// Damage model hitscan A: 100HP / 25 dmg = 4 hits = 4 hearts (QD3).
// R2 cannon: float HP kept, FULL=25 (1 heart), WEAK=12.5 (half heart),
// SUPER x2 = 50 / 25. Hearts UI shows halves (0-8).
export const MAX_HP = 100;
export const FULL_DAMAGE = 25;
export const WEAK_DAMAGE = 12.5;
export const HIT_DAMAGE = 25;
export const SUPER_DAMAGE_MULT = 2;
// Charge power mapping: power01 = 0.5 + 0.5 * clamp(chargeS / CHARGE_MAX_S).
// Threshold for full damage rewards committed charges.
export const FULL_POWER_THRESHOLD = 0.8;
export const HIT_MAX_RANGE = 18;
export const HIT_COOLDOWN_MS = 350;
export const KILL_SCORE = 10;
export const HIT_SCORE = 1;

// 4d.1 hand-ball combat (authoritative server ball physics).
// Precision pass (owner playtest): light lob only — weak shots still fly
// fairly flat with a slight drop, so aim stays intuitive. Deterministic,
// zero spray (SPRAY_DEG stays 0).
export const CHARGE_MAX_S = 1.0;
export const RELOAD_MS = 2500;
// Weak shots fly slightly slower than before (MIN 14 -> 11, ~21% down);
// strong/full shots keep the current MAX 20 speed/physics.
export const BALL_MIN_SPEED = 11;
export const BALL_MAX_SPEED = 20;
export const BALL_GRAVITY = 3.5;
// Torso/hand height above the thrower body-center y: ground body-center is
// BODY_CENTER_Y 1.1, so spawn y = bodyY + 0.3 == 1.4 on the ground (unchanged
// from the old absolute height); on platforms it tracks the elevation.
// Ground body-center y (mirrors PlayerState default y + respawn y).
export const BODY_CENTER_Y = 1.1;
export const BALL_TORSO_OFFSET = 0.3;
// Chest-exit muzzle: 0.7m along the aim dir from the body center — just in
// front of the 0.5m capsule radius so the ball visibly leaves the torso
// instead of popping 0.75m past a misaligned invisible point. Mirrored by
// client BALL_MUZZLE_OFFSET (preview math must stay identical).
export const BALL_MUZZLE_OFFSET = 0.7;
// Throw-polish: no shot randomness — the parabola alone is enough chaos.
// Balls fly exactly along the look yaw/pitch + server gravity. Kept at 0
// (not removed) so tuning stays in config if the owner ever wants it back.
export const SPRAY_DEG = 0;
export const BALL_HIT_RADIUS = 0.9;
export const BALL_GROUND_Y = 0.2;
export const MAX_LIVE_BALLS = 12;
// Self-damage arming: point-blank spawn does not insta-suicide.
export const SELF_ARMING_DIST_M = 1.0;
export const SELF_ARMING_TIME_S = 0.3;
export const HIT_KNOCKBACK_M = 1.2;
// Recoil: server-authoritative kick opposite the fire dir on every shot
// (weak 0.4m -> full 0.8m by charge power), clamped to the arena. No
// self-damage — position nudge only.
export const RECOIL_WEAK_M = 0.4;
export const RECOIL_FULL_M = 0.8;
// Two-level platform mirrors (client Arena PLATFORM_FIGURES): AABB tops for
// cannonball impacts. Thin ramp slabs are ignored server-side (balls fly
// over them); the client still collides the capsule with ramp prisms.
// 4 entries mirror client PLATFORM_FIGURES (x/z/hx/hz/topY only).
// rampSide marks the walk-up face (mirrors client rampSide): server movement
// collision leaves that face OPEN so fighters can climb onto the top, while
// the other three faces stay sheer walls.
// rampWidth mirrors client rampWidth (full slab width, m): the open face
// admits entry only inside the ramp corridor (lateral |offset| <=
// rampWidth/2 + body radius), so skirting the ramp mouth at ground level
// stays blocked like the client's solid platform box. rampWidth is also the
// lateral extent of the server ramp-slope band (see hits.rampHeightAt).
// RAMP_SLOPE_DEG mirrors client RAMP_SLOPE_DEG (run = topY / tan).
export const RAMP_SLOPE_DEG = 14;
export interface ServerPlatformDef {
  x: number;
  z: number;
  hx: number;
  hz: number;
  topY: number;
  rampSide: "+x" | "-x" | "+z" | "-z";
  rampWidth: number;
}
export const SERVER_PLATFORMS: ReadonlyArray<ServerPlatformDef> = [
  { x: 13.8, z: -8.5, hx: 1.2, hz: 1.2, topY: 2.6, rampSide: "+z", rampWidth: 2.0 },
  { x: -13.5, z: 10.0, hx: 2.4, hz: 1.0, topY: 1.8, rampSide: "-z", rampWidth: 1.6 },
  { x: -11.5, z: -9.5, hx: 1.4, hz: 1.4, topY: 2.2, rampSide: "+x", rampWidth: 1.8 },
  { x: 5.0, z: 13.5, hx: 1.0, hz: 1.0, topY: 2.0, rampSide: "-x", rampWidth: 1.6 },
];
// Super-core: center spawn every 45s, 15s life, blink last 3s, 1.7m pickup
// (matches the bigger 0.8/0.4 visual), buffs NEXT shot only (consumed on
// fire even on miss).
export const SUPER_SPAWN_S = 45;
export const SUPER_LIFE_S = 15;
export const SUPER_BLINK_S = 3;
export const SUPER_PICKUP_RADIUS = 1.7;
// Server obstacle mirrors (client Arena.getObstacleLayout): AABB + topY for
// cannonball impacts (a ball inside the footprint with y <= topY impacts)
// AND authoritative movement collision (see rooms/ArenaRoom
// resolvePlayerMove, where solids at/below the mover's feet stop blocking).
// Positions scaled x1.2 with the map (4 -> 4.8, 9 -> 10.8); block half
// extents unchanged.
// Stage 4d.3: the 4 CENTRAL blocks (at +-4.8) double to topY 2.0 (mirrors
// client hy 1.0) — trampoline-only high ground. Balls arcing over at
// y 1.0-2.0 now impact instead of flying through (intended gameplay change
// — flag for playtest). The 4 OUTER blocks stay at topY 0.8.
export interface ServerObstacleDef {
  x: number;
  z: number;
  hx: number;
  hz: number;
  topY: number;
}
export const SERVER_OBSTACLES: ReadonlyArray<ServerObstacleDef> = [
  { x: 4.8, z: 4.8, hx: 1, hz: 1, topY: 2.0 },
  { x: -4.8, z: 4.8, hx: 1, hz: 1, topY: 2.0 },
  { x: 4.8, z: -4.8, hx: 1, hz: 1, topY: 2.0 },
  { x: -4.8, z: -4.8, hx: 1, hz: 1, topY: 2.0 },
  { x: 10.8, z: 0, hx: 1.5, hz: 0.75, topY: 0.8 },
  { x: -10.8, z: 0, hx: 1.5, hz: 0.75, topY: 0.8 },
  { x: 0, z: 10.8, hx: 0.75, hz: 1.5, topY: 0.8 },
  { x: 0, z: -10.8, hx: 0.75, hz: 1.5, topY: 0.8 },
];
// R2 fire-pitch acceptance band (mirrors client CAMERA_PITCH_MIN/MAX):
// down-aim from elevation (down to -0.41) must reach the ball spawn
// unflattened — the old [-0.15, 0.9] literals clipped every downhill shot
// toward horizontal (client preview vs server flight mismatch on bug 2).
export const FIRE_PITCH_MIN = -0.41;
export const FIRE_PITCH_MAX = 0.36;
// Server trampoline-jump model (mirrors client Rapier trampolines so tower
// tops are reachable server-side, not just client-side): pads at
// TRAMPOLINE_SPOTS with TRAMPOLINE_RADIUS (mirror client getTrampolines /
// TRAMPOLINE_RADIUS). A grounded fighter whose XZ enters a pad launches with
// TRAMPOLINE_IMPULSE (mirror client TRAMPOLINE_IMPULSE incl. the owner 13.5
// buff) and follows the same damped vertical arc the client integrates
// (TRAMPOLINE_AIR_DAMPING mirrors client PLAYER_LINEAR_DAMPING,
// TRAMPOLINE_GRAVITY mirrors client world gravity 9.81 — NOT the floaty
// BALL_GRAVITY 3.5). Full ground-to-ground flight lasts ~1.75s (tower-top
// landing ~1.17s); TRAMPOLINE_MAX_AIR_S force-lands a stuck arc (the real
// arc lands well inside the cap; the cap never fires in practice).
export const TRAMPOLINE_SPOTS: ReadonlyArray<{ x: number; z: number }> = [
  { x: 0, z: 4.2 },
  { x: 0, z: -4.2 },
];
export const TRAMPOLINE_RADIUS = 1.2;
export const TRAMPOLINE_IMPULSE = 13.5;
export const TRAMPOLINE_AIR_DAMPING = 2.5;
export const TRAMPOLINE_GRAVITY = 9.81;
export const TRAMPOLINE_MAX_AIR_S = 3;
// Elevation-gate tuning (ramp-side pass-through fix): an open (ramp-side)
// face admits entry only when the mover is actually climbing — feet above
// RAMP_ADMIT_MIN_FEET — and only inside the support band (see below). A
// grounded fighter skirting the ramp mouth at feet ~0 is clamped like any
// sheer face, matching the client's solid platform box.
export const RAMP_ADMIT_MIN_FEET = 0.3;
// Wedge-side tolerance (m): legit ramp climbing changes height by at most
// slope x speed x tick (~0.06m), so stepping onto a ramp surface more than
// this above the feet means walking into the wedge SIDE (client Rapier
// blocks it) and the step is held on its axis instead.
export const RAMP_ENTRY_TOL = 0.3;
// Support hysteresis (tower-edge stickiness): keep the last elevated support
// while its feet still match within this tolerance, so walking off a top
// only falls after leaving the radius-expanded footprint (no pinned-at-face
// state, no snap-up from the ground beside a solid — that path fails the
// feet match by metres, not microns).
export const SUPPORT_STICK_TOL = 0.05;
// Charging slow-down mirror (client CHARGE_MOVE_MULT): aiming/charging
// fighters move at half speed, server and client alike.
export const CHARGE_MOVE_MULT = 0.5;
// Cannon bot tuning: random charge 0.3-1.0s, 2.5s cooldown + rand, zero spread.
export const BOT_CHARGE_MIN_S = 0.3;
export const BOT_CHARGE_MAX_S = 1.0;
export const BOT_RELOAD_MS = 2500;
// Throw-polish: bots aim with zero yaw spray — a bot miss comes from its
// lead/pitch choice only, never from randomness. Kept at 0 for compat.
export const BOT_SPRAY_DEG = 0;

// Guest nicks (no auth): validated + deduped on join.
export const NICK_MIN_LENGTH = 2;
export const NICK_MAX_LENGTH = 16;
export const DEFAULT_NICK_PREFIX = "Kaban";
// R1 pre-join spectator: empty Play nick falls back to Guest-XXXX.
export const GUEST_NICK_PREFIX = "Guest";

// Weak-bot tuning (slow, inaccurate, solo-friendly).
export const BOT_SPEED = 2.2;
export const BOT_FIRE_RANGE = 12;
export const BOT_FIRE_INTERVAL_MS = 1600;
export const BOT_RETARGET_MS = 2500;
export const BOT_NAMES = ["Boris", "Gosha", "Misha", "Pumba"] as const;
