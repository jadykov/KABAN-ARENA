// getServerUrl() pins (proxy topology): the client derives the Colyseus
// WebSocket endpoint from the page URL so one bundle works behind the prod
// Caddy reverse proxy (Caddy :80/:443 -> game :2567, direct :2567 open),
// on raw-IP http, and in local Vite dev (:5173 -> ws://host:2567).
// Vitest runs in node with no jsdom, so the page URL is faked by assigning
// a minimal window on globalThis (the same globalThis-record pattern the
// ui suites use for their fake document); VITE_SERVER_URL is controlled via
// vi.stubEnv, which feeds import.meta.env under vitest.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SERVER_URL_DEFAULT_PORT, getServerUrl } from "./config";

interface FakeLocation {
  protocol: string;
  hostname: string;
  port: string;
}

interface FakeWindow {
  location: FakeLocation;
}

function setPageLocation(protocol: string, hostname: string, port: string): void {
  const fakeWindow: FakeWindow = { location: { protocol, hostname, port } };
  (globalThis as unknown as { window: FakeWindow }).window = fakeWindow;
}

function clearPageWindow(): void {
  delete (globalThis as unknown as { window?: FakeWindow }).window;
}

afterEach(() => {
  clearPageWindow();
  vi.unstubAllEnvs();
});

describe("getServerUrl behind the Caddy proxy", () => {
  it("https page on the default port uses wss same-origin with no port", () => {
    setPageLocation("https:", "kaban.wpgg.ru", "");
    expect(getServerUrl()).toBe("wss://kaban.wpgg.ru");
  });

  it("https page with explicit :443 uses wss same-origin with no port", () => {
    setPageLocation("https:", "kaban.wpgg.ru", "443");
    expect(getServerUrl()).toBe("wss://kaban.wpgg.ru");
  });

  it("http page with explicit :80 uses ws same-origin with no port", () => {
    setPageLocation("http:", "185.188.182.46", "80");
    expect(getServerUrl()).toBe("ws://185.188.182.46");
  });

  it("http page on the default port uses ws same-origin with no port", () => {
    setPageLocation("http:", "185.188.182.46", "");
    expect(getServerUrl()).toBe("ws://185.188.182.46");
  });

  it("page served directly from :2567 keeps the :2567 suffix", () => {
    setPageLocation("http:", "185.188.182.46", "2567");
    expect(getServerUrl()).toBe(`ws://185.188.182.46:${SERVER_URL_DEFAULT_PORT}`);
  });

  it("Vite dev page (:5173) targets ws://host:2567 (dev behavior unchanged)", () => {
    setPageLocation("http:", "localhost", "5173");
    expect(getServerUrl()).toBe(`ws://localhost:${SERVER_URL_DEFAULT_PORT}`);
  });

  it("any other custom port targets ws(s)://host:2567", () => {
    setPageLocation("http:", "example.com", "8080");
    expect(getServerUrl()).toBe(`ws://example.com:${SERVER_URL_DEFAULT_PORT}`);
    setPageLocation("https:", "example.com", "8443");
    expect(getServerUrl()).toBe(`wss://example.com:${SERVER_URL_DEFAULT_PORT}`);
  });

  it("empty hostname falls back to localhost", () => {
    setPageLocation("http:", "", "5173");
    expect(getServerUrl()).toBe(`ws://localhost:${SERVER_URL_DEFAULT_PORT}`);
  });
});

describe("getServerUrl env override and headless fallback", () => {
  it("VITE_SERVER_URL wins over the page URL", () => {
    setPageLocation("https:", "kaban.wpgg.ru", "");
    vi.stubEnv("VITE_SERVER_URL", "wss://relay.example.com:9999");
    expect(getServerUrl()).toBe("wss://relay.example.com:9999");
  });

  it("empty VITE_SERVER_URL is ignored (falls through to the page URL)", () => {
    setPageLocation("https:", "kaban.wpgg.ru", "");
    vi.stubEnv("VITE_SERVER_URL", "");
    expect(getServerUrl()).toBe("wss://kaban.wpgg.ru");
  });

  it("no window (headless tests) falls back to ws://localhost:2567", () => {
    clearPageWindow();
    expect(typeof window).toBe("undefined");
    expect(getServerUrl()).toBe(`ws://localhost:${SERVER_URL_DEFAULT_PORT}`);
  });
});
