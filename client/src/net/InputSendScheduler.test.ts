import { describe, expect, it } from "vitest";
import { INPUT_SEND_INTERVAL_S } from "../config";
import { InputSendScheduler } from "./InputSendScheduler";

describe("InputSendScheduler render-independent input cadence", () => {
  it.each([30, 60, 90])("sends 1200 inputs during 60 seconds at %i rendered FPS", (fps) => {
    const scheduler = new InputSendScheduler();
    const sendFrames: number[] = [];
    for (let frame = 1; frame <= fps * 60; frame += 1) {
      if (scheduler.advance(1 / fps)) sendFrames.push(frame);
    }
    expect(INPUT_SEND_INTERVAL_S).toBe(0.05);
    expect(sendFrames).toHaveLength(1200);
    expect(new Set(sendFrames).size).toBe(sendFrames.length);
    // A send remains within one rendered frame of each 50 ms sampling
    // boundary. Losing residual time would drift at 30 and 90 FPS.
    sendFrames.forEach((frame, index) => {
      const delay = frame / fps - (index + 1) * INPUT_SEND_INTERVAL_S;
      expect(delay).toBeGreaterThanOrEqual(-1e-9);
      expect(delay).toBeLessThan(1 / fps + 1e-9);
    });
  });

  it("keeps cadence when quality switches between 60, 30 and 90 FPS", () => {
    const scheduler = new InputSendScheduler();
    let packets = 0;
    // Switch at fractional send intervals to exercise the preserved phase.
    for (const [fps, frames] of [[60, 1201], [30, 600], [90, 1798.5]] as const) {
      const wholeFrames = Math.floor(frames);
      for (let frame = 0; frame < wholeFrames; frame += 1) {
        if (scheduler.advance(1 / fps)) packets += 1;
      }
      const fraction = frames - wholeFrames;
      if (fraction > 0 && scheduler.advance(fraction / fps)) packets += 1;
    }
    expect(packets).toBe(1200); // Exactly 60 elapsed seconds.
  });

  it("drops missed intervals after a stall and never sends a backlog on later frames", () => {
    const scheduler = new InputSendScheduler();
    expect(scheduler.advance(0.04)).toBe(false);
    expect(scheduler.advance(10.01)).toBe(true); // One newest input, 201 intervals elapsed.
    expect(scheduler.advance(0)).toBe(false);
    expect(scheduler.advance(1 / 60)).toBe(false);
    expect(scheduler.advance(1 / 60)).toBe(false);
    expect(scheduler.advance(1 / 60)).toBe(true);
    let packets = 0;
    for (let frame = 0; frame < 60; frame += 1) {
      if (scheduler.advance(1 / 60)) packets += 1;
    }
    expect(packets).toBe(20);
  });

  it("samples at most once per frame when rendering falls below the network rate", () => {
    const scheduler = new InputSendScheduler();
    let packets = 0;
    for (let frame = 0; frame < 20; frame += 1) {
      if (scheduler.advance(0.1)) packets += 1;
    }
    expect(packets).toBe(20); // Ten rendered frames per second, no catch-up flood.
    expect(scheduler.advance(1 / 60)).toBe(false);
    expect(scheduler.advance(1 / 60)).toBe(false);
    expect(scheduler.advance(1 / 60)).toBe(true);
  });

  it("clears a partial interval on hide, leave or inactivity before resuming", () => {
    const scheduler = new InputSendScheduler();
    expect(scheduler.advance(0.04)).toBe(false);
    scheduler.reset();
    scheduler.reset();
    expect(scheduler.advance(1 / 60)).toBe(false);
    expect(scheduler.advance(1 / 60)).toBe(false);
    expect(scheduler.advance(1 / 60)).toBe(true);
    expect(scheduler.advance(0.04)).toBe(false);
    scheduler.reset();
    expect(scheduler.advance(0.01)).toBe(false);
    expect(scheduler.advance(0.04)).toBe(true);
  });

  it("ignores invalid durations without poisoning the next valid send", () => {
    const scheduler = new InputSendScheduler();
    expect(scheduler.advance(0.04)).toBe(false);
    for (const delta of [0, -1, Number.NaN, Infinity, -Infinity]) {
      expect(scheduler.advance(delta)).toBe(false);
    }
    expect(scheduler.advance(0.01)).toBe(true);
    expect(scheduler.advance(0.049)).toBe(false);
    expect(scheduler.advance(0.001)).toBe(true);
  });
});
