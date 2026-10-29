import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_ROLES } from "./helpers/mockPermissionsDb.js";

// SECURITY: the Steam cookies live in secret files and db.json keeps null
// for them, which GET /app-settings returns as it is. Settings sends its
// whole form back on Save, so every Save sent { steamSessionId: null,
// steamLoginSecure: null }; PUT handed the nulls to
// setSteamSessionCredentials(), which deleted both secret files. The
// mods.manage check on those keys compared the null with the stored null
// and let it through, so a role with panel.settings alone could clear the
// Workshop session on purpose too.

const ROLES = {
  ...TEST_ROLES,
  settings_only: { name: "settings_only", capabilities: ["panel.settings"] },
};

const getAllSettings = vi.fn();
const setSetting = vi.fn();
const setSteamSessionCredentials = vi.fn();

vi.mock("../database/init.js", () => ({
  getAllSettings,
  setSetting,
  getSetting: vi.fn(async () => null),
  getRoleByName: async (name) => ROLES[name] || null,
}));

vi.mock("../services/steamSessionCredentials.js", () => ({
  setSteamSessionCredentials,
}));

const { ErrorCode } = await import("../utils/errorCodes.js");
const { default: router } = await import("../routes/config.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

async function save(role, settings) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/app-settings" && entry.route.methods.put,
  );
  const handlers = layer.route.stack.map((s) => s.handle);
  const res = createResponse();
  const req = {
    body: { settings },
    user: { role },
    app: { get: () => null },
  };
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

describe("PUT /app-settings keeps the Steam cookies a Save sends back as null", () => {
  beforeEach(() => {
    setSetting.mockReset();
    setSteamSessionCredentials.mockReset().mockResolvedValue(undefined);
    getAllSettings.mockReset().mockResolvedValue({
      steamSessionId: null,
      steamLoginSecure: null,
      darkMode: false,
    });
  });

  it("an admin's ordinary Save of the whole form leaves the cookies alone", async () => {
    const res = await save("admin", { steamSessionId: null, steamLoginSecure: null, darkMode: true });
    expect(statusOf(res)).toBe(200);
    expect(setSteamSessionCredentials).not.toHaveBeenCalled();
    expect(setSetting).toHaveBeenCalledWith("darkMode", true);
    expect(setSetting).not.toHaveBeenCalledWith("steamSessionId", expect.anything());
    expect(setSetting).not.toHaveBeenCalledWith("steamLoginSecure", expect.anything());
  });

  it("a role with panel.settings but not mods.manage cannot clear them with null", async () => {
    await save("settings_only", { steamLoginSecure: null });
    expect(setSteamSessionCredentials).not.toHaveBeenCalled();
  });

  it("nor with an empty value", async () => {
    const res = await save("settings_only", { steamSessionId: "", steamLoginSecure: "" });
    expect(statusOf(res)).toBe(403);
    expect(res.json.mock.calls[0][0].code).toBe(ErrorCode.CONFIG_APP_SETTINGS_CAPABILITY_REQUIRED);
    expect(setSteamSessionCredentials).not.toHaveBeenCalled();
  });

  // Adversary pass: a database still holding "" for a cookie (written by an
  // older version) made "" look unchanged, which skipped the check the same
  // way the null did.
  it("nor by matching a stale empty copy in the database", async () => {
    getAllSettings.mockResolvedValue({ steamSessionId: "", steamLoginSecure: "" });
    const res = await save("settings_only", { steamLoginSecure: "" });
    expect(statusOf(res)).toBe(403);
    expect(setSteamSessionCredentials).not.toHaveBeenCalled();
  });

  it("a mods.manage holder can still clear or replace one on purpose", async () => {
    await save("admin", { steamSessionId: null, steamLoginSecure: "" });
    expect(setSteamSessionCredentials).toHaveBeenCalledWith(undefined, "");

    setSteamSessionCredentials.mockClear();
    await save("admin", { steamSessionId: "new-session", steamLoginSecure: null });
    expect(setSteamSessionCredentials).toHaveBeenCalledWith("new-session", undefined);
  });
});
