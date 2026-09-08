import { afterEach, describe, expect, it, vi } from "vitest";

// wrapper-bypass/sibling-instrumentation class sweep, 2026-09-08:
// checkForUpdates() used to have no lastError-equivalent field at all --
// every failure path (missing config, getInstalledBuildInfo/
// getLatestBuildInfo returning nothing, an invalid build-id parse, the
// catch-all) just logged server-side and returned null. This runs
// unattended (start()'s initial post-boot check plus an unconditional
// setInterval forever, both fire-and-forget), so a persistent
// misconfiguration or a blocked Steam API failed silently for as long as it
// lasted, with no signal reaching an operator who wasn't the one person who
// happened to click "Check Now" at the exact moment. Mirrors
// panelUpdateChecker.js's existing lastError convention exactly: set on
// every failure path, cleared on any check that reached a real answer.

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

afterEach(() => {
  vi.restoreAllMocks();
  settingsOverride = {};
});

describe("UpdateChecker.checkForUpdates sets lastError on every failure path", () => {
  it("sets lastError when steamcmdPath/serverPath are not configured", async () => {
    settingsOverride = { steamcmdPath: null };
    const checker = buildChecker();

    const result = await checker.checkForUpdates();

    expect(result).toBeNull();
    expect(checker.lastError).toMatch(/not configured/i);
  });

  it("sets lastError when the installed build cannot be determined", async () => {
    const checker = buildChecker();
    vi.spyOn(checker, "getInstalledBuildInfo").mockResolvedValue(null);

    const result = await checker.checkForUpdates();

    expect(result).toBeNull();
    expect(checker.lastError).toMatch(/installed build/i);
  });

  it("sets lastError when the latest build info cannot be fetched from Steam", async () => {
    const checker = buildChecker();
    vi.spyOn(checker, "getInstalledBuildInfo").mockResolvedValue({
      buildId: "100",
      branch: "public",
      lastUpdated: null,
    });
    vi.spyOn(checker, "getLatestBuildInfo").mockResolvedValue(null);

    const result = await checker.checkForUpdates();

    expect(result).toBeNull();
    expect(checker.lastError).toMatch(/latest build info/i);
  });

  it("sets lastError on an invalid (non-numeric) build ID", async () => {
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

    const result = await checker.checkForUpdates();

    expect(result).toBeNull();
    expect(checker.lastError).toMatch(/valid number/i);
  });

  it("sets lastError to the real error message when checkForUpdates throws", async () => {
    const checker = buildChecker();
    vi.spyOn(checker, "getInstalledBuildInfo").mockRejectedValue(
      new Error("EACCES: permission denied"),
    );

    const result = await checker.checkForUpdates();

    expect(result).toBeNull();
    expect(checker.lastError).toBe("EACCES: permission denied");
  });

  it("clears lastError on a check that reaches a real answer, even right after a prior failure", async () => {
    const checker = buildChecker();
    vi.spyOn(checker, "getInstalledBuildInfo").mockResolvedValueOnce(null);
    await checker.checkForUpdates();
    expect(checker.lastError).not.toBeNull();

    mockHealthyBuildInfo(checker);
    const result = await checker.checkForUpdates();

    expect(result).not.toBeNull();
    expect(checker.lastError).toBeNull();
  });

  // Kevin's client design (2026-09-08): the badge must distinguish NEVER
  // SUCCEEDED (show unknown) from SUCCEEDED THEN FAILED (keep showing the
  // last real, still-probably-true answer) -- flipping a genuine prior
  // "update available" to unknown on one transient failure would be a false
  // claim in the other direction. This class supports that distinction
  // exactly the way panelUpdateChecker.js's latestRelease/lastError pair
  // already does: this.updateAvailable is a SEPARATE field from lastError
  // and is only ever written on a successful check (see the success path
  // above), so a failure after a prior success retains the last real
  // result instead of clearing it. Client derivation: updateAvailable===null
  // means never succeeded (render unknown); updateAvailable!==null with
  // lastError!==null means succeeded-then-failed (keep showing the stale
  // but real result); updateAvailable!==null with lastError===null means
  // a clean, current answer.
  it("retains the last real result (does not null it out) when a LATER check fails -- proves the succeeded-then-failed state is distinguishable from never-succeeded", async () => {
    const checker = buildChecker();
    mockHealthyBuildInfo(checker);
    const first = await checker.checkForUpdates();
    expect(first).not.toBeNull();
    expect(checker.updateAvailable).not.toBeNull();
    const resultAfterSuccess = checker.updateAvailable;

    vi.spyOn(checker, "getInstalledBuildInfo").mockResolvedValueOnce(null);
    const second = await checker.checkForUpdates();

    expect(second).toBeNull();
    expect(checker.lastError).not.toBeNull();
    // The real prior answer is still there, byte-identical -- not cleared,
    // not replaced with a guess.
    expect(checker.updateAvailable).toBe(resultAfterSuccess);

    const status = await checker.getStatus();
    expect(status.updateAvailable).toBe(resultAfterSuccess);
    expect(status.lastError).not.toBeNull();
  });

  it("never-succeeded state is distinguishable from succeeded-then-failed: updateAvailable stays null when EVERY check has failed", async () => {
    const checker = buildChecker();
    vi.spyOn(checker, "getInstalledBuildInfo").mockResolvedValue(null);

    await checker.checkForUpdates();
    await checker.checkForUpdates();
    const status = await checker.getStatus();

    expect(status.updateAvailable).toBeNull();
    expect(status.lastError).not.toBeNull();
  });

  it("surfaces lastError through getStatus() alongside updateAvailable/lastCheck", async () => {
    const checker = buildChecker();
    vi.spyOn(checker, "getInstalledBuildInfo").mockResolvedValue(null);

    await checker.checkForUpdates();
    const status = await checker.getStatus();

    expect(status.lastError).toMatch(/installed build/i);
  });

  it("does not touch lastError on the reentrancy guard (a check already in progress)", async () => {
    const checker = buildChecker();
    mockHealthyBuildInfo(checker);
    checker.isChecking = true;
    checker.checkStartTime = Date.now();

    const result = await checker.checkForUpdates();

    expect(result).toBe(checker.updateAvailable);
    expect(checker.lastError).toBeNull();
  });
});
