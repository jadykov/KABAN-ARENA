import { beforeEach, describe, expect, it } from "vitest";
import {
  CROSSHAIR_CHARGING_COLOR,
  CROSSHAIR_FULL_COLOR,
  CROSSHAIR_RELOAD_COLOR,
  TRAJ_DOT_LIT_BOOST,
} from "../config";
import { HL_CHARTREUSE_CSS } from "../palette";
import {
  POWER_BAR_WIDTH_PX,
  RELOAD_BAR_WIDTH_PX,
  TRAJ_DOT_COUNT,
  createAim,
  isTrajDotLit,
  trajDotLitThreshold,
} from "./aim";

// Minimal DOM stub: vitest runs in node (no jsdom installed, no installs
// allowed), and createAim only needs createElement/style/dataset/appendChild.
class FakeElement {
  public id = "";
  public className = "";
  public readonly dataset: Record<string, string> = {};
  public readonly style: Record<string, string> = {};
  public readonly children: FakeElement[] = [];
  public parentElement: FakeElement | null = null;

  public appendChild(child: FakeElement): FakeElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  public removeChild(child: FakeElement): void {
    const index = this.children.indexOf(child);
    if (index >= 0) {
      this.children.splice(index, 1);
      child.parentElement = null;
    }
  }

  public querySelectorAll(selector: string): FakeElement[] {
    if (selector.startsWith(".")) {
      const wanted = selector.slice(1);
      return this.children.filter((child) =>
        child.className.split(" ").includes(wanted),
      );
    }
    if (selector.startsWith("#")) {
      const wanted = selector.slice(1);
      const found = this.children.find((child) => child.id === wanted);
      return found === undefined ? [] : [found];
    }
    return [];
  }

  public querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function installFakeDocument(): void {
  const fakeDocument = {
    createElement: (): FakeElement => new FakeElement(),
  };
  (globalThis as unknown as Record<string, unknown>)["document"] = fakeDocument;
}

function asHtml(element: FakeElement): HTMLElement {
  return element as unknown as HTMLElement;
}

beforeEach(() => {
  installFakeDocument();
});

// Throw-polish aim: symbolic dot + 5 traj dots + Worms power bar, no SVG.
describe("createAim throw-polish markup", () => {
  it("builds dot + 5 traj dots + power bar + reload bar with no SVG ring/spinner", () => {
    expect(TRAJ_DOT_COUNT).toBe(5);
    expect(POWER_BAR_WIDTH_PX).toBe(120);
    expect(RELOAD_BAR_WIDTH_PX).toBe(120);
    const parent = new FakeElement();
    const handle = createAim(asHtml(parent));
    try {
      const el = handle.el as unknown as FakeElement;
      expect(el.id).toBe("aim");
      expect(el.querySelector("#aim-dot")).not.toBe(null);
      expect(el.querySelectorAll(".traj-dot")).toHaveLength(5);
      const bar = el.querySelector("#power-bar");
      expect(bar).not.toBe(null);
      expect(bar?.querySelector("#power-bar-fill")).not.toBe(null);
      // Reviewer F1: the reload bar is a sibling OUTSIDE #aim (never a
      // child), so the sweep stays visible while #aim hides during reload.
      expect(el.querySelector("#reload-bar")).toBe(null);
      const reload = parent.querySelector("#reload-bar");
      expect(reload).not.toBe(null);
      expect(reload?.querySelector("#reload-bar-fill")).not.toBe(null);
      const svgChild = el.children.find((child) => child.id === "svg");
      expect(svgChild).toBe(undefined);
      expect(parent.children).toContain(el);
    } finally {
      handle.dispose();
    }
  });

  it("scales traj opacity/length with charge and fills the bar white->chartreuse->red", () => {
    const parent = new FakeElement();
    const handle = createAim(asHtml(parent));
    try {
      const el = handle.el as unknown as FakeElement;
      const dots = el.querySelectorAll(".traj-dot");
      const faint = dots.map((dot) => dot.style.opacity);
      handle.setCharge01(1);
      const charged = dots.map((dot) => dot.style.opacity);
      for (let i = 0; i < dots.length; i += 1) {
        expect(Number(charged[i])).toBeGreaterThan(Number(faint[i]));
      }
      const fill = el.querySelector("#power-bar")?.querySelector("#power-bar-fill");
      expect(fill?.style.width).toBe("100%");
      expect(fill?.style.background).not.toBe(CROSSHAIR_RELOAD_COLOR);
      expect(fill?.style.background).toBe(CROSSHAIR_FULL_COLOR);
      handle.setCharge01(0.5);
      expect(fill?.style.width).toBe("50%");
      // Palette ramp pin: mid-charge is chartreuse, empty is charging white.
      expect(fill?.style.background).toBe(HL_CHARTREUSE_CSS);
      handle.setCharge01(0);
      expect(fill?.style.width).toBe("0%");
      expect(fill?.style.background).toBe(CROSSHAIR_CHARGING_COLOR);
    } finally {
      handle.dispose();
    }
  });

  it("keeps the power bar charge-only while reload paints its own bar chartreuse", () => {
    const parent = new FakeElement();
    const handle = createAim(asHtml(parent));
    try {
      const el = handle.el as unknown as FakeElement;
      handle.setCharge01(0.6);
      handle.setReload01(0.5);
      // Power bar ignores reload (charge-only since Stage 4d.2): at 0.6 the
      // palette ramp paints chartreuse — width (60% vs the reload bar's
      // 50%) proves the bars are independent, not color.
      const fill = el.querySelector("#power-bar")?.querySelector("#power-bar-fill");
      expect(fill?.style.width).toBe("60%");
      expect(fill?.style.background).toBe(HL_CHARTREUSE_CSS);
      // Dedicated reload bar shows progress in chartreuse.
      const reloadFill = parent.querySelector("#reload-bar")?.querySelector("#reload-bar-fill");
      expect(reloadFill?.style.width).toBe("50%");
      expect(reloadFill?.style.background).toBe(CROSSHAIR_RELOAD_COLOR);
      // Ready = full bar; firing = empty bar.
      handle.setReload01(1);
      expect(reloadFill?.style.width).toBe("100%");
      handle.setReload01(0);
      expect(reloadFill?.style.width).toBe("0%");
      // Reload activity never touches the charge bar.
      expect(fill?.style.width).toBe("60%");
    } finally {
      handle.dispose();
    }
  });

  it("show/hide/dispose keep the AimHandle contract", () => {
    const parent = new FakeElement();
    const handle = createAim(asHtml(parent));
    const el = handle.el as unknown as FakeElement;
    const reload = parent.querySelector("#reload-bar");
    handle.hide();
    expect(el.style.display).toBe("none");
    handle.show();
    expect(el.style.display).toBe("");
    handle.dispose();
    expect(parent.children).not.toContain(el);
    expect(reload).not.toBe(null);
    if (reload !== null) {
      expect(parent.children).not.toContain(reload);
    }
  });

  // Reviewer F1: the reload sweep must be VISIBLE end-to-end. Pre-fix the
  // bar was a child of #aim, so stopCharge's hide() buried the whole 2.5s
  // sweep in a display:none subtree — this test asserts visibility (not
  // just paint) and fails on that behavior.
  it("shows the reload sweep while #aim is hidden, hides it when ready", () => {
    const parent = new FakeElement();
    const handle = createAim(asHtml(parent));
    try {
      const el = handle.el as unknown as FakeElement;
      const reload = parent.querySelector("#reload-bar");
      expect(reload).not.toBe(null);
      if (reload === null) {
        return;
      }
      const reloadFill = reload.querySelector("#reload-bar-fill");
      expect(reloadFill).not.toBe(null);
      // Idle: no permanent bar on screen.
      expect(reload.style.display).toBe("none");
      // Shot: #aim hides (stopCharge path) while the reload feed starts.
      handle.hide();
      expect(el.style.display).toBe("none");
      handle.setReload01(0.25);
      expect(reload.style.display).toBe("");
      expect(reloadFill?.style.width).toBe("25%");
      handle.setReload01(0.75);
      expect(reload.style.display).toBe("");
      expect(reloadFill?.style.width).toBe("75%");
      // Reload complete / ready: bar hides again (no visual noise).
      handle.setReload01(1);
      expect(reloadFill?.style.width).toBe("100%");
      expect(reload.style.display).toBe("none");
    } finally {
      handle.dispose();
    }
  });
});

// Precision pass: setTrajectory places dots on the real projected arc;
// null restores the symbolic fan fallback.
describe("createAim honest trajectory preview", () => {
  it("positions dots from samples and hides behind-camera dots", () => {
    const parent = new FakeElement();
    const handle = createAim(asHtml(parent));
    try {
      const el = handle.el as unknown as FakeElement;
      handle.setCharge01(1);
      handle.setTrajectory([
        { x: 10, y: -20, visible: true },
        { x: 20, y: -35, visible: true },
        { x: 30, y: -45, visible: false },
        { x: 40, y: -50, visible: true },
        { x: 50, y: -52, visible: true },
      ]);
      const dots = el.querySelectorAll(".traj-dot");
      expect(dots).toHaveLength(5);
      expect(dots[0]?.style.transform).toBe("translate(10.0px, -20.0px)");
      expect(dots[1]?.style.transform).toBe("translate(20.0px, -35.0px)");
      expect(dots[2]?.style.opacity).toBe("0");
      expect(dots[3]?.style.opacity).not.toBe("0");
      handle.setTrajectory(null);
      expect(dots[0]?.style.transform).not.toBe("translate(10.0px, -20.0px)");
    } finally {
      handle.dispose();
    }
  });
});

// Fix round 3: trajectory dots light up slightly brighter ONE BY ONE as the
// shot charges — dot i lights when charge01 reaches (i+1)/N. Opacity scalar
// on the pooled divs only (white-on-dark, so opacity is the brightness
// channel); no new elements, no lights, no draw-call growth.
describe("trajectory dots progressive glow (fix round 3)", () => {
  // Painter contract mirror (constant-referenced, not hardcoded): base =
  // (0.15 + 0.85*charge) * (1 - i*0.12); lit -> min(1, base * BOOST).
  function expectedOpacity(index: number, charge: number): string {
    const fade = 1 - index * 0.12;
    const base = (0.15 + 0.85 * charge) * fade;
    const lit = charge >= (index + 1) / TRAJ_DOT_COUNT;
    return (lit ? Math.min(1, base * TRAJ_DOT_LIT_BOOST) : base).toFixed(3);
  }

  function visibleSamples(): Array<{ x: number; y: number; visible: boolean }> {
    return [
      { x: 10, y: -20, visible: true },
      { x: 20, y: -35, visible: true },
      { x: 30, y: -45, visible: true },
      { x: 40, y: -50, visible: true },
      { x: 50, y: -52, visible: true },
    ];
  }

  it("lights dot i exactly when charge01 reaches (i+1)/N, one by one", () => {
    expect(TRAJ_DOT_LIT_BOOST).toBeCloseTo(1.6, 12);
    for (let i = 0; i < TRAJ_DOT_COUNT; i += 1) {
      const threshold = (i + 1) / TRAJ_DOT_COUNT;
      expect(trajDotLitThreshold(i)).toBeCloseTo(threshold, 12);
      // Just below the threshold the dot stays dark ...
      expect(isTrajDotLit(i, threshold - 1e-3)).toBe(false);
      // ... at and above it the dot is lit (boundary inclusive).
      expect(isTrajDotLit(i, threshold)).toBe(true);
      expect(isTrajDotLit(i, threshold + 0.2)).toBe(true);
    }
    // At charge 0 nothing is lit; at full charge everything is.
    for (let i = 0; i < TRAJ_DOT_COUNT; i += 1) {
      expect(isTrajDotLit(i, 0)).toBe(false);
      expect(isTrajDotLit(i, 1)).toBe(true);
    }
    // Non-finite charge never lights a dot.
    expect(isTrajDotLit(0, Number.NaN)).toBe(false);
  });

  it("boosts lit dots to min(1, base x BOOST), leaves unlit dots at base (charge 0.35)", () => {
    const parent = new FakeElement();
    const handle = createAim(asHtml(parent));
    try {
      const el = handle.el as unknown as FakeElement;
      handle.setCharge01(0.35);
      handle.setTrajectory(visibleSamples());
      const dots = el.querySelectorAll(".traj-dot");
      expect(dots).toHaveLength(TRAJ_DOT_COUNT);
      // Dot 0 (threshold 0.2) is lit, dot 1 (threshold 0.4) is not.
      expect(dots[0]?.style.opacity).toBe(expectedOpacity(0, 0.35));
      expect(dots[1]?.style.opacity).toBe(expectedOpacity(1, 0.35));
      // Spot pins: base 0.4475 -> lit 0.716 vs unlit 0.394 (subtle, distinct).
      expect(dots[0]?.style.opacity).toBe("0.716");
      expect(dots[1]?.style.opacity).toBe("0.394");
      expect(Number(dots[0]?.style.opacity)).toBeGreaterThan(Number(dots[1]?.style.opacity));
      // Dots 2-4 (thresholds 0.6/0.8/1.0) stay at base too.
      for (const i of [2, 3, 4]) {
        expect(dots[i]?.style.opacity).toBe(expectedOpacity(i, 0.35));
      }
    } finally {
      handle.dispose();
    }
  });

  it("flips exactly one dot across its threshold (0.59 -> 0.61 on dot 2, threshold 0.6)", () => {
    const parent = new FakeElement();
    const handle = createAim(asHtml(parent));
    try {
      const el = handle.el as unknown as FakeElement;
      handle.setTrajectory(visibleSamples());
      handle.setCharge01(0.59);
      const before = el.querySelectorAll(".traj-dot").map((dot) => dot.style.opacity);
      handle.setCharge01(0.61);
      const after = el.querySelectorAll(".traj-dot").map((dot) => dot.style.opacity);
      // Dot 2 crosses 0.6: base "0.495" -> boosted "0.813" (~x1.6 step).
      expect(before[2]).toBe(expectedOpacity(2, 0.59));
      expect(before[2]).toBe("0.495");
      expect(after[2]).toBe(expectedOpacity(2, 0.61));
      expect(after[2]).toBe("0.813");
      expect(Number(after[2]) / Number(before[2])).toBeCloseTo(TRAJ_DOT_LIT_BOOST, 1);
      // Neighbors keep their state: dot 1 stays lit, dot 3 stays unlit.
      expect(before[1]).toBe(expectedOpacity(1, 0.59));
      expect(after[1]).toBe(expectedOpacity(1, 0.61));
      expect(Number(after[1])).toBeGreaterThan(Number(before[1]));
      expect(after[3]).toBe(expectedOpacity(3, 0.61));
      expect(Number(after[3])).toBeLessThan(Number(after[2]));
    } finally {
      handle.dispose();
    }
  });

  it("returns every dot to base on cancel/reset (charge 0 + setTrajectory(null))", () => {
    const parent = new FakeElement();
    const handle = createAim(asHtml(parent));
    const freshParent = new FakeElement();
    const fresh = createAim(asHtml(freshParent));
    try {
      const el = handle.el as unknown as FakeElement;
      // Charge hard with the real arc, several dots lit ...
      handle.setCharge01(0.9);
      handle.setTrajectory(visibleSamples());
      const lit = el.querySelectorAll(".traj-dot").map((dot) => dot.style.opacity);
      expect(Number(lit[0])).toBeGreaterThan(Number(expectedOpacity(1, 0)));
      // ... then the cancelCharge/stopCharge path: charge 0 + null samples.
      handle.setCharge01(0);
      handle.setTrajectory(null);
      const reset = el.querySelectorAll(".traj-dot").map((dot) => dot.style.opacity);
      const freshBase = (fresh.el as unknown as FakeElement)
        .querySelectorAll(".traj-dot")
        .map((dot) => dot.style.opacity);
      expect(reset).toEqual(freshBase);
      for (let i = 0; i < TRAJ_DOT_COUNT; i += 1) {
        expect(reset[i]).toBe(expectedOpacity(i, 0));
      }
    } finally {
      handle.dispose();
      fresh.dispose();
    }
  });

  it("reuses the same pooled divs across repaints (no new elements)", () => {
    const parent = new FakeElement();
    const handle = createAim(asHtml(parent));
    try {
      const el = handle.el as unknown as FakeElement;
      const first = el.querySelectorAll(".traj-dot");
      expect(first).toHaveLength(TRAJ_DOT_COUNT);
      // Many repaint cycles: charge sweep + trajectory swaps + super toggle.
      for (const charge of [0, 0.2, 0.45, 0.7, 1, 0.33, 0]) {
        handle.setCharge01(charge);
        handle.setTrajectory(visibleSamples());
        handle.setSuper(charge > 0.5);
      }
      handle.setTrajectory(null);
      handle.setSuper(false);
      const after = el.querySelectorAll(".traj-dot");
      expect(after).toHaveLength(TRAJ_DOT_COUNT);
      for (let i = 0; i < TRAJ_DOT_COUNT; i += 1) {
        expect(after[i]).toBe(first[i]);
      }
    } finally {
      handle.dispose();
    }
  });
});
