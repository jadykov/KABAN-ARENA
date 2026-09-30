import { INPUT_SEND_INTERVAL_S } from "../config";

// Repeated fractional frame durations can land a few floating-point bits
// below a send boundary. One nanosecond of tolerance prevents a whole frame
// of drift without changing the 20 Hz input cadence.
const INPUT_SEND_EPSILON_S = 1e-9;

// Input sampling stays on the render callback and always sends the newest
// controls. Preserve the partial interval at 30/60/90 Hz; discard missed
// intervals after a stall instead of sending old controls in a catch-up loop.
export class InputSendScheduler {
  private elapsedSeconds = 0;

  public advance(deltaSeconds: number): boolean {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return false;
    this.elapsedSeconds += deltaSeconds;
    if (this.elapsedSeconds + INPUT_SEND_EPSILON_S < INPUT_SEND_INTERVAL_S) return false;

    const remainder = this.elapsedSeconds % INPUT_SEND_INTERVAL_S;
    this.elapsedSeconds = remainder <= INPUT_SEND_EPSILON_S
      || INPUT_SEND_INTERVAL_S - remainder <= INPUT_SEND_EPSILON_S ? 0 : remainder;
    return true;
  }

  public reset(): void {
    this.elapsedSeconds = 0;
  }
}
