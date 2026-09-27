import { KILLFEED_MAX_LINES, KILLFEED_OPACITY, MAX_HALVES, MAX_HEARTS } from "../config";
import { halvesPerHeart } from "../net/protocol";

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
    return `Суперзаряд у ${superPickup[1]}: ×2 к броску`;
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
  return "Подобран бонус";
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
  getHearts(): number;
  getHalves(): number;
  setSuperBadge(visible: boolean): void;
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

  const superBadge = document.createElement("div");
  superBadge.id = "hud-super";
  superBadge.textContent = "СУПЕР ×2";
  superBadge.style.display = "none";

  const killfeed = document.createElement("div");
  killfeed.id = "hud-killfeed";
  killfeed.setAttribute("role", "log");
  killfeed.setAttribute("aria-live", "polite");

  root.appendChild(info);
  root.appendChild(hearts);
  root.appendChild(scoreBlock);
  root.appendChild(superBadge);
  root.appendChild(killfeed);
  parent.appendChild(root);

  let currentHalves = maxHearts * 2;
  let disposed = false;

  const renderHearts = (): void => {
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
    hearts.setAttribute("aria-label", `Здоровье: ${currentHalves} из ${maxHearts * 2} половинок сердца`);
  };
  renderHearts();

  const handle: HudHandle = {
    element: root,
    setTimer(totalSeconds: number): void {
      infoTimer.textContent = formatTimer(totalSeconds);
    },
    setScore(nextScore: number): void {
      score.textContent = String(nextScore);
      score.setAttribute("aria-label", `Счёт: ${nextScore}`);
    },
    setPlayers(count: number): void {
      infoPlayers.textContent = `Игроки: ${count}`;
    },
    setWatching(count: number): void {
      infoWatching.textContent = `Зрители: ${count}`;
    },
    setCounters(players: number, watching: number): void {
      infoPlayers.textContent = `Игроки: ${players}`;
      infoWatching.textContent = `Зрители: ${watching}`;
    },
    setHearts(nextHalves: number): void {
      const safe = Number.isFinite(nextHalves) ? Math.floor(nextHalves) : 0;
      currentHalves = Math.max(0, Math.min(MAX_HALVES, safe));
      renderHearts();
    },
    setHeartsFromHearts(nextHearts: number): void {
      const safe = Number.isFinite(nextHearts) ? Math.floor(nextHearts) : 0;
      const clamped = Math.max(0, Math.min(maxHearts, safe));
      currentHalves = clamped * 2;
      renderHearts();
    },
    getHearts(): number {
      return Math.ceil(currentHalves / 2);
    },
    getHalves(): number {
      return currentHalves;
    },
    setSuperBadge(visible: boolean): void {
      superBadge.style.display = visible ? "" : "none";
    },
    setStatus(text: string): void {
      status.textContent = text;
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
    },
  };
  return handle;
}
