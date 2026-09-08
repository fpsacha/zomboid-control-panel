import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

// bughunt-2026-08-31-c: POST /restore/:filename's primary `filename` var IS
// safe -- path.basename() + a mandatory ".bak" extension check, and neither
// "." nor ".." ends in ".bak" so both are rejected incidentally. But the
// ORIGINAL filename recovered by stripping the ".bak"+timestamp suffix
// (`originalName`, via lastIndexOf/substring) was never independently
// re-validated before this fix, despite being the value actually joined
// into a WRITE target:
//
//   const targetPath = path.join(configPath, originalName);
//   ...
//   await fs.promises.copyFile(backupPath, targetPath);
//
// A crafted (but real -- must exist in the backups dir) filename of
// "....bak" (4 literal dots + "bak") makes the lastIndexOf/substring math
// land on originalName === ".." exactly, so targetPath resolves to
// configPath's PARENT directory. Before this fix, the only thing standing
// between that and an actual traversal was fs.copyFile refusing a directory
// as source or destination -- confirmed by an isolated repro outside this
// repo to fail with EPERM on Windows (expected EISDIR on Linux, not
// independently verified there). This file asserts the FIXED (explicit
// ".", "..", and separator rejection) behavior instead of depending on that
// platform-specific incidental protection.
const getActiveServer = vi.fn();
vi.mock("../database/init.js", () => ({
  getActiveServer,
  getAllSettings: vi.fn(async () => ({})),
  getRoleByName: mockGetRoleByName,
}));

const { default: router } = await import("../routes/serverFiles.js");

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

// 2026-09-08 quadruple-read sweep: every handler now reads
// req.activeServerContext instead of re-deriving it, populated once by the
// router's own gate (a non-route layer getRouteHandlers() above never
// reaches). Run it first, on the same req.
function getGateMiddleware() {
  return router.stack.filter((entry) => !entry.route)[1].handle;
}

async function runRoute(routePath, method, req) {
  const handlers = getRouteHandlers(routePath, method);
  const res = createResponse();
  await getGateMiddleware()(req, res, () => {});
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
  return res;
}

function postRestore(filename) {
  return runRoute("/restore/:filename", "post", { params: { filename } });
}

const SERVER_NAME = "servertest";
let configDir; // <parentDir>/config -- the restore target's own directory
let parentDir;
let backupDir;

beforeEach(() => {
  parentDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-traversal-"));
  configDir = path.join(parentDir, "config");
  fs.mkdirSync(configDir, { recursive: true });
  backupDir = path.join(configDir, "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  getActiveServer.mockReset().mockResolvedValue({
    serverConfigPath: configDir,
    serverName: SERVER_NAME,
  });
});

afterEach(() => {
  fs.rmSync(parentDir, { recursive: true, force: true });
});

describe("POST /restore/:filename -- originalName must be rejected when it resolves to '.' or '..'", () => {
  it("a crafted '....bak' backup (originalName strips to '..') is rejected, not restored", async () => {
    fs.writeFileSync(path.join(backupDir, "....bak"), "MALICIOUS-PARENT-OVERWRITE");
    // Sentinel one level ABOVE configDir -- exactly what targetPath would
    // resolve to (path.join(configDir, "..") === parentDir). If the
    // traversal were live, this is what an attacker's copyFile would target.
    const sentinelPath = path.join(parentDir, "sentinel.txt");
    fs.writeFileSync(sentinelPath, "untouched");

    const res = await postRestore("....bak");

    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody()?.code).toBe("RESTORE_INVALID_ORIGINAL_NAME");
    expect(fs.readFileSync(sentinelPath, "utf8")).toBe("untouched");
  });

  it("a bare '.' equivalent ('...bak', originalName strips to '.') is also rejected", async () => {
    fs.writeFileSync(path.join(backupDir, "...bak"), "MALICIOUS-SELF-OVERWRITE");
    const res = await postRestore("...bak");
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody()?.code).toBe("RESTORE_INVALID_ORIGINAL_NAME");
  });

  it("legitimate restore is unaffected by the fix -- normal '<name>.<timestamp>.bak' still restores", async () => {
    const targetFile = path.join(configDir, `${SERVER_NAME}.ini`);
    fs.writeFileSync(targetFile, "OLD-CONTENT");
    const backupName = `${SERVER_NAME}.ini.2026-08-31T12-00-00.bak`;
    fs.writeFileSync(path.join(backupDir, backupName), "RESTORED-CONTENT");

    const res = await postRestore(backupName);

    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()?.success).toBe(true);
    expect(fs.readFileSync(targetFile, "utf8")).toBe("RESTORED-CONTENT");
  });
});
