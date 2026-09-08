import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "events";

// Gap #2 (god-dispatched, 2026-09-08, "harden-updater"): preflight only ever
// proved api.github.com was reachable, at the LAST check-for-updates call --
// never the actual binary download host (objects.githubusercontent.com, a
// different host GitHub serves release assets from). A firewall/proxy that
// allowlists the API host but not the CDN passed preflight clean and only
// failed once Restart and Apply tried to fetch the binary.
//
// probeDownloadHostReachable() closes that gap with the same tri-state
// discipline as probeExeDeleteAccess: only a DEFINITIVE DNS/connect failure
// (ENOTFOUND/ECONNREFUSED) becomes a warning (never a blocker); a timeout,
// reset, or any other ambiguous error must read as unknown (null) so a slow
// proxy or captive portal can never misfire into a warning that trains the
// operator to ignore it.

const mockRequest = vi.fn();
vi.mock("https", () => ({
  default: {
    request: (...args) => mockRequest(...args),
  },
}));

process.pkg = {};
const { PanelUpdateChecker } = await import("../services/panelUpdateChecker.js");

function makeReq() {
  const req = new EventEmitter();
  req.setTimeout = vi.fn();
  req.destroy = vi.fn();
  req.end = vi.fn();
  return req;
}

describe("probeDownloadHostReachable() -- HEAD reachability probe, tri-state", () => {
  afterEach(() => {
    mockRequest.mockReset();
  });

  it("returns null without making a request for an unparseable URL", async () => {
    const checker = new PanelUpdateChecker();
    const result = await checker.probeDownloadHostReachable("not a url");
    expect(result).toBeNull();
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("returns null without making a request for a non-HTTPS URL", async () => {
    const checker = new PanelUpdateChecker();
    const result = await checker.probeDownloadHostReachable(
      "http://objects.githubusercontent.com/foo",
    );
    expect(result).toBeNull();
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("returns true when the host accepts the connection and responds, regardless of status code", async () => {
    const req = makeReq();
    mockRequest.mockImplementation((_url, _opts, callback) => {
      callback({ resume: vi.fn(), statusCode: 403 });
      return req;
    });
    const checker = new PanelUpdateChecker();
    const result = await checker.probeDownloadHostReachable(
      "https://objects.githubusercontent.com/foo",
    );
    expect(result).toBe(true);
  });

  it("returns false on a definitive ENOTFOUND", async () => {
    const req = makeReq();
    mockRequest.mockImplementation(() => req);
    const checker = new PanelUpdateChecker();
    const promise = checker.probeDownloadHostReachable(
      "https://objects.githubusercontent.com/foo",
    );
    const err = new Error("getaddrinfo ENOTFOUND objects.githubusercontent.com");
    err.code = "ENOTFOUND";
    req.emit("error", err);
    expect(await promise).toBe(false);
  });

  it("returns false on a definitive ECONNREFUSED", async () => {
    const req = makeReq();
    mockRequest.mockImplementation(() => req);
    const checker = new PanelUpdateChecker();
    const promise = checker.probeDownloadHostReachable(
      "https://objects.githubusercontent.com/foo",
    );
    const err = new Error("connect ECONNREFUSED");
    err.code = "ECONNREFUSED";
    req.emit("error", err);
    expect(await promise).toBe(false);
  });

  it("returns null, never false, for an ambiguous error code -- a reset or proxy hiccup is not a verified block", async () => {
    const req = makeReq();
    mockRequest.mockImplementation(() => req);
    const checker = new PanelUpdateChecker();
    const promise = checker.probeDownloadHostReachable(
      "https://objects.githubusercontent.com/foo",
    );
    const err = new Error("socket hang up");
    err.code = "ECONNRESET";
    req.emit("error", err);
    expect(await promise).toBeNull();
  });

  it("returns null on a timeout instead of guessing -- a slow proxy or captive portal must never look like a verified block", async () => {
    let timeoutCb;
    const req = makeReq();
    req.setTimeout = vi.fn((_ms, cb) => {
      timeoutCb = cb;
    });
    mockRequest.mockImplementation(() => req);
    const checker = new PanelUpdateChecker();
    const promise = checker.probeDownloadHostReachable(
      "https://objects.githubusercontent.com/foo",
    );
    timeoutCb();
    expect(await promise).toBeNull();
    expect(req.destroy).toHaveBeenCalled();
  });
});

describe("preflight() folds the download-host probe into warnings only, never a blocker", () => {
  let scratchDir;
  let originalExecPath;

  function setExecPath(p) {
    Object.defineProperty(process, "execPath", { value: p, configurable: true });
  }

  function makeChecker(probeResult) {
    const assetName =
      process.platform === "win32"
        ? "ZomboidControlPanel.exe"
        : "ZomboidControlPanel";
    const checker = new PanelUpdateChecker();
    checker.latestRelease = {
      version: "9.9.9",
      assets: [
        {
          name: assetName,
          size: 1024,
          downloadUrl: "https://objects.githubusercontent.com/fake-asset",
        },
      ],
    };
    checker.updateAvailable = true;
    vi.spyOn(checker, "getFreeDiskSpace").mockResolvedValue(1024 * 1024 * 1024 * 10);
    vi.spyOn(checker, "probeDownloadHostReachable").mockResolvedValue(probeResult);
    return checker;
  }

  function warning(result) {
    return result.warningDetails.find(
      (w) => w.key === "updates.preflight.downloadHostUnreachable",
    );
  }

  function setupRealDir() {
    originalExecPath = process.execPath;
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-dlhost-"));
    const assetName =
      process.platform === "win32"
        ? "ZomboidControlPanel.exe"
        : "ZomboidControlPanel";
    const fakeExePath = path.join(scratchDir, assetName);
    fs.writeFileSync(fakeExePath, "fake-exe");
    setExecPath(fakeExePath);
  }

  afterEach(() => {
    if (scratchDir) fs.rmSync(scratchDir, { recursive: true, force: true });
    scratchDir = undefined;
    if (originalExecPath) setExecPath(originalExecPath);
    originalExecPath = undefined;
  });

  it("warns, without blocking, on a verified-unreachable download host", async () => {
    setupRealDir();
    const result = await makeChecker(false).preflight();
    expect(warning(result)).toBeDefined();
    expect(warning(result).params.host).toBe("objects.githubusercontent.com");
    expect(
      result.blockerDetails.some(
        (b) => b.key === "updates.preflight.downloadHostUnreachable",
      ),
    ).toBe(false);
  });

  it("stays silent when the probe confirms the host reachable", async () => {
    setupRealDir();
    const result = await makeChecker(true).preflight();
    expect(warning(result)).toBeUndefined();
  });

  it("stays silent when the probe is inconclusive -- must not become furniture on a healthy install", async () => {
    setupRealDir();
    const result = await makeChecker(null).preflight();
    expect(warning(result)).toBeUndefined();
  });
});
