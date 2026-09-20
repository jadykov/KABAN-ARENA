import {
  JOYSTICK_DIAMETER,
  JOYSTICK_KNOB_DIAMETER,
  JOYSTICK_KNOB_OPACITY,
  JOYSTICK_OPACITY,
} from "../config";
import type { MoveVector } from "../engine/SceneManager";

// Pure helper (unit-tested): clamp a drag offset to the stick radius and
// normalize to [-1, 1]. y is negated so screen-up means forward (+1).
export function computeJoystickVector(
  deltaX: number,
  deltaY: number,
  radius: number,
): MoveVector {
  if (!(radius > 0)) {
    return { x: 0, y: 0 };
  }
  const length = Math.hypot(deltaX, deltaY);
  const clamped = length > radius ? radius / length : 1;
  const rawX = (deltaX * clamped) / radius;
  const rawY = (-deltaY * clamped) / radius;
  // Normalize negative zero so consumers and equality checks see plain 0.
  return {
    x: rawX === 0 ? 0 : rawX,
    y: rawY === 0 ? 0 : rawY,
  };
}

export interface JoystickOptions {
  onMove: (vector: MoveVector) => void;
// Reuse: optional disc diameter (px) and element id. Defaults keep the
// legacy left stick (120px, #joystick) so existing callers/tests are
// untouched; pass a custom diameter + id for any extra stick.
  diameter?: number;
  id?: string;
}

export interface JoystickHandle {
  element: HTMLDivElement;
  getVector(): MoveVector;
  destroy(): void;
}

// Custom pointer-event joystick (no Nipple.js dependency): a large
// transparent see-through disc on the left that never blocks the view.
// Rendered as a DOM overlay, not WebGL. destroy() removes all listeners
// and the element (room leave / scene reset safe).
export function createJoystick(
  parent: HTMLElement,
  options: JoystickOptions,
): JoystickHandle {
  const diameter =
    typeof options.diameter === "number" && Number.isFinite(options.diameter) && options.diameter > 0
      ? options.diameter
      : JOYSTICK_DIAMETER;
  const radius = diameter / 2;
  const stickId = typeof options.id === "string" && options.id !== "" ? options.id : "joystick";
  const knobId = `${stickId}-knob`;
  const base = document.createElement("div");
  base.id = stickId;
  base.style.width = `${diameter}px`;
  base.style.height = `${diameter}px`;
  base.style.opacity = String(JOYSTICK_OPACITY);

  const knob = document.createElement("div");
  knob.id = knobId;
  knob.style.width = `${JOYSTICK_KNOB_DIAMETER}px`;
  knob.style.height = `${JOYSTICK_KNOB_DIAMETER}px`;
  knob.style.marginLeft = `${-JOYSTICK_KNOB_DIAMETER / 2}px`;
  knob.style.marginTop = `${-JOYSTICK_KNOB_DIAMETER / 2}px`;
  knob.style.opacity = String(JOYSTICK_KNOB_OPACITY);
  base.appendChild(knob);
  parent.appendChild(base);

  let vector: MoveVector = { x: 0, y: 0 };
  let activePointerId: number | null = null;
  let destroyed = false;

  const setKnobOffset = (offsetX: number, offsetY: number): void => {
    knob.style.transform = `translate(${offsetX}px, ${offsetY}px)`;
  };

  const updateFromClientPoint = (clientX: number, clientY: number): void => {
    const rect = base.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    vector = computeJoystickVector(clientX - centerX, clientY - centerY, radius);
    const knobRange = radius - JOYSTICK_KNOB_DIAMETER / 2;
    setKnobOffset(vector.x * knobRange, -vector.y * knobRange);
    options.onMove({ ...vector });
  };

  const release = (): void => {
    activePointerId = null;
    vector = { x: 0, y: 0 };
    setKnobOffset(0, 0);
    options.onMove({ x: 0, y: 0 });
  };

  const handlePointerDown = (event: PointerEvent): void => {
    if (activePointerId !== null) {
      return;
    }
    activePointerId = event.pointerId;
    base.setPointerCapture(event.pointerId);
    updateFromClientPoint(event.clientX, event.clientY);
    event.preventDefault();
  };

  const handlePointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== activePointerId) {
      return;
    }
    updateFromClientPoint(event.clientX, event.clientY);
    event.preventDefault();
  };

  const handlePointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== activePointerId) {
      return;
    }
    release();
  };

  const handlePointerCancel = (event: PointerEvent): void => {
    if (event.pointerId !== activePointerId) {
      return;
    }
    release();
  };

  base.addEventListener("pointerdown", handlePointerDown);
  base.addEventListener("pointermove", handlePointerMove);
  base.addEventListener("pointerup", handlePointerUp);
  base.addEventListener("pointercancel", handlePointerCancel);

  return {
    element: base,
    getVector(): MoveVector {
      return { ...vector };
    },
    destroy(): void {
      if (destroyed) {
        return;
      }
      destroyed = true;
      base.removeEventListener("pointerdown", handlePointerDown);
      base.removeEventListener("pointermove", handlePointerMove);
      base.removeEventListener("pointerup", handlePointerUp);
      base.removeEventListener("pointercancel", handlePointerCancel);
      release();
      if (base.parentElement === parent) {
        parent.removeChild(base);
      }
    },
  };
}
