// Stage 4 NetworkManager: Colyseus FFA room ("arena") over guest nick +
// Play press, no auth. Inputs-only upstream at 20 ticks/s (throttled by the
// caller in main.ts), delta-patch snapshots downstream. Late join works till
// round end — the room accepts joins in any phase; this manager can connect
// at any time and picks up the current phase from the first snapshot.

import { Client, Room } from "colyseus.js";
import { ROOM_NAME } from "../config";
import {
  buildFirePayload,
  normalizeNick,
  ownerColorForSession,
  roundPhaseFromString,
  type FirePayload,
  type InputPayload,
  type NetBallSnapshot,
  type NetPlayerSnapshot,
  type NetSuperSnapshot,
  type RoundPhase,
} from "./protocol";

export interface RoomSnapshot {
  phase: RoundPhase;
  tick: number;
  countdownMs: number;
  remainingMs: number;
  winner: string;
  players: NetPlayerSnapshot[];
  balls: NetBallSnapshot[];
  super: NetSuperSnapshot | null;
}

export interface WelcomeSpawn {
  x: number;
  z: number;
}

export interface NetworkEvents {
  onSnapshot(snapshot: RoomSnapshot): void;
  onWelcome(sessionId: string, nick: string, spawn: WelcomeSpawn | null): void;
  onSpectator(sessionId: string): void;
  onRoomFull(message: string): void;
  onKillfeed(message: string): void;
  onLeave(): void;
  onError(message: string): void;
}

function toNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function toString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function toBoolean(value: unknown): boolean {
  return value === true;
}

// R1 compat: snapshots predating ready/spectator (or partial patches)
// decode as ready fighters so old states keep rendering.
function toBooleanWithDefault(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

interface WirePlayer {
  sessionId?: unknown;
  nick?: unknown;
  x?: unknown;
  y?: unknown;
  z?: unknown;
  rotY?: unknown;
  hp?: unknown;
  score?: unknown;
  alive?: unknown;
  isBot?: unknown;
  ready?: unknown;
  spectator?: unknown;
  superBuff?: unknown;
  reloadUntil?: unknown;
}

interface WirePlayers {
  forEach(callback: (value: WirePlayer, key: string) => void): void;
}

interface WireBall {
  ballId?: unknown;
  ownerId?: unknown;
  x?: unknown;
  y?: unknown;
  z?: unknown;
  power01?: unknown;
  super?: unknown;
}

interface WireBalls {
  forEach(callback: (value: WireBall, key: string) => void): void;
}

interface WireState {
  phase?: unknown;
  tick?: unknown;
  countdownMs?: unknown;
  remainingMs?: unknown;
  winner?: unknown;
  players?: WirePlayers | undefined;
  balls?: WireBalls | undefined;
  superActive?: unknown;
  superX?: unknown;
  superZ?: unknown;
  superExpiresAt?: unknown;
  superNextAt?: unknown;
}

// Structural decode of the replicated ArenaState (no schema import on the
// client; tolerant to missing fields so late-join partial states never crash).
// R2: balls + super decode with compat defaults (missing = no balls, no core).
// Ball color is derived from ownerId here (owner orange when self, palette
// hash otherwise) so the render pool tints every core by its thrower.
export function decodeSnapshot(state: unknown, selfId: string | null = null): RoomSnapshot {
  const wire = (typeof state === "object" && state !== null ? state : {}) as WireState;
  const players: NetPlayerSnapshot[] = [];
  try {
    wire.players?.forEach((player: WirePlayer, key: string): void => {
      players.push({
        sessionId: toString(player.sessionId, key),
        nick: toString(player.nick, key),
        x: toNumber(player.x, 0),
        y: toNumber(player.y, 1.1),
        z: toNumber(player.z, 0),
        rotY: toNumber(player.rotY, 0),
        hp: toNumber(player.hp, 100),
        score: toNumber(player.score, 0),
        alive: toBoolean(player.alive),
        isBot: toBoolean(player.isBot),
        ready: toBooleanWithDefault(player.ready, true),
        spectator: toBooleanWithDefault(player.spectator, false),
        superBuff: toBoolean(player.superBuff),
        reloadUntil: toNumber(player.reloadUntil, 0),
      });
    });
  } catch {
    // A malformed patch must never kill the render loop; partial data stands.
  }
  const balls: NetBallSnapshot[] = [];
  try {
    wire.balls?.forEach((ball: WireBall, key: string): void => {
      const ownerId = toString(ball.ownerId, "");
      balls.push({
        ballId: toString(ball.ballId, key),
        ownerId,
        x: toNumber(ball.x, 0),
        y: toNumber(ball.y, 1.4),
        z: toNumber(ball.z, 0),
        power01: toNumber(ball.power01, 0.5),
        super: toBoolean(ball.super),
        color: ownerColorForSession(ownerId, selfId),
      });
    });
  } catch {
    // Partial ball patches never kill the render loop.
  }
  const superActive = toBoolean(wire.superActive);
  const superSnapshot: NetSuperSnapshot | null = superActive
    ? {
        active: true,
        x: toNumber(wire.superX, 0),
        z: toNumber(wire.superZ, 0),
        expiresAt: toNumber(wire.superExpiresAt, 0),
        nextAt: toNumber(wire.superNextAt, 0),
      }
    : null;
  return {
    phase: roundPhaseFromString(wire.phase),
    tick: toNumber(wire.tick, 0),
    countdownMs: toNumber(wire.countdownMs, 0),
    remainingMs: toNumber(wire.remainingMs, 0),
    winner: toString(wire.winner, ""),
    players,
    balls,
    super: superSnapshot,
  };
}

export class NetworkManager {
  private readonly serverUrl: string;
  private readonly events: NetworkEvents;
  private room: Room | null = null;
  private sessionId: string | null = null;
  private disposed = false;

  public constructor(serverUrl: string, events: NetworkEvents) {
    this.serverUrl = serverUrl;
    this.events = events;
  }

  public get isConnected(): boolean {
    return this.room !== null;
  }

  public get ownSessionId(): string | null {
    return this.sessionId;
  }

  // Join (or create) the arena room with a guest nick. Resolves once the
  // server confirms the join; rejects with a human-readable error otherwise.
  public async connect(rawNick: string): Promise<void> {
    if (this.room !== null) {
      return;
    }
    const nick = normalizeNick(rawNick);
    const client = new Client(this.serverUrl);
    let room: Room;
    try {
      room = await client.joinOrCreate<RoomSnapshot>(ROOM_NAME, { nick });
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : "join failed");
    }
    if (this.disposed) {
      await room.leave();
      return;
    }
    this.room = room;
    this.sessionId = room.sessionId;
    room.onStateChange((state: unknown): void => {
      this.events.onSnapshot(decodeSnapshot(state, this.sessionId));
    });
    room.onMessage("welcome", (payload: unknown): void => {
      const body = (typeof payload === "object" && payload !== null ? payload : {}) as {
        sessionId?: unknown;
        nick?: unknown;
        x?: unknown;
        z?: unknown;
      };
      const rawX = body.x;
      const rawZ = body.z;
      const spawn: WelcomeSpawn | null =
        typeof rawX === "number" && Number.isFinite(rawX) && typeof rawZ === "number" && Number.isFinite(rawZ)
          ? { x: rawX, z: rawZ }
          : null;
      this.events.onWelcome(toString(body.sessionId, ""), toString(body.nick, nick), spawn);
    });
    room.onMessage("spectator", (payload: unknown): void => {
      const body = (typeof payload === "object" && payload !== null ? payload : {}) as {
        sessionId?: unknown;
      };
      this.events.onSpectator(toString(body.sessionId, this.sessionId ?? ""));
    });
    room.onMessage("room-full", (payload: unknown): void => {
      const body = (typeof payload === "object" && payload !== null ? payload : {}) as {
        reason?: unknown;
      };
      const reason = toString(body.reason, "Room is full");
      if (reason !== "") {
        this.events.onRoomFull(reason);
      } else {
        this.events.onRoomFull("Room is full");
      }
    });
    room.onMessage("killfeed", (payload: unknown): void => {
      const body = (typeof payload === "object" && payload !== null ? payload : {}) as {
        message?: unknown;
      };
      const message = toString(body.message, "");
      if (message !== "") {
        this.events.onKillfeed(message);
      }
    });
    room.onLeave((): void => {
      this.room = null;
      this.sessionId = null;
      this.events.onLeave();
    });
    room.onError((_code: number, message?: string): void => {
      this.events.onError(message ? message : "room error");
    });
  }

  public sendInput(payload: InputPayload): void {
    if (this.room === null) {
      return;
    }
    try {
      this.room.send("input", {
        x: payload.x,
        y: payload.y,
        rotY: payload.rotY,
        seq: payload.seq,
        charging: payload.charging === true,
      });
    } catch {
      // Transient send failures (reconnect race) are dropped: the next
      // 20Hz tick carries fresher input anyway.
    }
  }

  // R1 Play: spectator asks the server to enter the arena with a nick.
  // The server validates/dedupes and replies with "welcome" on success.
  public sendPlay(nick: string): void {
    if (this.room === null) {
      return;
    }
    try {
      this.room.send("play", { nick });
    } catch {
      // Transient send failures (reconnect race) are dropped: the user can
      // press Play again; no state is corrupted by a lost play message.
    }
  }

  // Hand-ball throw: release-to-fire with charge power + aim + SUPER flag +
  // thrower body-center y (torso-height spawn on any elevation).
  // The server validates phase/reload and consumes the buff even on a miss.
  public sendFire(payload: FirePayload): void {
    if (this.room === null) {
      return;
    }
    try {
      const body = buildFirePayload(payload.power01, payload.yaw, payload.pitch, payload.super, payload.throwerY);
      this.room.send("fire", body);
    } catch {
      // Same drop-on-race policy as inputs.
    }
  }

  public async disconnect(): Promise<void> {
    this.disposed = true;
    const room = this.room;
    this.room = null;
    this.sessionId = null;
    if (room !== null) {
      try {
        await room.leave();
      } catch {
        // Leave is best-effort during page teardown.
      }
    }
  }
}
