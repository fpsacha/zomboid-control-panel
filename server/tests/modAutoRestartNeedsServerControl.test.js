import { beforeEach, describe, expect, it, vi } from "vitest";

// SECURITY: auto-restart on mod update restarts the running servers when a
// tracked Workshop item updates. mods.manage alone could turn it on, set the
// warning to 0 and stop it waiting for players (and pick the tracked items
// and force an update check), so the role decided when the server restarted
// without server.control -- the capability every other restart door needs,
// scheduled restarts included. Settings' copy of the same switch
// (modAutoRestart/modRestartDelay on PUT /app-settings) is held to it too.

const ROLES = {
  mods_only: { name: "mods_only", capabilities: ["mods.manage"] },
  mods_and_control: { name: "mods_and_control", capabilities: ["mods.manage", "server.control"] },
  settings_only: { name: "settings_only", capabilities: ["panel.settings"] },
  settings_and_control: { name: "settings_and_control", capabilities: ["panel.settings", "server.control"] },
};

const stored = vi.hoisted(() => ({ settings: {} }));

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getSetting: vi.fn(async (key) => stored.settings[key] ?? null),
  getAllSettings: vi.fn(async () => ({ ...stored.settings })),
  setSetting: vi.fn(async () => {}),
  getRoleByName: vi.fn(async (name) => ROLES[name] || null),
}));

vi.mock("../services/steamSessionCredentials.js", () => ({
  setSteamSessionCredentials: vi.fn(),
}));

const { ErrorCode } = await import("../utils/errorCodes.js");
const { default: modsRouter } = await import("../routes/mods.js");
const { default: configRouter } = await import("../routes/config.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

async function run(router, routePath, method, req) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  const handlers = layer.route.stack.map((s) => s.handle);
  const res = createResponse();
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
  return res;
}

const statusOf = (res) => res.status.mock.calls.at(-1)?.[0] ?? 200;

function makeModChecker() {
  return {
    restartWarningMinutes: 5,
    delayIfPlayersOnline: true,
    maxDelayMinutes: 30,
    setUpdateCallback: vi.fn(async () => {}),
    setRestartOptions: vi.fn(async () => {}),
    handleModUpdate: vi.fn(),
    getStatus: vi.fn(async () => ({ restartWarningMinutes: 5, delayIfPlayersOnline: true, maxDelayMinutes: 30, checkInterval: 300000 })),
  };
}

let modChecker;
const app = () => ({ get: (key) => (key === "modChecker" ? modChecker : null) });

beforeEach(() => {
  modChecker = makeModChecker();
  stored.settings = {};
});

describe("POST /mods/auto-restart", () => {
  const toggle = (role, enabled) =>
    run(modsRouter, "/auto-restart", "post", { user: { role }, body: { enabled }, app: app() });

  it("refuses to turn it on for mods.manage without server.control", async () => {
    const res = await toggle("mods_only", true);
    expect(statusOf(res)).toBe(403);
    expect(modChecker.setUpdateCallback).not.toHaveBeenCalled();
  });

  it("lets mods.manage alone turn it off", async () => {
    const res = await toggle("mods_only", false);
    expect(statusOf(res)).toBe(200);
    expect(modChecker.setUpdateCallback).toHaveBeenCalledWith(null);
  });

  it("turns it on with server.control", async () => {
    const res = await toggle("mods_and_control", true);
    expect(statusOf(res)).toBe(200);
    expect(modChecker.setUpdateCallback).toHaveBeenCalledWith(expect.any(Function));
  });
});

describe("PUT /mods/restart-options", () => {
  const save = (role, body) => run(modsRouter, "/restart-options", "put", { user: { role }, body, app: app() });

  it("refuses a change to the warning, the wait for players or its limit without server.control", async () => {
    // "0" as text too: the number check accepts it, so it must count as a change.
    for (const body of [{ warningMinutes: 0 }, { warningMinutes: "0" }, { delayIfPlayersOnline: false }, { maxDelayMinutes: 120 }]) {
      const res = await save("mods_only", body);
      expect(statusOf(res), JSON.stringify(body)).toBe(403);
    }
    expect(modChecker.setRestartOptions).not.toHaveBeenCalled();
  });

  it("still saves the check interval, and the restart fields as they are, with mods.manage alone", async () => {
    const res = await save("mods_only", { warningMinutes: "5", delayIfPlayersOnline: true, maxDelayMinutes: 30, checkInterval: 120000 });
    expect(statusOf(res)).toBe(200);
    expect(modChecker.setRestartOptions).toHaveBeenCalled();
  });

  it("saves a change with server.control", async () => {
    const res = await save("mods_and_control", { warningMinutes: 0, delayIfPlayersOnline: false });
    expect(statusOf(res)).toBe(200);
    expect(modChecker.setRestartOptions).toHaveBeenCalledWith(expect.objectContaining({ warningMinutes: 0, delayIfPlayersOnline: false }));
  });
});

describe("PUT /config/app-settings: modAutoRestart and modRestartDelay", () => {
  const save = (role, settings) =>
    run(configRouter, "/app-settings", "put", { user: { role }, body: { settings }, app: app() });

  it("refuses to turn auto-restart on or change its delay without server.control", async () => {
    stored.settings = { modAutoRestart: false, modRestartDelay: 5 };
    const on = await save("settings_only", { modAutoRestart: true });
    expect(statusOf(on)).toBe(403);
    expect(on.json.mock.calls[0][0].code).toBe(ErrorCode.CONFIG_APP_SETTINGS_CAPABILITY_REQUIRED);

    stored.settings = { modAutoRestart: true, modRestartDelay: 5 };
    const delay = await save("settings_only", { modAutoRestart: true, modRestartDelay: 0 });
    expect(statusOf(delay)).toBe(403);
    expect(modChecker.setUpdateCallback).not.toHaveBeenCalled();
    expect(modChecker.setRestartOptions).not.toHaveBeenCalled();
  });

  it("lets a Save that leaves them as they are through", async () => {
    stored.settings = { modAutoRestart: true, modRestartDelay: 5, darkMode: false };
    const res = await save("settings_only", { modAutoRestart: true, modRestartDelay: 5, darkMode: true });
    expect(statusOf(res)).toBe(200);
  });

  it("applies a change with server.control", async () => {
    stored.settings = { modAutoRestart: false, modRestartDelay: 5 };
    const res = await save("settings_and_control", { modAutoRestart: true, modRestartDelay: 2 });
    expect(statusOf(res)).toBe(200);
    expect(modChecker.setUpdateCallback).toHaveBeenCalledWith(expect.any(Function));
    expect(modChecker.setRestartOptions).toHaveBeenCalledWith({ warningMinutes: 2 });
  });
});
