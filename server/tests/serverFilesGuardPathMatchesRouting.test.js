import { describe, expect, it, vi } from "vitest";

// The serverFiles guards (stopped-server gate for restore and template
// apply, running-server warning for config edits, the remote "no host
// filesystem browsing" refusal) re-read req.path instead of riding on the
// route itself. Express routes case-insensitively and accepts a trailing
// slash, so every spelling the router sends to a guarded handler must also
// trip the guard: /RESTORE/x was the #193 report, /restore/x/ the same gap
// one character later. Checked against the real router's own matching, so
// the test follows Express rather than a hand-written list of spellings.
vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => ({ isRemote: false })),
  getAllSettings: vi.fn(async () => ({})),
}));

vi.mock("../services/remoteConfigFiles.js", () => ({
  SFTP_CONFIG_PATH_KEY: "panelBridgeSftpConfigPath",
  acquireMirrorLock: vi.fn(),
  beginRemoteConfigSession: vi.fn(),
  getMirrorPath: vi.fn(),
  isRemoteConfigConfigured: vi.fn(() => false),
  pushRemoteConfigFiles: vi.fn(),
  validateRemoteConfigTransport: vi.fn(),
}));

const {
  default: router,
  isLocalConfigEdit,
  isLocalConfigOverwrite,
  isLocalOnlyPath,
} = await import("../routes/serverFiles.js");

function routeFor(method, path) {
  const verb = method.toLowerCase();
  return router.stack.find(
    (layer) => layer.route && layer.route.methods[verb] && layer.match(path),
  )?.route.path;
}

function spellings(path) {
  return [path, path.toUpperCase(), `${path}/`, `${path.toUpperCase()}/`];
}

const GUARDED = [
  { method: "POST", path: "/templates/abc/apply", guard: isLocalConfigOverwrite },
  { method: "POST", path: "/restore/servertest.ini.bak", guard: isLocalConfigOverwrite },
  { method: "POST", path: "/sandbox/world-snapshot/retire", guard: isLocalConfigOverwrite },
  { method: "PUT", path: "/ini", guard: isLocalConfigEdit },
  { method: "PUT", path: "/raw/ini", guard: isLocalConfigEdit },
  { method: "PUT", path: "/sandbox", guard: isLocalConfigEdit },
  { method: "GET", path: "/browse-files", guard: isLocalOnlyPath },
];

describe("serverFiles guards match every spelling Express routes to the guarded handler", () => {
  for (const { method, path, guard } of GUARDED) {
    const canonical = routeFor(method, path);

    it(`${method} ${path} is a real route`, () => {
      expect(canonical).toBeTruthy();
    });

    for (const variant of spellings(path)) {
      it(`${method} ${variant}`, () => {
        // Express sends this spelling to the same handler...
        expect(routeFor(method, variant)).toBe(canonical);
        // ...so the guard has to see it too.
        expect(guard({ method, path: variant })).toBe(true);
      });
    }
  }

  it("does not widen the guards to other routes", () => {
    expect(isLocalConfigOverwrite({ method: "POST", path: "/templates/" })).toBe(false);
    expect(isLocalConfigOverwrite({ method: "GET", path: "/restore/x.bak/" })).toBe(false);
    expect(isLocalConfigEdit({ method: "GET", path: "/ini/" })).toBe(false);
    expect(isLocalOnlyPath({ method: "GET", path: "/browse-files/x" })).toBe(false);
  });

  // SECURITY: req.path used to go through /\/+$/, quadratic on a long run of
  // slashes that doesn't end the path (seconds per request at 100k).
  it("reads a long run of slashes in linear time", () => {
    const run = "/".repeat(100_000);
    const started = Date.now();
    expect(isLocalOnlyPath({ method: "GET", path: `${run}browse-files` })).toBe(false);
    // Adversary pass: the run inside the path, and trailing slashes as well.
    expect(isLocalConfigEdit({ method: "PUT", path: `/ini${run}x${run}` })).toBe(false);
    expect(isLocalOnlyPath({ method: "GET", path: `/browse-files${run}` })).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
