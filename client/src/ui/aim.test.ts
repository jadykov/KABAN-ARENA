import { beforeEach, describe, expect, it } from "vitest";
import { CROSSHAIR_RELOAD_COLOR } from "../config";
import { POWER_BAR_WIDTH_PX, RELOAD_BAR_WIDTH_PX, TRAJ_DOT_COUNT, createAim } from "./aim";

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

  it("scales traj opacity/length with charge and fills the bar yellow->red", () => {
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
      handle.setCharge01(0.5);
      expect(fill?.style.width).toBe("50%");
    } finally {
      handle.dispose();
    }
  });

  it("keeps the power bar charge-only while reload paints its own bar blue", () => {
    const parent = new FakeElement();
    const handle = createAim(asHtml(parent));
    try {
      const el = handle.el as unknown as FakeElement;
      handle.setCharge01(0.6);
      handle.setReload01(0.5);
      // Power bar ignores reload (charge-only since Stage 4d.2).
      const fill = el.querySelector("#power-bar")?.querySelector("#power-bar-fill");
      expect(fill?.style.width).toBe("60%");
      expect(fill?.style.background).not.toBe(CROSSHAIR_RELOAD_COLOR);
      // Dedicated reload bar shows progress in blue.
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
