import { createServer, type Server as HttpServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLIENT_DIST_ENV_VAR, createApp } from "./index.js";

const INDEX_HTML = "<!doctype html><html><body>kaban arena test client</body></html>";
const STYLE_CSS = "body { background: #000; }";
const NESTED_JS = "console.log(\"fake asset\");";

let tempDirs: Array<string> = [];
let savedClientDistEnv: string | undefined;

beforeEach(() => {
  savedClientDistEnv = process.env[CLIENT_DIST_ENV_VAR];
});

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
  if (savedClientDistEnv === undefined) {
    delete process.env[CLIENT_DIST_ENV_VAR];
  } else {
    process.env[CLIENT_DIST_ENV_VAR] = savedClientDistEnv;
  }
  savedClientDistEnv = undefined;
});

function makeClientDist(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kaban-client-dist-"));
  tempDirs.push(dir);
  mkdirSync(path.join(dir, "assets"), { recursive: true });
  writeFileSync(path.join(dir, "index.html"), INDEX_HTML);
  writeFileSync(path.join(dir, "style.css"), STYLE_CSS);
  writeFileSync(path.join(dir, "assets", "app.js"), NESTED_JS);
  return dir;
}

async function withServer(app: ReturnType<typeof createApp>, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const httpServer: HttpServer = createServer(app);
  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => resolve());
  });
  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server did not bind a port");
  }
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error?: Error) => {
        if (error !== undefined) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
}

describe("static client serving (single-container prod)", () => {
  it("GET / returns index.html from KABAN_CLIENT_DIST", async () => {
    process.env[CLIENT_DIST_ENV_VAR] = makeClientDist();
    await withServer(createApp(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(INDEX_HTML);
    });
  });

  it("asset files are served as-is (root + nested)", async () => {
    process.env[CLIENT_DIST_ENV_VAR] = makeClientDist();
    await withServer(createApp(), async (baseUrl) => {
      const css = await fetch(`${baseUrl}/style.css`);
      expect(css.status).toBe(200);
      expect(await css.text()).toBe(STYLE_CSS);
      expect(css.headers.get("content-type") ?? "").toContain("css");
      const nested = await fetch(`${baseUrl}/assets/app.js`);
      expect(nested.status).toBe(200);
      expect(await nested.text()).toBe(NESTED_JS);
    });
  });

  it("SPA fallback serves index.html for unknown non-API paths", async () => {
    process.env[CLIENT_DIST_ENV_VAR] = makeClientDist();
    await withServer(createApp(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/room/abc/play`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(INDEX_HTML);
    });
  });

  it("missing asset paths 404 instead of serving HTML", async () => {
    process.env[CLIENT_DIST_ENV_VAR] = makeClientDist();
    await withServer(createApp(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/assets/no-such-bundle.js`);
      expect(res.status).toBe(404);
    });
  });

  it("/health stays exactly {ok:true} even with a dist present", async () => {
    process.env[CLIENT_DIST_ENV_VAR] = makeClientDist();
    await withServer(createApp(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });
  });

  it("colyseus/API paths are not swallowed by the SPA fallback", async () => {
    process.env[CLIENT_DIST_ENV_VAR] = makeClientDist();
    await withServer(createApp(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/matchmake/joinOrCreate/arena`, { method: "POST" });
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("kaban arena test client");
    });
  });

  it("GET /matchmake/... falls through to 404, not index.html (bare app, no colyseus)", async () => {
    process.env[CLIENT_DIST_ENV_VAR] = makeClientDist();
    await withServer(createApp(), async (baseUrl) => {
      const res = await fetch(`${baseUrl}/matchmake/joinOrCreate/arena`);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("kaban arena test client");
    });
  });

  it("missing dist dir is a no-op: no crash, /health works, / 404s", async () => {
    process.env[CLIENT_DIST_ENV_VAR] = path.join(os.tmpdir(), "kaban-client-dist-does-not-exist");
    const app = createApp();
    expect(app).toBeDefined();
    await withServer(app, async (baseUrl) => {
      const health = await fetch(`${baseUrl}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });
      const root = await fetch(`${baseUrl}/`);
      expect(root.status).toBe(404);
    });
  });
});
