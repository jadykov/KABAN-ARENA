import type { LookDelta, MoveVector } from "./SceneManager";

// Movement direction pressed on the physical keyboard. Mapping is done by
// `code` (physical key position), never by `key` (produced character), so
// WASD works in any layout, including non-Latin ones.
export type MoveDirection = "forward" | "back" | "left" | "right";

export function mapCodeToDirection(code: string): MoveDirection | null {
  switch (code) {
    case "KeyW":
    case "ArrowUp":
      return "forward";
    case "KeyS":
    case "ArrowDown":
      return "back";
    case "KeyA":
    case "ArrowLeft":
      return "left";
    case "KeyD":
    case "ArrowRight":
      return "right";
    default:
      return null;
  }
}

function readCode(event: Event): string | null {
  const code = (event as unknown as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function readButton(event: Event): number | null {
  const button = (event as unknown as { button?: unknown }).button;
  return typeof button === "number" ? button : null;
}

function readPointerType(event: Event): string | null {
  const pointerType = (event as unknown as { pointerType?: unknown }).pointerType;
  return typeof pointerType === "string" ? pointerType : null;
}

function readMovement(event: Event, field: "movementX" | "movementY"): number {
  const value = (event as unknown as Record<string, unknown>)[field];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// Focus guard: typing in a form field must never drive the avatar or
// swallow keystrokes. Duck-typed (tagName/isContentEditable) so it works
// with real DOM elements and with EventTarget test doubles alike.
export function isTypingTarget(event: Event): boolean {
  const target = (event as unknown as { target?: unknown }).target as {
    tagName?: unknown;
    isContentEditable?: unknown;
  } | null | undefined;
  if (target === null || target === undefined) {
    return false;
  }
  const tag = typeof target.tagName === "string" ? target.tagName.toUpperCase() : "";
  if (tag === "INPUT" || tag === "TEXTAREA") {
    return true;
  }
  return target.isContentEditable === true;
}

// Keyboard (layout-independent WASD via e.code) + virtual-joystick vector +
// hold-right-mouse-button camera deltas. Attach/detach cleanly so listeners
// never leak on room leave or scene reset. Strict TS: no `any` anywhere;
// DOM event payloads are read through guarded property readers above.
export class InputController {
  private readonly pressed = new Set<MoveDirection>();
  private joystick: MoveVector = { x: 0, y: 0 };
  private lookDelta: LookDelta = { dx: 0, dy: 0 };
  private rotating = false;
  private attached = false;

  private keyTarget: EventTarget | null = null;
  private pointerTarget: EventTarget | null = null;

  private readonly handleKeyDown = (event: Event): void => {
    if (isTypingTarget(event)) {
      return;
    }
    const code = readCode(event);
    if (code === null) {
      return;
    }
    const direction = mapCodeToDirection(code);
    if (direction === null) {
      return;
    }
    this.pressed.add(direction);
    event.preventDefault();
  };

  private readonly handleKeyUp = (event: Event): void => {
    if (isTypingTarget(event)) {
      return;
    }
    const code = readCode(event);
    if (code === null) {
      return;
    }
    const direction = mapCodeToDirection(code);
    if (direction === null) {
      return;
    }
    this.pressed.delete(direction);
  };

  private readonly handlePointerDown = (event: Event): void => {
    // Camera rotation is right-mouse-button only; touch/left clicks never
    // arm it, so the joystick and movement stay independent.
    if (readPointerType(event) === "touch") {
      return;
    }
    if (readButton(event) === 2) {
      this.rotating = true;
    }
  };

  private readonly handlePointerMove = (event: Event): void => {
    if (!this.rotating) {
      return;
    }
    if (readPointerType(event) === "touch") {
      return;
    }
    this.lookDelta.dx += readMovement(event, "movementX");
    // Stage 4d.2-fix2 (owner playtest): pushing the mouse away LOWERS/levels
    // the camera behind the character instead of raising it into a top-down
    // head view. Raw movementY passes through unnegated (screen-space, mouse
    // away = NEGATIVE dy), and SceneManager applies pitch += dy, so pushing
    // away pitches the camera down/level while pulling back raises it.
    // Mobile paths are untouched (move joystick, aim stick +y-up, float-aim
    // -dy conversion all stay up-positive as before).
    this.lookDelta.dy += readMovement(event, "movementY");
  };

  private readonly handlePointerUp = (event: Event): void => {
    if (readPointerType(event) === "touch") {
      return;
    }
    if (readButton(event) === 2 || readButton(event) === null) {
      this.rotating = false;
    }
  };

  private readonly handleContextMenu = (event: Event): void => {
    event.preventDefault();
  };

  public attach(keyTarget: EventTarget, pointerTarget: EventTarget): void {
    if (this.attached) {
      return;
    }
    this.attached = true;
    this.keyTarget = keyTarget;
    this.pointerTarget = pointerTarget;
    keyTarget.addEventListener("keydown", this.handleKeyDown);
    keyTarget.addEventListener("keyup", this.handleKeyUp);
    keyTarget.addEventListener("pointermove", this.handlePointerMove);
    keyTarget.addEventListener("pointerup", this.handlePointerUp);
    keyTarget.addEventListener("pointercancel", this.handlePointerUp);
    pointerTarget.addEventListener("pointerdown", this.handlePointerDown);
    pointerTarget.addEventListener("contextmenu", this.handleContextMenu);
  }

  public detach(): void {
    if (!this.attached) {
      return;
    }
    this.attached = false;
    this.keyTarget?.removeEventListener("keydown", this.handleKeyDown);
    this.keyTarget?.removeEventListener("keyup", this.handleKeyUp);
    this.keyTarget?.removeEventListener("pointermove", this.handlePointerMove);
    this.keyTarget?.removeEventListener("pointerup", this.handlePointerUp);
    this.keyTarget?.removeEventListener("pointercancel", this.handlePointerUp);
    this.pointerTarget?.removeEventListener("pointerdown", this.handlePointerDown);
    this.pointerTarget?.removeEventListener("contextmenu", this.handleContextMenu);
    this.keyTarget = null;
    this.pointerTarget = null;
    this.rotating = false;
  }

  public setJoystick(vector: MoveVector): void {
    this.joystick = { x: vector.x, y: vector.y };
  }

  public addLookDelta(delta: LookDelta): void {
    this.lookDelta.dx += delta.dx;
    this.lookDelta.dy += delta.dy;
  }

  public consumeLookDelta(): LookDelta {
    const delta = { ...this.lookDelta };
    this.lookDelta.dx = 0;
    this.lookDelta.dy = 0;
    return delta;
  }

  public isRotating(): boolean {
    return this.rotating;
  }

  public getPressed(): ReadonlySet<MoveDirection> {
    return this.pressed;
  }

  public getMoveVector(): MoveVector {
    let x = this.joystick.x;
    let y = this.joystick.y;
    if (this.pressed.has("left")) {
      x -= 1;
    }
    if (this.pressed.has("right")) {
      x += 1;
    }
    if (this.pressed.has("forward")) {
      y += 1;
    }
    if (this.pressed.has("back")) {
      y -= 1;
    }
    const length = Math.hypot(x, y);
    if (length > 1) {
      x /= length;
      y /= length;
    }
    return { x, y };
  }

  public reset(): void {
    this.pressed.clear();
    this.joystick = { x: 0, y: 0 };
    this.lookDelta = { dx: 0, dy: 0 };
    this.rotating = false;
  }

  public dispose(): void {
    this.detach();
    this.reset();
  }
}
