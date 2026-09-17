import { MAX_HALVES, MAX_HEARTS } from "../config";
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

export interface HudHandle {
  element: HTMLDivElement;
  setTimer(totalSeconds: number): void;
  setScore(score: number): void;
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

// Hybrid HUD (QD3 + R2 halves): DOM overlay top bar with always-visible
// timer + score, 4 hearts top-center under the timer rendered from halves
// (full/half/empty) and a SUPER badge for the x2-next-shot buff. Reload
// lives in the aim overlay since Stage 4d.2 (dedicated bar under the power
// bar). Minimal, readable on narrow mobile viewports, never blocks the
// canvas (pointer-events none).
export function createHud(parent: HTMLElement, maxHearts: number = MAX_HEARTS): HudHandle {
  const root = document.createElement("div");
  root.id = "hud";

  const topBar = document.createElement("div");
  topBar.id = "hud-topbar";

  const timer = document.createElement("span");
  timer.id = "hud-timer";
  timer.textContent = formatTimer(180);

  const score = document.createElement("span");
  score.id = "hud-score";
  score.textContent = "0";

  const status = document.createElement("span");
  status.id = "hud-status";
  status.textContent = "";

  topBar.appendChild(timer);
  topBar.appendChild(score);
  topBar.appendChild(status);

  const hearts = document.createElement("div");
  hearts.id = "hud-hearts";

  const superBadge = document.createElement("div");
  superBadge.id = "hud-super";
  superBadge.textContent = "SUPER x2";
  superBadge.style.display = "none";

  const killfeed = document.createElement("div");
  killfeed.id = "hud-killfeed";

  root.appendChild(topBar);
  root.appendChild(hearts);
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
        heart.textContent = "◐";
      } else {
        heart.className = "heart heart-empty";
        heart.textContent = "♡";
      }
      hearts.appendChild(heart);
    }
  };
  renderHearts();

  const handle: HudHandle = {
    element: root,
    setTimer(totalSeconds: number): void {
      timer.textContent = formatTimer(totalSeconds);
    },
    setScore(nextScore: number): void {
      score.textContent = String(nextScore);
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
    addKillfeed(message: string): void {
      const entry = document.createElement("div");
      entry.className = "killfeed-entry";
      entry.textContent = message;
      killfeed.prepend(entry);
      while (killfeed.children.length > 5) {
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
      handle.addKillfeed(`Hit by ${source} — ${currentHalves} halves left`);
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
