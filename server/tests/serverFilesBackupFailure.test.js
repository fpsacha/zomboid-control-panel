import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Regression coverage for the createBackup() fix (docs/qa/kevin-route-hunt.md
// Finding 2, authorised and ruled on by god): createBackup() used to return
// null for two completely different situations -- "nothing to back up"
// (benign) and "the backup failed" (dangerous) -- and every one of its 11
// call sites in serverFiles.js discarded the return value either way. This
// forces REAL backup failures (not a mocked createBackup) through the real
// function, per the explicit instruction not to prove a branch merely runs.
//
// The technique: pre-create a plain FILE at the exact path the backup
// directory should be. fs.promises.mkdir(that path, {recursive:true}) then
// genuinely fails (EEXIST/ENOTDIR) because it cannot create a directory
// where a non-directory file already exists -- a real, deterministic,
// platform-portable failure. Verified against both a real Windows temp dir
// and Node's own fs semantics before writing these tests; chmod-readonly
// and open file handles are known (per tonight's floor) to silently fail
// to block operations on this platform, so this file avoids both.

const getActiveServer = vi.fn();
const getAllSettings = vi.fn();

vi.mock("../database/init.js", () => ({
  getActiveServer,
  getAllSettings,
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

const { default: router } = await import("../routes/serverFiles.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

// Grabs the route's final handler, skipping every middleware ahead of it
// (the permission gate, the "server must be stopped" guard) -- this file is
// only exercising createBackup()'s own contract and how each handler reacts
// to it, which the gate tests elsewhere already cover independently.
function getHandler(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

// 2026-09-08 quadruple-read sweep: every handler now reads
// req.activeServerContext instead of re-deriving it, populated once by the
// router's own gate -- one of the middleware layers this file's getHandler()
// deliberately skips. Run that ONE gate first, on the same req, since every
// handler below now depends on it; still skip everything else ahead of the
// handler, matching this file's own stated scope.
function getGateMiddleware() {
  return router.stack.filter((entry) => !entry.route)[1].handle;
}

async function runHandler(routePath, method, req) {
  const res = createResponse();
  await getGateMiddleware()(req, res, () => {});
  await getHandler(routePath, method)(req, res, () => {});
  return res;
}

/** Break the backup dir a specific way: a plain file sits where the backup
 * directory needs to be created, so mkdir(recursive:true) genuinely fails. */
function sabotageBackupDir(configPath) {
  fs.writeFileSync(path.join(configPath, "backups"), "not a directory");
}

describe("createBackup() itself: distinguishes no-source from a real failure", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-backup-fail-unit-"));
    getActiveServer.mockReset();
    getAllSettings.mockReset();
    getAllSettings.mockResolvedValue({});
    getActiveServer.mockResolvedValue({
      serverConfigPath: tmpDir,
      serverName: "TestServer",
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns backedUp:false, reason:no-source when the file doesn't exist -- benign, not a failure", async () => {
    // Exercised indirectly through PUT /ini writing a brand-new file: no
    // prior INI exists, so no backup attempt should even be made, and the
    // write must still succeed with no warning.
    const res = await runHandler("/ini", "put", {
      body: { settings: { PublicName: "Test" } },
    });
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
    const payload = res.json.mock.calls[0][0];
    expect(payload.backupWarning).toBeUndefined();
  });

  it("returns 400 for a missing INI-save body", async () => {
    const res = await runHandler("/ini", "put", { body: null });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "INI_SETTINGS_REQUIRED" }),
    );
  });

  it("a real backup failure on an existing file produces backedUp:false, reason:failed with the actual error", async () => {
    const iniPath = path.join(tmpDir, "TestServer.ini");
    fs.writeFileSync(iniPath, "PublicName=Old\n");
    sabotageBackupDir(tmpDir);

    const res = await runHandler("/ini", "put", {
      body: { settings: { PublicName: "New" } },
    });

    // PUT /ini is an "ordinary edit" site: the write must still go through...
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
    expect(fs.readFileSync(iniPath, "utf-8")).toContain("PublicName=New");
    // ...but the response must tell the truth about the backup.
    const payload = res.json.mock.calls[0][0];
    expect(payload.backupWarning).toMatch(/could not back up/i);
  });
});

describe("PUT /ini (an 'ordinary edit' site): backup failure never blocks the edit, but is never hidden either", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-backup-fail-ini-"));
    getActiveServer.mockReset();
    getAllSettings.mockReset();
    getAllSettings.mockResolvedValue({});
    getActiveServer.mockResolvedValue({
      serverConfigPath: tmpDir,
      serverName: "TestServer",
    });
    fs.writeFileSync(path.join(tmpDir, "TestServer.ini"), "PublicName=Old\n");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a SUCCESSFUL backup still lets the edit through and carries no warning", async () => {
    const res = await runHandler("/ini", "put", {
      body: { settings: { PublicName: "New" } },
    });
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
    const payload = res.json.mock.calls[0][0];
    expect(payload.backupWarning).toBeUndefined();
    // A real backup file must actually exist -- not just "no warning".
    const backups = fs.readdirSync(path.join(tmpDir, "backups"));
    expect(backups.some((f) => f.startsWith("TestServer.ini."))).toBe(true);
  });

  it("a FAILED backup still lets the edit through, but says so", async () => {
    sabotageBackupDir(tmpDir);
    const res = await runHandler("/ini", "put", {
      body: { settings: { PublicName: "New" } },
    });
    expect(res.status).not.toHaveBeenCalledWith(500);
    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true);
    expect(payload.backupWarning).toMatch(/could not back up/i);
    expect(
      fs.readFileSync(path.join(tmpDir, "TestServer.ini"), "utf-8"),
    ).toContain("PublicName=New");
  });
});

describe("POST /sandbox/repair (the ONE unrecoverable-operation site): refuses to repair when the backup fails", () => {
  let tmpDir;

  function corruptSandbox() {
    // Missing a nested block header -- the exact orphaned-scalar shape
    // repairSandboxSyntax() knows how to fix (see its own header comment):
    // a scalar "key = value" line (no trailing comma) immediately followed
    // by a MORE-indented entry line, with a dangling extra "}" below --
    // the shape produced when a "<Name> = {" header line got dropped
    // upstream. One closing brace with no matching opener: unbalanced,
    // depth goes negative -- checkSandboxBraceBalance() must reject this
    // as-is, and repairSandboxSyntax() must be able to fix it by
    // synthesizing the missing wrapper table.
    const content = [
      "Vehicles = {",
      "    OrphanKey = true",
      "        NestedKey = 5,",
      "    }",
      "}",
    ].join("\n");
    fs.writeFileSync(
      path.join(tmpDir, "TestServer_SandboxVars.lua"),
      content,
    );
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-backup-fail-repair-"));
    getActiveServer.mockReset();
    getAllSettings.mockReset();
    getAllSettings.mockResolvedValue({});
    getActiveServer.mockResolvedValue({
      serverConfigPath: tmpDir,
      serverName: "TestServer",
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a SUCCESSFUL backup lets the repair proceed and names the real backup in the message", async () => {
    corruptSandbox();
    const res = await runHandler("/sandbox/repair", "post", {});

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, repaired: true }),
    );
    const payload = res.json.mock.calls[0][0];
    expect(payload.message).toMatch(/backup of the broken file was saved first/i);
    const backups = fs.readdirSync(path.join(tmpDir, "backups"));
    expect(
      backups.some((f) => f.startsWith("TestServer_SandboxVars.lua.")),
    ).toBe(true);
  });

  it("a FAILED backup refuses the repair outright -- the corrupted file is left completely untouched", async () => {
    corruptSandbox();
    const originalContent = fs.readFileSync(
      path.join(tmpDir, "TestServer_SandboxVars.lua"),
      "utf-8",
    );
    sabotageBackupDir(tmpDir);

    const res = await runHandler("/sandbox/repair", "post", {});

    expect(res.status).toHaveBeenCalledWith(422);
    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(false);
    expect(payload.error).toMatch(/could not back up/i);
    expect(payload.code).toBe("SANDBOX_REPAIR_BACKUP_FAILED");
    // The underlying fs error must reach the wire as params.reason -- not
    // just embedded, unresolvable, in the English `error` string. Proves
    // the withFileLock result object's params field survives the
    // result.code-style threading through to res.json().
    expect(payload.params).toEqual({ reason: expect.any(String) });
    expect(payload.params.reason.length).toBeGreaterThan(0);
    // The file must be byte-for-byte untouched -- refusal, not a partial write.
    expect(
      fs.readFileSync(path.join(tmpDir, "TestServer_SandboxVars.lua"), "utf-8"),
    ).toBe(originalContent);
  });
});
