import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";

// Security audit R2-31 (2026-10-28): over plain http:// the Steam Sync
// extension can't tell the panel from whatever else answers at its address
// (another network's 192.168.x host, a .lan name its DNS hands out). A
// sign-in that asks for it now gets a per-account panel key, and
// POST /api/auth/extension-proof answers HMAC(key, challenge) so the
// extension can check the address before it sends the Steam cookies or a
// password there again (browserExtensionPanelIdentity.test.js).

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

const { default: authService } = await import("../services/auth.js");
const { app, io } = await import("../index.js");

const PANEL_HOST = "192.168.1.10:3001";
const EXTENSION = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const PASSWORD = "correct horse battery";
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);
let port;

function post(path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: { Host: PANEL_HOST, Origin: EXTENSION, "Content-Type": "application/json", ...headers },
      },
      (res) => {
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
          resolve({ status: res.statusCode, json });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

const challenge = () => crypto.randomBytes(32).toString("base64url");
const expectedProof = (key, value) =>
  crypto.createHmac("sha256", key).update(`zcp-steam-sync-proof-v1:${value}`).digest("base64url");

beforeAll(async () => {
  authService.jwtSecret = "extension-panel-proof-test-secret-".padEnd(64, "x");
  await new Promise((resolve) => io.httpServer.listen(0, "127.0.0.1", resolve));
  port = io.httpServer.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => io.httpServer.close(resolve));
});

beforeEach(async () => {
  settings.clear();
  db.data.roles = [{ id: "role-admin", name: "admin", capabilities: ["users.manage"], isSeeded: true }];
  db.data.users = [
    { id: "u1", username: "admin", role: "admin", roleId: "role-admin", password: PASSWORD_HASH, tokenGen: 0 },
    { id: "u2", username: "moderator", role: "admin", roleId: "role-admin", password: PASSWORD_HASH, tokenGen: 0 },
  ];
  await app.get("refreshCorsConfig")();
});

describe("the Steam Sync extension's panel check (R2-31)", () => {
  it("hands the panel key to a sign-in that asks for it, and only then", async () => {
    const asked = await post("/api/auth/login", { username: "admin", password: PASSWORD, wantsPanelKey: true });
    expect(asked.status).toBe(200);
    expect(asked.json.panelKey).toBe(authService.extensionPanelKey("u1"));
    expect(asked.json.panelKey).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const notAsked = await post("/api/auth/login", { username: "admin", password: PASSWORD });
    expect(notAsked.json).not.toHaveProperty("panelKey");

    const wrongPassword = await post("/api/auth/login", { username: "admin", password: "nope", wantsPanelKey: true });
    expect(wrongPassword.status).toBe(401);
    expect(wrongPassword.json).not.toHaveProperty("panelKey");
  });

  it("answers a challenge with that key, signed in or not", async () => {
    const { json } = await post("/api/auth/login", { username: "admin", password: PASSWORD, wantsPanelKey: true });
    const value = challenge();

    const res = await post("/api/auth/extension-proof", { username: "ADMIN", challenge: value });

    expect(res.status).toBe(200);
    expect(res.json.proof).toBe(expectedProof(json.panelKey, value));
  });

  it("gives every account its own key, and a new one when the sign-in secret changes", async () => {
    const admin = authService.extensionPanelKey("u1");
    expect(authService.extensionPanelKey("u2")).not.toBe(admin);
    const secret = authService.jwtSecret;
    try {
      authService.jwtSecret = "another-secret-".padEnd(64, "y");
      expect(authService.extensionPanelKey("u1")).not.toBe(admin);
    } finally {
      authService.jwtSecret = secret;
    }
  });

  it("answers an unknown name like a known one, so it can't list accounts", async () => {
    const value = challenge();
    const unknown = await post("/api/auth/extension-proof", { username: "nobody", challenge: value });
    const known = await post("/api/auth/extension-proof", { username: "admin", challenge: value });

    expect(unknown.status).toBe(200);
    expect(unknown.json.proof).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(unknown.json.proof).not.toBe(known.json.proof);
  });

  // Adversary pass: the answer must not double as anything else the panel
  // signs, and odd input is refused rather than hashed.
  it("never answers with a key, a token signature, or for a malformed challenge", async () => {
    const key = authService.extensionPanelKey("u1");
    const accessToken = authService.generateAccessToken(db.data.users[0]);
    const [header, payload, signature] = accessToken.split(".");
    const res = await post("/api/auth/extension-proof", { username: "admin", challenge: `${header}${payload}`.slice(0, 128) });
    expect(res.status).toBe(200);
    expect([key, signature]).not.toContain(res.json.proof);

    for (const body of [
      { username: "admin" },
      { username: "admin", challenge: "short" },
      { username: "admin", challenge: `${"a".repeat(30)}.${"b".repeat(30)}` },
      { username: "admin", challenge: "a".repeat(129) },
      { username: "", challenge: challenge() },
      { username: ["admin"], challenge: challenge() },
      { username: "a".repeat(129), challenge: challenge() },
    ]) {
      const refused = await post("/api/auth/extension-proof", body);
      expect(refused.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(refused.json).not.toHaveProperty("proof");
    }
  });
});
