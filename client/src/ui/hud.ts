import { KILLFEED_MAX_LINES, KILLFEED_OPACITY, MAX_HALVES, MAX_HEARTS } from "../config";
import { halvesPerHeart } from "../net/protocol";
import { getSuperBonus, SUPER_BONUS_SLOT_MS, type SuperBonusDefinition } from "../../../shared/super-bonuses.mjs";
import { SUPER_BONUS_PRESENTATIONS } from "./superBonusPresentation";

// Pure helper (unit-tested): hearts left after taking hits, never below 0.
export function heartsAfterHits(currentHearts: number, hits: number): number {
  return Math.max(0, currentHearts - hits);
}

export function halvesAfterHits(currentHalves: number, hits: number): number {
  return Math.max(0, currentHalves - hits);
}

export function formatTimer(totalSeconds: number): string {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

// The server sends event strings for every viewer. Keep wire messages stable
// and translate the text only when the local HUD displays them.
export function localizeKillfeed(message: string): string {
  const joined = /^(.+) joined the fight$/.exec(message);
  if (joined !== null) {
    return `${joined[1]} вступает в бой`;
  }
  const fragged = /^(.+) fragged (.+)$/.exec(message);
  if (fragged !== null) {
    return `${fragged[1]} выбивает ${fragged[2]}`;
  }
  const superPickup = /^(.+) grabbed SUPER core \(x2 next shot\)$/.exec(message);
  if (superPickup !== null) {
    return `Супербонус у ${superPickup[1]}`;
  }
  return /[А-Яа-яЁё]/u.test(message) ? message : "Событие на арене";
}

export function localizePowerUp(kind: string): string {
  if (kind === "shield") {
    return "Подобран щит";
  }
  if (kind === "speed") {
    return "Подобрано ускорение";
  }
  if (kind === "charge") {
    return "Подобран быстрый заряд";
  }
  return "Подобран бонус";
}

export interface HudBuffs {
  shield?: { seconds: number; hp: number };
  speed?: { seconds: number };
  charge?: { seconds: number };
}

export interface HudHandle {
  element: HTMLDivElement;
  setTimer(totalSeconds: number): void;
  setScore(score: number): void;
  setPlayers(count: number): void;
  setWatching(count: number): void;
  setCounters(players: number, watching: number): void;
  // R2: value is halves (0..8, 4 hearts x full/half/empty). Legacy callers
  // passing hearts (0..4) still render something sane — values <= 4 map to
  // full hearts (halves = value * 2) only via setHeartsFromHearts; prefer
  // passing halvesForHp() directly.
  setHearts(halves: number): void;
  setHeartsFromHearts(hearts: number): void;
  setBuffs(buffs: HudBuffs): void;
  // Allocation-free per-frame path. Nonpositive deadlines hide immediately;
  // the visible timer still changes at the established tenth-second steps.
  setBuffValues(shieldSeconds: number, shieldHp: number, speedSeconds: number, chargeSeconds: number): void;
  getHearts(): number;
  getHalves(): number;
  // One row: the held bonus takes priority over the available centre pickup.
  // Null, unknown kinds and nonpositive/nonfinite time hide their state.
  setSuperBonus(kind: string | null, remainingS: number): void;
  setCentreBonus(kind: string | null, remainingS: number): void;
  // Caller supplies the authoritative 2-second deadline and clears on reset.
  setTurkeyMask(active: boolean): void;
  setStatus(text: string): void;
  addKillfeed(message: string): void;
  // Placeholder hit logic for the Stage 2 test scene: 1 hit = 1 heart lost.
  // Stage 4 replaces this with authoritative server damage.
  simulateHit(source: string): void;
  dispose(): void;
}

// The HUD stays in its established touch-safe zones: match info at top-left,
// health alone at top-center, score/status at top-right, and a short event
// line below the right-side buttons. CSS supplies the illustrated plate
// treatment; this DOM tree keeps the same input and update contracts.
export function createHud(parent: HTMLElement, maxHearts: number = MAX_HEARTS): HudHandle {
  const root = document.createElement("div");
  root.id = "hud";

  // Top-left info list (phone playtest): timer line + live counters, always
  // visible, separate from the centered hearts and the right score block.
  const info = document.createElement("div");
  info.id = "hud-info";

  const infoTimer = document.createElement("div");
  infoTimer.id = "hud-info-timer";
  infoTimer.textContent = formatTimer(180);

  const infoPlayers = document.createElement("div");
  infoPlayers.id = "hud-info-players";
  infoPlayers.textContent = "Игроки: 0";

  const infoWatching = document.createElement("div");
  infoWatching.id = "hud-info-watching";
  infoWatching.textContent = "Зрители: 0";

  info.appendChild(infoTimer);
  info.appendChild(infoPlayers);
  info.appendChild(infoWatching);

  // Right-side score block (playtest round): vertical dark pill pinned
  // top-right, clear of the mute/fullscreen buttons — line 1 is the score,
  // line 2 the transient status. Center top holds ONLY the hearts now.
  const scoreBlock = document.createElement("div");
  scoreBlock.id = "hud-score-block";

  const scoreLabel = document.createElement("span");
  scoreLabel.id = "hud-score-label";
  scoreLabel.textContent = "СЧЁТ";

  const score = document.createElement("span");
  score.id = "hud-score";
  score.textContent = "0";
  score.setAttribute("aria-label", "Счёт: 0");

  const status = document.createElement("span");
  status.id = "hud-status";
  status.textContent = "";

  scoreBlock.appendChild(scoreLabel);
  scoreBlock.appendChild(score);
  scoreBlock.appendChild(status);
  status.setAttribute("aria-live", "polite");

  const hearts = document.createElement("div");
  hearts.id = "hud-hearts";
  hearts.setAttribute("role", "img");

  // Shield absorbs damage separately from health. Keep four normal hearts
  // and show one outlined shield heart while any shield capacity remains.
  const shieldHeart = document.createElement("span");
  shieldHeart.id = "hud-shield-heart";
  shieldHeart.style.display = "none";
  const shieldSymbol = document.createElement("img");
  shieldSymbol.src = "/icons/bonus-shield.svg";
  shieldSymbol.alt = "";
  const shieldHeartGlyph = document.createElement("span");
  shieldHeartGlyph.textContent = "♥";
  const shieldCapacity = document.createElement("i");
  shieldCapacity.id = "hud-shield-capacity";
  shieldHeart.appendChild(shieldSymbol);
  shieldHeart.appendChild(shieldHeartGlyph);
  shieldHeart.appendChild(shieldCapacity);

  const buffsPanel = document.createElement("div");
  buffsPanel.id = "hud-buffs";
  buffsPanel.setAttribute("aria-label", "Активные бонусы");
  const buffRows = {} as Record<keyof HudBuffs, {
    row: HTMLDivElement; timer: HTMLSpanElement; label: string; active: boolean; tenths: number;
  }>;
  for (const [kind, label] of [
    ["shield", "Щит"], ["speed", "Ускорение"], ["charge", "Быстрый заряд"],
  ] as const) {
    const row = document.createElement("div");
    row.className = `hud-buff hud-buff--${kind}`;
    row.style.display = "none";
    row.setAttribute("data-kind", kind);
    const icon = document.createElement("img");
    icon.src = `/icons/bonus-${kind}.svg`;
    icon.alt = "";
    const title = document.createElement("span");
    title.className = "hud-buff-title";
    title.textContent = label;
    const timer = document.createElement("span");
    timer.className = "hud-buff-timer";
    row.appendChild(icon);
    row.appendChild(title);
    row.appendChild(timer);
    buffsPanel.appendChild(row);
    buffRows[kind] = { row, timer, label, active: false, tenths: 0 };
  }

  const superRow = document.createElement("div");
  superRow.id = "hud-super";
  superRow.style.display = "none";
  superRow.style.pointerEvents = "none";
  superRow.setAttribute("role", "group");
  superRow.setAttribute("aria-hidden", "true");
  const superIcon = document.createElement("img");
  superIcon.id = "hud-super-icon";
  superIcon.setAttribute("src", "/icons/super-gift.svg");
  superIcon.setAttribute("alt", "");
  superIcon.setAttribute("aria-hidden", "true");
  const superName = document.createElement("span");
  superName.id = "hud-super-name";
  superName.setAttribute("aria-live", "polite");
  const superHint = document.createElement("span");
  superHint.id = "hud-super-hint";
  const superTimer = document.createElement("span");
  superTimer.id = "hud-super-timer";
  superRow.appendChild(superIcon);
  superRow.appendChild(superName);
  superRow.appendChild(superHint);
  superRow.appendChild(superTimer);

  // Sibling stacking keeps the feather mask below #hud, #aim and all touch
  // controls. Neither the mask nor its decorative feathers can receive input.
  const turkeyMask = document.createElement("div");
  turkeyMask.id = "hud-turkey-mask";
  turkeyMask.style.display = "none";
  turkeyMask.style.pointerEvents = "none";
  turkeyMask.setAttribute("aria-hidden", "true");
  for (const edge of ["top", "bottom"] as const) {
    const fringe = document.createElement("div");
    fringe.className = `turkey-fringe turkey-fringe--${edge}`;
    for (let i = 0; i < 7; i += 1) {
      const feather = document.createElement("span");
      feather.className = "turkey-feather";
      fringe.appendChild(feather);
    }
    turkeyMask.appendChild(fringe);
  }

  const killfeed = document.createElement("div");
  killfeed.id = "hud-killfeed";
  killfeed.setAttribute("role", "log");
  killfeed.setAttribute("aria-live", "polite");

  root.appendChild(info);
  root.appendChild(hearts);
  root.appendChild(buffsPanel);
  root.appendChild(scoreBlock);
  root.appendChild(superRow);
  root.appendChild(killfeed);
  parent.appendChild(turkeyMask);
  parent.appendChild(root);

  let currentHalves = maxHearts * 2;
  let currentShieldHp = 0;
  let heartLabel = "";
  let paintedShieldLabel = "";
  let disposed = false;
  const heldBonus: { definition: SuperBonusDefinition | undefined; seconds: number } = { definition: undefined, seconds: 0 };
  const centreBonus = { seconds: 0 };
  let paintedBonus: SuperBonusDefinition | undefined;
  let paintedBonusSource = "";
  let paintedBonusSeconds = 0;
  let turkeyActive = false;

  const paintSuperBonus = (): void => {
    const source = heldBonus.definition !== undefined ? "held" : centreBonus.seconds > 0 ? "centre" : "";
    const bonus = source === "held" ? heldBonus : centreBonus;
    const definition = source === "held" ? heldBonus.definition : undefined;
    const active = source !== "";
    if (definition !== paintedBonus || source !== paintedBonusSource) {
      const presentation = definition === undefined ? undefined : SUPER_BONUS_PRESENTATIONS[definition.kind];
      superRow.style.display = active ? "" : "none";
      superRow.setAttribute("aria-hidden", active ? "false" : "true");
      superRow.setAttribute("aria-label", source === "centre" ? "Подарок в центре" : definition?.name ?? "");
      superRow.setAttribute("data-source", source);
      superRow.setAttribute("data-kind", definition?.kind ?? "");
      superIcon.setAttribute("src", definition === undefined ? "/icons/super-gift.svg" : `/icons/super-${definition.kind}.svg`);
      superName.textContent = source === "centre" ? "Подарок в центре" : presentation?.name ?? "";
      superHint.textContent = presentation?.hint ?? "";
      superRow.style.borderColor = definition === undefined ? "" : `#${definition.color.toString(16).padStart(6, "0")}`;
      paintedBonus = definition;
      paintedBonusSource = source;
    }
    const seconds = active ? bonus.seconds : 0;
    if (seconds !== paintedBonusSeconds) {
      superTimer.textContent = seconds > 0 ? `${seconds} с` : "";
      superTimer.setAttribute("aria-label", seconds > 0 ? `Осталось ${seconds} с` : "");
      paintedBonusSeconds = seconds;
    }
  };

  const setBonus = (bonus: typeof heldBonus, kind: string | null, remainingS: number, maxSeconds: number): void => {
    const definition = Number.isFinite(remainingS) && remainingS > 0 ? getSuperBonus(kind) : undefined;
    const seconds = definition === undefined ? 0 : Math.min(maxSeconds, Math.ceil(remainingS));
    if (bonus.definition === definition && bonus.seconds === seconds) return;
    bonus.definition = definition;
    bonus.seconds = seconds;
    paintSuperBonus();
  };

  const updateHeartLabel = (): void => {
    const shieldLabel = currentShieldHp > 0 ? `; щит: ${Math.ceil(currentShieldHp)} из 25 прочности` : "";
    const label = `Здоровье: ${currentHalves} из ${maxHearts * 2} половинок сердца${shieldLabel}`;
    if (heartLabel !== label) {
      hearts.setAttribute("aria-label", label);
      heartLabel = label;
    }
  };

  const renderHearts = (): void => {
    while (hearts.lastElementChild !== null) hearts.removeChild(hearts.lastElementChild);
    hearts.textContent = "";
    const perHeart = halvesPerHeart(currentHalves);
    for (let i = 0; i < maxHearts; i += 1) {
      const fill = perHeart[i] ?? 0;
      const heart = document.createElement("span");
      if (fill >= 2) {
        heart.className = "heart heart-full";
        heart.textContent = "♥";
      } else if (fill === 1) {
        heart.className = "heart heart-half";
        heart.textContent = "♥";
      } else {
        heart.className = "heart heart-empty";
        heart.textContent = "♡";
      }
      hearts.appendChild(heart);
    }
    hearts.appendChild(shieldHeart);
    updateHeartLabel();
  };
  renderHearts();

  const paintBuff = (kind: keyof HudBuffs, seconds: number): boolean => {
    const buff = buffRows[kind];
    const active = Number.isFinite(seconds) && seconds > 0;
    if (buff.active !== active) {
      buff.row.style.display = active ? "" : "none";
      buff.active = active;
    }
    const tenths = active ? Math.ceil(seconds * 10) : 0;
    if (buff.tenths !== tenths) {
      const formatted = active ? `${(tenths / 10).toFixed(1)} с` : "";
      buff.timer.textContent = formatted;
      buff.row.setAttribute("aria-label", active ? `${buff.label}: ${formatted}` : `${buff.label}: неактивен`);
      buff.tenths = tenths;
    }
    return active;
  };

  const paintBuffs = (shieldSeconds: number, hp: number, speedSeconds: number, chargeSeconds: number): void => {
    const timedShield = paintBuff("shield", shieldSeconds);
    paintBuff("speed", speedSeconds);
    paintBuff("charge", chargeSeconds);
    const shieldActive = timedShield && Number.isFinite(hp) && hp > 0;
    const nextHp = shieldActive ? hp : 0;
    const hpChanged = currentShieldHp !== nextHp;
    if (hpChanged) {
      currentShieldHp = nextHp;
      updateHeartLabel();
    }
    const display = shieldActive ? "" : "none";
    if (shieldHeart.style.display !== display) shieldHeart.style.display = display;
    if (shieldActive && hpChanged) {
      const fraction = Math.max(0, Math.min(1, hp / 25));
      const width = `${Math.round(fraction * 100)}%`;
      if (shieldCapacity.style.width !== width) shieldCapacity.style.width = width;
      const label = `Щит: ${Math.ceil(hp)} из 25 прочности`;
      if (paintedShieldLabel !== label) {
        shieldHeart.setAttribute("aria-label", label);
        paintedShieldLabel = label;
      }
    }
  };

  const handle: HudHandle = {
    element: root,
    setTimer(totalSeconds: number): void {
      const text = formatTimer(totalSeconds);
      if (infoTimer.textContent !== text) infoTimer.textContent = text;
    },
    setScore(nextScore: number): void {
      const text = String(nextScore);
      if (score.textContent !== text) {
        score.textContent = text;
        score.setAttribute("aria-label", `Счёт: ${nextScore}`);
      }
    },
    setPlayers(count: number): void {
      const text = `Игроки: ${count}`;
      if (infoPlayers.textContent !== text) infoPlayers.textContent = text;
    },
    setWatching(count: number): void {
      const text = `Зрители: ${count}`;
      if (infoWatching.textContent !== text) infoWatching.textContent = text;
    },
    setCounters(players: number, watching: number): void {
      handle.setPlayers(players);
      handle.setWatching(watching);
    },
    setHearts(nextHalves: number): void {
      const safe = Number.isFinite(nextHalves) ? Math.floor(nextHalves) : 0;
      const halves = Math.max(0, Math.min(MAX_HALVES, safe));
      if (currentHalves === halves) return;
      currentHalves = halves;
      renderHearts();
    },
    setHeartsFromHearts(nextHearts: number): void {
      const safe = Number.isFinite(nextHearts) ? Math.floor(nextHearts) : 0;
      const clamped = Math.max(0, Math.min(maxHearts, safe));
      if (currentHalves === clamped * 2) return;
      currentHalves = clamped * 2;
      renderHearts();
    },
    setBuffs(buffs: HudBuffs): void {
      paintBuffs(buffs.shield?.seconds ?? 0, buffs.shield?.hp ?? 0, buffs.speed?.seconds ?? 0, buffs.charge?.seconds ?? 0);
    },
    setBuffValues(shieldSeconds: number, hp: number, speedSeconds: number, chargeSeconds: number): void {
      paintBuffs(shieldSeconds, hp, speedSeconds, chargeSeconds);
    },
    getHearts(): number {
      return Math.ceil(currentHalves / 2);
    },
    getHalves(): number {
      return currentHalves;
    },
    setSuperBonus(kind: string | null, remainingS: number): void {
      setBonus(heldBonus, kind, remainingS, SUPER_BONUS_SLOT_MS / 1000);
    },
    setCentreBonus(_kind: string | null, remainingS: number): void {
      // Public central snapshots intentionally carry no kind. Presence and
      // expiry alone drive the generic gift row, even for legacy snapshots.
      const seconds = Number.isFinite(remainingS) && remainingS > 0 ? Math.ceil(remainingS) : 0;
      if (centreBonus.seconds === seconds) return;
      centreBonus.seconds = seconds;
      paintSuperBonus();
    },
    setTurkeyMask(active: boolean): void {
      if (turkeyActive === active) return;
      turkeyActive = active;
      turkeyMask.style.display = active ? "" : "none";
    },
    setStatus(text: string): void {
      if (status.textContent !== text) status.textContent = text;
    },
    // Event feed (owner 4d.4): brief one-liners for join/kill/pickup only —
    // newest on top, at most KILLFEED_MAX_LINES visible (older drop off, no
    // history pile-up), painted at KILLFEED_OPACITY so the feed never blocks
    // the gameplay HUD or touch-safe zones on a phone screen. The container
    // lives under #hud (pointer-events none), so entries never eat input.
    addKillfeed(message: string): void {
      const entry = document.createElement("div");
      entry.className = "killfeed-entry";
      entry.textContent = message;
      entry.style.opacity = String(KILLFEED_OPACITY);
      killfeed.prepend(entry);
      while (killfeed.children.length > KILLFEED_MAX_LINES) {
        const last = killfeed.lastElementChild;
        if (last !== null) {
          killfeed.removeChild(last);
        } else {
          break;
        }
      }
    },
    simulateHit(source: string): void {
      if (currentHalves <= 0) {
        return;
      }
      currentHalves = halvesAfterHits(currentHalves, 2);
      renderHearts();
      handle.addKillfeed(`Попадание от ${source} — осталось половинок сердца: ${currentHalves}`);
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      if (root.parentElement === parent) {
        parent.removeChild(root);
      }
      if (turkeyMask.parentElement === parent) {
        parent.removeChild(turkeyMask);
      }
    },
  };
  return handle;
}
