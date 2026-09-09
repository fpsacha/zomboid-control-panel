import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// docker-unraid-onboarding, 2026-09-09: Pam's containerMountInfo.js
// (describeContainerMountPoints(), via /proc/self/mountinfo, no Docker
// socket needed) can tell "a genuine bind mount that's just empty" apart
// from "an ordinary directory baked into the image that nothing was ever
// bound to" -- something fs.existsSync/statSync alone structurally cannot
// do. scanAllCandidates()'s plain "empty" status collapsed both into one
// answer before this integration; these tests prove it no longer does,
// isolated from mountDiscovery.test.js's own suite (which exercises the
// REAL containerMountInfo module, harmlessly null-mounted on a dev
// machine with no /proc) so this file's mock doesn't leak into tests that
// don't need it.
const describeContainerMountPoints = vi.fn();
vi.mock("../utils/containerMountInfo.js", () => ({
  describeContainerMountPoints: (...args) => describeContainerMountPoints(...args),
}));

const { scanAllCandidates } = await import("../services/mountDiscovery.js");

let tmpRoot;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pz-mount-info-integration-"));
  describeContainerMountPoints.mockReset();
});

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("scanAllCandidates: containerMountInfo integration for the 'empty' status", () => {
  it("reports 'not-mounted' with the volume-mapping reason for a container-convention candidate that fs sees as an empty directory but mountinfo says was never bound", () => {
    // Simulate the exact shape god/Pam described: /pz-server exists (the
    // image bakes an empty placeholder directory in), but nothing was ever
    // bind-mounted there.
    vi.spyOn(fs, "statSync").mockImplementation((p) => {
      if (p === "/pz-server") return { isDirectory: () => true };
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    vi.spyOn(fs, "readdirSync").mockImplementation((p) => (p === "/pz-server" ? [] : []));
    describeContainerMountPoints.mockImplementation((paths) =>
      paths.map((p) => ({ path: p, mounted: p === "/pz-server" ? false : null })),
    );

    const results = scanAllCandidates();
    const pzServer = results.find((r) => r.installPath === "/pz-server");
    expect(pzServer.status).toBe("not-mounted");
    expect(pzServer.reason).toMatch(/add a volume mapping/i);
  });

  it("keeps 'empty' but with a sharper, mount-confirmed reason when mountinfo confirms a real mount that's genuinely empty", () => {
    vi.spyOn(fs, "statSync").mockImplementation((p) => {
      if (p === "/pz-server") return { isDirectory: () => true };
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    vi.spyOn(fs, "readdirSync").mockImplementation(() => []);
    describeContainerMountPoints.mockImplementation((paths) =>
      paths.map((p) => ({ path: p, mounted: p === "/pz-server" ? true : null })),
    );

    const results = scanAllCandidates();
    const pzServer = results.find((r) => r.installPath === "/pz-server");
    expect(pzServer.status).toBe("empty");
    expect(pzServer.reason).toMatch(/correctly mounted, but nothing has been saved/i);
  });

  it("falls back to the existing plain-fs 'empty' reason, unchanged, when mountinfo cannot be read at all (mounted: null)", () => {
    vi.spyOn(fs, "statSync").mockImplementation((p) => {
      if (p === "/pz-server") return { isDirectory: () => true };
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    vi.spyOn(fs, "readdirSync").mockImplementation(() => []);
    describeContainerMountPoints.mockImplementation((paths) =>
      paths.map((p) => ({ path: p, mounted: null })),
    );

    const results = scanAllCandidates();
    const pzServer = results.find((r) => r.installPath === "/pz-server");
    expect(pzServer.status).toBe("empty");
    expect(pzServer.reason).toMatch(/doesn't look like a project zomboid/i);
  });

  it("never calls describeContainerMountPoints for a bare-metal or environment-sourced candidate, even when empty -- mount semantics don't apply there", () => {
    const installDir = path.join(tmpRoot, "install");
    fs.mkdirSync(installDir, { recursive: true });
    vi.stubEnv("PZ_SERVER_PATH", installDir);
    describeContainerMountPoints.mockReturnValue([]);

    scanAllCandidates();

    const calledPaths = describeContainerMountPoints.mock.calls.flatMap((call) => call[0]);
    expect(calledPaths).not.toContain(installDir);
  });
});
