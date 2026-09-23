import { createRequire } from "node:module";

// @colyseus/schema ships dual ESM/CJS builds, each with its own symbol
// identity ($changes, $childType, ...). Colyseus core is CJS and encodes
// via require() -> build/cjs, while an ESM `import` resolves to
// build/esm: state built on the ESM copy crashes the live CJS Encoder in
// `setState` with `setRoot of undefined` (both tsx-dev and node dist are
// affected; only vitest unifies the instances, which is why unit tests
// stayed green). Load the CJS copy so our state shares the exact
// class/symbol identity the live serializer uses.
const requireSchema = createRequire(import.meta.url);
const schemaCjs = requireSchema("@colyseus/schema") as typeof import("@colyseus/schema");
const { MapSchema, Schema, type } = schemaCjs;

// Minimal @type state (positions, rotations, health, active states).
// Patches replicate at PATCH_RATE_MS (20/s); clients interpolate.
// R1 pre-join spectator: newcomers join as spectators (ready=false,
// spectator=true, alive=false) and only enter the arena on "play".
// R2 cannon: superBuff marks x2 NEXT shot, reloadUntil gates charging.
export class PlayerState extends Schema {
  @type("string") sessionId = "";
  @type("string") nick = "";
  @type("number") x = 0;
  @type("number") y = 1.1;
  @type("number") z = 0;
  @type("number") rotY = 0;
  @type("number") hp = 100;
  @type("number") score = 0;
  @type("boolean") alive = false;
  @type("boolean") isBot = false;
  @type("number") invulnUntil = 0;
  @type("boolean") ready = false;
  @type("boolean") spectator = true;
  @type("boolean") superBuff = false;
  @type("number") reloadUntil = 0;
}

// R2 cannonball: authoritative parabolic projectile (gravity arc, collides,
// impact despawn). Replicated minimally for client render (pos + flags).
// Stage 4d.4: ricochet marks a bounced ball (never damages again), resting
// marks a settled decorative core (no movement, no damage), rolling marks a
// ground roll with inertia (friction-damped planar motion, client spins the
// mesh; rolling is a post-ricochet state: no damage, no knockback, no
// broadcast). settleMs/restY are server-only (plain fields, never
// replicated): ms spent sliding on the rest surface + the pinned surface
// height (surfaceTop + BALL_RADIUS).
export class BallState extends Schema {
  @type("string") ballId = "";
  @type("string") ownerId = "";
  @type("number") x = 0;
  @type("number") y = 1.4;
  @type("number") z = 0;
  @type("number") vx = 0;
  @type("number") vy = 0;
  @type("number") vz = 0;
  @type("number") power01 = 0.5;
  @type("boolean") super = false;
  @type("number") ageMs = 0;
  @type("number") distM = 0;
  @type("boolean") ricochet = false;
  @type("boolean") resting = false;
  @type("boolean") rolling = false;
  public settleMs = 0;
  public restY = 0;
}

export type RoundPhase = "lobby" | "countdown" | "playing" | "ended";

export class ArenaState extends Schema {
  @type("number") tick = 0;
  @type("string") phase: string = "lobby";
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
  @type({ map: BallState }) balls = new MapSchema<BallState>();
  @type("number") countdownMs = 0;
  @type("number") remainingMs = 0;
  @type("string") winner = "";
  // Super-core lifecycle: active pickup at (superX, superZ), expires at
  // superExpiresAt; next spawn at superNextAt.
  // Future center items (NOT implemented): "pineapple" (radius AoE on throw)
  // and "heal" (+1 heart on pickup) plug in as sibling field groups here
  // (active/x/z/expiresAt/nextAt per kind) driven by tickCenterItems() in
  // ArenaRoom — keep super fields untouched when adding them.
  // TODO(pineapple): pineappleActive/pineappleX/pineappleZ/...
  // TODO(heal): healActive/healX/healZ/...
  @type("boolean") superActive = false;
  @type("number") superX = 0;
  @type("number") superZ = 0;
  @type("number") superExpiresAt = 0;
  @type("number") superNextAt = 0;
}
