import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// chunks-routes-have-no-tests (Dwight's original finding, predates tonight):
// chunks.js gates three routes on chunks.manage -- /save-path, /delete-chunks
// and /delete-region. Re-checked rather than re-derived (per the dispatch):
// delete-chunks/delete-region turned out to be fully covered by two existing
// files -- chunksRoutesCapability.test.js proves the gate on all three
// routes, chunksDeletionLogic.test.js exhaustively proves delete-chunks/
// delete-region's actual deletion behaviour (B42/B41 detection, cell-aux
// cleanup, region inversion, partial failures, vehicle pruning, the
// SERVER_STATE_UNKNOWN fail-closed guard). /save-path's gate is covered by
// the same file -- its BEHAVIOUR never was, anywhere in the suite (grepped).
// This file is that missing piece: what a request to /save-path actually
// does, not just who's allowed to send it.
//
// HARNESS CHOICE, justified in one line per the card: same runRoute
// (stitch the matched route's own two-handler stack: gate + handler)
// approach chunksDeletionLogic.test.js already established for this exact
// file, not routeRoleSweep's single-layer runner (chunks.js's gate is
// per-route, not router-level, so there's no router.use() layer to reach in
// the first place) and not a full-stack HTTP server (no auth-exemption
// coupling to prove here, unlike the thumbnail fix -- the gate is a plain
// requirePermission check already proven correct in isolation by
// chunksRoutesCapability.test.js).
//
// Real temp directories, not fs mocking -- chunks.js pulls in the logger,
// which does real fs.mkdirSync + winston file transports at module load
// time (see chunksDeletionLogic.test.js's header for the same note).

// Custom role, on top of the shared admin/technician/moderator fixture --
// holds chunks.manage and NOTHING else, the exact caller the 2026-08-27
// server.configure gate exists to stop. mockGetRoleByName only knows the
// three seeded roles, so this file wraps it rather than editing the shared
// fixture.
const getRoleByName = vi.fn(async (name) =>
  name === "chunks_manage_only"
    ? { capabilities: ["chunks.manage"] }
    : mockGetRoleByName(name),
);

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
  updateServer: vi.fn(),
  setSetting: vi.fn(),
  // Defaults to "no legacy zomboidDataPath stored" -- matches every
  // existing test's getActiveServer fixture below, none of which sets a
  // zomboidDataPath on the active-server row either, so currentPath
  // resolves to null and every persisted-path test below is exercising a
  // genuine CHANGE (validated !== null), same as it always implicitly was.
  getSetting: vi.fn(async () => null),
  getRoleByName,
}));

const { getActiveServer, updateServer, setSetting, getSetting } = await import("../database/init.js");
const { default: router } = await import("../routes/chunks.js");

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

function getRouteHandlers(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${routePath} route registered`);
  return layer.route.stack.map((s) => s.handle);
}

async function runRoute(routePath, method, req) {
  const handlers = getRouteHandlers(routePath, method);
  const res = createResponse();
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
  return res;
}

function postSavePath(body, role = "technician") {
  return runRoute("/save-path", "post", { user: { role }, body });
}

describe("POST /save-path", () => {
  let zomboidDir;

  beforeEach(() => {
    getActiveServer.mockReset();
    // Real database/init.js semantics: updateServer() resolves to the
    // updated server record on success, null if the id no longer exists.
    // Defaulting to a truthy stand-in here (not undefined) matches that --
    // the specific "server vanished mid-request" case below overrides this
    // per-test with mockResolvedValueOnce(null).
    updateServer.mockReset().mockResolvedValue({ id: "srv-1" });
    setSetting.mockReset().mockResolvedValue(undefined);
    getSetting.mockReset().mockResolvedValue(null);
    getRoleByName.mockClear();
    // Named with "Zomboid" so inspectZomboidPath() accepts it purely on the
    // path-marker check -- same trick chunksScan.test.js's fixtures use --
    // without needing real save-artifact files for the "valid path" cases.
    zomboidDir = fs.mkdtempSync(path.join(os.tmpdir(), "chunks-savepath-Zomboid-"));
  });

  afterEach(() => {
    fs.rmSync(zomboidDir, { recursive: true, force: true });
  });

  describe("input validation, before any path even touches disk", () => {
    it("missing path -> 400 CHUNKS_SAVE_PATH_MISSING", async () => {
      const res = await postSavePath({});
      expect(res.getStatusCode()).toBe(400);
      expect(res.getBody()).toMatchObject({ code: "CHUNKS_SAVE_PATH_MISSING" });
      expect(updateServer).not.toHaveBeenCalled();
      expect(setSetting).not.toHaveBeenCalled();
    });

    it("non-string path -> 400 CHUNKS_SAVE_PATH_MISSING, not a type coercion attempt", async () => {
      const res = await postSavePath({ path: 12345 });
      expect(res.getStatusCode()).toBe(400);
      expect(res.getBody()).toMatchObject({ code: "CHUNKS_SAVE_PATH_MISSING" });
    });

    it("a quote-only path collapses to empty after normalization -> 400 CHUNKS_SAVE_PATH_EMPTY, not CHUNKS_SAVE_PATH_MISSING (this exercises the validated-but-empty branch, distinct from the raw-empty check above)", async () => {
      const res = await postSavePath({ path: '""' });
      expect(res.getStatusCode()).toBe(400);
      expect(res.getBody()).toMatchObject({ code: "CHUNKS_SAVE_PATH_EMPTY" });
    });
  });

  describe("filesystem validation -- resolveCustomOrDefaultDataPath's rejections propagate with their own statusCode and details", () => {
    it("a path that does not exist on disk -> 400, rejection.reason 'not-found'", async () => {
      const missing = path.join(zomboidDir, "does-not-exist");
      const res = await postSavePath({ path: missing });
      expect(res.getStatusCode()).toBe(400);
      expect(res.getBody().rejection).toMatchObject({ reason: "not-found" });
      expect(updateServer).not.toHaveBeenCalled();
      expect(setSetting).not.toHaveBeenCalled();
    });

    it("a path that exists but is a FILE, not a directory -> 400, rejection.reason 'not-a-directory'", async () => {
      const filePath = path.join(zomboidDir, "not-a-dir.txt");
      fs.writeFileSync(filePath, "x");
      const res = await postSavePath({ path: filePath });
      expect(res.getStatusCode()).toBe(400);
      expect(res.getBody().rejection).toMatchObject({ reason: "not-a-directory" });
    });

    // SECURITY (2026-09-05, env-var-expansion-oracle): resolveCustomOrDefaultDataPath
    // runs the submitted path through normalizeUserPath(), which expands
    // %VAR%/${VAR}/$VAR from process.env. Before the fix, the "not-found"
    // rejection's message AND rejection.tried echoed that EXPANDED value --
    // a chunks.manage-only caller (no admin, no diagnostics.manage) could
    // read any process-environment secret (JWT_SECRET, RCON_PASSWORD, ...)
    // one request at a time via path="%SOME_SECRET%". The fix must echo the
    // caller's raw literal instead, in both the message and rejection.tried.
    it("an env-var-shaped path never echoes the EXPANDED secret back -- only the caller's literal input", async () => {
      process.env.ZCP_TEST_LEAK_SECRET = "super-secret-value-should-not-leak";
      try {
        const res = await postSavePath({ path: "%ZCP_TEST_LEAK_SECRET%" });
        expect(res.getStatusCode()).toBe(400);
        expect(res.getBody().rejection).toMatchObject({ reason: "not-found" });
        expect(res.getBody().rejection.tried).toBe("%ZCP_TEST_LEAK_SECRET%");
        expect(res.getBody().rejection.tried).not.toContain("super-secret-value-should-not-leak");
        expect(res.getBody().error).not.toContain("super-secret-value-should-not-leak");
      } finally {
        delete process.env.ZCP_TEST_LEAK_SECRET;
      }
    });

    it("a real directory with no Zomboid markers at all -> 403 (not 400 -- distinct from the filesystem-shape rejections above), rejection.reason 'no-zomboid-markers'", async () => {
      // A plain temp dir with no "Zomboid" in its name and no save artifacts
      // inside it -- inspectZomboidPath() has nothing to accept it on.
      const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), "not-a-save-folder-"));
      try {
        const res = await postSavePath({ path: plainDir });
        expect(res.getStatusCode()).toBe(403);
        expect(res.getBody().rejection).toMatchObject({ reason: "no-zomboid-markers" });
      } finally {
        fs.rmSync(plainDir, { recursive: true, force: true });
      }
    });
  });

  describe("a valid path is persisted to the right place", () => {
    it("an active server with an id -> updateServer(id, {zomboidDataPath}), never touches the legacy setting", async () => {
      getActiveServer.mockResolvedValue({ id: "srv-1", name: "Main" });
      const res = await postSavePath({ path: zomboidDir });

      expect(res.getStatusCode()).toBe(200);
      expect(res.getBody()).toMatchObject({
        ok: true,
        target: "server",
        serverId: "srv-1",
        path: path.resolve(zomboidDir),
      });
      expect(updateServer).toHaveBeenCalledWith("srv-1", {
        zomboidDataPath: path.resolve(zomboidDir),
      });
      expect(setSetting).not.toHaveBeenCalled();
    });

    it("no active server at all -> setSetting('zomboidDataPath', ...), never calls updateServer", async () => {
      getActiveServer.mockResolvedValue(null);
      const res = await postSavePath({ path: zomboidDir });

      expect(res.getStatusCode()).toBe(200);
      expect(res.getBody()).toMatchObject({
        ok: true,
        target: "setting",
        path: path.resolve(zomboidDir),
      });
      expect(setSetting).toHaveBeenCalledWith("zomboidDataPath", path.resolve(zomboidDir));
      expect(updateServer).not.toHaveBeenCalled();
    });

    it("an active server row that exists but has no id -> falls back to the legacy setting, same as no active server at all", async () => {
      getActiveServer.mockResolvedValue({ name: "Ghost", id: null });
      const res = await postSavePath({ path: zomboidDir });

      expect(res.getStatusCode()).toBe(200);
      expect(res.getBody()).toMatchObject({ ok: true, target: "setting" });
      expect(setSetting).toHaveBeenCalledWith("zomboidDataPath", path.resolve(zomboidDir));
      expect(updateServer).not.toHaveBeenCalled();
    });
  });

  // updateServer() returns null (not a thrown error) when the server id it
  // was asked to update no longer exists -- e.g. the active server profile
  // was deleted by a concurrent request between this route's getActiveServer()
  // call and its updateServer() call. Before this fix, that return value was
  // discarded and the route reported ok:true anyway even though nothing was
  // written.
  it("active server vanishes between lookup and write -> 404, not a false ok:true", async () => {
    getActiveServer.mockResolvedValue({ id: "srv-1", name: "Main" });
    updateServer.mockResolvedValueOnce(null);
    const res = await postSavePath({ path: zomboidDir });

    expect(res.getStatusCode()).toBe(404);
    expect(res.getBody().ok).not.toBe(true);
    expect(updateServer).toHaveBeenCalledWith("srv-1", {
      zomboidDataPath: path.resolve(zomboidDir),
    });
  });

  it("an unexpected error while persisting -> 500 with a sanitized message, not a raw stack leak", async () => {
    getActiveServer.mockResolvedValue({ id: "srv-1" });
    updateServer.mockRejectedValue(new Error("disk full: /var/lib/panel/data.db"));
    const res = await postSavePath({ path: zomboidDir });

    expect(res.getStatusCode()).toBe(500);
    expect(res.getBody().error).toBeTruthy();
  });

  // 2026-08-27 capability-description sweep, finding 6: this route repoints
  // the ACTIVE SERVER's entire zomboidDataPath -- the same field
  // serverManager.js/mods.js/server.js resolve Server/<name>.ini (RCON
  // password included) from -- behind a label promising chunk cleanup. A
  // chunks.manage holder could point a live server at a different real
  // Zomboid folder and have it silently pick up a different RCON password
  // on next restart. server.configure is now required IN ADDITION, but only
  // when the submitted path would actually CHANGE what's stored -- the
  // seeded technician role holds both capabilities (confirmed by reading
  // services/permissions.js's TECHNICIAN_CAPABILITIES directly, not
  // remembered), so every test above continues to pass unchanged.
  describe("server.configure required in addition to chunks.manage, enforced on CHANGE not presence", () => {
    it("chunks.manage alone is refused when the path would actually change the active server's stored value", async () => {
      getActiveServer.mockResolvedValue({ id: "srv-1", zomboidDataPath: "/old/path" });
      const res = await postSavePath({ path: zomboidDir }, "chunks_manage_only");

      expect(res.getStatusCode()).toBe(403);
      expect(res.getBody()).toMatchObject({
        code: "CHUNKS_SAVE_PATH_CAPABILITY_REQUIRED",
      });
      expect(updateServer).not.toHaveBeenCalled();
      expect(setSetting).not.toHaveBeenCalled();
    });

    it("chunks.manage alone is refused when there is no active server and the legacy setting would change", async () => {
      getActiveServer.mockResolvedValue(null);
      getSetting.mockResolvedValue("/old/legacy/path");
      const res = await postSavePath({ path: zomboidDir }, "chunks_manage_only");

      expect(res.getStatusCode()).toBe(403);
      expect(res.getBody()).toMatchObject({
        code: "CHUNKS_SAVE_PATH_CAPABILITY_REQUIRED",
      });
      expect(setSetting).not.toHaveBeenCalled();
    });

    it("chunks.manage + server.configure succeeds at repointing the active server", async () => {
      getActiveServer.mockResolvedValue({ id: "srv-1", zomboidDataPath: "/old/path" });
      const res = await postSavePath({ path: zomboidDir }, "technician");

      expect(res.getStatusCode()).toBe(200);
      expect(updateServer).toHaveBeenCalledWith("srv-1", {
        zomboidDataPath: path.resolve(zomboidDir),
      });
    });

    it("re-submitting the path already in effect needs nothing beyond chunks.manage -- no false 403 on an unchanged save", async () => {
      const resolved = path.resolve(zomboidDir);
      getActiveServer.mockResolvedValue({ id: "srv-1", zomboidDataPath: resolved });
      const res = await postSavePath({ path: zomboidDir }, "chunks_manage_only");

      expect(res.getStatusCode()).toBe(200);
      expect(updateServer).toHaveBeenCalledWith("srv-1", { zomboidDataPath: resolved });
    });

    it("re-submitting the current legacy-setting value (no active server) also needs nothing beyond chunks.manage", async () => {
      const resolved = path.resolve(zomboidDir);
      getActiveServer.mockResolvedValue(null);
      getSetting.mockResolvedValue(resolved);
      const res = await postSavePath({ path: zomboidDir }, "chunks_manage_only");

      expect(res.getStatusCode()).toBe(200);
      expect(setSetting).toHaveBeenCalledWith("zomboidDataPath", resolved);
    });
  });
});
