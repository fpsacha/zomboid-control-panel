import { beforeEach, describe, expect, it, vi } from "vitest";

// PUT /config/app-settings is gated by panel.settings alone, but
// VALID_SETTINGS_KEYS lets a holder silently rewrite rconPassword/rconHost/
// rconPort (server.configure's territory), Steam credentials (server.
// install's), PanelBridge SFTP including its password (bridge.setup's), the
// Discord guild ID (integrations.manage's), and Workshop session cookies
// (mods.manage's) -- five other capabilities' worth of reach through one
// door with a "CORS policy, mod-check interval and other app-level
// settings" label. Found in the 2026-08-26 capability-description sweep.
//
// Fix: a settings key listed in SETTINGS_KEY_CAPABILITY now requires the
// caller to hold the capability that actually governs it, but ONLY when the
// submitted value would genuinely CHANGE the stored one -- Settings.tsx's
// Save button resends the entire settings object on every save (confirmed
// by reading the client before building this, per standing instruction),
// so gating on mere presence would refuse every save by anyone who isn't
// already an admin.

const ROLES = {
  admin: {
    capabilities: [
      "panel.settings",
      "server.configure",
      "server.install",
      "bridge.setup",
      "integrations.manage",
      "mods.manage",
      "servers.manage",
    ],
  },
  // Holds panel.settings (passes the route's own gate) and NOTHING else --
  // the exact caller this fix exists to stop.
  settings_only: { capabilities: ["panel.settings"] },
  settings_and_configure: {
    capabilities: ["panel.settings", "server.configure"],
  },
  settings_and_servers_manage: {
    capabilities: ["panel.settings", "servers.manage"],
  },
  settings_and_mods: {
    capabilities: ["panel.settings", "mods.manage"],
  },
};

const getRoleByName = vi.fn(async (name) => ROLES[name] || null);
const getAllSettings = vi.fn();
const setSetting = vi.fn();
const setSteamSessionCredentials = vi.fn();

vi.mock("../database/init.js", () => ({
  getAllSettings,
  setSetting,
  getRoleByName,
}));

vi.mock("../services/steamSessionCredentials.js", () => ({
  setSteamSessionCredentials,
}));

const { default: router } = await import("../routes/config.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getLayer(routePath, method) {
  return router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
}

async function runPut(settings, role, current = {}) {
  getAllSettings.mockResolvedValue(current);
  const layer = getLayer("/app-settings", "put");
  const handlers = layer.route.stack.map((s) => s.handle);
  const response = createResponse();
  const request = {
    body: { settings },
    user: { role },
    app: { get: () => null },
  };
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](request, response, next);
  };
  await next();
  return response;
}

describe("PUT /config/app-settings -- per-key capability partition", () => {
  beforeEach(() => {
    getAllSettings.mockReset();
    setSetting.mockReset();
    setSteamSessionCredentials.mockReset().mockResolvedValue(undefined);
    getRoleByName.mockClear();
  });

  it("refuses to change rconPassword for a caller who holds panel.settings but not server.configure", async () => {
    const response = await runPut(
      { rconPassword: "new-password" },
      "settings_only",
      { rconPassword: "old-password" },
    );

    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        missing: [{ key: "rconPassword", requiredCapability: "server.configure" }],
      }),
    );
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("allows the same change for a caller who also holds server.configure", async () => {
    const response = await runPut(
      { rconPassword: "new-password" },
      "settings_and_configure",
      { rconPassword: "old-password" },
    );

    expect(setSetting).toHaveBeenCalledWith("rconPassword", "new-password");
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });

  it("re-sending the whole settings object with an UNCHANGED governed value is a no-op for the capability check, not a refusal (whole-object resend must not lock out saves)", async () => {
    // The capability check is diff-aware; the underlying write loop below it
    // is not and never was (pre-existing behavior, not this fix's concern)
    // -- it still writes every filtered entry, including a same-value
    // no-op. What this fix must guarantee is that resending an unchanged
    // governed value never trips the 403, which would otherwise refuse
    // every save by anyone who isn't already an admin.
    const response = await runPut(
      {
        rconPassword: "same-password",
        steamApiKey: "same-key",
        darkMode: true, // a real, allowed change alongside the unchanged governed keys
      },
      "settings_only",
      { rconPassword: "same-password", steamApiKey: "same-key", darkMode: false },
    );

    expect(response.status).not.toHaveBeenCalledWith(403);
    expect(setSetting).toHaveBeenCalledWith("darkMode", true);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });

  it("a request touching multiple governed keys names every offending one and rejects atomically -- no partial apply", async () => {
    const response = await runPut(
      {
        rconPassword: "new-password",
        steamApiKey: "new-key",
        discordGuildId: "123456789012345678",
      },
      "settings_only",
      { rconPassword: "old-password", steamApiKey: "old-key", discordGuildId: "old" },
    );

    expect(response.status).toHaveBeenCalledWith(403);
    const payload = response.json.mock.calls[0][0];
    expect(payload.missing).toEqual(
      expect.arrayContaining([
        { key: "rconPassword", requiredCapability: "server.configure" },
        { key: "steamApiKey", requiredCapability: "server.install" },
        { key: "discordGuildId", requiredCapability: "integrations.manage" },
      ]),
    );
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("an unowned, genuinely app-level key (darkMode) needs nothing beyond panel.settings itself", async () => {
    const response = await runPut(
      { darkMode: true },
      "settings_only",
      { darkMode: false },
    );

    expect(setSetting).toHaveBeenCalledWith("darkMode", true);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });

  it("a masked-placeholder resend of an untouched secret never reaches the capability check at all (already filtered upstream)", async () => {
    const response = await runPut(
      { rconPassword: "••••••••1234" },
      "settings_only",
      { rconPassword: "old-password" },
    );

    expect(setSetting).not.toHaveBeenCalled();
    expect(response.status).not.toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });

  it("admin (holds every capability) can change every governed key in one save", async () => {
    const response = await runPut(
      {
        rconPassword: "new-password",
        steamApiKey: "new-key",
        panelBridgeSftpPassword: "new-sftp",
        discordGuildId: "123456789012345678",
        steamSessionId: "new-session",
      },
      "admin",
      {
        rconPassword: "old-password",
        steamApiKey: "old-key",
        panelBridgeSftpPassword: "old-sftp",
        discordGuildId: "old",
        steamSessionId: "old-session",
      },
    );

    expect(setSetting).toHaveBeenCalledWith("rconPassword", "new-password");
    expect(setSetting).toHaveBeenCalledWith("steamApiKey", "new-key");
    expect(setSetting).toHaveBeenCalledWith(
      "panelBridgeSftpPassword",
      "new-sftp",
    );
    expect(setSetting).toHaveBeenCalledWith(
      "discordGuildId",
      "123456789012345678",
    );
    expect(setSteamSessionCredentials).toHaveBeenCalledWith(
      "new-session",
      undefined,
    );
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });

  // 2026-08-27 follow-up: zomboidDataPath/serverConfigPath/serverPath are
  // the LEGACY mirror of the exact fields servers.js's own routes write on
  // the active server record (confirmed by reading every real consumer --
  // server.js's getServerConfigPath(), chunks.js's getZomboidDataPath(),
  // modChecker.js -- all of which fall back to this legacy setting even
  // while an active server exists, whenever that server's own field is
  // unset). Mapped to servers.manage to match the sibling write path, not
  // to server.configure, per the "same field two doors" rule rather than
  // the label. workshopCollectionAutoSync joined mods.manage as the
  // missing sibling of the three keys already mapped there.
  it("zomboidDataPath requires servers.manage, not server.configure", async () => {
    const blocked = await runPut(
      { zomboidDataPath: "/new/path" },
      "settings_and_configure", // has server.configure, NOT servers.manage
      { zomboidDataPath: "/old/path" },
    );
    expect(blocked.status).toHaveBeenCalledWith(403);
    expect(blocked.json).toHaveBeenCalledWith(
      expect.objectContaining({
        missing: [{ key: "zomboidDataPath", requiredCapability: "servers.manage" }],
      }),
    );

    setSetting.mockClear();
    const allowed = await runPut(
      { zomboidDataPath: "/new/path" },
      "settings_and_servers_manage",
      { zomboidDataPath: "/old/path" },
    );
    expect(setSetting).toHaveBeenCalledWith("zomboidDataPath", "/new/path");
    expect(allowed.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });

  it("serverConfigPath and serverPath also require servers.manage", async () => {
    const response = await runPut(
      { serverConfigPath: "/new/cfg", serverPath: "/new/install" },
      "settings_only",
      { serverConfigPath: "/old/cfg", serverPath: "/old/install" },
    );
    expect(response.status).toHaveBeenCalledWith(403);
    const payload = response.json.mock.calls[0][0];
    expect(payload.missing).toEqual(
      expect.arrayContaining([
        { key: "serverConfigPath", requiredCapability: "servers.manage" },
        { key: "serverPath", requiredCapability: "servers.manage" },
      ]),
    );
  });

  it("workshopCollectionAutoSync requires mods.manage, matching its sibling keys", async () => {
    const blocked = await runPut(
      { workshopCollectionAutoSync: true },
      "settings_only",
      { workshopCollectionAutoSync: false },
    );
    expect(blocked.status).toHaveBeenCalledWith(403);
    expect(blocked.json).toHaveBeenCalledWith(
      expect.objectContaining({
        missing: [
          { key: "workshopCollectionAutoSync", requiredCapability: "mods.manage" },
        ],
      }),
    );

    setSetting.mockClear();
    const allowed = await runPut(
      { workshopCollectionAutoSync: true },
      "settings_and_mods",
      { workshopCollectionAutoSync: false },
    );
    expect(setSetting).toHaveBeenCalledWith("workshopCollectionAutoSync", true);
    expect(allowed.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });

  it("serverPort stays unmapped -- dead legacy storage with no live consumer, needs nothing beyond panel.settings", async () => {
    const response = await runPut(
      { serverPort: 16262 },
      "settings_only",
      { serverPort: 16261 },
    );
    expect(setSetting).toHaveBeenCalledWith("serverPort", 16262);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });
});
