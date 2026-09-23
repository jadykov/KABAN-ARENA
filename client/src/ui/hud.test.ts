import { beforeEach, describe, expect, it } from "vitest";
import { KILLFEED_MAX_LINES, KILLFEED_OPACITY } from "../config";
import { createHud } from "./hud";

// Minimal DOM stub (same pattern as ui/aim.test.ts: vitest runs in node with
// no jsdom, and createHud only needs createElement/style/textContent +
// appendChild/prepend/removeChild). Extended with textContent, prepend and
// lastElementChild, which the killfeed path uses.
class FakeElement {
  public id = "";
  public className = "";
  public textContent = "";
  public readonly dataset: Record<string, string> = {};
  public readonly style: Record<string, string> = {};
  public readonly children: FakeElement[] = [];
  public parentElement: FakeElement | null = null;

  public appendChild(child: FakeElement): FakeElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  public prepend(child: FakeElement): void {
    child.parentElement = this;
    this.children.unshift(child);
  }

  public removeChild(child: FakeElement): void {
    const index = this.children.indexOf(child);
    if (index >= 0) {
      this.children.splice(index, 1);
      child.parentElement = null;
    }
  }

  public get lastElementChild(): FakeElement | null {
    return this.children.length > 0 ? (this.children[this.children.length - 1] as FakeElement) : null;
  }

  public querySelectorAll(selector: string): FakeElement[] {
    if (selector.startsWith(".")) {
      const wanted = selector.slice(1);
      return this.children.filter((child) => child.className.split(" ").includes(wanted));
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

function killfeedOf(handle: { element: HTMLDivElement }): FakeElement {
  const root = handle.element as unknown as FakeElement;
  const feed = root.querySelector("#hud-killfeed");
  if (feed === null) {
    throw new Error("hud killfeed container missing");
  }
  return feed;
}

beforeEach(() => {
  installFakeDocument();
});

// Owner 4d.4 event feed: brief join/kill/pickup one-liners, newest on top, at
// most KILLFEED_MAX_LINES visible, painted at KILLFEED_OPACITY.
describe("createHud killfeed (event feed)", () => {
  it("keeps only the newest KILLFEED_MAX_LINES entries, newest on top", () => {
    expect(KILLFEED_MAX_LINES).toBe(1);
    const parent = new FakeElement();
    const handle = createHud(asHtml(parent));
    try {
      handle.addKillfeed("first");
      let feed = killfeedOf(handle);
      expect(feed.children).toHaveLength(1);
      expect(feed.children[0]?.textContent).toBe("first");
      // Second event drops "first" — the feed holds exactly one line.
      handle.addKillfeed("second");
      feed = killfeedOf(handle);
      expect(feed.children).toHaveLength(1);
      expect(feed.children[0]?.textContent).toBe("second");
      // Third event drops the oldest ("second"), newest stays on top.
      handle.addKillfeed("third");
      feed = killfeedOf(handle);
      expect(feed.children).toHaveLength(KILLFEED_MAX_LINES);
      expect(feed.children[0]?.textContent).toBe("third");
    } finally {
      handle.dispose();
    }
  });

  it("paints entries at KILLFEED_OPACITY", () => {
    const parent = new FakeElement();
    const handle = createHud(asHtml(parent));
    try {
      handle.addKillfeed("Alpha fragged Beta");
      const feed = killfeedOf(handle);
      expect(feed.children).toHaveLength(1);
      expect(feed.children[0]?.style.opacity).toBe(String(KILLFEED_OPACITY));
      handle.addKillfeed("Gamma joined the fight");
      for (const entry of feed.children) {
        expect(entry.style.opacity).toBe(String(KILLFEED_OPACITY));
      }
    } finally {
      handle.dispose();
    }
  });

  it("renders kill/join/pickup one-liners verbatim", () => {
    const cases = [
      "Alpha fragged Beta",
      "Gamma joined the fight",
      "Delta grabbed SUPER core (x2 next shot)",
    ];
    for (const message of cases) {
      const parent = new FakeElement();
      const handle = createHud(asHtml(parent));
      try {
        handle.addKillfeed(message);
        const feed = killfeedOf(handle);
        expect(feed.children).toHaveLength(1);
        expect(feed.children[0]?.textContent).toBe(message);
        expect(feed.children[0]?.className).toBe("killfeed-entry");
      } finally {
        handle.dispose();
      }
    }
  });

  it("dispose removes the HUD from its parent and is idempotent", () => {
    const parent = new FakeElement();
    const handle = createHud(asHtml(parent));
    const root = handle.element as unknown as FakeElement;
    expect(parent.children).toContain(root);
    handle.dispose();
    expect(parent.children).not.toContain(root);
    expect(root.parentElement).toBe(null);
    // Second dispose is a safe no-op (never throws, never touches the parent).
    handle.dispose();
    expect(parent.children).toHaveLength(0);
  });
});
