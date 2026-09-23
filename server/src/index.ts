import { createServer, type Server as HttpServer } from "http";
import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import { Server } from "colyseus";
import { ArenaRoom } from "./rooms/ArenaRoom.js";

export const DEFAULT_PORT = 2567;

// Name of the env var pointing at the built client bundle served by the
// production single-container image (see Dockerfile.prod).
export const CLIENT_DIST_ENV_VAR = "KABAN_CLIENT_DIST";
// Default client bundle location: `<repoRoot>/client/dist` resolved relative
// to the compiled server output (`server/dist/index.js`). The prod image
// keeps the same layout (`/app/server/dist` + `/app/client/dist`), so this
// default is correct both for a local `server/dist` build and in production.
export const DEFAULT_CLIENT_DIST_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../client/dist",
);
// Request prefixes owned by Colyseus (HTTP matchmaking) or by the API: the
// SPA fallback must never swallow them — they keep the pre-static behavior
// (express 404; Colyseus answers its own routes via its httpServer listener).
const API_PATH_PREFIXES: ReadonlyArray<string> = ["/health", "/matchmake", "/colyseus"];

export function resolveClientDistDir(): string | null {
  const raw = process.env[CLIENT_DIST_ENV_VAR];
  const dir = raw === undefined || raw === "" ? DEFAULT_CLIENT_DIST_DIR : raw;
  try {
    if (!statSync(dir).isDirectory()) {
      return null;
    }
    if (!statSync(path.join(dir, "index.html")).isFile()) {
      return null;
    }
  } catch {
    return null;
  }
  return dir;
}

export function createApp(): Express {
  const app: Express = express();
  app.get("/health", (_req, res): void => {
    res.json({ ok: true });
  });
  // Static client bundle: no-op when the dir (or its index.html) is missing,
  // so dev/test flows without a client build behave exactly as before.
  const clientDist = resolveClientDistDir();
  if (clientDist !== null) {
    app.use(express.static(clientDist));
    // SPA fallback: any non-API, extensionless path renders the client
    // entry. Paths with a file extension that matched no static file (a
    // missing asset) fall through to 404 instead of serving HTML as JS/CSS.
    app.get("*", (req, res, next): void => {
      if (API_PATH_PREFIXES.some((prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`))) {
        next();
        return;
      }
      if (path.extname(req.path) !== "") {
        next();
        return;
      }
      res.sendFile(path.join(clientDist, "index.html"));
    });
  }
  return app;
}

export function createGameServer(): { app: Express; httpServer: HttpServer; gameServer: Server } {
  const app: Express = createApp();
  const httpServer: HttpServer = createServer(app);
  const gameServer = new Server({ server: httpServer });
  gameServer.define("arena", ArenaRoom);
  return { app, httpServer, gameServer };
}

function getPort(): number {
  const raw = process.env["PORT"];
  if (raw === undefined || raw === "") {
    return DEFAULT_PORT;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : DEFAULT_PORT;
}

async function main(): Promise<void> {
  const { httpServer } = createGameServer();
  const port = getPort();
  await new Promise<void>((resolve) => {
    httpServer.listen(port, () => resolve());
  });
  // oxlint-disable-next-line no-console
  console.log(`KABAN ARENA server listening on :${port}`);
}

const entry = process.argv[1] ?? "";
const invokedDirectly = entry.endsWith("index.ts") || entry.endsWith("index.js");
if (invokedDirectly) {
  await main();
}
