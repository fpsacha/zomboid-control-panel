import { beforeEach, describe, expect, it, vi } from "vitest";

const createServer = vi.fn();
const discoverMounts = vi.fn();
const discoverMountIssues = vi.fn(() => []);
const scanAllCandidates = vi.fn(() => []);
const probeInstallPath = vi.fn();
const probeDataPath = vi.fn();
const readServerIniSettings = vi.fn();

import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

vi.mock("../database/init.js", () => ({ createServer, getRoleByName: mockGetRoleByName }));
vi.mock("../services/mountDiscovery.js", () => ({
  discoverMounts,
  discoverMountIssues,
  scanAllCandidates,
  probeInstallPath,
  probeDataPath,
  readServerIniSettings,
}));

const { default: router } = await import("../routes/discovery.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

async function runCreate(body, user = { role: "admin" }) {
  const layer = router.stack.find(
    (entry) =>
      entry.route?.path === "/create-from-discovery" &&
      entry.route.methods.post,
  );
  const handlers = layer.route.stack.map((entry) => entry.handle);
  const response = createResponse();
  let index = -1;
  const request = { body, user };
  const next = async (error) => {
    if (error) throw error;
    index += 1;
    if (index < handlers.length) await handlers[index](request, response, next);
  };
  await next();
  return response;
}

async function runDiscover(user = { role: "admin" }) {
  const layer = router.stack.find(
    (entry) =>
      entry.route?.path === "/discover-mounts" &&
      entry.route.methods.get,
  );
  const handlers = layer.route.stack.map((entry) => entry.handle);
  const response = createResponse();
  let index = -1;
  const request = { user };
  const next = async (error) => {
    if (error) throw error;
    index += 1;
    if (index < handlers.length) await handlers[index](request, response, next);
  };
  await next();
  return response;
}

describe("POST /api/servers/create-from-discovery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    discoverMounts.mockReturnValue([
      {
        installPath: "/pz-server",
        dataPath: "/zomboid",
        serverNames: ["servertest"],
      },
    ]);
    probeInstallPath.mockReturnValue({ valid: true, serverNames: [] });
    probeDataPath.mockReturnValue({ valid: true, serverNames: ["servertest"] });
    readServerIniSettings.mockReturnValue({
      rconPort: 27015,
      rconPassword: "rcon-secret",
      serverPort: 16261,
      publicName: "Test Server",
    });
    createServer.mockResolvedValue({
      id: "server-id",
      name: "Test Server",
      rconPassword: "rcon-secret",
      adminPassword: "admin-secret",
    });
  });

  it("rejects paths that were not returned by server-side discovery", async () => {
    const response = await runCreate({
      installPath: "/etc",
      dataPath: "/var/lib",
      serverName: "servertest",
    });

    expect(response.status).toHaveBeenCalledWith(400);
    expect(createServer).not.toHaveBeenCalled();
  });

  it("rejects a traversing serverName", async () => {
    const response = await runCreate({
      installPath: "/pz-server",
      dataPath: "/zomboid",
      serverName: "../../secrets",
    });

    expect(response.status).toHaveBeenCalledWith(400);
    expect(createServer).not.toHaveBeenCalled();
  });

  it("requires an administrator", async () => {
    const response = await runCreate(
      { installPath: "/pz-server", dataPath: "/zomboid" },
      { role: "viewer" },
    );

    expect(response.status).toHaveBeenCalledWith(403);
    expect(createServer).not.toHaveBeenCalled();
  });

  it("creates from the discovered paths and masks returned credentials", async () => {
    const response = await runCreate({
      installPath: "/pz-server",
      dataPath: "/zomboid",
      serverName: "servertest",
    });

    expect(createServer).toHaveBeenCalledWith(
      expect.objectContaining({
        installPath: "/pz-server",
        zomboidDataPath: "/zomboid",
        serverName: "servertest",
      }),
    );
    const payload = response.json.mock.calls[0][0];
    expect(payload.server.rconPassword).not.toBe("rcon-secret");
    expect(payload.server.adminPassword).not.toBe("admin-secret");
  });

  // docker-unraid-onboarding, 2026-09-09: found by Dwight tracing this
  // route end to end against docker/unraid/zomboid-panel.xml's own
  // documented two-container topology (panel and PZ server in SEPARATE
  // containers, reachable only over the Docker network) -- the template's
  // RCON_HOST field says verbatim "Never use 127.0.0.1." This used to be
  // hardcoded regardless of that env var.
  it("uses process.env.RCON_HOST when the operator configured it, instead of always hardcoding 127.0.0.1", async () => {
    vi.stubEnv("RCON_HOST", "projectzomboid");

    const response = await runCreate({
      installPath: "/pz-server",
      dataPath: "/zomboid",
      serverName: "servertest",
    });

    expect(response.status).not.toHaveBeenCalledWith(400);
    expect(createServer).toHaveBeenCalledWith(
      expect.objectContaining({ rconHost: "projectzomboid" }),
    );
    vi.unstubAllEnvs();
  });

  it("falls back to 127.0.0.1 when RCON_HOST is unset (the co-located, single-container topology)", async () => {
    vi.stubEnv("RCON_HOST", "");

    await runCreate({
      installPath: "/pz-server",
      dataPath: "/zomboid",
      serverName: "servertest",
    });

    expect(createServer).toHaveBeenCalledWith(
      expect.objectContaining({ rconHost: "127.0.0.1" }),
    );
    vi.unstubAllEnvs();
  });

  it("falls back to 127.0.0.1 rather than literally using 'CHANGE_ME' as a hostname -- the Unraid template's own unedited default for this required field", async () => {
    vi.stubEnv("RCON_HOST", "CHANGE_ME");

    await runCreate({
      installPath: "/pz-server",
      dataPath: "/zomboid",
      serverName: "servertest",
    });

    expect(createServer).toHaveBeenCalledWith(
      expect.objectContaining({ rconHost: "127.0.0.1" }),
    );
    vi.unstubAllEnvs();
  });

  it("reports malformed discovered INI settings instead of blaming a missing password", async () => {
    readServerIniSettings.mockReturnValue(null);

    const response = await runCreate({
      installPath: "/pz-server",
      dataPath: "/zomboid",
      serverName: "servertest",
    });

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      error: expect.stringMatching(/valid RCON or game port settings/i),
    });
    expect(createServer).not.toHaveBeenCalled();
  });

  // discovery-silent-multi-server-autopick, 2026-09-09: the ONE place
  // tonight's onboarding push goes the opposite direction from "stop
  // asking, guess, let them change it" -- a silent wrong pick between
  // several real, already-configured servers the operator owns is not a
  // recoverable-later guess like a path or a port. Both branches covered:
  // the single-server case (must not regress, it's the common one) and the
  // new ambiguous case.
  it("still auto-picks silently when the mount has exactly one server and none was specified", async () => {
    // beforeEach's default probeDataPath already returns a single name.
    const response = await runCreate({
      installPath: "/pz-server",
      dataPath: "/zomboid",
    });

    expect(response.status).not.toHaveBeenCalledWith(400);
    expect(createServer).toHaveBeenCalledWith(
      expect.objectContaining({ serverName: "servertest" }),
    );
  });

  it("refuses to silently pick between two or more real servers at the same mount, and hands back the full list instead", async () => {
    probeDataPath.mockReturnValue({
      valid: true,
      serverNames: ["ServerA", "ServerB"],
    });

    const response = await runCreate({
      installPath: "/pz-server",
      dataPath: "/zomboid",
    });

    expect(response.status).toHaveBeenCalledWith(400);
    expect(createServer).not.toHaveBeenCalled();
    const payload = response.json.mock.calls[0][0];
    expect(payload.serverNames).toEqual(["ServerA", "ServerB"]);
    expect(payload.error).toContain("ServerA");
    expect(payload.error).toContain("ServerB");
  });

  it("still creates the explicitly named server when the mount is ambiguous, without triggering the ambiguity refusal", async () => {
    probeDataPath.mockReturnValue({
      valid: true,
      serverNames: ["ServerA", "ServerB"],
    });
    discoverMounts.mockReturnValue([
      {
        installPath: "/pz-server",
        dataPath: "/zomboid",
        serverNames: ["ServerA", "ServerB"],
      },
    ]);

    const response = await runCreate({
      installPath: "/pz-server",
      dataPath: "/zomboid",
      serverName: "ServerB",
    });

    expect(response.status).not.toHaveBeenCalledWith(400);
    expect(createServer).toHaveBeenCalledWith(
      expect.objectContaining({ serverName: "ServerB" }),
    );
  });

  it("rejects non-string discovery paths with a client error", async () => {
    const response = await runCreate({
      installPath: { path: "/pz-server" },
      dataPath: "/zomboid",
    });

    expect(response.status).toHaveBeenCalledWith(400);
    expect(discoverMounts).not.toHaveBeenCalled();
  });
});

describe("GET /api/servers/discover-mounts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires the servers.discover capability", async () => {
    const response = await runDiscover({ role: "viewer" });

    expect(response.status).toHaveBeenCalledWith(403);
    expect(discoverMounts).not.toHaveBeenCalled();
  });

  it("returns discovered mounts to an authorized operator", async () => {
    discoverMounts.mockReturnValue([{ installPath: "/pz-server" }]);

    const response = await runDiscover();

    expect(response.json).toHaveBeenCalledWith({
      mounts: [{ installPath: "/pz-server" }],
      inaccessible: [],
      candidates: [],
    });
  });

  it("reports permission-denied candidates separately from missing ones", async () => {
    discoverMounts.mockReturnValue([]);
    discoverMountIssues.mockReturnValue([
      { path: "/pz-server", source: "common-mount", reason: "permission-denied" },
    ]);

    const response = await runDiscover();

    expect(response.json).toHaveBeenCalledWith({
      mounts: [],
      inaccessible: [
        { path: "/pz-server", source: "common-mount", reason: "permission-denied" },
      ],
      candidates: [],
    });
  });

  // server-detection-lifecycle-hardening, 2026-09-09: the additive,
  // ranked-with-reasons field -- see mountDiscovery.js's scanAllCandidates()
  // for what builds this. Route-level: just prove it's plumbed through
  // untouched, alongside the two pre-existing fields.
  it("returns the ranked candidate scan (with reasons) alongside the existing mounts/inaccessible fields", async () => {
    discoverMounts.mockReturnValue([]);
    discoverMountIssues.mockReturnValue([]);
    scanAllCandidates.mockReturnValue([
      { installPath: "/pz-server", dataPath: "/zomboid", source: "common-mount", status: "ready", reason: "Found a complete Project Zomboid server here -- server files and save data both present.", serverNames: ["servertest"], hasStartScript: true, hasPanelBridge: false },
      { installPath: "/data", dataPath: null, source: "generic-single-mount", status: "not-mounted", reason: "Not mounted -- this container path doesn't exist. If you're on Docker or Unraid, check the volume/bind-mount mapping for this path in your container's settings.", serverNames: [], hasStartScript: false, hasPanelBridge: false },
    ]);

    const response = await runDiscover();

    const payload = response.json.mock.calls[0][0];
    expect(payload.candidates).toHaveLength(2);
    expect(payload.candidates[0].status).toBe("ready");
    expect(payload.candidates[1].status).toBe("not-mounted");
    expect(payload.candidates[1].reason).toMatch(/not mounted/i);
  });
});