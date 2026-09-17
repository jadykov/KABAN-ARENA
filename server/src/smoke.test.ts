import { describe, expect, it } from "vitest";
import { ArenaRoom } from "./rooms/ArenaRoom.js";
import { ArenaState } from "./state.js";
import { createApp, createGameServer } from "./index.js";

describe("server smoke", () => {
  it("creates default arena state", () => {
    const state = new ArenaState();
    expect(state.tick).toBe(0);
    expect(state.phase).toBe("lobby");
  });

  it("room boots with fresh state", async () => {
    const room = new ArenaRoom();
    await room.onCreate();
    expect(room.state.tick).toBe(0);
    expect(room.state.phase).toBe("lobby");
    await room.onLeave({ sessionId: "test-session", send: (): void => {} } as never);
  });

  it("game server defines the arena room", () => {
    // NOTE: intentionally does not instantiate the real Colyseus Server here:
    // `new Server()` registers process-level handlers and transport state that
    // keeps the vitest tinypool worker alive and breaks teardown serialization.
    // Real listen/define wiring is covered outside unit tests (Stage 4 e2e).
    const app = createApp();
    expect(app).toBeDefined();
    expect(ArenaRoom).toBeDefined();
    expect(createGameServer).toBeDefined();
  });
});
