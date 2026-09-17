import { createServer, type Server as HttpServer } from "http";
import express, { type Express } from "express";
import { Server } from "colyseus";
import { ArenaRoom } from "./rooms/ArenaRoom.js";

export const DEFAULT_PORT = 2567;

export function createApp(): Express {
  const app: Express = express();
  app.get("/health", (_req, res): void => {
    res.json({ ok: true });
  });
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
