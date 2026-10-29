import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

// SECURITY (2026-10-28): a Socket.IO handshake took the access token from
// the URL query (?token=) as well as from its auth payload. URLs end up in
// reverse-proxy access logs and browser history, which is why HTTP stopped
// taking ?token= outside the one SSE stream (security audit M2); the socket
// still did. The panel's client sends the token in the auth payload only
// (client/src/lib/socketAuth.ts), so that is now the only place read.
//
// Same raw Engine.IO v4 framing as presetupSocketRefused.test.js:
// "40<auth>" connect, "40{sid}" accepted, "44{message}" refused.

const settings = new Map();
const db = { data: { users: [], roles: [] } };

vi.mock("../database/init.js", () => ({
  getSetting: async (key) => settings.get(key) ?? null,
  setSetting: async (key, value) => {
    settings.set(key, value);
  },
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
const { io } = await import("../index.js");

let port;
let accessToken;

function connectRawSocket({ query = "", connectPacket = "40" } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket${query}`,
    );
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      ws.close();
      resolve(value);
    };
    ws.on("error", (error) => (settled ? null : reject(error)));
    ws.on("close", () => settle({ outcome: "closed" }));
    ws.on("message", (data) => {
      const packet = data.toString();
      if (packet.startsWith("0")) {
        ws.send(connectPacket);
      } else if (packet === "2") {
        ws.send("3");
      } else if (packet.startsWith("40")) {
        settle({ outcome: "connected" });
      } else if (packet.startsWith("44")) {
        settle({ outcome: "refused", message: JSON.parse(packet.slice(2)).message });
      }
    });
  });
}

beforeAll(async () => {
  authService.jwtSecret = "socket-url-token-test-secret-".padEnd(64, "x");
  await new Promise((resolve) => io.httpServer.listen(0, "127.0.0.1", resolve));
  port = io.httpServer.address().port;
});

afterAll(async () => {
  io.disconnectSockets(true);
  await new Promise((resolve) => io.httpServer.close(resolve));
});

beforeEach(() => {
  settings.clear();
  db.data.roles = [
    { id: "role-admin", name: "admin", capabilities: ["users.manage", "roles.manage"], isSeeded: true },
  ];
  db.data.users = [
    { id: "u-admin", username: "admin", role: "admin", roleId: "role-admin", password: "x", tokenGen: 0 },
  ];
  accessToken = authService.generateAccessToken(db.data.users[0]);
});

afterEach(() => {
  io.disconnectSockets(true);
});

describe("Socket.IO handshake: the access token is read from the auth payload only", () => {
  it("accepts a valid token sent in the auth payload", async () => {
    const result = await connectRawSocket({ connectPacket: `40${JSON.stringify({ token: accessToken })}` });
    expect(result.outcome).toBe("connected");
  });

  it("refuses a valid token sent only in the URL query", async () => {
    const result = await connectRawSocket({ query: `&token=${encodeURIComponent(accessToken)}` });
    expect(result).toEqual({ outcome: "refused", message: "Authentication required" });
  });

  // Adversary pass: an auth payload that is present but has no usable token
  // must not fall back to the URL's.
  it("does not fall back to the URL token when the auth payload's token is empty or not a string", async () => {
    const query = `&token=${encodeURIComponent(accessToken)}`;
    for (const auth of [{}, { token: "" }, { token: [accessToken] }, { token: { toString: accessToken } }]) {
      const result = await connectRawSocket({ query, connectPacket: `40${JSON.stringify(auth)}` });
      expect(result.outcome, JSON.stringify(auth)).toBe("refused");
    }
  });
});
