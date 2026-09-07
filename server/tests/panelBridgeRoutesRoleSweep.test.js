import { describe, expect, it, vi } from "vitest";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// panelBridge.js now gates with requirePermission (DB-backed) instead of
// requireRole -- these are gate-only tests (never proceed into a real
// handler), so a minimal getRoleByName-only mock is enough.
vi.mock("../database/init.js", () => ({
  getRoleByName: mockGetRoleByName,
}));

// panelBridge.js: 89 routes, only 8 had a requireRole call (all SFTP/mod-
// install, from an earlier pass) plus /command. Everything else was
// reachable by any signed-in account. Same both-directions standard as the
// rest of the sweep: bridge setup/integration control and its own
// diagnostics need admin+technician; the curated in-game GM tools
// (teleport, weather, zombies, sound, visual, chat, utilities, character
// import/export) are deliberately left open to every role -- that's the
// moderator's territory /command's whitelist-free passthrough is gated
// admin-only specifically to avoid replacing.

function createResponse() {
  const response = { status: () => response, json: () => response };
  let statusCode = 200;
  response.status = (code) => {
    statusCode = code;
    return response;
  };
  response.getStatusCode = () => statusCode;
  return response;
}

function getGate(router, routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${routePath} route registered`);
  return layer.route.stack[0].handle;
}

async function runGate(router, routePath, method, role) {
  const res = createResponse();
  let calledNext = false;
  await getGate(router, routePath, method)(
    { user: { role } },
    res,
    () => {
      calledNext = true;
    },
  );
  return { res, calledNext };
}

describe("panelBridge.js: bridge setup/integration control -- admin+technician", () => {
  const ROUTES = [
    ["/auto-configure", "post"],
    ["/scan-server/:serverId", "get"],
    ["/auto-detect", "post"],
    ["/configure", "post"],
    ["/configure-direct", "post"],
    ["/start", "post"],
    ["/stop", "post"],
    ["/scan-paths", "get"],
    ["/refresh", "post"],
    ["/mod-path", "get"],
    ["/world/save", "post"],
  ];

  it.each(ROUTES)("refuses a moderator on %s %s", async (routePath, method) => {
    const { default: router } = await import("../routes/panelBridge.js");
    const { res } = await runGate(router, routePath, method, "moderator");
    expect(res.getStatusCode()).toBe(403);
  });

  it.each(ROUTES)("does not refuse a technician at the gate on %s %s", async (routePath, method) => {
    const { default: router } = await import("../routes/panelBridge.js");
    const { calledNext } = await runGate(router, routePath, method, "technician");
    expect(calledNext).toBe(true);
  });
});

describe("panelBridge.js: bridge/catalog diagnostics -- admin+technician", () => {
  const ROUTES = [
    ["/debug/log", "get"],
    ["/debug/stats", "get"],
    ["/debug/mode", "post"],
    ["/debug/api", "get"],
    ["/debug/handlers", "get"],
    ["/debug/clear-errors", "post"],
    ["/catalog/scan-items", "post"],
    ["/catalog/scan-vehicles", "post"],
    ["/catalog/debug-item-script", "post"],
  ];

  it.each(ROUTES)("refuses a moderator on %s %s", async (routePath, method) => {
    const { default: router } = await import("../routes/panelBridge.js");
    const { res } = await runGate(router, routePath, method, "moderator");
    expect(res.getStatusCode()).toBe(403);
  });

  it.each(ROUTES)("does not refuse a technician at the gate on %s %s", async (routePath, method) => {
    const { default: router } = await import("../routes/panelBridge.js");
    const { calledNext } = await runGate(router, routePath, method, "technician");
    expect(calledNext).toBe(true);
  });
});

describe("panelBridge.js: existing SFTP + mod-install gates are unchanged (admin+technician)", () => {
  const ROUTES = [
    ["/sftp/test", "post"],
    ["/sftp/configure", "post"],
    ["/sftp/logs/list", "post"],
    ["/sftp/logs/tail", "post"],
    ["/sftp/config/list", "post"],
    ["/install-local", "post"],
    ["/install-mod-auto", "post"],
    ["/install-mod", "post"],
  ];

  it.each(ROUTES)("refuses a moderator on %s %s", async (routePath, method) => {
    const { default: router } = await import("../routes/panelBridge.js");
    const { res } = await runGate(router, routePath, method, "moderator");
    expect(res.getStatusCode()).toBe(403);
  });

  it.each(ROUTES)("does not refuse a technician at the gate on %s %s", async (routePath, method) => {
    const { default: router } = await import("../routes/panelBridge.js");
    const { calledNext } = await runGate(router, routePath, method, "technician");
    expect(calledNext).toBe(true);
  });
});

describe("panelBridge.js: POST /command stays admin-only (unchanged, whitelist-free passthrough)", () => {
  it("refuses a technician", async () => {
    const { default: router } = await import("../routes/panelBridge.js");
    const { res } = await runGate(router, "/command", "post", "technician");
    expect(res.getStatusCode()).toBe(403);
  });

  it("does not refuse an admin", async () => {
    const { default: router } = await import("../routes/panelBridge.js");
    const { calledNext } = await runGate(router, "/command", "post", "admin");
    expect(calledNext).toBe(true);
  });
});

// sweep-round5 (2026-09-07) FOLLOW-UP: this describe block used to be
// titled "/status, /ping, /commands stay outside the matrix entirely" and
// asserted all three had no gate, on one shared judgement written by one
// author at one time. That judgement was wrong for /status: it returned
// cachePath/remotePath/remoteDirectories (host and remote-server
// filesystem paths) to any authenticated session regardless of role
// (7ead08e0). /status is now gated with requireAnyPermission("bridge.setup",
// "bridge.diagnostics") -- removed from this list entirely (a route that's
// actually gated belongs in a "has a gate" test, not a "has no gate" one);
// see panelBridgeStatusRouteCapability.test.js and
// routeAuthorizationCoverage.test.js for its coverage.
//
// The other two members of that original judgement were re-checked against
// source, not re-inherited, once the first one turned out wrong:
describe("panelBridge.js: /commands stays outside the matrix -- static API documentation only", () => {
  it("GET /commands has no requirePermission gate ahead of its handler -- confirmed safe: every field is a literal in the handler, nothing derived from req/DB/per-install state", async () => {
    const { default: router } = await import("../routes/panelBridge.js");
    const layer = router.stack.find(
      (entry) => entry.route?.path === "/commands" && entry.route.methods.get,
    );
    expect(layer.route.stack.length).toBe(1);
  });
});

// /ping is NOT confirmed safe. Its modStatus.path (the mod's own base path
// on the game server) and modStatus.filePath (the panel's local path to the
// status file -- for a remote/SFTP server, the local mirror directory) are
// the same class of unmasked-filesystem-path leak /status had; it also
// returns a live modStatus.players username list with no players.view
// check, unlike every other route that exposes player presence. Reported
// to god as a likely real hole rather than fixed here (release-1-2-17,
// 2026-09-07) -- god's call on whether it lands in v1.2.17 or after. This
// test documents only that the route remains ungated in the code today; it
// is not a claim that ungated is correct, and must be deleted (not just
// have its assertion flipped) the moment that changes -- same rule that
// applied to /status above.
describe("panelBridge.js: /ping -- KNOWN GAP, not yet actioned (see comment above)", () => {
  it("GET /ping has no requirePermission gate ahead of its handler -- documents current (leaky) state, not a design decision", async () => {
    const { default: router } = await import("../routes/panelBridge.js");
    const layer = router.stack.find(
      (entry) => entry.route?.path === "/ping" && entry.route.methods.get,
    );
    expect(layer.route.stack.length).toBe(1);
  });
});

// /server-info used to sit in TRULY_UNGATED above -- it returned every
// online player's exact x/y/z position and current health with no gate at
// all. Now requirePermission("players.view"), same capability players.js
// uses for reading player details/status. All three default roles hold it,
// so this is a zero-behaviour-change addition for every legitimate caller
// (both client call sites -- WorldMap and Debug -- only render post-login,
// behind App.tsx's auth gate, and always send whatever token they have).
describe("panelBridge.js: GET /server-info -- players.view (previously wide open)", () => {
  it("has a requirePermission gate ahead of its handler", async () => {
    const { default: router } = await import("../routes/panelBridge.js");
    const layer = router.stack.find(
      (entry) => entry.route?.path === "/server-info" && entry.route.methods.get,
    );
    expect(layer.route.stack.length).toBe(2);
  });

  for (const role of ["admin", "technician", "moderator"]) {
    it(`does not refuse a ${role}`, async () => {
      const { default: router } = await import("../routes/panelBridge.js");
      const { calledNext } = await runGate(router, "/server-info", "get", role);
      expect(calledNext).toBe(true);
    });
  }
});

describe("panelBridge.js: server.world_events (world-wide GM effects, folded in from previously-ungated) -- open to every role", () => {
  const WORLD_EVENTS_ROUTES = [
    ["/weather", "get"],
    ["/weather/blizzard", "post"],
    ["/weather/tropical-storm", "post"],
    ["/weather/storm", "post"],
    ["/weather/stop", "post"],
    ["/weather/generate", "post"],
    ["/weather/snow", "post"],
    ["/weather/rain/start", "post"],
    ["/weather/rain/stop", "post"],
    ["/weather/lightning", "post"],
    ["/climate/floats", "get"],
    ["/climate/float", "post"],
    ["/climate/reset", "post"],
    ["/climate/temperature", "post"],
    ["/climate/wind", "post"],
    ["/climate/fog", "post"],
    ["/climate/clouds", "post"],
    ["/time", "get"],
    ["/time", "post"],
    ["/world/stats", "get"],
    ["/message", "post"],
    ["/sound/world", "post"],
    ["/utilities/status", "get"],
    ["/utilities/restore", "post"],
    ["/utilities/shutoff", "post"],
    ["/zombies/count", "get"],
    ["/zombies/clear-near-player", "post"],
    ["/zombies/clear-all", "post"],
    ["/visual/view-distance", "post"],
    ["/visual/daylight", "post"],
    ["/visual/night-strength", "post"],
    ["/visual/desaturation", "post"],
    ["/visual/ambient", "post"],
    ["/chat/info", "get"],
    ["/chat/alert", "post"],
  ];
  // /sound/near-player, /sound/gunshot, /sound/alarm, /sound/noise,
  // /zombies/spawn-near, /zombies/spawn-behind, /chat/admin and
  // /chat/general used to be in this list -- moved out 2026-08-27 (operator
  // ruling on ranked-bug #5) to players.endanger_or_impersonate, see the
  // describe block below. Each takes an optional target (a username, or in
  // chat/general's case an arbitrary custom author name) and can spawn
  // zombies/sound at a named player or make a chat message read as if they
  // said it, unlike every route still in this array (/zombies/clear-near-
  // player also takes a username but is benign -- it clears zombies FROM
  // near a player, a help action not a harm one -- so it stayed here).
  // /sound/alarm and /sound/noise were caught in a second pass, AFTER the
  // operator had already ruled on the original 7+2 -- both take the exact
  // same {username} -> resolve-to-player's-x/y/z shape as /sound/gunshot
  // and /sound/near-player (PanelBridge.lua handlers.triggerAlarmSound/
  // createNoise), just missed in the first enumeration. Flagged to the
  // operator and folded into the same already-approved capability rather
  // than left half-fixed, since the harm shape is identical to routes he
  // already ruled on, not a new category needing its own decision.

  it.each(WORLD_EVENTS_ROUTES)("does not refuse a moderator on %s %s", async (routePath, method) => {
    const { default: router } = await import("../routes/panelBridge.js");
    const { calledNext } = await runGate(router, routePath, method, "moderator");
    expect(calledNext).toBe(true);
  });

  it.each(WORLD_EVENTS_ROUTES)("does not refuse a technician on %s %s", async (routePath, method) => {
    const { default: router } = await import("../routes/panelBridge.js");
    const { calledNext } = await runGate(router, routePath, method, "technician");
    expect(calledNext).toBe(true);
  });
});

describe("panelBridge.js: players.endanger_or_impersonate (targeted zombie/sound actions + chat impersonation) -- admin only, carved out of server.world_events", () => {
  const ENDANGER_ROUTES = [
    ["/sound/near-player", "post"],
    ["/sound/gunshot", "post"],
    ["/sound/alarm", "post"],
    ["/sound/noise", "post"],
    ["/zombies/spawn-near", "post"],
    ["/zombies/spawn-behind", "post"],
    ["/chat/admin", "post"],
    ["/chat/general", "post"],
  ];

  it.each(ENDANGER_ROUTES)("refuses a moderator on %s %s (lost with the split -- intended)", async (routePath, method) => {
    const { default: router } = await import("../routes/panelBridge.js");
    const { res } = await runGate(router, routePath, method, "moderator");
    expect(res.getStatusCode()).toBe(403);
  });

  it.each(ENDANGER_ROUTES)("refuses a technician on %s %s (lost with the split -- intended)", async (routePath, method) => {
    const { default: router } = await import("../routes/panelBridge.js");
    const { res } = await runGate(router, routePath, method, "technician");
    expect(res.getStatusCode()).toBe(403);
  });

  it.each(ENDANGER_ROUTES)("does not refuse an admin on %s %s", async (routePath, method) => {
    const { default: router } = await import("../routes/panelBridge.js");
    const { calledNext } = await runGate(router, routePath, method, "admin");
    expect(calledNext).toBe(true);
  });
});

describe("panelBridge.js: players.gm_tools (player-targeted actions + supporting reads, folded in from previously-ungated) -- open to every role", () => {
  const GM_TOOLS_ROUTES = [
    ["/players", "get"],
    ["/players/:username", "get"],
    ["/players/:username/teleport", "post"],
    ["/players/:username/give-item", "post"],
    ["/players/:username/heal", "post"],
    ["/players/:username/kill", "post"],
    ["/players/:username/godmode", "post"],
    ["/players/:username/invisible", "post"],
    ["/sandbox", "get"],
    ["/character/export", "post"],
    ["/character/import", "post"],
    ["/catalog/items", "get"],
    ["/catalog/vehicles", "get"],
  ];

  it.each(GM_TOOLS_ROUTES)("does not refuse a moderator on %s %s", async (routePath, method) => {
    const { default: router } = await import("../routes/panelBridge.js");
    const { calledNext } = await runGate(router, routePath, method, "moderator");
    expect(calledNext).toBe(true);
  });

  it.each(GM_TOOLS_ROUTES)("does not refuse a technician on %s %s", async (routePath, method) => {
    const { default: router } = await import("../routes/panelBridge.js");
    const { calledNext } = await runGate(router, routePath, method, "technician");
    expect(calledNext).toBe(true);
  });
});
