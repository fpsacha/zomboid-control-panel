import { describe, expect, it, vi, afterEach, afterAll } from "vitest";

// LINUX BUG HUNT follow-up (2026-08-29): broadening the scan's discovery
// net to "zomboid"/"zombie.network" (see linuxScanAmbiguousProcessDetection
// .test.js for the main fix) created a new, serious risk: this panel is
// very plausibly installed in a path like /opt/zomboid-control-panel/, so
// the PANEL'S OWN long-running `node server/index.js` process genuinely
// contains "zomboid" in its own command line. Without an explicit
// exclusion, that self-match would show up as a permanent "ambiguous"
// candidate on EVERY scan, on every host running the panel from such a
// path -- meaning every genuinely-idle check would report scanFailed:true
// (unknown) forever, exactly the regression god's dispatch explicitly
// warned against ("do not swing it so far that a genuinely stopped server
// reports unknown forever").
//
// Confirmed empirically during development (not just reasoned about): a
// real WSL run from a directory named zomboid-control-panel-verify hit
// this exact self-match before the process.pid exclusion was added.
//
// This test can't rely on the real checkout path happening to contain
// "zomboid" (it won't, in CI), so it mocks child_process's exec() to
// inject a synthetic pgrep line whose PID is THIS test's own process.pid --
// the exact shape a real self-match takes -- and proves it's excluded.

const execMock = vi.fn();
vi.mock("child_process", () => ({
  exec: (...args) => execMock(...args),
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getServer: vi.fn(async () => null),
  getServers: vi.fn(async () => []),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
}));

vi.mock("../utils/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const originalPlatform = process.platform;
Object.defineProperty(process, "platform", {
  value: "linux",
  configurable: true,
});

const { ServerManager } = await import("../services/serverManager.js");

afterEach(() => {
  execMock.mockReset();
});

afterAll(() => {
  Object.defineProperty(process, "platform", {
    value: originalPlatform,
    configurable: true,
  });
});

function makeManager(overrides) {
  const manager = new ServerManager();
  Object.assign(manager, { configLoaded: true, ...overrides });
  return manager;
}

// exec() is called positionally as exec(cmd, options, callback) throughout
// serverManager.js's Linux scan path.
function mockPgrepOutput(line) {
  execMock.mockImplementation((cmd, _opts, callback) => {
    if (String(cmd).startsWith("pgrep")) {
      callback(null, line ? `${line}\n` : "");
    } else {
      callback(new Error("unexpected exec call in this test: " + cmd));
    }
  });
}

describe("getServerProcessDetails(): excludes the panel's own process from the scan", () => {
  it("a pgrep line whose PID equals process.pid is excluded entirely -- not matched, not ambiguous -- even though its command line contains 'zomboid'", async () => {
    mockPgrepOutput(
      `${process.pid} node /opt/zomboid-control-panel/server/index.js`,
    );

    const manager = makeManager({
      serverName: "AnyServer",
      savePath: "/tmp/AnyServerZomboid",
      serverPath: "/opt/AnyServer",
    });
    const details = await manager.getServerProcessDetails();

    // The panel's own process is excluded, so the scan sees nothing at all
    // -- a genuinely idle result, not "unknown".
    expect(details.running).toBe(false);
    expect(details.scanFailed).toBe(false);
  });

  it("positive control: an ambiguous candidate with a DIFFERENT pid still triggers scanFailed:true -- proves the exclusion is PID-specific, not a blanket suppression", async () => {
    const otherPid = process.pid + 1;
    mockPgrepOutput(`${otherPid} /some/launcher -jar projectzomboid.jar`);

    const manager = makeManager({
      serverName: "AnyServer",
      savePath: "/tmp/AnyServerZomboid",
      serverPath: "/opt/AnyServer",
    });
    const details = await manager.getServerProcessDetails();

    expect(details.running).toBe(false);
    expect(details.scanFailed).toBe(true);
  });
});
