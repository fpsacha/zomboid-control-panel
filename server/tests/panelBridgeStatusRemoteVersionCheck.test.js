import { beforeEach, describe, expect, it, vi } from "vitest";

// 2026-09-02, bridge-enforcement: canAutoInstall()/checkBridgeInstalled()
// both require a local target path to content-compare against, which a
// remote/SFTP server has none of -- the panel never writes to its
// filesystem. Before this, GET /panel-bridge/status still computed
// `localInstall` unconditionally, so a remote server got a real-looking but
// meaningless {canAutoInstall:false, installed:false, needsUpdate:false} --
// "nothing is installed locally" (true, there is no "locally" for remote),
// not "up to date" (unknowable). This wires in the only signal that
// topology can ever produce instead: a plain version-STRING comparison
// between the bridge's own live self-report and what this panel bundles --
// unblocks the client-side staleness indicator, since remote users have no
// other automated remedy (see panelBridgeInstaller.js's own comment on
// getBundledBridgeVersion/isBridgeVersionBehindBundled for why content
// comparison is impossible there).

let getStatusReturn;
let isModConnectedReturn;
vi.mock("../services/panelBridge.js", () => ({
  default: {
    getStatus: () => getStatusReturn,
    isModConnected: () => isModConnectedReturn,
  },
}));

let activeServer;
vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => activeServer),
  getRoleByName: vi.fn(),
}));

const { default: router } = await import("../routes/panelBridge.js");
const { getBundledBridgeVersion } = await import(
  "../services/panelBridgeInstaller.js"
);

function getHandler(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  // sweep-round5 (2026-09-07): GET /status now carries a
  // requireAnyPermission("bridge.setup", "bridge.diagnostics") gate ahead
  // of the real handler, so the stack has two entries. This test's own
  // job is the remoteBridgeVersionCheck LOGIC, already exercised past the
  // gate elsewhere (requireAnyPermission.test.js, backupReadRoutesAnyCapability.test.js's
  // sibling coverage, routeAuthorizationCoverage.test.js) -- grab the LAST
  // handler (the real one), not the first, rather than re-proving the gate
  // exists here too.
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createResponse() {
  return { json: vi.fn() };
}

beforeEach(() => {
  getStatusReturn = { alive: false };
  isModConnectedReturn = false;
});

describe("GET /panel-bridge/status -- remote servers get a version-string check, not a misleading local-install status", () => {
  it("reports remoteBridgeVersionCheck and leaves localInstall null for a remote server", async () => {
    activeServer = { id: "s1", name: "Remote Server", isRemote: true };
    getStatusReturn = { alive: true, version: "0.0.1" };

    const response = createResponse();
    await getHandler("/status", "get")({}, response);

    const payload = response.json.mock.calls[0][0];
    expect(payload.localInstall).toBeNull();
    expect(payload.remoteBridgeVersionCheck).toEqual({
      bundledVersion: getBundledBridgeVersion(),
      liveVersion: "0.0.1",
      behind: true,
    });
  });

  it("reports behind:false when the remote live version matches what's bundled", async () => {
    activeServer = { id: "s1", isRemote: true };
    getStatusReturn = { alive: true, version: getBundledBridgeVersion() };

    const response = createResponse();
    await getHandler("/status", "get")({}, response);

    expect(
      response.json.mock.calls[0][0].remoteBridgeVersionCheck.behind,
    ).toBe(false);
  });

  it("reports behind:null when the remote server has never reported a live version", async () => {
    activeServer = { id: "s1", isRemote: true };
    getStatusReturn = { alive: false, version: null };

    const response = createResponse();
    await getHandler("/status", "get")({}, response);

    const check = response.json.mock.calls[0][0].remoteBridgeVersionCheck;
    expect(check.liveVersion).toBeNull();
    expect(check.behind).toBeNull();
  });

  it("still reports localInstall (not remoteBridgeVersionCheck) for a local server -- unchanged behavior", async () => {
    activeServer = {
      id: "s1",
      isRemote: false,
      installPath: "/does/not/exist/anywhere",
    };

    const response = createResponse();
    await getHandler("/status", "get")({}, response);

    const payload = response.json.mock.calls[0][0];
    expect(payload.remoteBridgeVersionCheck).toBeNull();
    expect(payload.localInstall).toEqual(
      expect.objectContaining({ canAutoInstall: false }),
    );
  });

  it("leaves both null when there is no active server at all", async () => {
    activeServer = null;

    const response = createResponse();
    await getHandler("/status", "get")({}, response);

    const payload = response.json.mock.calls[0][0];
    expect(payload.localInstall).toBeNull();
    expect(payload.remoteBridgeVersionCheck).toBeNull();
  });
});
