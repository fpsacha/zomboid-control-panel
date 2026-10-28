import { beforeEach, describe, expect, it, vi } from "vitest";

const logPlayerAction = vi.fn();

vi.mock("../database/init.js", () => ({
  // R2-5: these tests act as a role that may grant staff levels.
  getRoleByName: vi.fn(async () => ({ capabilities: ["players.moderate", "rcon.execute"] })),
  logPlayerAction,
  getPlayerLogs: vi.fn(),
  getPlayerNotes: vi.fn(),
  getPlayerNote: vi.fn(),
  upsertPlayerNote: vi.fn(),
  deletePlayerNote: vi.fn(),
  getPlayerStats: vi.fn(),
  getPlayerStat: vi.fn(),
  getSteamIdBans: vi.fn(),
  addSteamIdBan: vi.fn(),
  removeSteamIdBan: vi.fn(),
  getActiveServer: vi.fn(),
}));

vi.mock("../services/panelBridge.js", () => ({
  default: { isRunning: false, sendCommand: vi.fn() },
}));

const { default: router } = await import("../routes/players.js");

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
  return { body, user: { username: "tech", role: "technician" }, app: { get: () => rconService } };
}

// Sibling bug to the one playersBanRecordIntegrity.test.js pins for
// ban/unban/banid/unbanid/voiceban/adduser: RconService methods resolve
// {success:false} rather than throwing when RCON is unreachable (server
// offline / mid-restart). These eight routes wrote to the player activity
// log (GET /activity, the panel's own audit trail) unconditionally, so an
// admin reviewing history later would see "kicked PlayerX" or "gave PlayerX
// 50 XP" entries for actions that never actually reached the server -- the
// exact moment RCON is most likely to be down is also the moment an admin is
// most likely to be trying to discipline someone or intervene.
describe("players routes: activity log only written on RCON/bridge success", () => {
  beforeEach(() => {
    logPlayerAction.mockReset();
  });

  describe("POST /kick", () => {
    it("logs the action when RCON succeeds", async () => {
      const rconService = {
        kickPlayer: vi.fn(async () => ({ success: true, response: "ok" })),
      };
      const response = createResponse();

      await getRouteHandler("post", "/kick")(
        createRequest({ username: "Bob", reason: "griefing" }, rconService),
        response,
      );

      expect(logPlayerAction).toHaveBeenCalledWith("Bob", "kick", "griefing", undefined, "tech");
    });

    it("does NOT log the action when RCON reports failure (server offline)", async () => {
      const rconService = {
        kickPlayer: vi.fn(async () => ({
          success: false,
          error: "Server is not running",
        })),
      };
      const response = createResponse();

      await getRouteHandler("post", "/kick")(
        createRequest({ username: "Bob", reason: "griefing" }, rconService),
        response,
      );

      expect(logPlayerAction).not.toHaveBeenCalled();
      expect(response.json).toHaveBeenCalledWith({
        success: false,
        error: "Server is not running",
      });
    });
  });

  describe("POST /access-level", () => {
    it("logs the action when RCON succeeds", async () => {
      const rconService = {
        setAccessLevel: vi.fn(async () => ({ success: true, response: "ok" })),
      };
      const response = createResponse();

      await getRouteHandler("post", "/access-level")(
        createRequest({ username: "Bob", level: "admin" }, rconService),
        response,
      );

      expect(logPlayerAction).toHaveBeenCalledWith("Bob", "access_level", "admin", undefined, "tech");
    });

    it("does NOT log the action when RCON reports failure", async () => {
      const rconService = {
        setAccessLevel: vi.fn(async () => ({
          success: false,
          error: "Server is not running",
        })),
      };
      const response = createResponse();

      await getRouteHandler("post", "/access-level")(
        createRequest({ username: "Bob", level: "admin" }, rconService),
        response,
      );

      expect(logPlayerAction).not.toHaveBeenCalled();
    });
  });

  describe("POST /add-item", () => {
    it("logs the action when RCON succeeds", async () => {
      const rconService = {
        addItem: vi.fn(async () => ({ success: true, response: "ok" })),
      };
      const response = createResponse();

      await getRouteHandler("post", "/add-item")(
        createRequest({ username: "Bob", item: "Base.Axe", count: 1 }, rconService),
        response,
      );

      expect(logPlayerAction).toHaveBeenCalledWith("Bob", "add_item", "Base.Axe x1", undefined, "tech");
    });

    it("does NOT log the action when RCON reports failure", async () => {
      const rconService = {
        addItem: vi.fn(async () => ({
          success: false,
          error: "Server is not running",
        })),
      };
      const response = createResponse();

      await getRouteHandler("post", "/add-item")(
        createRequest({ username: "Bob", item: "Base.Axe", count: 1 }, rconService),
        response,
      );

      expect(logPlayerAction).not.toHaveBeenCalled();
    });
  });

  describe("POST /add-xp", () => {
    it("logs the action when RCON succeeds", async () => {
      const rconService = {
        addXp: vi.fn(async () => ({ success: true, response: "ok" })),
      };
      const response = createResponse();

      await getRouteHandler("post", "/add-xp")(
        createRequest({ username: "Bob", perk: "Strength", amount: 50 }, rconService),
        response,
      );

      expect(logPlayerAction).toHaveBeenCalledWith("Bob", "add_xp", "Strength=50", undefined, "tech");
    });

    it("does NOT log the action when RCON reports failure", async () => {
      const rconService = {
        addXp: vi.fn(async () => ({
          success: false,
          error: "Server is not running",
        })),
      };
      const response = createResponse();

      await getRouteHandler("post", "/add-xp")(
        createRequest({ username: "Bob", perk: "Strength", amount: 50 }, rconService),
        response,
      );

      expect(logPlayerAction).not.toHaveBeenCalled();
    });
  });

  describe("POST /add-vehicle", () => {
    it("logs the action when RCON succeeds", async () => {
      const rconService = {
        addVehicle: vi.fn(async () => ({ success: true, response: "ok" })),
      };
      const response = createResponse();

      await getRouteHandler("post", "/add-vehicle")(
        createRequest({ username: "Bob", vehicle: "Base.CarNormal" }, rconService),
        response,
      );

      expect(logPlayerAction).toHaveBeenCalledWith("Bob", "add_vehicle", "Base.CarNormal", undefined, "tech");
    });

    it("does NOT log the action when RCON reports failure", async () => {
      const rconService = {
        addVehicle: vi.fn(async () => ({
          success: false,
          error: "Server is not running",
        })),
      };
      const response = createResponse();

      await getRouteHandler("post", "/add-vehicle")(
        createRequest({ username: "Bob", vehicle: "Base.CarNormal" }, rconService),
        response,
      );

      expect(logPlayerAction).not.toHaveBeenCalled();
    });
  });

  describe("POST /godmode", () => {
    it("logs the action when the underlying command succeeds", async () => {
      const rconService = {
        setGodMode: vi.fn(async () => ({ success: true, response: "ok" })),
      };
      const response = createResponse();

      await getRouteHandler("post", "/godmode")(
        createRequest({ username: "Bob", enabled: true }, rconService),
        response,
      );

      expect(logPlayerAction).toHaveBeenCalledWith("Bob", "godmode", "enabled", undefined, "tech");
    });

    it("does NOT log the action when the underlying command fails", async () => {
      const rconService = {
        setGodMode: vi.fn(async () => ({
          success: false,
          error: "Server is not running",
        })),
      };
      const response = createResponse();

      await getRouteHandler("post", "/godmode")(
        createRequest({ username: "Bob", enabled: true }, rconService),
        response,
      );

      expect(logPlayerAction).not.toHaveBeenCalled();
    });
  });

  describe("POST /invisible", () => {
    it("logs the action when the underlying command succeeds", async () => {
      const rconService = {
        setInvisible: vi.fn(async () => ({ success: true, response: "ok" })),
      };
      const response = createResponse();

      await getRouteHandler("post", "/invisible")(
        createRequest({ username: "Bob", enabled: true }, rconService),
        response,
      );

      expect(logPlayerAction).toHaveBeenCalledWith("Bob", "invisible", "enabled", undefined, "tech");
    });

    it("does NOT log the action when the underlying command fails", async () => {
      const rconService = {
        setInvisible: vi.fn(async () => ({
          success: false,
          error: "Server is not running",
        })),
      };
      const response = createResponse();

      await getRouteHandler("post", "/invisible")(
        createRequest({ username: "Bob", enabled: true }, rconService),
        response,
      );

      expect(logPlayerAction).not.toHaveBeenCalled();
    });
  });

  describe("POST /noclip", () => {
    it("logs the action when the underlying command succeeds", async () => {
      const rconService = {
        setNoclip: vi.fn(async () => ({ success: true, response: "ok" })),
      };
      const response = createResponse();

      await getRouteHandler("post", "/noclip")(
        createRequest({ username: "Bob", enabled: true }, rconService),
        response,
      );

      expect(logPlayerAction).toHaveBeenCalledWith("Bob", "noclip", "enabled", undefined, "tech");
    });

    it("does NOT log the action when the underlying command fails", async () => {
      const rconService = {
        setNoclip: vi.fn(async () => ({
          success: false,
          error: "Server is not running",
        })),
      };
      const response = createResponse();

      await getRouteHandler("post", "/noclip")(
        createRequest({ username: "Bob", enabled: true }, rconService),
        response,
      );

      expect(logPlayerAction).not.toHaveBeenCalled();
    });
  });
});

describe("players toggle routes: enabled must remain a boolean", () => {
  it.each(["/godmode", "/invisible", "/noclip", "/voiceban"])(
    "rejects a string false on %s instead of enabling the player mode",
    async (routePath) => {
      const methodByRoute = {
        "/godmode": "setGodMode",
        "/invisible": "setInvisible",
        "/noclip": "setNoclip",
        "/voiceban": "voiceBan",
      };
      const method = methodByRoute[routePath];
      const rconService = { [method]: vi.fn(async () => ({ success: true })) };
      const response = createResponse();

      await getRouteHandler("post", routePath)(
        createRequest({ username: "Bob", enabled: "false" }, rconService),
        response,
      );

      expect(response.status).toHaveBeenCalledWith(400);
      expect(response.json).toHaveBeenCalledWith({
        error: "enabled must be a boolean",
        // 2026-08-26 bug hunt round 2: players.js adopted the ErrorCode registry.
        code: "PLAYERS_INVALID_ENABLED_FLAG",
      });
      expect(rconService[method]).not.toHaveBeenCalled();
    },
  );
});

describe("player notes: persisted values must keep their documented shape", () => {
  it("rejects a non-text note instead of storing an object", async () => {
    const response = createResponse();
    const upsert = (await import("../database/init.js")).upsertPlayerNote;

    await getRouteHandler("post", "/notes")(
      createRequest({ playerName: "Bob", note: { malicious: true } }, {}),
      response,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      error: "Note must be text",
      // 2026-08-26 bug hunt round 2: players.js adopted the ErrorCode registry.
      code: "PLAYERS_NOTE_MUST_BE_TEXT",
    });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("rejects an invalid player name before reaching persistence", async () => {
    const response = createResponse();
    const upsert = (await import("../database/init.js")).upsertPlayerNote;

    await getRouteHandler("post", "/notes")(
      createRequest({ playerName: "bad\\name", note: "note" }, {}),
      response,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(upsert).not.toHaveBeenCalled();
  });
});
