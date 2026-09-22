// F3 snap-gate debug overlay (diagnostic only, zero gameplay effect): a small
// fixed DOM panel showing the LIVE values of every UP-snap gate populated by
// SceneManager.reconcileSelf, so a live wedge repro can be read off (or
// filmed) instead of guessed at. Toggled by F3, starts hidden, refreshes at
// ~10Hz (single textContent write per refresh, no per-frame DOM churn).
// Headless-safe: with no document (vitest node env) every method is a no-op.

export const SNAP_DEBUG_REFRESH_MS = 100;
export const SNAP_DEBUG_TOGGLE_CODE = "F3";

// One flattened snapshot of the snap-gate state. main.ts builds this from
// SceneManager.getLastReconcileTelemetry() + live avatar reads; the overlay
// only formats, never derives gates itself.
export interface SnapDebugState {
  serverY: number;
  clientY: number;
  divergence: number;
  // Stall-snap gates (bug round 7): divOk (div >= STALL_MIN_DIV), input
  // magnitude + inputOk (>= STALL_INPUT_MIN), stall-window progress +
  // stallOk (< MIN_PROGRESS_M over STALL_WINDOW_S).
  stallMinDiv: number;
  divOk: boolean;
  inputMag: number;
  inputMin: number;
  inputOk: boolean;
  stallProgressM: number;
  stallWindowM: number;
  stallOk: boolean;
  // Big-div heal state: sustained-hold timer + threshold + gap requirement.
  bigDivHoldS: number;
  bigDivHoldNeedS: number;
  bigDivAbs: number;
  bigDivNeed: number;
  bigHealCount: number;
  lastBigHealAgoS: number;
  airborne: boolean;
  cooldownLeftS: number;
  levelTopIndex: number;
  levelTopY: number;
  evalTopIndex: number;
  xzOk: boolean;
  blockCenterX: number;
  blockCenterZ: number;
  blockDist: number;
  xzDist: number;
  xzBand: string;
  result: string;
  snapKind: string;
  upSnapCount: number;
  // Seconds since the last stall-snap (-1 = never).
  lastUpSnapAgoS: number;
  note: string;
}

function fmt(value: number, digits: number): string {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  return value.toFixed(digits);
}

function signed(value: number, digits: number): string {
  if (!Number.isFinite(value)) {
    return "n/a";
  }
  const sign = value < 0 ? "-" : "+";
  return `${sign}${Math.abs(value).toFixed(digits)}`;
}

function mark(ok: boolean): string {
  return ok ? "[OK]" : "[FAIL]";
}

// Pure formatter (headless-testable): every stall/big-div gate on its own
// labeled line with a pass/fail mark, plus the XZ band, result, and both
// snap counters (stall snaps / big heals).
export function formatSnapDebug(state: SnapDebugState): string {
  const topLabel =
    state.levelTopIndex >= 0 ? `#${state.levelTopIndex} y=${fmt(state.levelTopY, 2)}` : "none";
  const blockLabel =
    state.evalTopIndex >= 0
      ? `#${state.evalTopIndex} c=(${fmt(state.blockCenterX, 2)},${fmt(state.blockCenterZ, 2)}) d=${fmt(state.blockDist, 2)}`
      : "none";
  const lastSnap = state.lastUpSnapAgoS >= 0 ? `${fmt(state.lastUpSnapAgoS, 1)}s ago` : "never";
  const lastBig = state.lastBigHealAgoS >= 0 ? `${fmt(state.lastBigHealAgoS, 1)}s ago` : "never";
  const lines = [
    "SNAP-DEBUG (F3)",
    `Y: srv=${fmt(state.serverY, 3)} cli=${fmt(state.clientY, 3)} div=${signed(state.divergence, 3)}`,
    `G div>=${fmt(state.stallMinDiv, 2)}: ${state.divOk ? "YES" : "NO"} ${mark(state.divOk)}`,
    `G top srvY~=top: ${topLabel} ${mark(state.levelTopIndex >= 0)}`,
    `G input>=${fmt(state.inputMin, 1)}: ${fmt(state.inputMag, 2)} ${mark(state.inputOk)}`,
    `G stall prog<${fmt(state.stallWindowM, 2)}: ${fmt(state.stallProgressM, 3)} ${mark(state.stallOk)}`,
    `G air !airborne: ${state.airborne ? "YES" : "NO"} ${mark(!state.airborne)}`,
    `G cool ==0: ${fmt(state.cooldownLeftS, 2)}s ${mark(!(state.cooldownLeftS > 0))}`,
    `G xin blk+0.5: ${state.evalTopIndex >= 0 ? (state.xzOk ? "YES" : "NO") : "n/a"} ${blockLabel} ${mark(state.xzOk)}`,
    `BIG |div|>=${fmt(state.bigDivNeed, 2)}: ${fmt(state.bigDivAbs, 3)} hold=${fmt(state.bigDivHoldS, 2)}/${fmt(state.bigDivHoldNeedS, 2)}s`,
    `XZ srv: ${fmt(state.xzDist, 2)}m [${state.xzBand}] res=${state.result}(${state.snapKind})`,
    `SNAPS: ${state.upSnapCount} last=${lastSnap} BIGHEAL: ${state.bigHealCount} last=${lastBig} note=${state.note}`,
  ];
  return lines.join("\n");
}

export class SnapDebugOverlay {
  private readonly readState: () => SnapDebugState;
  private element: HTMLDivElement | null = null;
  private lastMs = 0;

  constructor(readState: () => SnapDebugState) {
    this.readState = readState;
    if (typeof document === "undefined") {
      return;
    }
    const element = document.createElement("div");
    element.style.position = "fixed";
    element.style.top = "8px";
    element.style.left = "8px";
    element.style.zIndex = "9999";
    element.style.pointerEvents = "none";
    element.style.display = "none";
    element.style.fontFamily = "monospace";
    element.style.fontSize = "11px";
    element.style.lineHeight = "1.5";
    element.style.whiteSpace = "pre";
    element.style.color = "#9fe8ff";
    element.style.background = "rgba(0,0,0,0.75)";
    element.style.padding = "6px 8px";
    element.style.borderRadius = "4px";
    document.body.appendChild(element);
    this.element = element;
  }

  get visible(): boolean {
    return this.element !== null && this.element.style.display !== "none";
  }

  toggle(): boolean {
    if (this.element === null) {
      return false;
    }
    const show = this.element.style.display === "none";
    this.element.style.display = show ? "block" : "none";
    if (show) {
      this.lastMs = 0;
      this.refresh();
    }
    return show;
  }

  refresh(): void {
    if (this.element === null || this.element.style.display === "none") {
      return;
    }
    const now = Date.now();
    if (now - this.lastMs < SNAP_DEBUG_REFRESH_MS) {
      return;
    }
    this.lastMs = now;
    this.element.textContent = formatSnapDebug(this.readState());
  }

  dispose(): void {
    if (this.element !== null && this.element.parentElement !== null) {
      this.element.parentElement.removeChild(this.element);
    }
    this.element = null;
  }
}
