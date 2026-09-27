import source from "../../shared/arena-layout.json";
import { validateArenaLayout } from "../../shared/arena-layout.mjs";

export type { ArenaLayout } from "../../shared/arena-layout.mjs";
export { ARENA_HALF_SIZE, RAMP_SLOPE_DEG, PICKUP_VISUAL_Y, validateArenaLayout } from "../../shared/arena-layout.mjs";

// Vite bundles this JSON into the client. A map edit in development reloads
// the page; a production client must be rebuilt along with a server restart.
export const ARENA_LAYOUT = validateArenaLayout(source);
