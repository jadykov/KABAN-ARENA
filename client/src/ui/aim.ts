import {
  CROSSHAIR_CHARGING_COLOR,
  CROSSHAIR_FULL_COLOR,
  CROSSHAIR_IDLE_COLOR,
  CROSSHAIR_RELOAD_COLOR,
  CROSSHAIR_SUPER_COLOR,
  TRAJ_DOT_LIT_BOOST,
} from "../config";
import { HL_CHARTREUSE_CSS } from "../palette";

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
export const RELOAD_BAR_WIDTH_PX = 120;

// Progressive charge glow (post-playtest fix round 3): dot i lights once the
// charge fraction reaches its threshold (i+1)/N, one by one as the shot
// charges. Pure + unit-testable; the per-frame painter below reads it.
// Dots are a local-only DOM overlay (created per client in createAim, fed
// from the local charge path in main.ts — remotes/spectators never touch
// them), so no spectator/remote handling is needed.
export function trajDotLitThreshold(index: number, count: number = TRAJ_DOT_COUNT): number {
  const safeCount = Number.isFinite(count) && count > 0 ? Math.floor(count) : TRAJ_DOT_COUNT;
  return (index + 1) / safeCount;
}

export function isTrajDotLit(index: number, charge01: number, count: number = TRAJ_DOT_COUNT): boolean {
  if (!Number.isFinite(charge01)) {
    return false;
  }
  return charge01 >= trajDotLitThreshold(index, count);
}

// Throw-polish aim: a fine center reticle + 5
// trajectory dots + Worms-style power bar (120px, bottom-center, charge
// ONLY since Stage 4d.2) + a dedicated thin reload bar right below it
// (same 120px width, highlight fill, 1 = ready; a sibling outside #aim so the
// sweep stays visible while #aim hides during reload — reviewer F1).
// While charging the caller feeds setTrajectory() with the REAL projected
// arc (same v0 from charge power + server gravity), so the dots move with power/aim; the symbolic fan below
// is only a not-charging fallback. Pure DOM overlay, pointer-events none,
// zero WebGL cost. R1/R2 charge/reload/halves/super timing untouched.
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

  const powerCaption = document.createElement("div");
  powerCaption.id = "power-caption";
  powerCaption.textContent = "ЗАРЯД";
  el.appendChild(powerCaption);

  const reloadBar = document.createElement("div");
  reloadBar.id = "reload-bar";
  const reloadFill = document.createElement("div");
  reloadFill.id = "reload-bar-fill";
  reloadBar.appendChild(reloadFill);
  // Reviewer F1 fix: the reload bar lives OUTSIDE #aim as a sibling under
  // the same parent. #aim hides on every shot (stopCharge) while the 2.5s
  // reload sweep runs — a child bar would paint hidden for the whole window
  // and the sweep would never be observable. Fixed positioning makes the DOM
  // parent visually irrelevant; visibility is owned by paintReload below.
  reloadBar.style.display = "none";
  parent.appendChild(reloadBar);
  parent.appendChild(el);

  let disposed = false;
  let superMode = false;
  let lastCharge = 0;
  let lastReload = 0;
  // The caller reuses its projection buffer. Own five slots so later caller
  // mutations cannot change this overlay until the next setTrajectory().
  const customTraj: TrajSample[] = Array.from({ length: TRAJ_DOT_COUNT }, () => ({ x: 0, y: 0, visible: false }));
  let hasCustomTraj = false;
  const paintedDots = trajDots.map(() => ({
    x: Number.NaN, y: Number.NaN, transform: "", opacityValue: Number.NaN, opacity: "", hidden: false, color: "",
  }));
  let paintedDotColor = "";
  let paintedPowerColor = "";
  let paintedPowerPercent = -1;
  let paintedReloadPercent = -1;

  function finiteOr(value: number, fallback: number): number {
    return Number.isFinite(value) ? value : fallback;
  }

  const paintTraj = (): void => {
    const charge = lastCharge;
    const color = superMode ? CROSSHAIR_SUPER_COLOR : CROSSHAIR_IDLE_COLOR;
    for (let i = 0; i < trajDots.length; i += 1) {
      const traj = trajDots[i];
      const painted = paintedDots[i];
      if (traj === undefined || painted === undefined) {
        continue;
      }
      const sample = hasCustomTraj ? customTraj[i] : undefined;
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
      if (painted.x !== x || painted.y !== y) {
        const transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
        if (painted.transform !== transform) {
          traj.style.transform = transform;
          painted.transform = transform;
        }
        painted.x = x;
        painted.y = y;
      }
      const fade = 1 - i * 0.12;
      const baseOpacity = (0.15 + 0.85 * charge) * fade;
      // Progressive glow: a lit dot paints at base x TRAJ_DOT_LIT_BOOST
      // (clamped to 1) — subtle one-by-one brightening with charge. Same
      // pooled divs, opacity scalar only: no new elements, no lights, no
      // draw-call growth. Cancel/reset feeds charge 0 + setTrajectory(null), so every
      // dot falls back to base automatically. Dots are white-on-dark, so
      // opacity IS the brightness channel (a brightness() filter would be a
      // no-op on white — deliberately not used).
      const lit = isTrajDotLit(i, charge, trajDots.length);
      const boosted = lit ? Math.min(1, baseOpacity * TRAJ_DOT_LIT_BOOST) : baseOpacity;
      const opacityValue = hidden ? 0 : boosted;
      if (painted.opacityValue !== opacityValue || painted.hidden !== hidden) {
        const opacity = hidden ? "0" : boosted.toFixed(3);
        if (painted.opacity !== opacity) {
          traj.style.opacity = opacity;
          painted.opacity = opacity;
        }
        painted.opacityValue = opacityValue;
        painted.hidden = hidden;
      }
      if (painted.color !== color) {
        traj.style.background = color;
        painted.color = color;
      }
    }
    if (paintedDotColor !== color) {
      dot.style.background = color;
      paintedDotColor = color;
    }
  };

  const paintBar = (): void => {
    // Stage 4d.2: the power bar is charge-only (reload moved to its own bar
    // below, painted by paintReload). No dual-purpose anymore.
    // Palette ramp (all stops are palette constants, no raw color math):
    // empty white -> charging chartreuse -> FULL muted red. Bar width
    // carries the fine granularity; color carries the band.
    const percent = Math.round(lastCharge * 100);
    if (paintedPowerPercent !== percent) {
      powerFill.style.width = `${percent}%`;
      paintedPowerPercent = percent;
    }
    const state = superMode ? "super" : lastCharge >= 1 ? "full" : lastCharge > 0 ? "charging" : "idle";
    if (el.dataset.state !== state) el.dataset.state = state;
    const caption = lastCharge >= 1 ? "ПОЛНЫЙ ЗАРЯД" : superMode ? "СУПЕРЗАРЯД" : "ЗАРЯД";
    if (powerCaption.textContent !== caption) powerCaption.textContent = caption;
    const t = Math.max(0, Math.min(1, lastCharge));
    const color = superMode && t > 0 ? CROSSHAIR_SUPER_COLOR
      : t >= 1 ? CROSSHAIR_FULL_COLOR : t > 0 ? HL_CHARTREUSE_CSS : CROSSHAIR_CHARGING_COLOR;
    if (paintedPowerColor !== color) {
      powerFill.style.background = color;
      paintedPowerColor = color;
    }
  };

  // Dedicated reload bar: highlight fill, 1 = ready, 0 = just fired. Owns its own
  // visibility: shown only mid-sweep (strictly between 0 and 1) so the fill
  // is observable end-to-end after a shot; idle (0) and ready (1) hide it so
  // no permanent bar sits on screen (spectator/pre-join included).
  const paintReload = (): void => {
    const percent = Math.round(lastReload * 100);
    if (paintedReloadPercent !== percent) {
      reloadFill.style.width = `${percent}%`;
      paintedReloadPercent = percent;
    }
    const display = lastReload > 0 && lastReload < 1 ? "" : "none";
    if (reloadBar.style.display !== display) reloadBar.style.display = display;
  };

  reloadFill.style.background = CROSSHAIR_RELOAD_COLOR;
  paintTraj();
  paintBar();
  paintReload();

  const handle: AimHandle = {
    el,
    setCharge01(value: number): void {
      const charge = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
      if (lastCharge === charge) return;
      lastCharge = charge;
      paintTraj();
      paintBar();
    },
    setReload01(value: number): void {
      const reload = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
      if (lastReload === reload) return;
      lastReload = reload;
      paintReload();
    },
    setSuper(active: boolean): void {
      const superActive = active === true;
      if (superMode === superActive) return;
      superMode = superActive;
      paintTraj();
      paintBar();
    },
    setTrajectory(samples: readonly TrajSample[] | null): void {
      const useCustom = samples !== null && samples.length >= TRAJ_DOT_COUNT;
      let changed = hasCustomTraj !== useCustom;
      if (useCustom && samples !== null) {
        for (let i = 0; i < TRAJ_DOT_COUNT; i += 1) {
          const sample = samples[i];
          const stored = customTraj[i];
          if (sample === undefined || stored === undefined) continue;
          const x = finiteOr(sample.x, 0);
          const y = finiteOr(sample.y, 0);
          const visible = sample.visible === true;
          if (stored.x !== x || stored.y !== y || stored.visible !== visible) changed = true;
          stored.x = x;
          stored.y = y;
          stored.visible = visible;
        }
      }
      hasCustomTraj = useCustom;
      if (changed) paintTraj();
    },
    show(): void {
      if (el.style.display !== "") el.style.display = "";
    },
    hide(): void {
      if (el.style.display !== "none") el.style.display = "none";
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      if (el.parentElement === parent) {
        parent.removeChild(el);
      }
      if (reloadBar.parentElement === parent) {
        parent.removeChild(reloadBar);
      }
    },
  };
  return handle;
}
