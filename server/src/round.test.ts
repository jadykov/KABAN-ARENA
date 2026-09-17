import { describe, expect, it } from "vitest";
import { LOBBY_COUNTDOWN_MS, REMATCH_DELAY_MS, ROUND_DURATION_MS, ROUND_HARD_CAP_MS } from "./config.js";
import { getSpawnForIndex, sanitizeNick } from "./hits.js";
import { createBrain, pickBotTarget, pseudoRandom, stepBot } from "./bots.js";
import { PlayerState } from "./state.js";

describe("round loop C2 timings 3/3/2", () => {
  it("lobby countdown is 3s and round is 3min with hard cap under 5min", () => {
    expect(LOBBY_COUNTDOWN_MS).toBe(3000);
    expect(ROUND_DURATION_MS).toBe(180000);
    expect(ROUND_HARD_CAP_MS).toBeLessThan(5 * 60 * 1000);
    expect(REMATCH_DELAY_MS).toBeGreaterThan(0);
  });

  it("nick validation enforces 2-16 chars and dedupes", () => {
    expect(sanitizeNick("A", new Set())).toBe("Kaban");
    expect(sanitizeNick("  Bo  ", new Set())).toBe("Bo");
    expect(sanitizeNick("x".repeat(40), new Set())).toHaveLength(16);
    expect(sanitizeNick("Bo", new Set(["Bo"]))).not.toBe("Bo");
    expect(sanitizeNick(12345, new Set())).toBe("Kaban");
  });

  it("six spawn points exist for 2-6 player rooms (inside HALF 16.8)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 6; i += 1) {
      const spawn = getSpawnForIndex(i);
      expect(Math.abs(spawn.x)).toBeLessThanOrEqual(16.8);
      expect(Math.abs(spawn.z)).toBeLessThanOrEqual(16.8);
      seen.add(`${spawn.x},${spawn.z}`);
    }
    expect(seen.size).toBe(6);
  });
});

describe("weak bots (server-side simple AI)", () => {
  function makeBot(sessionId: string, x: number, z: number): PlayerState {
    const bot = new PlayerState();
    bot.sessionId = sessionId;
    bot.x = x;
    bot.z = z;
    bot.alive = true;
    bot.isBot = true;
    // R1: bots are always ready fighters, never spectators.
    bot.ready = true;
    bot.spectator = false;
    return bot;
  }

  it("PRNG is deterministic for stable tests", () => {
    expect(pseudoRandom(42)).toBe(pseudoRandom(42));
  });

  it("bot steps toward its wander target with a normalized vector", () => {
    const bot = makeBot("bot-1", 0, 0);
    const brain = createBrain(0, 7);
    const step = stepBot(bot, brain, 0);
    expect(Math.hypot(step.moveX, step.moveZ)).toBeCloseTo(1);
  });

  it("bot holds fire out of range, fires at nearest enemy in range", () => {
    const bot = makeBot("bot-1", 0, 0);
    const far = makeBot("enemy-far", 60, 0);
    far.isBot = false;
    const near = makeBot("enemy-near", 3, 0);
    near.isBot = false;
    const brain = createBrain(0, 7);
    // Only the far enemy: hold fire.
    expect(pickBotTarget(bot, [bot, far], brain, 100000)).toBe(null);
    // Nearest in-range enemy after the interval: fire.
    const targetId = pickBotTarget(bot, [bot, far, near], brain, 100000);
    expect(targetId).toBe("enemy-near");
    // Interval gates the next shot.
    expect(pickBotTarget(bot, [bot, near], brain, 100001)).toBe(null);
  });
});
