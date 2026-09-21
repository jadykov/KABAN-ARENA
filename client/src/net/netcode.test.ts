// Stage 4 netcode unit tests: wire-protocol helpers (nick, input clamp,
// hearts mapping, hitscan target pick) + interpolation math (lerp, angle
// wrap, smoothing, RemoteTrack snap/ease). NetworkManager socket I/O is
// covered by server room tests + live playtest, not unit mocks.

import { describe, expect, it } from "vitest";
import { BALL_FIRST_TICK_HOLD_S, GUEST_NICK_PREFIX, HIT_DAMAGE, MAX_HEARTS, TRAJ_PREVIEW_DT_S } from "../config";
import { expSmoothFactor, lerp, lerpAngle, RemoteTrack } from "./interpolation";
import { decodeSnapshot } from "./NetworkManager";
import {
  buildFirePayload,
  buildGuestNick,
  buildInputPayload,
  clampMoveInput,
  countFighters,
  countSpectators,
  formatCounters,
  heartsForHp,
  normalizeNick,
  normalizePlayNick,
  pickHitTarget,
  previewTimeAt,
  roundPhaseFromString,
  worldMoveFromYaw,
  type NetPlayerSnapshot,
} from "./protocol";

describe("guest nick normalization (no auth)", () => {
  it("trims and keeps valid nicks", () => {
    expect(normalizeNick("  Bo  ")).toBe("Bo");
    expect(normalizeNick("Kaban42")).toBe("Kaban42");
  });

  it("falls back for blank/short/non-string input", () => {
    expect(normalizeNick("")).toBe("Kaban");
    expect(normalizeNick("A")).toBe("Kaban");
    expect(normalizeNick(12345)).toBe("Kaban");
    expect(normalizeNick(undefined)).toBe("Kaban");
  });

  it("caps at 16 chars", () => {
    expect(normalizeNick("x".repeat(40))).toHaveLength(16);
  });
});

describe("input payload (inputs-only 20 ticks/s)", () => {
  it("clamps axes and normalizes overlong vectors", () => {
    const clamped = clampMoveInput(2, 0);
    expect(clamped.x).toBe(1);
    const diagonal = clampMoveInput(1, 1);
    expect(Math.hypot(diagonal.x, diagonal.y)).toBeCloseTo(1);
    expect(clampMoveInput(Number.NaN, 0)).toEqual({ x: 0, y: 0 });
  });

  it("builds a sequenced payload with sane fallbacks", () => {
    const payload = buildInputPayload(0.5, -0.5, 1.2, 7);
    expect(payload).toEqual({ x: 0.5, y: -0.5, rotY: 1.2, seq: 7, charging: false });
    const bad = buildInputPayload(0, 0, Number.NaN, Number.NaN);
    expect(bad.rotY).toBe(0);
    expect(bad.seq).toBe(0);
  });
});

describe("fire payload (throwerY torso-height optionality)", () => {
  it("carries finite throwerY, omits non-finite (server derives instead)", () => {
    const withY = buildFirePayload(1, 0.4, 0.2, false, 3.7);
    expect(withY.throwerY).toBeCloseTo(3.7, 10);
    expect(withY.power01).toBe(1);
    expect("throwerY" in buildFirePayload(1, 0.4, 0.2, false, Number.NaN)).toBe(false);
    expect("throwerY" in buildFirePayload(1, 0.4, 0.2, false, null)).toBe(false);
    expect("throwerY" in buildFirePayload(1, 0.4, 0.2, false)).toBe(false);
  });
});

describe("damage hearts mapping (hitscan A: 100HP/25dmg = 4 hearts)", () => {
  it("loses exactly one heart per 25dmg hit", () => {
    expect(heartsForHp(100)).toBe(4);
    expect(heartsForHp(100 - HIT_DAMAGE)).toBe(3);
    expect(heartsForHp(50)).toBe(2);
    expect(heartsForHp(25)).toBe(1);
    expect(heartsForHp(0)).toBe(0);
  });

  it("clamps out-of-range HP", () => {
    expect(heartsForHp(1000)).toBe(MAX_HEARTS);
    expect(heartsForHp(-5)).toBe(0);
    expect(heartsForHp(Number.NaN)).toBe(0);
  });
});

describe("client hitscan target pick", () => {
  const candidates = [
    { sessionId: "self", x: 0, z: 0, alive: true },
    { sessionId: "near", x: 3, z: 0, alive: true },
    { sessionId: "far", x: 60, z: 0, alive: true },
    { sessionId: "dead", x: 1, z: 0, alive: false },
  ];

  it("picks the nearest living enemy in range", () => {
    expect(pickHitTarget("self", 0, 0, candidates)).toBe("near");
  });

  it("holds fire when nobody is in range", () => {
    expect(pickHitTarget("self", 0, 0, [candidates[2]!])).toBe(null);
  });

  it("never targets self or the dead", () => {
    expect(pickHitTarget("self", 0, 0, [candidates[0]!, candidates[3]!])).toBe(null);
  });
});

describe("round phase parsing", () => {
  it("accepts known phases, defaults to lobby", () => {
    expect(roundPhaseFromString("playing")).toBe("playing");
    expect(roundPhaseFromString("countdown")).toBe("countdown");
    expect(roundPhaseFromString("ended")).toBe("ended");
    expect(roundPhaseFromString("bogus")).toBe("lobby");
    expect(roundPhaseFromString(undefined)).toBe("lobby");
  });
});

describe("preview time base (first-tick hold offset, bug 2 secondary)", () => {
  it("starts at one server tick and steps by the preview dt", () => {
    // The server holds newborn balls one patch tick (50ms) at the muzzle,
    // so dot i samples HOLD + i*DT instead of i*DT.
    expect(BALL_FIRST_TICK_HOLD_S).toBe(0.05);
    expect(previewTimeAt(0)).toBeCloseTo(BALL_FIRST_TICK_HOLD_S, 10);
    expect(previewTimeAt(1) - previewTimeAt(0)).toBeCloseTo(TRAJ_PREVIEW_DT_S, 10);
    expect(previewTimeAt(5)).toBeCloseTo(BALL_FIRST_TICK_HOLD_S + 5 * TRAJ_PREVIEW_DT_S, 10);
  });

  it("floors garbage indexes to the hold instead of NaN", () => {
    expect(previewTimeAt(-3)).toBeCloseTo(BALL_FIRST_TICK_HOLD_S, 10);
    expect(previewTimeAt(Number.NaN)).toBeCloseTo(BALL_FIRST_TICK_HOLD_S, 10);
  });
});

describe("snapshot decoding (tolerant late-join states)", () => {
  it("decodes a full state", () => {
    const players = new Map([
      ["s1", { sessionId: "s1", nick: "A", x: 1, y: 1.1, z: 2, rotY: 0.5, hp: 75, score: 3, alive: true, isBot: false }],
    ]);
    const snapshot = decodeSnapshot({
      phase: "playing",
      tick: 42,
      countdownMs: 0,
      remainingMs: 170000,
      winner: "",
      players: { forEach: (cb: (v: unknown, k: string) => void): void => players.forEach((v, k) => cb(v, k)) },
    });
    expect(snapshot.phase).toBe("playing");
    expect(snapshot.tick).toBe(42);
    expect(snapshot.players).toHaveLength(1);
    expect(snapshot.players[0]?.nick).toBe("A");
    expect(snapshot.players[0]?.hp).toBe(75);
  });

  it("survives empty/malformed states", () => {
    expect(decodeSnapshot(null).phase).toBe("lobby");
    expect(decodeSnapshot(undefined).players).toEqual([]);
    expect(decodeSnapshot({}).remainingMs).toBe(0);
  });

  it("defaults missing ready/spectator to ready fighter (compat)", () => {
    const players = new Map([
      ["s1", { sessionId: "s1", nick: "A", x: 0, y: 1.1, z: 0, rotY: 0, hp: 100, score: 0, alive: true, isBot: false }],
    ]);
    const snapshot = decodeSnapshot({
      phase: "playing",
      tick: 1,
      countdownMs: 0,
      remainingMs: 1000,
      winner: "",
      players: { forEach: (cb: (v: unknown, k: string) => void): void => players.forEach((v, k) => cb(v, k)) },
    });
    expect(snapshot.players[0]?.ready).toBe(true);
    expect(snapshot.players[0]?.spectator).toBe(false);
  });

  it("preserves explicit spectator flags", () => {
    const players = new Map([
      [
        "s2",
        {
          sessionId: "s2",
          nick: "Watcher",
          x: 0,
          y: 1.1,
          z: 0,
          rotY: 0,
          hp: 100,
          score: 0,
          alive: false,
          isBot: false,
          ready: false,
          spectator: true,
        },
      ],
    ]);
    const snapshot = decodeSnapshot({
      phase: "lobby",
      tick: 2,
      countdownMs: 0,
      remainingMs: 0,
      winner: "",
      players: { forEach: (cb: (v: unknown, k: string) => void): void => players.forEach((v, k) => cb(v, k)) },
    });
    expect(snapshot.players[0]?.ready).toBe(false);
    expect(snapshot.players[0]?.spectator).toBe(true);
  });
});

describe("R1 play nick (empty -> Guest-XXXX)", () => {
  it("keeps a trimmed nick", () => {
    expect(normalizePlayNick("  Bo  ")).toBe("Bo");
  });

  it("falls back to a Guest nick when blank", () => {
    const nick = normalizePlayNick("   ");
    expect(nick.startsWith(`${GUEST_NICK_PREFIX}-`)).toBe(true);
  });

  it("builds Guest nicks with the configured prefix", () => {
    const nick = buildGuestNick();
    expect(nick.startsWith(`${GUEST_NICK_PREFIX}-`)).toBe(true);
    expect(nick.length).toBeGreaterThan(GUEST_NICK_PREFIX.length + 1);
  });
});

describe("R1 lobby counters (Players N | Watching M)", () => {
  function makePlayer(overrides: Partial<NetPlayerSnapshot> & { sessionId: string }): NetPlayerSnapshot {
    return {
      nick: overrides.sessionId,
      x: 0,
      y: 1.1,
      z: 0,
      rotY: 0,
      hp: 100,
      score: 0,
      alive: true,
      isBot: false,
      ready: true,
      spectator: false,
      superBuff: false,
      reloadUntil: 0,
      ...overrides,
      sessionId: overrides.sessionId,
    };
  }

  it("counts only ready fighters as players", () => {
    const players = [
      makePlayer({ sessionId: "f1" }),
      makePlayer({ sessionId: "f2" }),
      makePlayer({ sessionId: "w1", ready: false, spectator: true, alive: false }),
      makePlayer({ sessionId: "w2", ready: false, spectator: true, alive: false }),
    ];
    expect(countFighters(players)).toBe(2);
    expect(countSpectators(players)).toBe(2);
    expect(formatCounters(players)).toBe("Players: 2 | Watching: 2");
  });

  it("treats not-ready entries as watchers even without the spectator flag", () => {
    const players = [makePlayer({ sessionId: "w3", ready: false, spectator: false, alive: false })];
    expect(countFighters(players)).toBe(0);
    expect(countSpectators(players)).toBe(1);
  });
});

describe("world-space move transform (shared client/server formula)", () => {
  it("is identity at yaw 0 for forward (forward = -Z)", () => {
    // yaw 0: forward = (0, -1) in (x, z). Full forward -> world (0, -1).
    const world = worldMoveFromYaw(0, 1, 0);
    expect(world.x).toBeCloseTo(0, 10);
    expect(world.y).toBeCloseTo(-1, 10);
  });

  it("rotates strafe-right to world +X at yaw 0", () => {
    const world = worldMoveFromYaw(1, 0, 0);
    expect(world.x).toBeCloseTo(1, 10);
    expect(world.y).toBeCloseTo(0, 10);
  });

  it("matches the SceneManager camera-relative formula at 90deg yaw", () => {
    // SceneManager.update: forward = (-sin(yaw), -cos(yaw)),
    // right = (-forward.z, forward.x). yaw = PI/2: forward = (-1, 0),
    // right = (0, -1). Full forward must give world (-1, 0).
    const yaw = Math.PI / 2;
    const world = worldMoveFromYaw(0, 1, yaw);
    expect(world.x).toBeCloseTo(-1, 10);
    expect(world.y).toBeCloseTo(0, 10);
    const strafe = worldMoveFromYaw(1, 0, yaw);
    expect(strafe.x).toBeCloseTo(0, 10);
    expect(strafe.y).toBeCloseTo(-1, 10);
  });

  it("preserves vector length (pure rotation) and clamps overlong input", () => {
    const diagonal = worldMoveFromYaw(1, 1, 0.7);
    expect(Math.hypot(diagonal.x, diagonal.y)).toBeCloseTo(1, 10);
    expect(worldMoveFromYaw(Number.NaN, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(worldMoveFromYaw(0, 0, Number.NaN).x).toBeCloseTo(0, 10);
  });
});

describe("interpolation math (lerp/slerp at 20Hz patches)", () => {
  it("lerps positions", () => {
    expect(lerp(0, 10, 0.5)).toBe(5);
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(0, 10, 1)).toBe(10);
  });

  it("takes the shortest arc across +/-PI", () => {
    // From +170deg to -170deg the short way is +20deg, not -340deg.
    const from = (170 * Math.PI) / 180;
    const to = (-170 * Math.PI) / 180;
    const mid = lerpAngle(from, to, 0.5);
    expect(Math.abs(mid)).toBeGreaterThan(Math.PI - 0.2);
  });

  it("smoothing factor grows with dt and stays in [0,1]", () => {
    const small = expSmoothFactor(1 / 60);
    const large = expSmoothFactor(1);
    expect(small).toBeGreaterThan(0);
    expect(large).toBeGreaterThan(small);
    expect(large).toBeLessThanOrEqual(1);
    expect(expSmoothFactor(0)).toBe(0);
    expect(expSmoothFactor(-1)).toBe(0);
  });
});

describe("RemoteTrack (snap on sight/teleport, ease otherwise)", () => {
  it("snaps the first update", () => {
    const track = new RemoteTrack();
    expect(track.isInitialized).toBe(false);
    track.update({ x: 5, y: 1.1, z: -3, rotY: 1 }, 1 / 60);
    expect(track.x).toBe(5);
    expect(track.z).toBe(-3);
    expect(track.isInitialized).toBe(true);
  });

  it("eases toward small moves instead of snapping", () => {
    const track = new RemoteTrack(0, 1.1, 0, 0);
    track.snap({ x: 0, y: 1.1, z: 0, rotY: 0 });
    track.update({ x: 1, y: 1.1, z: 0, rotY: 0 }, 1 / 60);
    expect(track.x).toBeGreaterThan(0);
    expect(track.x).toBeLessThan(1);
  });

  it("snaps teleports/respawns over the guard distance", () => {
    const track = new RemoteTrack(0, 1.1, 0, 0);
    track.snap({ x: 0, y: 1.1, z: 0, rotY: 0 });
    track.update({ x: 12, y: 1.1, z: 0, rotY: 0 }, 1 / 60);
    expect(track.x).toBe(12);
  });

  it("converges to a stationary target over a second", () => {
    const track = new RemoteTrack(0, 1.1, 0, 0);
    track.snap({ x: 0, y: 1.1, z: 0, rotY: 0 });
    const target = { x: 2, y: 1.1, z: 0, rotY: 0 };
    for (let i = 0; i < 60; i += 1) {
      track.update(target, 1 / 60);
    }
    expect(track.x).toBeCloseTo(2, 1);
  });
});
