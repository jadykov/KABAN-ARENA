// Copies owner ad pictures + committed SVG placeholders from
// client/assets/ads/ to client/public/ads/ (Vite serves public/ at the
// web root, matching ADS_PUBLIC_BASE_PATH). Run via `npm run sync-ads`.
// Owner workflow (QA4-A): drop fence-N.png/jpg or banner.png/jpg into
// client/assets/ads/, rerun sync, restart the client.
import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(here, "../assets/ads");
const outDir = resolve(here, "../public/ads");

await mkdir(outDir, { recursive: true });
await cp(srcDir, outDir, { recursive: true });
console.log(`sync-ads: ${srcDir} -> ${outDir}`);
