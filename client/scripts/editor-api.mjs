import { createServer } from "node:http";
import { readFile, rename, writeFile } from "node:fs/promises";
import { validateArenaLayout } from "../../shared/arena-layout.mjs";

const layoutPath = new URL("../../shared/arena-layout.json", import.meta.url);
const allowedOrigins = new Set(["http://localhost:5173", "http://127.0.0.1:5173"]);
const maxBytes = 512 * 1024;

function send(response, status, payload) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(payload));
}

const server = createServer((request, response) => {
  void (async () => {
    if (request.url !== "/__arena-layout") {
      send(response, 404, { error: "Not found" });
      return;
    }
    const origin = request.headers.origin;
    if (!allowedOrigins.has(origin)) {
      send(response, 403, { error: "Local editor only" });
      return;
    }
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Arena-Editor");
    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.end();
      return;
    }
    if (request.method === "GET") {
      response.statusCode = 200;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      response.end(await readFile(layoutPath, "utf8"));
      return;
    }
    if (request.method !== "PUT") {
      send(response, 405, { error: "Method not allowed" });
      return;
    }
    if (request.headers["x-arena-editor"] !== "1" || !request.headers["content-type"]?.startsWith("application/json")) {
      send(response, 415, { error: "Editor JSON required" });
      return;
    }
    let body = "";
    for await (const chunk of request) {
      body += chunk.toString();
      if (Buffer.byteLength(body) > maxBytes) {
        send(response, 413, { error: "Map file is too large" });
        return;
      }
    }
    let layout;
    try {
      layout = validateArenaLayout(JSON.parse(body));
    } catch (error) {
      send(response, 400, { error: error instanceof Error ? error.message : "Invalid map" });
      return;
    }
    const pendingPath = new URL(`../../shared/arena-layout.json.${process.pid}.pending`, import.meta.url);
    await writeFile(pendingPath, `${JSON.stringify(layout, null, 2)}\n`, "utf8");
    await rename(pendingPath, layoutPath);
    send(response, 200, { ok: true });
  })().catch((error) => {
    if (!response.writableEnded) send(response, 500, { error: error instanceof Error ? error.message : "Unable to save map" });
  });
});

server.listen(5174, "0.0.0.0", () => {
  process.stdout.write("KABAN ARENA local editor API listening on :5174\n");
});
