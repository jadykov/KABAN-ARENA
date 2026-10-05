import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { KILLFEED_MAX_LINES, KILLFEED_OPACITY } from "../config";
import { SUPER_BONUSES } from "../../../shared/super-bonuses.mjs";
import { createHud, localizeKillfeed, localizePowerUp } from "./hud";

const gameStyles = readFileSync(new URL("../style.css", import.meta.url), "utf8");

// Minimal DOM stub (same pattern as ui/aim.test.ts: vitest runs in node with
// no jsdom, and createHud only needs createElement/style/textContent +
// appendChild/prepend/removeChild). Extended with textContent, prepend and
// lastElementChild, which the killfeed path uses.
class FakeElement {
  public constructor(public readonly tagName = "div") {}
  public id = "";
  public className = "";
  public readonly writes: string[] = [];
  private text = "";
  public get textContent(): string { return this.text; }
  public set textContent(value: string) { this.text = value; this.writes.push("textContent"); }
  public readonly dataset: Record<string, string> = {};
  public readonly style = new Proxy<Record<string, string>>({}, {
    set: (target, name, value: string): boolean => {
      this.writes.push(`style.${String(name)}`);
      return Reflect.set(target, name, value);
    },
  });
  public readonly attributes: Record<string, string> = {};
  public readonly children: FakeElement[] = [];
  public parentElement: FakeElement | null = null;

  public setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
    this.writes.push(`attribute.${name}`);
  }

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
    createElement: (tagName: string): FakeElement => new FakeElement(tagName),
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

// The top-left info lines live nested (root > #hud-info > lines) while the
// FakeElement querySelector only sees direct children — walk the tree.
function byId(handle: { element: HTMLDivElement }, id: string): FakeElement {
  const root = handle.element as unknown as FakeElement;
  const queue: FakeElement[] = [root];
  while (queue.length > 0) {
    const current = queue.shift() as FakeElement;
    if (current.id === id) {
      return current;
    }
    queue.push(...current.children);
  }
  throw new Error(`hud element #${id} missing`);
}

function allElements(element: FakeElement): FakeElement[] {
  return [element, ...element.children.flatMap(allElements)];
}

function clearWrites(handle: { element: HTMLDivElement }): void {
  for (const child of allElements(handle.element as unknown as FakeElement)) child.writes.length = 0;
}

function writesOf(handle: { element: HTMLDivElement }): string[] {
  return allElements(handle.element as unknown as FakeElement).flatMap((child) => child.writes);
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

// Phone-playtest HUD layout: timer + Players/Watching counters live in the
// top-left #hud-info list; score + transient status live in the right-side
// #hud-score-block (no centered topbar exists anymore); hearts stay centered
// alone at center top, untouched.
describe("createHud top-left info list", () => {
  it("writes the timer and counter lines via the new setters", () => {
    const parent = new FakeElement();
    const handle = createHud(asHtml(parent));
    try {
      expect(byId(handle, "hud-info-timer").textContent).toBe("3:00");
      expect(byId(handle, "hud-info-players").textContent).toBe("Игроки: 0");
      expect(byId(handle, "hud-info-watching").textContent).toBe("Зрители: 0");
      handle.setTimer(65);
      expect(byId(handle, "hud-info-timer").textContent).toBe("1:05");
      handle.setPlayers(3);
      expect(byId(handle, "hud-info-players").textContent).toBe("Игроки: 3");
      handle.setWatching(2);
      expect(byId(handle, "hud-info-watching").textContent).toBe("Зрители: 2");
      handle.setCounters(5, 1);
      expect(byId(handle, "hud-info-players").textContent).toBe("Игроки: 5");
      expect(byId(handle, "hud-info-watching").textContent).toBe("Зрители: 1");
    } finally {
      handle.dispose();
    }
  });

  it("keeps score + transient status in the right score block (no topbar)", () => {
    const parent = new FakeElement();
    const handle = createHud(asHtml(parent));
    try {
      const root = handle.element as unknown as FakeElement;
      const scoreBlock = root.querySelector("#hud-score-block");
      if (scoreBlock === null) {
        throw new Error("hud score block missing");
      }
      expect(scoreBlock.querySelector("#hud-score")).not.toBe(null);
      expect(scoreBlock.querySelector("#hud-status")).not.toBe(null);
      expect(scoreBlock.querySelector("#hud-timer")).toBe(null);
      expect(scoreBlock.querySelector("#hud-info-timer")).toBe(null);
      // The centered topbar pill is gone entirely (center top = hearts only).
      expect(root.querySelector("#hud-topbar")).toBe(null);
      handle.setScore(7);
      expect(byId(handle, "hud-score").textContent).toBe("7");
      expect(byId(handle, "hud-score-label").textContent).toBe("СЧЁТ");
      expect(byId(handle, "hud-score").attributes["aria-label"]).toBe("Счёт: 7");
      handle.setStatus("Возрождение…");
      expect(byId(handle, "hud-status").textContent).toBe("Возрождение…");
      // Hearts container still a direct centered child of the root, untouched.
      expect(root.querySelector("#hud-hearts")).not.toBe(null);
      expect(byId(handle, "hud-hearts").textContent).toBeDefined();
    } finally {
      handle.dispose();
    }
  });

  it("announces health and renders a half heart as a heart glyph", () => {
    const parent = new FakeElement();
    const handle = createHud(asHtml(parent));
    try {
      handle.setHearts(5);
      const hearts = byId(handle, "hud-hearts");
      expect(hearts.attributes.role).toBe("img");
      expect(hearts.attributes["aria-label"]).toBe("Здоровье: 5 из 8 половинок сердца");
      expect(hearts.children.find((heart) => heart.className === "heart heart-half")?.textContent).toBe("♥");
    } finally {
      handle.dispose();
    }
  });

  it("keeps shield capacity separate from health and times all three active buffs", () => {
    const parent = new FakeElement();
    const handle = createHud(asHtml(parent));
    try {
      handle.setHearts(5);
      handle.setBuffs({
        shield: { seconds: 9.94, hp: 12.5 },
        speed: { seconds: 4.23 },
        charge: { seconds: 10 },
      });
      const hearts = byId(handle, "hud-hearts");
      expect(hearts.children.filter((child) => child.className.startsWith("heart "))).toHaveLength(4);
      expect(hearts.attributes["aria-label"]).toBe("Здоровье: 5 из 8 половинок сердца; щит: 13 из 25 прочности");
      expect(byId(handle, "hud-shield-heart").style.display).toBe("");
      expect(byId(handle, "hud-shield-heart").attributes["aria-label"]).toBe("Щит: 13 из 25 прочности");
      expect(byId(handle, "hud-shield-capacity").style.width).toBe("50%");
      const rows = byId(handle, "hud-buffs").children;
      expect(rows.map((row) => row.attributes["data-kind"])).toEqual(["shield", "speed", "charge"]);
      expect(rows.map((row) => row.children[2]?.textContent)).toEqual(["10.0 с", "4.3 с", "10.0 с"]);
      expect(rows.map((row) => (row.children[0] as unknown as { src: string }).src)).toEqual([
        "/icons/bonus-shield.svg", "/icons/bonus-speed.svg", "/icons/bonus-charge.svg",
      ]);
      handle.setBuffs({ charge: { seconds: 0.04 } });
      expect(rows.map((row) => row.style.display)).toEqual(["none", "none", ""]);
      expect(byId(handle, "hud-shield-heart").style.display).toBe("none");
      handle.setBuffs({});
      expect(rows.every((row) => row.style.display === "none")).toBe(true);
    } finally {
      handle.dispose();
    }
  });

  it("preserves health nodes and avoids repeated score/status/counter/buff writes", () => {
    const parent = new FakeElement();
    const handle = createHud(asHtml(parent));
    try {
      handle.setHearts(5);
      handle.setScore(7);
      handle.setCounters(4, 2);
      handle.setTimer(65);
      handle.setStatus("Игра");
      handle.setSuperBonus("turkey", 20);
      handle.setBuffValues(9.96, 12.5, 4.25, 5.94);
      const originalHearts = [...byId(handle, "hud-hearts").children];
      clearWrites(handle);
      for (let i = 0; i < 120; i += 1) {
        handle.setHearts(5);
        handle.setScore(7);
        handle.setCounters(4, 2);
        handle.setTimer(65.8);
        handle.setStatus("Игра");
        handle.setSuperBonus("turkey", 19.98);
        handle.setBuffValues(9.92, 12.5, 4.22, 5.91);
      }
      expect(byId(handle, "hud-hearts").children).toEqual(originalHearts);
      expect(writesOf(handle)).toEqual([]);
      // Hearts-from-hearts also keeps unchanged nodes, then still handles damage.
      handle.setHeartsFromHearts(2);
      const changedHearts = [...byId(handle, "hud-hearts").children];
      expect(handle.getHalves()).toBe(4);
      clearWrites(handle);
      handle.setHeartsFromHearts(2);
      expect(byId(handle, "hud-hearts").children).toEqual(changedHearts);
      expect(writesOf(handle)).toEqual([]);
      handle.simulateHit("test");
      expect(handle.getHalves()).toBe(2);
      expect(byId(handle, "hud-hearts").attributes["aria-label"]).toContain("Здоровье: 2");
    } finally {
      handle.dispose();
    }
  });

  it("paints exact tenths, applies shield damage immediately and hides at expiry/reset", () => {
    const parent = new FakeElement();
    const handle = createHud(asHtml(parent));
    try {
      const rows = byId(handle, "hud-buffs").children;
      handle.setBuffValues(0.101, 25, 0.04, 0.101);
      expect(rows.map((row) => row.children[2]?.textContent)).toEqual(["0.2 с", "0.1 с", "0.2 с"]);
      clearWrites(handle);
      handle.setBuffValues(0.1, 12.5, 0.03, 0.1);
      expect(rows.map((row) => row.children[2]?.textContent)).toEqual(["0.1 с", "0.1 с", "0.1 с"]);
      expect(byId(handle, "hud-shield-capacity").style.width).toBe("50%");
      expect(byId(handle, "hud-hearts").attributes["aria-label"]).toContain("щит: 13 из 25");
      clearWrites(handle);
      handle.setBuffValues(0.001, 12.5, 0.001, 0.001);
      expect(writesOf(handle)).toEqual([]);
      handle.setBuffValues(0, 12.5, -0.001, 0);
      expect(rows.every((row) => row.style.display === "none")).toBe(true);
      expect(rows.map((row) => row.children[2]?.textContent)).toEqual(["", "", ""]);
      expect(rows.every((row) => row.attributes["aria-label"]?.endsWith(": неактивен"))).toBe(true);
      expect(byId(handle, "hud-shield-heart").style.display).toBe("none");
      expect(byId(handle, "hud-hearts").attributes["aria-label"]).not.toContain("щит:");
      clearWrites(handle);
      handle.setBuffs({});
      handle.setBuffValues(0, 0, 0, 0);
      expect(writesOf(handle)).toEqual([]);
      // New life / room: no cached former duration can leak into the timer.
      handle.setBuffValues(10, 25, 5, 10);
      expect(rows.map((row) => row.children[2]?.textContent)).toEqual(["10.0 с", "5.0 с", "10.0 с"]);
      expect(byId(handle, "hud-shield-capacity").style.width).toBe("100%");
      handle.setBuffs({}); // disconnect/death path
      expect(rows.every((row) => row.style.display === "none")).toBe(true);
    } finally {
      handle.dispose();
    }
  });

  it("does not retain or mutate caller buffs and ignores nonfinite timers/capacity", () => {
    const parent = new FakeElement();
    const handle = createHud(asHtml(parent));
    try {
      const buffs = Object.freeze({
        shield: Object.freeze({ seconds: 7.23, hp: 15 }),
        speed: Object.freeze({ seconds: 2.99 }),
        charge: Object.freeze({ seconds: 9.01 }),
      });
      handle.setBuffs(buffs);
      const rows = byId(handle, "hud-buffs").children;
      expect(rows.map((row) => row.children[2]?.textContent)).toEqual(["7.3 с", "3.0 с", "9.1 с"]);
      expect(buffs.shield).toEqual({ seconds: 7.23, hp: 15 });
      handle.setBuffValues(Number.NaN, 25, Infinity, -1);
      expect(rows.every((row) => row.style.display === "none")).toBe(true);
      handle.setBuffValues(1, Number.NaN, 0, 0);
      expect(byId(handle, "hud-shield-heart").style.display).toBe("none");
      expect(byId(handle, "hud-hearts").attributes["aria-label"]).not.toContain("щит:");
      handle.setBuffs({});
    } finally {
      handle.dispose();
    }
  });
});

describe("super bonus HUD", () => {
  it("shows brief copy, the matching avatar and a 20-second countdown for all eleven held items", () => {
    const pickupCopy = {
      sheep: ["Овца", "Гонится · взрыв по всем"],
      turkey: ["Индейка", "Перья на 2 с"],
      freeze: ["Кирпич", "Заморозка на 1 с"],
      boomerang: ["Колбаса", "Возвращается · отойди!"],
      jelly: ["Холодец", "Подбрасывает вверх"],
      herring: ["Селёдка", "Облако · отойди!"],
      swamp: ["Болото", "Замедляет на 5 с"],
      ice: ["Каток", "Скользкий лёд на 5 с"],
      soda: ["Лимонад", "Мина · опасна всем"],
      vacuum: ["Пылесос", "Притягивает на 5 с"],
      grenade: ["Граната", "+1 ♥ · мимо: 3 взрыва"],
    } as const;
    const parent = new FakeElement();
    const handle = createHud(asHtml(parent));
    try {
      expect(byId(handle, "hud-super").style.display).toBe("none");
      expect(byId(handle, "hud-super-icon").tagName).toBe("img");
      expect(byId(handle, "hud-super-icon").attributes.alt).toBe("");
      expect(byId(handle, "hud-super-icon").attributes["aria-hidden"]).toBe("true");
      for (const bonus of SUPER_BONUSES) {
        handle.setSuperBonus(bonus.kind, 20);
        expect(byId(handle, "hud-super-name").textContent).toBe(pickupCopy[bonus.kind][0]);
        expect(byId(handle, "hud-super-hint").textContent).toBe(pickupCopy[bonus.kind][1]);
        expect(byId(handle, "hud-super-icon").attributes.src).toBe(`/icons/super-${bonus.kind}.svg`);
        expect(byId(handle, "hud-super").attributes["aria-label"]).toBe(bonus.name);
        expect(byId(handle, "hud-super-timer").textContent).toBe("20 с");
        expect(byId(handle, "hud-super").attributes["data-kind"]).toBe(bonus.kind);
        expect(byId(handle, "hud-super").attributes["aria-hidden"]).toBe("false");
      }
      handle.setSuperBonus("soda", 24);
      expect(byId(handle, "hud-super-timer").textContent).toBe("20 с");
      clearWrites(handle);
      handle.setSuperBonus("soda", 4.01);
      expect(byId(handle, "hud-super-timer").textContent).toBe("5 с");
      expect(byId(handle, "hud-super-timer").attributes["aria-label"]).toBe("Осталось 5 с");
      expect(byId(handle, "hud-super-icon").writes).toEqual([]);
      expect(byId(handle, "hud-super-name").writes).toEqual([]);
      expect(byId(handle, "hud-super-hint").writes).toEqual([]);
    } finally {
      handle.dispose();
    }
  });

  it("shows only a generic centre gift for hidden or known legacy kinds", () => {
    const handle = createHud(asHtml(new FakeElement()));
    try {
      for (const kind of ["", null, ...SUPER_BONUSES.map((bonus) => bonus.kind)]) {
        handle.setCentreBonus(kind, 15);
        expect(byId(handle, "hud-super").style.display).toBe("");
        expect(byId(handle, "hud-super-name").textContent).toBe("Подарок в центре");
        expect(byId(handle, "hud-super-hint").textContent).toBe("");
        expect(byId(handle, "hud-super-icon").attributes.src).toBe("/icons/super-gift.svg");
        expect(byId(handle, "hud-super").attributes["data-kind"]).toBe("");
        expect(byId(handle, "hud-super").attributes["data-source"]).toBe("centre");
        expect(byId(handle, "hud-super").style.borderColor ?? "").toBe("");
        expect(byId(handle, "hud-super-timer").textContent).toBe("15 с");
      }
      clearWrites(handle);
      handle.setCentreBonus("sheep", 15);
      expect(writesOf(handle)).toEqual([]);
    } finally { handle.dispose(); }
  });

  it("shows the centre pickup before collection and prioritizes the held item in the same row", () => {
    const parent = new FakeElement();
    const handle = createHud(asHtml(parent));
    try {
      handle.setCentreBonus("sheep", 14.3);
      expect(byId(handle, "hud-super-name").textContent).toBe("Подарок в центре");
      expect(byId(handle, "hud-super-timer").textContent).toBe("15 с");
      expect(byId(handle, "hud-super").attributes["data-source"]).toBe("centre");
      handle.setSuperBonus("freeze", 19.2);
      expect(byId(handle, "hud-super-name").textContent).toBe("Кирпич");
      expect(byId(handle, "hud-super-icon").attributes.src).toBe("/icons/super-freeze.svg");
      expect(byId(handle, "hud-super").attributes["data-source"]).toBe("held");
      clearWrites(handle);
      handle.setCentreBonus("sheep", 8.2);
      expect(writesOf(handle)).toEqual([]);
      handle.setSuperBonus(null, 0);
      expect(byId(handle, "hud-super-name").textContent).toBe("Подарок в центре");
      expect(byId(handle, "hud-super-timer").textContent).toBe("9 с");
      expect(byId(handle, "hud-super-hint").textContent).toBe("");
      expect(byId(handle, "hud-super-icon").attributes.src).toBe("/icons/super-gift.svg");
      expect(byId(handle, "hud-super").attributes["data-kind"]).toBe("");
      expect(byId(handle, "hud-super").attributes["aria-label"]).toBe("Подарок в центре");
      expect(byId(handle, "hud-super").style.borderColor).toBe("");
      handle.setCentreBonus(null, 0);
      expect(byId(handle, "hud-super").style.display).toBe("none");
      expect(byId(handle, "hud-super-name").textContent).toBe("");
      expect(byId(handle, "hud-super-hint").textContent).toBe("");
      expect(byId(handle, "hud-super-timer").textContent).toBe("");
      expect(byId(handle, "hud-super").attributes["data-source"]).toBe("");
      expect(byId(handle, "hud-super").attributes["aria-label"]).toBe("");
    } finally {
      handle.dispose();
    }
  });

  it("hides exactly at expiry and clears invalid or reset bonus states", () => {
    const parent = new FakeElement();
    const handle = createHud(asHtml(parent));
    try {
      handle.setSuperBonus("vacuum", 0.001);
      expect(byId(handle, "hud-super").style.display).toBe("");
      expect(byId(handle, "hud-super-timer").textContent).toBe("1 с");
      handle.setSuperBonus("vacuum", 0);
      expect(byId(handle, "hud-super").style.display).toBe("none");
      expect(byId(handle, "hud-super").attributes["aria-hidden"]).toBe("true");
      for (const [kind, remainingS] of [
        ["ice", -0.001], ["ice", Number.NaN], ["ice", Infinity], ["unknown", 20], [null, 20],
      ] as const) {
        handle.setSuperBonus("ice", 20);
        handle.setSuperBonus(kind, remainingS);
        expect(byId(handle, "hud-super").style.display).toBe("none");
        expect(byId(handle, "hud-super-timer").textContent).toBe("");
        expect(byId(handle, "hud-super-icon").attributes.src).toBe("/icons/super-gift.svg");
        expect(byId(handle, "hud-super").attributes["data-kind"]).toBe("");
      }
      for (const remainingS of [0, -1, Number.NaN, Infinity]) {
        handle.setCentreBonus("", 0.001);
        expect(byId(handle, "hud-super").style.display).toBe("");
        handle.setCentreBonus("", remainingS);
        expect(byId(handle, "hud-super").style.display).toBe("none");
      }
      clearWrites(handle);
      handle.setSuperBonus(null, 0);
      handle.setCentreBonus(null, 0);
      expect(writesOf(handle)).toEqual([]);
    } finally {
      handle.dispose();
    }
  });

  it("leaves controls accessible and uses no new buttons or focusable inventory", () => {
    const parent = new FakeElement();
    const handle = createHud(asHtml(parent));
    try {
      const mask = parent.querySelector("#hud-turkey-mask");
      if (mask === null) throw new Error("turkey mask missing");
      expect(mask.parentElement).toBe(parent);
      expect(mask.attributes["aria-hidden"]).toBe("true");
      expect(mask.style.pointerEvents).toBe("none");
      expect(byId(handle, "hud-super").style.pointerEvents).toBe("none");
      expect(mask.style.display).toBe("none");
      handle.setTurkeyMask(true);
      expect(mask.style.display).toBe("");
      expect(mask.children.map((fringe) => fringe.className)).toEqual([
        "turkey-fringe turkey-fringe--top", "turkey-fringe turkey-fringe--bottom",
      ]);
      expect(allElements(parent).some((element) =>
        ["button", "input", "select", "a"].includes(element.tagName) || element.attributes.tabindex !== undefined,
      )).toBe(false);
      handle.setSuperBonus("turkey", 19.9);
      clearWrites(handle);
      mask.writes.length = 0;
      for (let i = 0; i < 120; i += 1) {
        handle.setSuperBonus("turkey", 19.5);
        handle.setTurkeyMask(true);
      }
      expect(writesOf(handle)).toEqual([]);
      expect(mask.writes).toEqual([]);
      handle.setTurkeyMask(false);
      expect(mask.style.display).toBe("none");
    } finally {
      handle.dispose();
    }
    expect(parent.children).toHaveLength(0);
  });

  it("keeps the middle third clear and stacks feathers below the reticle, HUD and touch controls", () => {
    const rule = (selector: string): string => {
      const start = gameStyles.indexOf(`${selector} {`);
      if (start < 0) throw new Error(`CSS rule ${selector} missing`);
      return gameStyles.slice(start, gameStyles.indexOf("}", start));
    };
    const maskLayer = Number(/z-index:\s*(\d+)/.exec(rule("#hud-turkey-mask"))?.[1]);
    expect(rule(".turkey-fringe")).toContain("height: 33.333333%");
    expect(rule(".turkey-fringe")).toContain("overflow: hidden");
    expect(rule(".turkey-fringe--top")).toContain("top: 0");
    expect(rule(".turkey-fringe--bottom")).toContain("bottom: 0");
    for (const selector of ["#hud", "#aim", "#joystick", "#fire-button", "#mute-button,\n#fullscreen-button"]) {
      const controlLayer = Number(/z-index:\s*(\d+)/.exec(rule(selector))?.[1]);
      expect(controlLayer).toBeGreaterThan(maskLayer);
    }
  });
});

describe("Russian player-facing event messages", () => {
  it("translates known server events without changing player names", () => {
    expect(localizeKillfeed("Alice joined the fight")).toBe("Alice вступает в бой");
    expect(localizeKillfeed("Alice fragged Борис")).toBe("Alice выбивает Борис");
    expect(localizeKillfeed("Alice grabbed SUPER core (x2 next shot)"))
      .toBe("Супербонус у Alice");
  });

  it("accepts already localized server events and hides unknown English text", () => {
    expect(localizeKillfeed("Alice получает щит")).toBe("Alice получает щит");
    expect(localizeKillfeed("internal server error")).toBe("Событие на арене");
  });

  it("names local pickup effects in Russian", () => {
    expect(localizePowerUp("shield")).toBe("Подобран щит");
    expect(localizePowerUp("speed")).toBe("Подобрано ускорение");
    expect(localizePowerUp("charge")).toBe("Подобран быстрый заряд");
    expect(localizePowerUp("future-kind")).toBe("Подобран бонус");
  });
});
