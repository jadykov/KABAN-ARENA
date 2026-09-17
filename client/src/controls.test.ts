import { describe, expect, it } from "vitest";
import {
  CAMERA_FOLLOW_DISTANCE,
  CAMERA_FOV,
  JOYSTICK_DIAMETER,
  MAX_HEARTS,
} from "./config";
import { InputController, isTypingTarget, mapCodeToDirection } from "./engine/InputController";
import { formatTimer, heartsAfterHits } from "./ui/hud";
import { computeJoystickVector } from "./ui/joystick";

interface FakeKeyEventOptions {
  code?: string;
  key?: string;
}

function dispatchKey(target: EventTarget, type: string, options: FakeKeyEventOptions): void {
  const event = new Event(type) as Event & { code?: string; key?: string };
  if (options.code !== undefined) {
    event.code = options.code;
  }
  if (options.key !== undefined) {
    event.key = options.key;
  }
  target.dispatchEvent(event);
}

describe("layout-independent WASD mapping (uses e.code, not key)", () => {
  it("maps KeyW/A/S/D physical codes to directions", () => {
    expect(mapCodeToDirection("KeyW")).toBe("forward");
    expect(mapCodeToDirection("KeyA")).toBe("left");
    expect(mapCodeToDirection("KeyS")).toBe("back");
    expect(mapCodeToDirection("KeyD")).toBe("right");
  });

  it("maps arrow codes as well", () => {
    expect(mapCodeToDirection("ArrowUp")).toBe("forward");
    expect(mapCodeToDirection("ArrowDown")).toBe("back");
    expect(mapCodeToDirection("ArrowLeft")).toBe("left");
    expect(mapCodeToDirection("ArrowRight")).toBe("right");
  });

  it("rejects unrelated codes", () => {
    expect(mapCodeToDirection("KeyQ")).toBeNull();
    expect(mapCodeToDirection("Space")).toBeNull();
    expect(mapCodeToDirection("")).toBeNull();
  });
});

describe("InputController", () => {
  it("moves on physical code even with a non-Latin produced character", () => {
    // Russian layout: physical KeyA produces "ф" — movement must still work
    // because the controller reads `code`, never `key`.
    const keys = new EventTarget();
    const pointers = new EventTarget();
    const input = new InputController();
    input.attach(keys, pointers);
    try {
      dispatchKey(keys, "keydown", { code: "KeyA", key: "ф" });
      expect(input.getPressed().has("left")).toBe(true);
      expect(input.getMoveVector().x).toBe(-1);
    } finally {
      input.dispose();
    }
  });

  it("ignores events without a code (key alone never drives movement)", () => {
    const keys = new EventTarget();
    const pointers = new EventTarget();
    const input = new InputController();
    input.attach(keys, pointers);
    try {
      dispatchKey(keys, "keydown", { key: "ф" });
      expect(input.getPressed().size).toBe(0);
      expect(input.getMoveVector()).toEqual({ x: 0, y: 0 });
    } finally {
      input.dispose();
    }
  });

  it("combines opposite keys and releases cleanly on keyup", () => {
    const keys = new EventTarget();
    const pointers = new EventTarget();
    const input = new InputController();
    input.attach(keys, pointers);
    try {
      dispatchKey(keys, "keydown", { code: "KeyW" });
      dispatchKey(keys, "keydown", { code: "KeyD" });
      const moved = input.getMoveVector();
      expect(moved.x).toBeGreaterThan(0);
      expect(moved.y).toBeGreaterThan(0);
      expect(Math.hypot(moved.x, moved.y)).toBeLessThanOrEqual(1.0001);
      dispatchKey(keys, "keyup", { code: "KeyW" });
      dispatchKey(keys, "keyup", { code: "KeyD" });
      expect(input.getMoveVector()).toEqual({ x: 0, y: 0 });
    } finally {
      input.dispose();
    }
  });

  it("accumulates and consumes camera look deltas without breaking movement", () => {
    const input = new InputController();
    try {
      input.addLookDelta({ dx: 10, dy: -4 });
      input.addLookDelta({ dx: 5, dy: 2 });
      expect(input.consumeLookDelta()).toEqual({ dx: 15, dy: -2 });
      expect(input.consumeLookDelta()).toEqual({ dx: 0, dy: 0 });
      expect(input.getMoveVector()).toEqual({ x: 0, y: 0 });
    } finally {
      input.dispose();
    }
  });

  it("delivers non-inverted mouse look: mouse up (negative movementY) is +dy", () => {
    // Owner playtest: raising the mouse must raise the camera/aim.
    // Raw movementY is screen-space (up = negative); the controller negates
    // it so LookDelta.dy stays "up positive" like every stick path, and
    // SceneManager pitch += dy then looks up.
    const keys = new EventTarget();
    const pointers = new EventTarget();
    const input = new InputController();
    input.attach(keys, pointers);
    try {
      const down = new Event("pointerdown") as Event & {
        button?: number;
        pointerType?: string;
      };
      down.button = 2;
      down.pointerType = "mouse";
      pointers.dispatchEvent(down);
      const move = new Event("pointermove") as Event & {
        movementX?: number;
        movementY?: number;
        pointerType?: string;
      };
      move.movementX = 8;
      move.movementY = -10; // mouse pushed up
      move.pointerType = "mouse";
      keys.dispatchEvent(move);
      expect(input.consumeLookDelta()).toEqual({ dx: 8, dy: 10 });
      expect(input.consumeLookDelta()).toEqual({ dx: 0, dy: 0 });
    } finally {
      input.dispose();
    }
  });

  it("merges joystick input and stops listening after detach", () => {
    const keys = new EventTarget();
    const pointers = new EventTarget();
    const input = new InputController();
    input.attach(keys, pointers);
    try {
      input.setJoystick({ x: 0.5, y: 0 });
      expect(input.getMoveVector().x).toBeCloseTo(0.5);
      input.detach();
      dispatchKey(keys, "keydown", { code: "KeyW" });
      expect(input.getPressed().size).toBe(0);
    } finally {
      input.dispose();
    }
  });
});

describe("joystick vector math", () => {
  it("normalizes center and edges", () => {
    expect(computeJoystickVector(0, 0, 60)).toEqual({ x: 0, y: 0 });
    // Screen-up drag means forward (+y).
    expect(computeJoystickVector(0, -60, 60)).toEqual({ x: 0, y: 1 });
    expect(computeJoystickVector(60, 0, 60)).toEqual({ x: 1, y: 0 });
  });

  it("clamps drags beyond the stick radius", () => {
    const vector = computeJoystickVector(120, 0, 60);
    expect(vector.x).toBeCloseTo(1);
    expect(Math.hypot(vector.x, vector.y)).toBeLessThanOrEqual(1.0001);
  });

  it("guards invalid radius", () => {
    expect(computeJoystickVector(10, 10, 0)).toEqual({ x: 0, y: 0 });
  });
});

describe("HUD helpers", () => {
  it("loses exactly one heart per hit and never below zero", () => {
    expect(heartsAfterHits(MAX_HEARTS, 1)).toBe(MAX_HEARTS - 1);
    expect(heartsAfterHits(1, 1)).toBe(0);
    expect(heartsAfterHits(0, 1)).toBe(0);
  });

  it("formats the round timer", () => {
    expect(formatTimer(180)).toBe("3:00");
    expect(formatTimer(5)).toBe("0:05");
    expect(formatTimer(-3)).toBe("0:00");
  });
});

describe("nick input focus guard (#join-nick must not drive the avatar)", () => {
  function fieldTarget(tagName: string): EventTarget {
    const target = new EventTarget() as EventTarget & { tagName: string };
    target.tagName = tagName;
    return target;
  }

  function trackedKeyEvent(type: string, code: string): { event: Event; prevented: () => boolean } {
    let stopped = false;
    const event = new Event(type) as Event & { code?: string };
    event.code = code;
    event.preventDefault = (): void => {
      stopped = true;
    };
    return { event, prevented: (): boolean => stopped };
  }

  it("ignores WASD keydown from an INPUT target (no move, no preventDefault)", () => {
    const keys = fieldTarget("INPUT");
    const pointers = new EventTarget();
    const input = new InputController();
    input.attach(keys, pointers);
    try {
      const { event, prevented } = trackedKeyEvent("keydown", "KeyW");
      keys.dispatchEvent(event);
      expect(isTypingTarget(event)).toBe(true);
      expect(input.getPressed().size).toBe(0);
      expect(input.getMoveVector()).toEqual({ x: 0, y: 0 });
      expect(prevented()).toBe(false);
    } finally {
      input.dispose();
    }
  });

  it("ignores keyup from a TEXTAREA target (symmetric with keydown)", () => {
    const keys = fieldTarget("TEXTAREA");
    const pointers = new EventTarget();
    const input = new InputController();
    input.attach(keys, pointers);
    try {
      const down = trackedKeyEvent("keydown", "KeyW");
      keys.dispatchEvent(down.event);
      expect(input.getPressed().size).toBe(0);
      const up = trackedKeyEvent("keyup", "KeyW");
      keys.dispatchEvent(up.event);
      expect(isTypingTarget(up.event)).toBe(true);
      expect(input.getPressed().size).toBe(0);
      expect(input.getMoveVector()).toEqual({ x: 0, y: 0 });
    } finally {
      input.dispose();
    }
  });

  it("still registers WASD keydown on a body-like target", () => {
    const keys = new EventTarget();
    const pointers = new EventTarget();
    const input = new InputController();
    input.attach(keys, pointers);
    try {
      const { event, prevented } = trackedKeyEvent("keydown", "KeyA");
      keys.dispatchEvent(event);
      expect(isTypingTarget(event)).toBe(false);
      expect(input.getPressed().has("left")).toBe(true);
      expect(prevented()).toBe(true);
    } finally {
      input.dispose();
    }
  });

  it("flags INPUT/TEXTAREA/contentEditable, clears body/div", () => {
    const inputEvent = new Event("keydown");
    Object.defineProperty(inputEvent, "target", { value: { tagName: "INPUT" } });
    expect(isTypingTarget(inputEvent)).toBe(true);
    const areaEvent = new Event("keydown");
    Object.defineProperty(areaEvent, "target", { value: { tagName: "textarea" } });
    expect(isTypingTarget(areaEvent)).toBe(true);
    const editableEvent = new Event("keydown");
    Object.defineProperty(editableEvent, "target", { value: { tagName: "DIV", isContentEditable: true } });
    expect(isTypingTarget(editableEvent)).toBe(true);
    const bodyEvent = new Event("keydown");
    Object.defineProperty(bodyEvent, "target", { value: { tagName: "BODY" } });
    expect(isTypingTarget(bodyEvent)).toBe(false);
  });
});

describe("Stage 2 confirmed constants", () => {
  it("keeps owner-confirmed camera/joystick values", () => {
    expect(CAMERA_FOV).toBe(75);
    expect(CAMERA_FOLLOW_DISTANCE).toBe(4);
    expect(JOYSTICK_DIAMETER).toBe(120);
    expect(MAX_HEARTS).toBe(4);
  });
});
