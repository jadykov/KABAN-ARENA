import { SUPER_BONUS_SLOT_MS, isSuperBonusKind, type SuperBonusKind } from "../../../shared/super-bonuses.mjs";
import type { NetPlayerSnapshot } from "./protocol";

// Local mirror of authoritative timers. It never awards items or changes HP.
export class BonusControlState {
  private sessionId = "";
  private launchSeq = 0;
  private active = false;
  private kind: SuperBonusKind | "" = "";
  private superUntil = 0;
  private frozenUntil = 0;
  private turkeyUntil = 0;
  private launchBaseline = false;

  public get needsLaunchBaseline(): boolean { return this.launchBaseline; }

  public sync(player: NetPlayerSnapshot | null, serverNow: number): number {
    if (player === null) {
      this.reset();
      return 0;
    }
    const newSession = this.sessionId !== player.sessionId;
    const sequence = Math.max(0, Math.floor(player.launchSeq ?? 0));
    this.launchBaseline = (newSession || !this.active) && player.alive && sequence > 0;
    const launch = !newSession && this.active && player.alive && sequence > this.launchSeq
      ? Math.max(0, player.launchVelocity ?? 0) : 0;
    this.sessionId = player.sessionId;
    this.launchSeq = !newSession && this.active && player.alive ? Math.max(this.launchSeq, sequence) : sequence;
    this.active = player.alive && player.ready && !player.spectator;
    if (!this.active) {
      this.clearEffects();
      return 0;
    }
    this.superUntil = Math.max(0, player.superUntil ?? 0);
    this.kind = isSuperBonusKind(player.superKind) && this.superUntil > serverNow ? player.superKind : "";
    this.frozenUntil = Math.max(0, player.frozenUntil ?? 0);
    this.turkeyUntil = Math.max(0, player.turkeyUntil ?? 0);
    return launch;
  }

  public heldKind(now: number): SuperBonusKind | "" { return this.superUntil > now ? this.kind : ""; }
  public heldRemaining(now: number): number {
    return this.heldKind(now) === "" ? 0 : Math.min(SUPER_BONUS_SLOT_MS / 1000, Math.max(0, this.superUntil - now) / 1000);
  }
  public isFrozen(now: number): boolean { return this.active && this.frozenUntil > now; }
  public hasTurkeyMask(now: number): boolean { return this.active && this.turkeyUntil > now; }
  public consumeHeld(): void { this.kind = ""; this.superUntil = 0; }
  public reset(): void {
    this.sessionId = "";
    this.launchSeq = 0;
    this.active = false;
    this.launchBaseline = false;
    this.clearEffects();
  }
  private clearEffects(): void {
    this.kind = "";
    this.superUntil = 0;
    this.frozenUntil = 0;
    this.turkeyUntil = 0;
  }
}
