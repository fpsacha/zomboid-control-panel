import { describe, expect, it, vi, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Regression coverage for the HTTPS-crash finding: PUT /app-settings used
// to accept httpsCertPath/httpsKeyPath/httpsPort as any string/number with
// zero validation -- the only guard against a bad value lived at panel BOOT
// (server/index.js's setupHttpsServer, see httpsSetup.test.js), which meant
// a bad value could be saved successfully (200, success toast) and only
// fail on the next restart. This file exercises the save-time half of the
// fix: reject a bad value immediately, with a clear reason, before it's
// ever persisted.

const settingsStore = { panelPort: 3001 };

vi.mock("../database/init.js", () => ({
  getAllSettings: vi.fn(async () => ({ ...settingsStore })),
  getSetting: vi.fn(async (key) => settingsStore[key]),
  setSetting: vi.fn(async (key, value) => {
    settingsStore[key] = value;
  }),
  // This file bypasses requirePermission("panel.settings") entirely (see
  // getRouteHandler below -- it invokes only the last handler in the
  // route's stack, on purpose, since gate coverage lives in
  // configRoutesRoleSweep.test.js and this file exercises validation logic
  // directly). The per-key capability partition added in the 2026-08-26
  // capability-description-sweep fix runs INSIDE that last handler though,
  // so every save here needs a real, fully-privileged caller behind it --
  // same shape as any other request this file sends, just one more field
  // that now matters.
  getRoleByName: vi.fn(async (name) =>
    name === "admin"
      ? {
          capabilities: [
            "panel.settings",
            "server.configure",
            "server.install",
            "bridge.setup",
            "integrations.manage",
            "mods.manage",
            // modAutoRestart/modRestartDelay (a restart decision).
            "server.control",
          ],
        }
      : null,
  ),
}));

function createResponse() {
  const response = { status: () => response, json: () => response };
  let statusCode = 200;
  let body = null;
  response.status = (code) => {
    statusCode = code;
    return response;
  };
  response.json = (payload) => {
    body = payload;
    return response;
  };
  response.getStatusCode = () => statusCode;
  response.getBody = () => body;
  return response;
}

function getRouteHandler(router, routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  // Last handler in the stack: requirePermission runs first, the real
  // logic last -- gate coverage lives in configRoutesRoleSweep.test.js,
  // this file exercises the validation logic directly.
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function putAppSettings(settings) {
  const { default: router } = await import("../routes/config.js");
  const res = createResponse();
  await getRouteHandler(router, "/app-settings", "put")(
    {
      body: { settings },
      user: { role: "admin" },
      app: { get: () => undefined },
    },
    res,
  );
  return res;
}

let tempDir;

afterEach(() => {
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  tempDir = null;
  settingsStore.panelPort = 3001;
  delete settingsStore.httpsPort;
});

// These all now need httpsEnabled: true in the payload -- as of the
// 2026-08-26 bug hunt (finding 4, GitHub #118 generalized), httpsCertPath/
// httpsKeyPath/httpsPort are skipped entirely while HTTPS won't be enabled
// after this save, the same treatment SFTP's fields got below.
describe("PUT /app-settings -- httpsCertPath / httpsKeyPath validation (HTTPS enabled)", () => {
  it("rejects a directory as httpsCertPath instead of saving it", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-appsettings-test-"));
    const res = await putAppSettings({ httpsEnabled: true, httpsCertPath: tempDir });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().error).toMatch(/must be a file, not a directory/);
  });

  it("rejects a path that doesn't exist", async () => {
    const res = await putAppSettings({
      httpsEnabled: true,
      httpsKeyPath: "C:\\nonexistent\\path\\key.pem",
    });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().error).toMatch(/does not point to a file that exists/);
  });

  it("accepts an empty string even while enabled -- clearing the custom cert path back to auto-generated must still work", async () => {
    const res = await putAppSettings({ httpsEnabled: true, httpsCertPath: "" });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().success).toBe(true);
  });

  it("accepts a real, readable file", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-appsettings-test-"));
    const certPath = path.join(tempDir, "panel.cert");
    fs.writeFileSync(certPath, "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n");
    const res = await putAppSettings({ httpsEnabled: true, httpsCertPath: certPath });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().success).toBe(true);
  });

  // GitHub #118, the reproducible half of finding 4: Settings.tsx never
  // clears httpsCertPath/httpsKeyPath when HTTPS is toggled off, so a stale
  // path (moved file, revoked permissions) sitting there used to block
  // every unrelated save. HTTPS disabled must exempt it regardless of value.
  it("does not block an unrelated save over a stale/garbage httpsCertPath while HTTPS is disabled", async () => {
    const res = await putAppSettings({
      httpsEnabled: false,
      httpsCertPath: "C:\\this\\file\\was\\deleted\\ages\\ago.cert",
      darkMode: true,
    });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().success).toBe(true);
  });
});

describe("PUT /app-settings -- httpsPort validation (HTTPS enabled, bind-port range joined to BIND_PORT_MIN/MAX)", () => {
  it("rejects a non-integer value", async () => {
    const res = await putAppSettings({ httpsEnabled: true, httpsPort: "not-a-number" });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().error).toMatch(/HTTPS port must be a whole number/);
  });

  it.each(["1e2", " "])("rejects non-decimal whole-number input %j", async (value) => {
    const res = await putAppSettings({ httpsEnabled: true, httpsPort: value });
    expect(res.getStatusCode()).toBe(400);
  });

  it("rejects an out-of-range value", async () => {
    const res = await putAppSettings({ httpsEnabled: true, httpsPort: 999999 });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().error).toMatch(/HTTPS port must be a whole number/);
  });

  // Now rejected by the BIND_PORT_MIN floor (1024), not just a bare "must
  // be positive" check -- HTTPS is a bind port like panelPort, joined to
  // the same shared range in this pass (bug hunt finding 4).
  it("rejects a port below the 1024 bind floor, zero, and negative values", async () => {
    const belowFloor = await putAppSettings({ httpsEnabled: true, httpsPort: 443 });
    expect(belowFloor.getStatusCode()).toBe(400);
    const zero = await putAppSettings({ httpsEnabled: true, httpsPort: 0 });
    expect(zero.getStatusCode()).toBe(400);
    const negative = await putAppSettings({ httpsEnabled: true, httpsPort: -443 });
    expect(negative.getStatusCode()).toBe(400);
  });

  it("rejects a port equal to the panel's own HTTP port", async () => {
    settingsStore.panelPort = 3001;
    const res = await putAppSettings({ httpsEnabled: true, httpsPort: 3001 });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().error).toMatch(/cannot be the same as the panel's HTTP port/);
  });

  it("accepts a valid, non-colliding port", async () => {
    settingsStore.panelPort = 3001;
    const res = await putAppSettings({ httpsEnabled: true, httpsPort: 3443 });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().success).toBe(true);
  });

  it("does not block an unrelated save over an out-of-range httpsPort while HTTPS is disabled", async () => {
    const res = await putAppSettings({ httpsEnabled: false, httpsPort: 0, darkMode: true });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().success).toBe(true);
  });
});

describe("PUT /app-settings -- reconnectInterval validation (same missing-range-check shape, lower stakes; autoReconnect enabled)", () => {
  it("rejects an out-of-range value", async () => {
    const tooLow = await putAppSettings({ autoReconnect: true, reconnectInterval: 0 });
    expect(tooLow.getStatusCode()).toBe(400);
    const tooHigh = await putAppSettings({ autoReconnect: true, reconnectInterval: 601 });
    expect(tooHigh.getStatusCode()).toBe(400);
  });

  // The RCON service clamps whatever is stored to 5-600 s, so a 1-4 that was
  // accepted here would silently run as 5, and 61-600 (valid for the service)
  // used to be refused.
  it.each([1, 4, "3"])("rejects %j, below the 5 s the service would run it at", async (value) => {
    const res = await putAppSettings({ autoReconnect: true, reconnectInterval: value });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().error).toMatch(/from 5 to 600/);
  });

  it.each([5, 60, 61, 300, "600", 600])("accepts %j, a value the service applies as it is", async (value) => {
    const res = await putAppSettings({ autoReconnect: true, reconnectInterval: value });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().success).toBe(true);
  });

  it("rejects scientific notation instead of coercing it", async () => {
    const res = await putAppSettings({ autoReconnect: true, reconnectInterval: "1e1" });
    expect(res.getStatusCode()).toBe(400);
  });

  it("accepts a valid value", async () => {
    const res = await putAppSettings({ autoReconnect: true, reconnectInterval: 15 });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().success).toBe(true);
  });
});

// One table-driven pass covering every field in FEATURE_GATED_FIELDS
// (config.js) instead of five more hand-written "skips while disabled" /
// "still validates when turning on" test blocks -- the DO-IT-ONCE
// instruction (2026-08-26 bug hunt follow-up) applies to the tests too, not
// just the production code: five nearly-identical copies of this test are
// exactly as likely to silently miss a sixth field as five copies of the
// guard itself were.
describe("PUT /app-settings -- feature-gated fields (FEATURE_GATED_FIELDS), table-driven", () => {
  const cases = [
    ["panelBridgeSftpEnabled", "panelBridgeSftpPort", 0, /SFTP port must be a whole number/],
    ["panelBridgeSftpEnabled", "panelBridgeSftpPollIntervalSeconds", 1, /SFTP sync interval/],
    ["httpsEnabled", "httpsPort", 0, /HTTPS port must be a whole number/],
    ["modAutoRestart", "modRestartDelay", -1, /Mod restart delay/],
    ["serverAutoUpdate", "serverAutoUpdateWarningMinutes", 61, /Server auto-update warning/],
    ["autoExportOnLogin", "autoExportMaxPerPlayer", 500, /Auto-export copies kept/],
    ["autoReconnect", "reconnectInterval", 0, /reconnectInterval must be a whole number/],
  ];

  it.each(cases)(
    "skips validating %s's %s (garbage value %j) while the flag is off in this same save",
    async (flagKey, fieldKey, garbageValue) => {
      const res = await putAppSettings({ [flagKey]: false, [fieldKey]: garbageValue });
      expect(res.getStatusCode()).toBe(200);
      expect(res.getBody().success).toBe(true);
    },
  );

  it.each(cases)(
    "still validates %s's %s when THIS save is what turns the flag on (ordering: reads the payload, not stale stored state)",
    async (flagKey, fieldKey, garbageValue, errorPattern) => {
      const res = await putAppSettings({ [flagKey]: true, [fieldKey]: garbageValue });
      expect(res.getStatusCode()).toBe(400);
      expect(res.getBody().error).toMatch(errorPattern);
    },
  );
});

// Regression coverage for the 2026-08-23 config.js numeric-field audit:
// panelPort sat in the same allowed-keys list as httpsPort, two lines away,
// with NO case at all in this loop -- an out-of-range value saved silently
// (200, no error) and only surfaced at the next restart, after the Restart
// Panel button had already sent the browser to a port nothing is listening
// on. This is the lockout case the reconnectInterval comment above named but
// never enumerated. Range matches auth.js's /setup panelPort check for the
// same field (SETUP_PANEL_PORT_INVALID): 1024-65535.
describe("PUT /app-settings -- panelPort validation (the lockout case, not the mild one)", () => {
  it("rejects a non-integer value", async () => {
    const res = await putAppSettings({ panelPort: "not-a-number" });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().error).toMatch(/Panel port must be a whole number/);
  });

  it("rejects an out-of-range value instead of saving it silently", async () => {
    const res = await putAppSettings({ panelPort: 80 });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().error).toMatch(/Panel port must be a whole number/);
  });

  it("rejects a value below 1024 (matches auth.js /setup's reserved-range floor for this field)", async () => {
    const res = await putAppSettings({ panelPort: 1023 });
    expect(res.getStatusCode()).toBe(400);
  });

  it("rejects a value above 65535", async () => {
    const res = await putAppSettings({ panelPort: 65536 });
    expect(res.getStatusCode()).toBe(400);
  });

  it("accepts a valid port", async () => {
    const res = await putAppSettings({ panelPort: 3001 });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().success).toBe(true);
  });
});

// The collision guard httpsPort's block enforces used to be one-directional:
// a new httpsPort was checked against the stored panelPort, but a new
// panelPort was never checked against the stored httpsPort. The exact
// collision the guard exists to prevent was reachable by simply approaching
// from the other side. See 2026-08-23 config.js numeric-field audit part 2.
describe("PUT /app-settings -- panelPort/httpsPort collision is bidirectional", () => {
  it("rejects a panelPort equal to the stored httpsPort", async () => {
    settingsStore.httpsPort = 8443;
    const res = await putAppSettings({ panelPort: 8443 });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().error).toMatch(/cannot be the same as the panel's HTTPS port/);
  });

  it("accepts a panelPort that doesn't collide with the stored httpsPort", async () => {
    settingsStore.httpsPort = 8443;
    const res = await putAppSettings({ panelPort: 3001 });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().success).toBe(true);
  });

  it("accepts a panelPort when no httpsPort is configured yet", async () => {
    const res = await putAppSettings({ panelPort: 3001 });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().success).toBe(true);
  });
});

// The "second door" finding: rconPort, serverPort, minMemory and maxMemory
// are the exact four fields server.js's /install, /quick-setup,
// /configure-rcon and /configure-network now refuse out-of-range on
// (2026-08-23 validateInt-coerces audit, commit 39f836f) -- but PUT
// /app-settings could set every one of them directly with zero validation,
// undoing that fix's shape through a route none of those checks live in.
// Same ranges as server.js's checks so the two doors can't disagree.
describe("PUT /app-settings -- the second door onto server.js's four hardened fields", () => {
  it("rejects an out-of-range rconPort", async () => {
    const res = await putAppSettings({ rconPort: 99 });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().error).toMatch(/RCON port must be a whole number/);
  });

  it("accepts a valid rconPort", async () => {
    const res = await putAppSettings({ rconPort: 27015 });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().success).toBe(true);
  });

  it("rejects an out-of-range serverPort", async () => {
    const res = await putAppSettings({ serverPort: 80 });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().error).toMatch(/Game port must be a whole number/);
  });

  it("accepts a valid serverPort", async () => {
    const res = await putAppSettings({ serverPort: 16261 });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().success).toBe(true);
  });

  it("rejects an over-cap minMemory", async () => {
    const res = await putAppSettings({ minMemory: 256 });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().error).toMatch(/Minimum memory \(GB\) must be a whole number/);
  });

  it("accepts a valid minMemory", async () => {
    const res = await putAppSettings({ minMemory: 4 });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().success).toBe(true);
  });

  it("rejects an over-cap maxMemory", async () => {
    const res = await putAppSettings({ maxMemory: 9999 });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().error).toMatch(/Maximum memory \(GB\) must be a whole number/);
  });

  it("accepts a valid maxMemory", async () => {
    const res = await putAppSettings({ maxMemory: 8 });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().success).toBe(true);
  });
});

// Lower priority: an out-of-range value here doesn't misdirect anything, it
// self-heals to 3 via `Number(...) || 3` the next time index.js reads it for
// export rotation -- but an unvalidated garbage value would still sit in the
// database unreadable by that fallback's intent. Range matches Settings.tsx's
// own input (min=1 max=50).
// Gated by autoExportOnLogin as of the 2026-08-26 bug hunt (finding 11) --
// these need autoExportOnLogin: true in the payload to reach the check.
describe("PUT /app-settings -- autoExportMaxPerPlayer validation (low priority, self-heals at use; autoExportOnLogin enabled)", () => {
  it("rejects an out-of-range value instead of storing garbage", async () => {
    const res = await putAppSettings({ autoExportOnLogin: true, autoExportMaxPerPlayer: 500 });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().error).toMatch(/Auto-export copies kept must be a whole number/);
  });

  it("accepts a valid value", async () => {
    const res = await putAppSettings({ autoExportOnLogin: true, autoExportMaxPerPlayer: 3 });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().success).toBe(true);
  });
});

// The 8 boolean-shaped keys that accepted any truthy/falsy JS value with no
// gate at all until this pass -- same treatment as the 6 already checked
// (corsAllowAll etc.), added here instead of a third future enumeration
// finding them again.
describe("PUT /app-settings -- the other 8 boolean settings now reject a non-boolean value", () => {
  const booleanKeys = [
    "modAutoRestart",
    "serverAutoUpdate",
    "darkMode",
    "autoReconnect",
    "httpsEnabled",
    "autoStartServer",
    "workshopCollectionAutoSync",
    "panelBridgeSftpEnabled",
  ];

  for (const key of booleanKeys) {
    it(`rejects a non-boolean value for ${key}`, async () => {
      const res = await putAppSettings({ [key]: "yes" });
      expect(res.getStatusCode()).toBe(400);
      expect(res.getBody().error).toBe(`${key} must be true or false`);
    });

    it(`accepts a real boolean for ${key}`, async () => {
      const res = await putAppSettings({ [key]: true });
      expect(res.getStatusCode()).toBe(200);
      expect(res.getBody().success).toBe(true);
    });
  }
});

// Bound chased from modChecker.js's setRestartOptions
// (`Math.max(0, Math.min(30, val))`): [0, 30]. Settings.tsx's own input says
// min=1, a real discrepancy -- ruled in favour of the service's floor, not
// the client's: the service is the authority on what the system can do, and
// refusing 0 here while the consumer accepts it fine would create a NEW
// save-vs-consumer disagreement, the same bug class this thread closed.
// Settings.tsx keeping min=1 is a UI recommendation, not a capability claim,
// and is allowed to differ.
// Gated by modAutoRestart as of the 2026-08-26 bug hunt (finding 9) -- these
// need modAutoRestart: true in the payload to reach the check.
describe("PUT /app-settings -- modRestartDelay validation (bound chased, service is the authority; modAutoRestart enabled)", () => {
  it("accepts zero -- the service's own floor, even though Settings.tsx's UI recommends min=1", async () => {
    const res = await putAppSettings({ modAutoRestart: true, modRestartDelay: 0 });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().success).toBe(true);
  });

  it("rejects a negative value", async () => {
    const res = await putAppSettings({ modAutoRestart: true, modRestartDelay: -1 });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().error).toMatch(/Mod restart delay \(minutes\) must be a whole number/);
  });

  it("rejects a value above 30", async () => {
    const res = await putAppSettings({ modAutoRestart: true, modRestartDelay: 31 });
    expect(res.getStatusCode()).toBe(400);
  });

  it("accepts a valid value", async () => {
    const res = await putAppSettings({ modAutoRestart: true, modRestartDelay: 5 });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().success).toBe(true);
  });
});

// Bound chased from updateChecker.js's parseAutoUpdateWarningMinutes
// (`Math.min(60, Math.max(0, ...))`) -- matches Settings.tsx's own input
// (min=0 max=60) exactly, no discrepancy for this one. Gated by
// serverAutoUpdate as of the 2026-08-26 bug hunt (finding 10) -- these need
// serverAutoUpdate: true in the payload to reach the check.
describe("PUT /app-settings -- serverAutoUpdateWarningMinutes validation (bound chased, matches client exactly; serverAutoUpdate enabled)", () => {
  it("accepts zero (a real, meaningful choice here: restart with no warning)", async () => {
    const res = await putAppSettings({ serverAutoUpdate: true, serverAutoUpdateWarningMinutes: 0 });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().success).toBe(true);
  });

  it("rejects a value above 60", async () => {
    const res = await putAppSettings({ serverAutoUpdate: true, serverAutoUpdateWarningMinutes: 61 });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().error).toMatch(/Server auto-update warning \(minutes\) must be a whole number/);
  });

  it("accepts a valid value", async () => {
    const res = await putAppSettings({ serverAutoUpdate: true, serverAutoUpdateWarningMinutes: 15 });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().success).toBe(true);
  });
});

describe("PUT /app-settings -- SFTP numeric settings validation", () => {
  // These now need panelBridgeSftpEnabled: true in the payload -- as of
  // GitHub #118, an SFTP field is only validated when SFTP will actually be
  // on after this save, so a range check test has to enable the feature it
  // means to exercise.
  it("rejects an explicit zero SFTP port while SFTP is enabled", async () => {
    const res = await putAppSettings({ panelBridgeSftpEnabled: true, panelBridgeSftpPort: 0 });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().error).toMatch(/SFTP port must be a whole number/);
  });

  it("rejects a prefixed SFTP port instead of truncating it, while SFTP is enabled", async () => {
    const res = await putAppSettings({ panelBridgeSftpEnabled: true, panelBridgeSftpPort: "22junk" });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().error).toMatch(/SFTP port must be a whole number/);
  });

  it("rejects an out-of-range SFTP polling interval while SFTP is enabled", async () => {
    const res = await putAppSettings({ panelBridgeSftpEnabled: true, panelBridgeSftpPollIntervalSeconds: 1 });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().error).toMatch(/SFTP sync interval/);
  });

  // GitHub #118: port 22 is the standard SFTP port and the frontend's own
  // shipped default (Settings.tsx) -- it must be accepted, not just
  // tolerated by skipping validation.
  it("accepts port 22 as a valid SFTP port when SFTP is enabled", async () => {
    const res = await putAppSettings({ panelBridgeSftpEnabled: true, panelBridgeSftpPort: 22 });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().success).toBe(true);
  });

  // The exact reported scenario: PanelBridge on local filesystem, SFTP
  // disabled, the frontend's default port 22 still sitting in the payload
  // (Settings.tsx always sends the whole settings object) -- saving an
  // unrelated setting must succeed instead of being blocked by a field
  // nobody is using.
  it("GitHub #118: SFTP disabled with the default port 22 does not block saving an unrelated setting", async () => {
    const res = await putAppSettings({
      panelBridgeSftpEnabled: false,
      panelBridgeSftpPort: "22",
      panelBridgeAutoUpdate: false,
    });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().success).toBe(true);
  });

  // Ordering: the effective flag must come from THIS payload, not stored
  // state, in both directions -- otherwise either an operator turning SFTP
  // on gets its port silently skipped, or turning it off doesn't actually
  // exempt the port in the same save.
  it("still validates the SFTP port when this save is what turns SFTP on, even though it was off in storage", async () => {
    const res = await putAppSettings({ panelBridgeSftpEnabled: true, panelBridgeSftpPort: 0 });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().error).toMatch(/SFTP port must be a whole number/);
  });

  it("skips SFTP port validation when this save is what turns SFTP off, even with an out-of-range port present", async () => {
    const res = await putAppSettings({ panelBridgeSftpEnabled: false, panelBridgeSftpPort: 0 });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().success).toBe(true);
  });
});
