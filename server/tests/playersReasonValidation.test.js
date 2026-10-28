import { beforeEach, describe, expect, it, vi } from "vitest";

const logPlayerAction = vi.fn();
const addSteamIdBan = vi.fn();

vi.mock("../database/init.js", () => ({
  logPlayerAction,
  getPlayerLogs: vi.fn(),
  getPlayerNotes: vi.fn(),
  getPlayerNote: vi.fn(),
  upsertPlayerNote: vi.fn(),
  deletePlayerNote: vi.fn(),
  getPlayerStats: vi.fn(),
  getPlayerStat: vi.fn(),
  getSteamIdBans: vi.fn(),
  addSteamIdBan,
  removeSteamIdBan: vi.fn(),
  getActiveServer: vi.fn(),
}));

vi.mock("../services/panelBridge.js", () => ({
  default: { isRunning: false, sendCommand: vi.fn() },
}));

const { default: router } = await import("../routes/players.js");
const { RconService } = await import("../services/rcon.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getRouteHandler(method, routePath) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createRequest(body, rconService) {
  return { body, app: { get: () => rconService } };
}

function makeRconService() {
  return {
    kickPlayer: vi.fn(async () => ({ success: true, response: "ok" })),
    banPlayer: vi.fn(async () => ({ success: true, response: "ok", sentReason: "x" })),
    banSteamId: vi.fn(async () => ({ success: true, response: "ok" })),
  };
}

// The client's reason preview (rconTextPreview.ts) tells the operator that
// characters the game cannot carry are stripped or altered, and then sends the
// text. The route used to answer 400 "Invalid reason format" to anything
// outside a short Latin whitelist instead, so the warning promised an outcome
// the server refused.
const ACCEPTED_REASONS = [
  "cheating [RDM]",
  "RDM / KOS",
  "Читерство",
  "toxic ~ rude",
  "a < b > c",
  "wildcard *",
  "测试原因",
  "emoji \u{1F600} reason",
  "x".repeat(256),
];

const REJECTED_REASONS = [
  ["a newline", "line one\nline two"],
  ["a carriage return", "line one\rline two"],
  ["a NUL", "bad\0reason"],
  ["a tab", "bad\treason"],
  ["a DEL", "bad\x7freason"],
  ["more than 256 characters", "x".repeat(257)],
  ["a non-string", 12345],
  ["an object", { toString: () => "x" }],
];

beforeEach(() => {
  logPlayerAction.mockReset();
  addSteamIdBan.mockReset();
});

describe("POST /kick reason", () => {
  for (const reason of ACCEPTED_REASONS) {
    it(`accepts ${JSON.stringify(reason.length > 40 ? `${reason.slice(0, 12)}... (${reason.length} chars)` : reason)}`, async () => {
      const rconService = makeRconService();
      const response = createResponse();

      await getRouteHandler("post", "/kick")(
        createRequest({ username: "Bob", reason }, rconService),
        response,
      );

      expect(response.status).not.toHaveBeenCalled();
      expect(rconService.kickPlayer).toHaveBeenCalledWith("Bob", reason);
    });
  }

  for (const [label, reason] of REJECTED_REASONS) {
    it(`rejects ${label}`, async () => {
      const rconService = makeRconService();
      const response = createResponse();

      await getRouteHandler("post", "/kick")(
        createRequest({ username: "Bob", reason }, rconService),
        response,
      );

      expect(response.status).toHaveBeenCalledWith(400);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: "Invalid reason format" }),
      );
      expect(rconService.kickPlayer).not.toHaveBeenCalled();
    });
  }
});

describe("POST /ban reason", () => {
  for (const reason of ACCEPTED_REASONS) {
    it(`accepts ${JSON.stringify(reason.length > 40 ? `${reason.slice(0, 12)}... (${reason.length} chars)` : reason)}`, async () => {
      const rconService = makeRconService();
      const response = createResponse();

      await getRouteHandler("post", "/ban")(
        createRequest({ username: "Bob", reason }, rconService),
        response,
      );

      expect(response.status).not.toHaveBeenCalled();
      expect(rconService.banPlayer).toHaveBeenCalledWith("Bob", undefined, reason);
    });
  }

  for (const [label, reason] of REJECTED_REASONS) {
    it(`rejects ${label}`, async () => {
      const rconService = makeRconService();
      const response = createResponse();

      await getRouteHandler("post", "/ban")(
        createRequest({ username: "Bob", reason }, rconService),
        response,
      );

      expect(response.status).toHaveBeenCalledWith(400);
      expect(rconService.banPlayer).not.toHaveBeenCalled();
    });
  }
});

describe("POST /banid reason (stored in the panel only, never sent to the game)", () => {
  const steamId = "12345678901234567";

  for (const reason of ACCEPTED_REASONS) {
    it(`accepts and stores ${JSON.stringify(reason.length > 40 ? `${reason.slice(0, 12)}... (${reason.length} chars)` : reason)}`, async () => {
      const rconService = makeRconService();
      const response = createResponse();

      await getRouteHandler("post", "/banid")(
        createRequest({ steamId, reason }, rconService),
        response,
      );

      expect(response.status).not.toHaveBeenCalled();
      expect(addSteamIdBan).toHaveBeenCalledWith(steamId, reason);
      expect(logPlayerAction).toHaveBeenCalledWith(steamId, "banid", reason, undefined, null);
    });
  }

  for (const [label, reason] of REJECTED_REASONS.filter(([, r]) => typeof r === "string" && r.trim() !== "")) {
    it(`rejects ${label}`, async () => {
      const rconService = makeRconService();
      const response = createResponse();

      await getRouteHandler("post", "/banid")(
        createRequest({ steamId, reason }, rconService),
        response,
      );

      expect(response.status).toHaveBeenCalledWith(400);
      expect(rconService.banSteamId).not.toHaveBeenCalled();
      expect(addSteamIdBan).not.toHaveBeenCalled();
    });
  }
});

describe("what actually reaches the game for a reason the route now accepts", () => {
  it("is narrowed by rcon.sanitizeForBanReason, so nothing unsafe gets through", () => {
    const rcon = new RconService();
    expect(rcon.sanitizeForBanReason("cheating [RDM]")).toBe("cheating RDM");
    expect(rcon.sanitizeForBanReason("RDM / KOS")).toBe("RDM  KOS");
    expect(rcon.sanitizeForBanReason("Читерство")).toBe("");
    expect(rcon.sanitizeForBanReason('say "hi" \\ <b>*~</b>')).not.toMatch(/["\\<>*~]/);
  });
});
