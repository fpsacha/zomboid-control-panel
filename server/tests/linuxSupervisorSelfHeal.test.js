import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { afterEach, describe, expect, it } from "vitest";
import { generateStartSh } from "../../build.js";

// State-machine sweep of the updater/supervisor surface, 2026-09-07 (god's
// dispatch): applyUpdateBundle() (services/updateBundle.js) replaces the
// LIVE Linux binary while it is still running -- rename it to
// ZomboidControlPanel.bundle-previous, then (several filesystem operations
// later) rename the staged replacement into its place. A crash, OOM-kill,
// or power loss anywhere in that window leaves NOTHING at
// ./ZomboidControlPanel to exec. Before this fix, nothing on the whole
// updater surface ever looked at ZomboidControlPanel.bundle-previous again:
// recoverInterruptedUpdateBundle() (the one function that DOES know how to
// undo an interrupted apply) has exactly two callers in the entire
// codebase, both scoped to a single live HTTP request (the exec-permission
// check inside POST /api/panel/restart, and the version-mismatch branch of
// acknowledgeUpdateBundle() at startup) -- neither of which can ever run
// again once the binary itself no longer exists to relaunch. That made this
// specific interruption window a genuine STUCK state: not "recoverable with
// manual steps" but literally unrecoverable by anything that runs code,
// because the thing that would need to run cannot start. Windows already
// had the equivalent self-heal (build.js's generateStartBat() -- a
// persistent .bat supervisor process that survives the exe's crash and can
// see the backup regardless) from tonight's earlier Start.bat fixes
// (0f3fe9f9, acb202b1); Linux's start.sh never got the same check because
// its apply logic is structurally different (in-process rename, not a
// supervisor-driven swap) -- eleven point fixes to this surface tonight,
// none of them this one.
//
// This tests restore_interrupted_update() -- the shell function this fix
// adds to generateStartSh()'s output -- in ISOLATION from the rest of the
// generated script (which also needs setsid and a real subprocess launch;
// see linuxSupervisorIntegration.test.js for that harness) by extracting
// just the function body via its own braces and sourcing it directly. Only
// `[ -f ]`/`[ -d ]`/`mv`/`chmod` are exercised, all portable enough to run
// under Windows' bash (MSYS/Git Bash) too -- unlike the full script (which
// needs `setsid`, Linux-only), this test is NOT gated to platform "linux",
// so it verifies the actual fix on every CI runner, not just one.
function extractFunctionSource(scriptSource, functionName) {
  const match = scriptSource.match(
    new RegExp(`${functionName}\\(\\)\\s*\\{[\\s\\S]*?\\n\\}`),
  );
  if (!match) {
    throw new Error(`${functionName}() not found in generated start.sh -- did its shape change?`);
  }
  return match[0];
}

const FUNCTION_SOURCE = extractFunctionSource(
  generateStartSh(),
  "restore_interrupted_update",
);

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function runInRoot(root) {
  const wrapper = path.join(root, "run.sh");
  fs.writeFileSync(wrapper, `#!/bin/bash\ncd "$(dirname "$0")"\n${FUNCTION_SOURCE}\nrestore_interrupted_update\n`);
  return execFileSync("bash", [wrapper], { cwd: root, encoding: "utf8" });
}

describe("generateStartSh()'s restore_interrupted_update: self-heals a Linux self-update interrupted mid-rename", () => {
  it("sanity check: the function was actually found and looks like the real thing (guards against a silent extraction-regex break)", () => {
    expect(FUNCTION_SOURCE).toContain("ZomboidControlPanel.bundle-previous");
    expect(FUNCTION_SOURCE).toContain("dist.previous");
  });

  it("restores the binary from its backup when the live binary is missing (the exact state an interrupted applyUpdateBundle() leaves behind)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-selfheal-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, "ZomboidControlPanel.bundle-previous"), "old-binary-bytes");

    const output = runInRoot(root);

    expect(fs.existsSync(path.join(root, "ZomboidControlPanel"))).toBe(true);
    expect(fs.existsSync(path.join(root, "ZomboidControlPanel.bundle-previous"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "ZomboidControlPanel"), "utf8")).toBe("old-binary-bytes");
    expect(output).toMatch(/is missing but a pre-update backup exists/);
  });

  it("restores the client dist from its backup when the live dist is missing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-selfheal-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, "client", "dist.previous"), { recursive: true });
    fs.writeFileSync(path.join(root, "client", "dist.previous", "index.html"), "<html>old</html>");

    runInRoot(root);

    expect(fs.existsSync(path.join(root, "client", "dist", "index.html"))).toBe(true);
    expect(fs.existsSync(path.join(root, "client", "dist.previous"))).toBe(false);
  });

  it("does NOT touch the live binary when it already exists, even if a stale backup is also present (post-successful-apply, cleanup just hasn't run yet -- must never overwrite a newer live binary with an older backup)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-selfheal-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, "ZomboidControlPanel"), "new-binary-bytes");
    fs.writeFileSync(path.join(root, "ZomboidControlPanel.bundle-previous"), "old-binary-bytes");

    const output = runInRoot(root);

    expect(fs.readFileSync(path.join(root, "ZomboidControlPanel"), "utf8")).toBe("new-binary-bytes");
    expect(fs.existsSync(path.join(root, "ZomboidControlPanel.bundle-previous"))).toBe(true);
    expect(output).not.toMatch(/restoring it/);
  });

  it("is a silent no-op when neither the binary nor a backup exists (e.g. a fresh checkout that never staged an update) -- does not fabricate a binary or throw", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-selfheal-"));
    roots.push(root);

    const output = runInRoot(root);

    expect(fs.existsSync(path.join(root, "ZomboidControlPanel"))).toBe(false);
    expect(output).not.toMatch(/restoring it/);
  });

  // POSIX exec-bit semantics don't exist on NTFS -- Git Bash/MSYS's chmod is
  // a no-op there, so this can only mean something on a real POSIX fs.
  const itLinux = process.platform === "linux" ? it : it.skip;
  itLinux("makes the restored binary executable", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-selfheal-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, "ZomboidControlPanel.bundle-previous"), "old-binary-bytes", {
      mode: 0o644,
    });

    runInRoot(root);

    const mode = fs.statSync(path.join(root, "ZomboidControlPanel")).mode;
    expect(mode & 0o111).not.toBe(0);
  });
});
