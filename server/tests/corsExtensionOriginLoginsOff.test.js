import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import WebSocket from "ws";

// Security audit R2-27 (2026-10-28): every chrome-extension://,
// moz-extension:// and safari-web-extension:// origin got credentialed
// CORS. With panel logins off every caller is admin, so any extension in a
// browser that could reach the panel -- one with no permission for the
// panel's address at all -- could read the whole API and open a socket.
// Now, while logins are off, an extension must be named under Settings >
// Remote Access (or in CORS_ORIGINS); with logins on nothing changes (it
// still needs the panel password, which the Steam Sync popup signs in with).

const settings = new Map();
const db = { data: { users: [], roles: [] } };

vi.mock("../database/init.js", () => ({
  getSetting: async (key) => settings.get(key) ?? null,
  setSetting: async (key, value) => {
    settings.set(key, value);
  },
  getAllSettings: async () => Object.fromEntries(settings),
  getDb: async () => db,
  commitNow: async () => {},
  scheduleWrite: () => {},
  getRoles: async () => db.data.roles,
  getRoleById: async (id) => db.data.roles.find((r) => String(r.id) === String(id)) || null,
  getRoleByName: async (name) => db.data.roles.find((r) => r.name === name) || null,
  getUsersForRole: async () => [],
  peekServerDisplayName: () => null,
}));

const { app, io } = await import("../index.js");

const PANEL_HOST = "192.168.1.10:3001";
const CHROME_EXTENSION = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const FIREFOX_EXTENSION = "moz-extension://0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b";
let port;

function request(method, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        text += chunk;
      });
      res.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch (_) {
          // not JSON
        }
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    req.on("error", reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

// An Engine.IO polling handshake: "0{...}" when the socket would open.
function socketHandshake(origin) {
  return request("GET", "/socket.io/?EIO=4&transport=polling", { Host: PANEL_HOST, Origin: origin });
}

function websocketOpens(origin) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`, {
      origin,
      headers: { Host: PANEL_HOST },
    });
    ws.on("message", (data) => {
      if (data.toString().startsWith("0")) {
        ws.close();
        resolve(true);
      }
    });
    ws.on("error", () => resolve(false));
    ws.on("unexpected-response", () => resolve(false));
  });
}

beforeAll(async () => {
  await new Promise((resolve) => io.httpServer.listen(0, "127.0.0.1", resolve));
  port = io.httpServer.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => io.httpServer.close(resolve));
});

beforeEach(async () => {
  settings.clear();
  settings.set("authEnabled", false);
  db.data.roles = [{ id: "role-admin", name: "admin", capabilities: ["users.manage", "panel.settings"], isSeeded: true }];
  db.data.users = [
    { id: "u1", username: "admin", role: "admin", roleId: "role-admin", password: "x", tokenGen: 0 },
  ];
  await app.get("refreshCorsConfig")();
});

describe("browser extension origins while panel logins are off (R2-27)", () => {
  it("refuses an extension nobody named, and grants it no CORS read", async () => {
    for (const origin of [CHROME_EXTENSION, FIREFOX_EXTENSION]) {
      const res = await request("GET", "/api/config/app-settings", { Host: PANEL_HOST, Origin: origin });
      expect(res.status, origin).toBe(403);
      expect(res.headers["access-control-allow-origin"], origin).toBeUndefined();
      expect(res.json?.panelPort, origin).toBeUndefined();
    }
  });

  it("refuses its preflight too, so a JSON write never goes out", async () => {
    const res = await request("OPTIONS", "/api/mods/collection/extension-push", {
      Host: PANEL_HOST,
      Origin: CHROME_EXTENSION,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    });
    expect(res.status).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("tells the extension the exact line to add", async () => {
    const res = await request("POST", "/api/auth/login", {
      Host: PANEL_HOST,
      Origin: CHROME_EXTENSION,
      "Content-Type": "application/json",
    }, JSON.stringify({ username: "admin", password: "x" }));
    expect(res.status).toBe(403);
    expect(res.json.error).toContain(CHROME_EXTENSION);
    expect(res.json.error).toContain("Settings > Remote Access");
  });

  it("refuses its Socket.IO handshake, polling or WebSocket", async () => {
    const polling = await socketHandshake(CHROME_EXTENSION);
    expect(polling.status).not.toBe(200);
    expect(polling.text.startsWith("0")).toBe(false);
    expect(await websocketOpens(FIREFOX_EXTENSION)).toBe(false);
  });

  it("lets in the extension the operator named under Remote Access, and only that one", async () => {
    settings.set("corsAllowedOrigins", `https://panel.example.com\n${FIREFOX_EXTENSION.toUpperCase()}`);
    await app.get("refreshCorsConfig")();

    const named = await request("GET", "/api/health", { Host: PANEL_HOST, Origin: FIREFOX_EXTENSION });
    expect(named.status).toBe(200);
    expect(named.headers["access-control-allow-origin"]).toBe(FIREFOX_EXTENSION);
    expect(named.headers["access-control-allow-credentials"]).toBe("true");
    expect((await socketHandshake(FIREFOX_EXTENSION)).text.startsWith("0")).toBe(true);

    const other = await request("GET", "/api/health", { Host: PANEL_HOST, Origin: CHROME_EXTENSION });
    expect(other.status).toBe(403);
  });

  it("does the same for one named in CORS_ORIGINS", async () => {
    const before = process.env.CORS_ORIGINS;
    process.env.CORS_ORIGINS = CHROME_EXTENSION;
    try {
      await app.get("refreshCorsConfig")();
      const res = await request("GET", "/api/health", { Host: PANEL_HOST, Origin: CHROME_EXTENSION });
      expect(res.status).toBe(200);
      expect(res.headers["access-control-allow-origin"]).toBe(CHROME_EXTENSION);
    } finally {
      if (before === undefined) delete process.env.CORS_ORIGINS;
      else process.env.CORS_ORIGINS = before;
      await app.get("refreshCorsConfig")();
    }
  });

  it("can be named through the Settings page's own save", async () => {
    const saved = await request("PUT", "/api/config/app-settings", {
      Host: PANEL_HOST,
      Origin: `http://${PANEL_HOST}`,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/json",
    }, JSON.stringify({ settings: { corsAllowedOrigins: CHROME_EXTENSION } }));
    expect(saved.status).toBe(200);

    const res = await request("GET", "/api/health", { Host: PANEL_HOST, Origin: CHROME_EXTENSION });
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(CHROME_EXTENSION);
  });

  it("keeps the panel's own page working", async () => {
    const res = await request("GET", "/api/config/app-settings", {
      Host: PANEL_HOST,
      Origin: `http://${PANEL_HOST}`,
      "Sec-Fetch-Site": "same-origin",
    });
    expect(res.status).toBe(200);
  });

  it("still lets an extension in while panel logins are on (it needs the password there)", async () => {
    settings.set("authEnabled", true);
    const res = await request("GET", "/api/health", { Host: PANEL_HOST, Origin: CHROME_EXTENSION });
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(CHROME_EXTENSION);
  });

  // Adversary pass: shapes that try to pass for the named extension.
  it("does not mistake a look-alike origin for the named extension", async () => {
    settings.set("corsAllowedOrigins", CHROME_EXTENSION);
    await app.get("refreshCorsConfig")();
    for (const origin of [
      `${CHROME_EXTENSION}x`,
      `${CHROME_EXTENSION}.evil`,
      `${CHROME_EXTENSION}:443`,
      `${CHROME_EXTENSION}/popup.html`,
      `chrome-extension://x@${CHROME_EXTENSION.slice("chrome-extension://".length)}`,
      CHROME_EXTENSION.replace("chrome-extension", "moz-extension"),
      "null",
    ]) {
      const res = await request("GET", "/api/health", { Host: PANEL_HOST, Origin: origin });
      expect(res.status, origin).toBe(403);
      expect(res.headers["access-control-allow-origin"], origin).toBeUndefined();
    }
  });

  it("never treats a named extension's id as one of the panel's own host names", async () => {
    settings.set("corsAllowedOrigins", CHROME_EXTENSION);
    settings.set("corsAllowPrivateNetworks", false);
    await app.get("refreshCorsConfig")();
    const res = await request("GET", "/api/health", { Host: "abcdefghijklmnopabcdefghijklmnop" });
    expect(res.status).toBe(403);
  });
});
