import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { buildUpdateRollbackNoticeCheck } from "../routes/debug.js";

// god's addition to Q3 (harden-updater, 2026-09-08): a presence-based
// Linux rollback (build.js's rollback_failed_update()) can succeed
// silently -- the operator ends up running an older version than the one
// they installed with nothing telling them why. rollback_failed_update()
// leaves a durable .update-rollback-notice.json breadcrumb (a plain `cp`
// of the update-bundle.json journal, before removing it) at a fixed path
// next to the panel's own binary; this turns that breadcrumb into a
// Diagnostics entry. Uses a real temp file rather than mocking fs -- the
// function's whole contract is "read this exact file shape," and a real
// file is cheaper and more faithful than a mock here.
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeInstallDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-rollback-notice-"));
  roots.push(root);
  return root;
}

describe("buildUpdateRollbackNoticeCheck (update.rollback diagnostics check)", () => {
  it("returns null when no notice file exists (the normal case)", () => {
    const installDir = makeInstallDir();

    expect(buildUpdateRollbackNoticeCheck(installDir, "1.2.18")).toBeNull();
  });

  it("returns null when the notice file is not valid JSON (never crashes the whole /diagnostics handler over a malformed breadcrumb)", () => {
    const installDir = makeInstallDir();
    fs.writeFileSync(path.join(installDir, ".update-rollback-notice.json"), "not json{{{");

    expect(buildUpdateRollbackNoticeCheck(installDir, "1.2.18")).toBeNull();
  });

  it("warns, naming the failed version and the currently-running version, when a notice is present", () => {
    const installDir = makeInstallDir();
    fs.writeFileSync(
      path.join(installDir, ".update-rollback-notice.json"),
      JSON.stringify({ version: "1.2.19", phase: "rolled_back" }),
    );

    const check = buildUpdateRollbackNoticeCheck(installDir, "1.2.18");

    expect(check).not.toBeNull();
    expect(check.id).toBe("update.rollback");
    expect(check.status).toBe("warn");
    expect(check.category).toBe("updates");
    expect(check.message).toContain("1.2.19");
    expect(check.message).toContain("1.2.18");
    expect(check.params).toEqual({ version: "1.2.19", currentVersion: "1.2.18" });
  });

  it("falls back to a generic description when the notice file is missing its version field", () => {
    const installDir = makeInstallDir();
    fs.writeFileSync(path.join(installDir, ".update-rollback-notice.json"), JSON.stringify({}));

    const check = buildUpdateRollbackNoticeCheck(installDir, "1.2.18");

    expect(check.message).toContain("an update");
    expect(check.params.version).toBe("an update");
  });

  it("falls back to '?' for the current version when none is provided", () => {
    const installDir = makeInstallDir();
    fs.writeFileSync(
      path.join(installDir, ".update-rollback-notice.json"),
      JSON.stringify({ version: "1.2.19" }),
    );

    const check = buildUpdateRollbackNoticeCheck(installDir, undefined);

    expect(check.params.currentVersion).toBe("?");
  });
});
