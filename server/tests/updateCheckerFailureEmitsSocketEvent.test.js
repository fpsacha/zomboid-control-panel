import { afterEach, describe, expect, it, vi } from "vitest";

// success-only-emission class sweep, 2026-09-08 (last unfixed member):
// server:updateAvailable and server:updateCheck were only ever emitted from
// checkForUpdates()'s success path, so a background check that starts
// failing after the page has loaded was invisible to a connected client
// until a full reload re-fetched getStatus() -- the mount-time snapshot
// (880d14ff) made the initial read honest, but nothing kept it live once a
// live failure occurred. This mirrors that fix's carried lastError
// (319a1144) out over the wire the same way a success already goes out, on
// a NEW event name (server:updateCheckFailed) rather than the existing
// success events -- the existing client handlers for those unconditionally
// set updateCheckEverSucceeded(true) and lastError(null) on ANY receipt, so
// reusing them for a failure-shaped payload would make the client claim a
// check just succeeded at the exact moment one just failed.

vi.mock("../services/managedContainer.js", () => ({
  resolveManagedContainer: vi.fn(async () => ({ handled: false })),
}));

let settingsOverride = {};
vi.mock("../database/init.js", () => ({
  getSetting: vi.fn(async (key) => {
    if (key in settingsOverride) return settingsOverride[key];
    if (key === "steamcmdPath") return "/opt/steamcmd";
    if (key === "serverPath") return "/opt/pzserver";
    return null;
  }),
  setSetting: vi.fn(async () => {}),
  getActiveServer: vi.fn(async () => ({
    id: "server-1",
    installPath: "/opt/pzserver",
    isRemote: false,
  })),
}));

const { UpdateChecker } = await import("../services/updateChecker.js");

function buildChecker() {
  const io = { emit: vi.fn() };
  const checker = new UpdateChecker(io, { rconService: { connected: false }, serverManager: {} });
  vi.spyOn(checker, "getGameVersion").mockResolvedValue(null);
  return checker;
}

function mockHealthyBuildInfo(checker) {
  vi.spyOn(checker, "getInstalledBuildInfo").mockResolvedValue({
    buildId: "100",
    branch: "public",
    lastUpdated: null,
  });
  vi.spyOn(checker, "getLatestBuildInfo").mockResolvedValue({
    branch: "public",
    buildId: "100",
    timeUpdated: null,
    description: null,
  });
}

function failedEmits(checker) {
  return checker.io.emit.mock.calls.filter(([event]) => event === "server:updateCheckFailed");
}

afterEach(() => {
  vi.restoreAllMocks();
  settingsOverride = {};
});

describe("UpdateChecker.checkForUpdates emits server:updateCheckFailed on every failure path", () => {
  it("emits with the lastError when steamcmdPath/serverPath are not configured", async () => {
    settingsOverride = { steamcmdPath: null };
    const checker = buildChecker();

    await checker.checkForUpdates();

    const calls = failedEmits(checker);
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual({ lastError: checker.lastError });
    expect(checker.lastError).toMatch(/not configured/i);
  });

  it("emits when the installed build cannot be determined", async () => {
    const checker = buildChecker();
    vi.spyOn(checker, "getInstalledBuildInfo").mockResolvedValue(null);

    await checker.checkForUpdates();

    const calls = failedEmits(checker);
    expect(calls).toHaveLength(1);
    expect(calls[0][1].lastError).toMatch(/installed build/i);
  });

  it("emits when the latest build info cannot be fetched from Steam", async () => {
    const checker = buildChecker();
    vi.spyOn(checker, "getInstalledBuildInfo").mockResolvedValue({
      buildId: "100",
      branch: "public",
      lastUpdated: null,
    });
    vi.spyOn(checker, "getLatestBuildInfo").mockResolvedValue(null);

    await checker.checkForUpdates();

    const calls = failedEmits(checker);
    expect(calls).toHaveLength(1);
    expect(calls[0][1].lastError).toMatch(/latest build info/i);
  });

  it("emits on an invalid (non-numeric) build ID", async () => {
    const checker = buildChecker();
    vi.spyOn(checker, "getInstalledBuildInfo").mockResolvedValue({
      buildId: "not-a-number",
      branch: "public",
      lastUpdated: null,
    });
    vi.spyOn(checker, "getLatestBuildInfo").mockResolvedValue({
      branch: "public",
      buildId: "100",
      timeUpdated: null,
      description: null,
    });

    await checker.checkForUpdates();

    const calls = failedEmits(checker);
    expect(calls).toHaveLength(1);
    expect(calls[0][1].lastError).toMatch(/valid number/i);
  });

  it("emits with the real error text when checkForUpdates throws", async () => {
    const checker = buildChecker();
    vi.spyOn(checker, "getInstalledBuildInfo").mockRejectedValue(
      new Error("EACCES: permission denied"),
    );

    await checker.checkForUpdates();

    const calls = failedEmits(checker);
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual({ lastError: "EACCES: permission denied" });
  });

  it("does not emit the failure event on a successful check", async () => {
    const checker = buildChecker();
    mockHealthyBuildInfo(checker);

    await checker.checkForUpdates();

    expect(failedEmits(checker)).toHaveLength(0);
  });

  it("does not emit on the reentrancy guard (a check already in progress)", async () => {
    const checker = buildChecker();
    mockHealthyBuildInfo(checker);
    checker.isChecking = true;
    checker.checkStartTime = Date.now();

    await checker.checkForUpdates();

    expect(failedEmits(checker)).toHaveLength(0);
  });

  it("uses a distinct event name from the success-path events, so the existing client success handlers (which unconditionally mark the check as succeeded) never receive a failure-shaped payload", async () => {
    const checker = buildChecker();
    vi.spyOn(checker, "getInstalledBuildInfo").mockResolvedValue(null);

    await checker.checkForUpdates();

    const emittedEvents = checker.io.emit.mock.calls.map(([event]) => event);
    expect(emittedEvents).not.toContain("server:updateAvailable");
    expect(emittedEvents).not.toContain("server:updateCheck");
    expect(emittedEvents).toContain("server:updateCheckFailed");
  });
});
