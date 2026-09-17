// Perf budget helper: clamp devicePixelRatio to the Stage 1 mobile cap.
// Max 1.5 per AGENTS.md/MAP.md; Stage 3/5 may fall back 1.5 -> 1.0.
export const MAX_PIXEL_RATIO = 1.5;

export function getClampedPixelRatio(devicePixelRatio: number): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.min(dpr, MAX_PIXEL_RATIO);
}
