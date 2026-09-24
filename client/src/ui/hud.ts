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

// Hybrid HUD (QD3 + R2 halves, phone playtest round): DOM overlay with a
// compact top-LEFT info list (timer / Players / Watching), 4 hearts alone
// top-center rendered from halves (full/half/empty), a right-side score
// block (score line + transient status line, clears the mute/fullscreen
// buttons) and a SUPER badge for the x2-next-shot buff. Reload lives in the
// aim overlay since Stage 4d.2 (dedicated bar under the power bar). Minimal,
// readable on narrow mobile viewports, never blocks the canvas
// (pointer-events none).
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
  infoPlayers.textContent = "Players: 0";

  const infoWatching = document.createElement("div");
  infoWatching.id = "hud-info-watching";
  infoWatching.textContent = "Watching: 0";

  info.appendChild(infoTimer);
  info.appendChild(infoPlayers);
  info.appendChild(infoWatching);

  // Right-side score block (playtest round): vertical dark pill pinned
  // top-right, clear of the mute/fullscreen buttons — line 1 is the score,
  // line 2 the transient status. Center top holds ONLY the hearts now.
  const scoreBlock = document.createElement("div");
  scoreBlock.id = "hud-score-block";

  const score = document.createElement("span");
  score.id = "hud-score";
  score.textContent = "0";

  const status = document.createElement("span");
  status.id = "hud-status";
  status.textContent = "";

  scoreBlock.appendChild(score);
  scoreBlock.appendChild(status);

  const hearts = document.createElement("div");
  hearts.id = "hud-hearts";

  const superBadge = document.createElement("div");
  superBadge.id = "hud-super";
  superBadge.textContent = "SUPER x2";
  superBadge.style.display = "none";

  const killfeed = document.createElement("div");
  killfeed.id = "hud-killfeed";

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
      infoTimer.textContent = formatTimer(totalSeconds);
    },
    setScore(nextScore: number): void {
      score.textContent = String(nextScore);
    },
    setPlayers(count: number): void {
      infoPlayers.textContent = `Players: ${count}`;
    },
    setWatching(count: number): void {
      infoWatching.textContent = `Watching: ${count}`;
    },
    setCounters(players: number, watching: number): void {
      infoPlayers.textContent = `Players: ${players}`;
      infoWatching.textContent = `Watching: ${watching}`;
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
