import {
  CROSSHAIR_CHARGING_COLOR,
  CROSSHAIR_FULL_COLOR,
  CROSSHAIR_RELOAD_COLOR,
  CROSSHAIR_SUPER_COLOR,
} from "../config";

export interface AimHandle {
  el: HTMLDivElement;
  setCharge01(value: number): void;
  setReload01(value: number): void;
  setSuper(active: boolean): void;
  // Honest preview: screen-space offsets (px from screen center) sampled
  // from the real parabola by the caller (same v0 + gravity as the server).
  // Null restores the symbolic fan fallback (used when not charging).
  setTrajectory(samples: readonly TrajSample[] | null): void;
  show(): void;
  hide(): void;
  dispose(): void;
}

export interface TrajSample {
  x: number;
  y: number;
  visible: boolean;
}

export const TRAJ_DOT_COUNT = 5;
export const POWER_BAR_WIDTH_PX = 120;

// Throw-polish aim: tiny symbolic center dot (4px, 40% opacity) + 5
// trajectory dots + Worms-style power bar (120px, bottom-center). While
// charging the caller feeds setTrajectory() with the REAL projected arc
// (same v0 from charge power + server gravity), so the dots move with
// power/aim; the symbolic fan below is only a not-charging fallback.
// Reload uses the bar only (blue fill). Pure DOM overlay, pointer-events
// none, zero WebGL cost. R1/R2 charge/reload/halves/super timing untouched.
export function createAim(parent: HTMLElement): AimHandle {
  const el = document.createElement("div");
  el.id = "aim";

  const dot = document.createElement("div");
  dot.id = "aim-dot";
  el.appendChild(dot);

  const trajDots: HTMLDivElement[] = [];
  for (let i = 0; i < TRAJ_DOT_COUNT; i += 1) {
    const traj = document.createElement("div");
    traj.className = "traj-dot";
    traj.dataset.index = String(i);
    el.appendChild(traj);
    trajDots.push(traj);
  }

  const powerBar = document.createElement("div");
  powerBar.id = "power-bar";
  const powerFill = document.createElement("div");
  powerFill.id = "power-bar-fill";
  powerBar.appendChild(powerFill);
  el.appendChild(powerBar);
  parent.appendChild(el);

  let disposed = false;
  let superMode = false;
  let lastCharge = 0;
  let lastReload = 0;
  let customTraj: TrajSample[] | null = null;

  const isReloading = (): boolean => lastReload > 0 && lastReload < 1;

  function finiteOr(value: number, fallback: number): number {
    return Number.isFinite(value) ? value : fallback;
  }

  const paintTraj = (): void => {
    const charge = lastCharge;
    const color = superMode ? CROSSHAIR_SUPER_COLOR : "#ffffff";
    const useCustom = customTraj !== null && customTraj.length === trajDots.length;
    for (let i = 0; i < trajDots.length; i += 1) {
      const traj = trajDots[i];
      if (traj === undefined) {
        continue;
      }
      const sample = useCustom && customTraj !== null ? customTraj[i] : undefined;
      let x: number;
      let y: number;
      let hidden = false;
      if (sample !== undefined) {
        x = finiteOr(sample.x, 0);
        y = finiteOr(sample.y, 0);
        hidden = sample.visible !== true;
      } else {
        const fanX = (i - 2) * 9;
        const baseY = -(14 + i * 11);
        const lengthScale = 0.45 + 0.55 * charge;
        x = fanX * lengthScale;
        y = baseY * lengthScale;
      }
      traj.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      const fade = 1 - i * 0.12;
      const baseOpacity = (0.15 + 0.85 * charge) * fade;
      traj.style.opacity = hidden ? "0" : baseOpacity.toFixed(3);
      traj.style.background = color;
    }
    dot.style.background = superMode ? CROSSHAIR_SUPER_COLOR : "#ffffff";
  };

  const paintBar = (): void => {
    if (isReloading()) {
      powerFill.style.width = `${Math.round(lastReload * 100)}%`;
      powerFill.style.background = CROSSHAIR_RELOAD_COLOR;
      return;
    }
    powerFill.style.width = `${Math.round(lastCharge * 100)}%`;
    if (superMode && lastCharge > 0) {
      powerFill.style.background = CROSSHAIR_SUPER_COLOR;
      return;
    }
    // Worms ramp: yellow -> red as charge grows.
    const t = Math.max(0, Math.min(1, lastCharge));
    if (t >= 1) {
      powerFill.style.background = CROSSHAIR_FULL_COLOR;
    } else if (t > 0) {
      const hue = Math.round(48 - 48 * t);
      powerFill.style.background = `hsl(${hue} 100% 55%)`;
    } else {
      powerFill.style.background = CROSSHAIR_CHARGING_COLOR;
    }
  };

  const repaint = (): void => {
    paintTraj();
    paintBar();
  };
  repaint();

  const handle: AimHandle = {
    el,
    setCharge01(value: number): void {
      lastCharge = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
      repaint();
    },
    setReload01(value: number): void {
      lastReload = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
      repaint();
    },
    setSuper(active: boolean): void {
      superMode = active === true;
      repaint();
    },
    setTrajectory(samples: readonly TrajSample[] | null): void {
      if (samples === null) {
        customTraj = null;
      } else {
        customTraj = samples.slice(0, TRAJ_DOT_COUNT).map((sample) => ({
          x: finiteOr(sample.x, 0),
          y: finiteOr(sample.y, 0),
          visible: sample.visible === true,
        }));
      }
      repaint();
    },
    show(): void {
      el.style.display = "";
    },
    hide(): void {
      el.style.display = "none";
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      if (el.parentElement === parent) {
        parent.removeChild(el);
      }
    },
  };
  return handle;
}
