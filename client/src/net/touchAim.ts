// Stage 4e mobile scheme (PUBG-style, owner-confirmed): touch-drag anywhere
// on the RIGHT half of the screen (outside HUD buttons) is FREE CAMERA
// rotation with NO charge; the FIRE button hold charges + aims. This module
// owns the pointer-id routing state for both gestures so the behavior stays
// unit-testable (see net/touchAim.test.ts); main.ts only reads DOM payloads
// (pointerId/clientX/clientY/pointerType/target), forwards plain data here,
// and runs the charge FSM. Desktop mouse/keyboard paths are untouched.
//
// Feel parity: drag px maps to [-1, 1] over FLOAT_DRAG_RADIUS_PX with
// AIM_EXPO shaping and the joystick screen-up convention (+y = pitch up) —
// the exact formula of the legacy float path, so FIRE aim feels identical to
// the old float aim (damped while charging via yawRateScale/pitchRateScale)
// and the free camera runs the same math at full rate while idle.
// Scalar only; the two vector objects are mutated in place and exposed by
// reference so the per-frame loop reads them with zero allocations.
import { AIM_EXPO, FLOAT_DEADZONE, FLOAT_DRAG_RADIUS_PX } from "../config";
import { applyExpo } from "./protocol";

// Plain pointer data forwarded by main.ts (no DOM types here, so tests drive
// the same state machine with synthetic points).
export interface TouchDragPoint {
  pointerId: number;
  x: number;
  y: number;
}

export interface TouchAimVector {
  x: number;
  y: number;
}

// Right-half predicate: a touch at/after the screen midpoint belongs to the
// camera zone (the left half belongs to the move stick). Boundary inclusive
// so a tap exactly on the middle line still rotates instead of dying.
export function isRightHalf(clientX: number, innerWidth: number): boolean {
  if (!Number.isFinite(clientX) || !Number.isFinite(innerWidth)) {
    return false;
  }
  return clientX >= innerWidth / 2;
}

// Drag offset in px -> expo-shaped aim vector in [-1, 1]. Normalizes by the
// drag radius, clamps over-long drags to unit length, applies the shared
// expo, and negates screen Y so dragging up aims up. Non-finite input yields
// a zero vector (call sites treat it as "no aim"). One small object per call
// on the pointer-event path only — never per frame.
export function computeTouchAimVector(deltaXPx: number, deltaYPx: number): TouchAimVector {
  if (!Number.isFinite(deltaXPx) || !Number.isFinite(deltaYPx)) {
    return { x: 0, y: 0 };
  }
  const radius = FLOAT_DRAG_RADIUS_PX > 0 ? FLOAT_DRAG_RADIUS_PX : 80;
  let dx = deltaXPx / radius;
  let dy = deltaYPx / radius;
  const length = Math.hypot(dx, dy);
  if (length > 1) {
    dx /= length;
    dy /= length;
  }
  const vx = applyExpo(dx, AIM_EXPO);
  const vy = applyExpo(-dy, AIM_EXPO);
  // Normalize negative zero so consumers and equality checks see plain 0.
  return { x: vx === 0 ? 0 : vx, y: vy === 0 ? 0 : vy };
}

// Deflection check shared by the per-frame integration sites: a vector at or
// past FLOAT_DEADZONE drives aim that frame. Non-finite never deflects.
export function isAimDeflected(x: number, y: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return false;
  }
  return Math.hypot(x, y) >= FLOAT_DEADZONE;
}

// Pointer-id routing state for the two Stage 4e gestures. FIRE tracks ONE
// pointer (charge + aim); the free camera tracks ONE pointer (look only,
// never charge). Every move/up/cancel routes by pointer id alone — never by
// event target — so a FIRE thumb sliding off the button keeps aiming (the
// button captures the pointer and moves bubble to window) and release
// anywhere still reaches the tracked id.
export class TouchAimState {
  private fireActive = false;
  private firePointerId: number | null = null;
  private fireOriginX = 0;
  private fireOriginY = 0;
  private readonly fireVec: TouchAimVector = { x: 0, y: 0 };

  private camActive = false;
  private camPointerId: number | null = null;
  private camOriginX = 0;
  private camOriginY = 0;
  private readonly camVec: TouchAimVector = { x: 0, y: 0 };

  // Live vector references (mutated in place, never replaced): the per-frame
  // loop holds them across frames with zero allocations.
  public fireVector(): TouchAimVector {
    return this.fireVec;
  }

  public camVector(): TouchAimVector {
    return this.camVec;
  }

  public isFireActive(): boolean {
    return this.fireActive;
  }

  public isCamActive(): boolean {
    return this.camActive;
  }

  public isFirePointer(pointerId: number | null): boolean {
    return this.fireActive && pointerId !== null && pointerId === this.firePointerId;
  }

  public isCamPointer(pointerId: number | null): boolean {
    return this.camActive && pointerId !== null && pointerId === this.camPointerId;
  }

  // FIRE down: arm tracking for one pointer and zero the aim vector. Extra
  // pointers while one is tracked are ignored (single-pointer guard, same as
  // the legacy float path). Returns true when this pointer is now tracked.
  public fireDown(point: TouchDragPoint): boolean {
    if (this.fireActive) {
      return false;
    }
    this.fireActive = true;
    this.firePointerId = point.pointerId;
    this.fireOriginX = point.x;
    this.fireOriginY = point.y;
    this.fireVec.x = 0;
    this.fireVec.y = 0;
    return true;
  }

  // FIRE move: recompute the aim vector from the drag offset. Target-free by
  // design — sliding off the button keeps aiming. Returns true only for the
  // tracked pointer (other fingers never disturb FIRE aim).
  public fireMove(point: TouchDragPoint): boolean {
    if (!this.fireActive || point.pointerId !== this.firePointerId) {
      return false;
    }
    const next = computeTouchAimVector(point.x - this.fireOriginX, point.y - this.fireOriginY);
    this.fireVec.x = next.x;
    this.fireVec.y = next.y;
    return true;
  }

  // FIRE release/cancel: zero the vector first (so the release resolves from
  // the mirrored camera exactly like the legacy float zero-before-stop
  // ordering) and drop tracking. Returns true when a tracked hold ended —
  // the caller runs stopCharge (fire, tap guard inside) vs cancelCharge.
  // A null id (synthetic event without an id) ends the tracked hold, matching
  // the legacy float up/cancel convention.
  public fireUp(pointerId: number | null): boolean {
    if (!this.fireActive) {
      return false;
    }
    if (pointerId !== null && pointerId !== this.firePointerId) {
      return false;
    }
    this.fireActive = false;
    this.firePointerId = null;
    this.fireVec.x = 0;
    this.fireVec.y = 0;
    return true;
  }

  public fireCancel(pointerId: number | null): boolean {
    return this.fireUp(pointerId);
  }

  // Free-camera down: start tracking ONLY when not charging and no drag is
  // active. NEVER charges — a false return means "ignored" (charging finger
  // or second finger: do nothing until the charge ends). Returns true when
  // this pointer is now tracked.
  public camDown(point: TouchDragPoint, isCharging: boolean): boolean {
    if (isCharging || this.camActive) {
      return false;
    }
    this.camActive = true;
    this.camPointerId = point.pointerId;
    this.camOriginX = point.x;
    this.camOriginY = point.y;
    this.camVec.x = 0;
    this.camVec.y = 0;
    return true;
  }

  // Free-camera move: same drag math as FIRE (full rate applies per frame
  // because the loop is not charging). Ignored unless tracked.
  public camMove(point: TouchDragPoint): boolean {
    if (!this.camActive || point.pointerId !== this.camPointerId) {
      return false;
    }
    const next = computeTouchAimVector(point.x - this.camOriginX, point.y - this.camOriginY);
    this.camVec.x = next.x;
    this.camVec.y = next.y;
    return true;
  }

  // Free-camera lift: drop tracking with NO charge calls and no automatic
  // catch-up (the camera holds until the player moves or looks again).
  // Null id ends the tracked drag, matching the float convention.
  public camUp(pointerId: number | null): boolean {
    if (!this.camActive) {
      return false;
    }
    if (pointerId !== null && pointerId !== this.camPointerId) {
      return false;
    }
    this.camActive = false;
    this.camPointerId = null;
    this.camVec.x = 0;
    this.camVec.y = 0;
    return true;
  }

  public camCancel(pointerId: number | null): boolean {
    return this.camUp(pointerId);
  }

  // A charge takes over the right half: drop any free-camera drag so a
  // second finger cannot swing aim mid-charge. Called on every successful
  // charge start; a lifted-then-retouched finger starts a fresh drag.
  public clearCam(): void {
    this.camActive = false;
    this.camPointerId = null;
    this.camVec.x = 0;
    this.camVec.y = 0;
  }

  // Full reset (scene reset path): drop both gestures and zero both vectors.
  public reset(): void {
    this.fireActive = false;
    this.firePointerId = null;
    this.fireVec.x = 0;
    this.fireVec.y = 0;
    this.clearCam();
  }
}
