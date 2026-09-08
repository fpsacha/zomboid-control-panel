import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { afterEach, describe, expect, it } from "vitest";
import { generateStartSh } from "../../build.js";

// Presence-based failed-update rollback (god's dispatch, 2026-09-08,
// "harden-updater" Q3, taken for real this time): mirrors Start.bat's
// `.update-applying`-presence check on Linux, where the equivalent signal
// is update-bundle.json + ZomboidControlPanel.bundle-previous both still
// on disk -- deliberately file-existence only, no JSON parser, matching
// restore_interrupted_update()'s own house style (see
// linuxSupervisorSelfHeal.test.js). This tests rollback_failed_update()
// itself in ISOLATION, the same way that file tests
// restore_interrupted_update() -- extracting just the function body so it
// runs portably (no setsid, no real subprocess launch) under Windows' bash
// (MSYS/Git Bash) too, not gated to a real Linux runner. The ordering
// question (why this must run AFTER exit==75/78, not before like
// Start.bat) is exercised at the full-script level in
// linuxSupervisorIntegration.test.js instead, since it depends on the main
// loop's own exit-code branches, not on this function alone.
function extractFunctionSource(scriptSource, functionName) {
  const match = scriptSource.match(
    new RegExp(`${functionName}\\(\\)\\s*\\{[\\s\\S]*?\\n\\}`),
  );
  if (!match) {
    throw new Error(`${functionName}() not found in generated start.sh -- did its shape change?`);
  }
  return match[0];
}

const FUNCTION_SOURCE = extractFunctionSource(generateStartSh(), "rollback_failed_update");

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// Captures both the function's own stdout AND its return code (echoed on
// the last line, stripped before returning) -- rollback_failed_update()'s
// success/failure is its whole contract, not just what it prints.
function runInRoot(root) {
  const wrapper = path.join(root, "run.sh");
  fs.writeFileSync(
    wrapper,
    `#!/bin/bash\ncd "$(dirname "$0")"\n${FUNCTION_SOURCE}\nrollback_failed_update\necho "EXIT:$?"\n`,
  );
  const raw = execFileSync("bash", [wrapper], { cwd: root, encoding: "utf8" });
  const lines = raw.split("\n");
  const exitLine = lines.find((l) => l.startsWith("EXIT:"));
  return {
    output: raw,
    exitCode: exitLine ? Number(exitLine.slice("EXIT:".length)) : null,
  };
}

describe("generateStartSh()'s rollback_failed_update: restores the previous build when an update never acknowledges startup", () => {
  it("sanity check: the function was actually found and looks like the real thing (guards against a silent extraction-regex break)", () => {
    expect(FUNCTION_SOURCE).toContain("ZomboidControlPanel.bundle-previous");
    expect(FUNCTION_SOURCE).toContain("dist.previous");
    expect(FUNCTION_SOURCE).toContain("update-rollback-notice.json");
  });

  it("restores the binary from its backup, removes the journal, and reports success", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-rollback-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, "ZomboidControlPanel.bundle-previous"), "old-binary-bytes");
    fs.writeFileSync(path.join(root, "update-bundle.json"), JSON.stringify({ version: "1.2.3" }));

    const { output, exitCode } = runInRoot(root);

    expect(exitCode).toBe(0);
    expect(fs.readFileSync(path.join(root, "ZomboidControlPanel"), "utf8")).toBe("old-binary-bytes");
    expect(fs.existsSync(path.join(root, "ZomboidControlPanel.bundle-previous"))).toBe(false);
    expect(fs.existsSync(path.join(root, "update-bundle.json"))).toBe(false);
    expect(output).toContain("Rollback complete");
  });

  it("restores the client dist from its backup too", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-rollback-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, "ZomboidControlPanel.bundle-previous"), "old-binary-bytes");
    fs.writeFileSync(path.join(root, "update-bundle.json"), "{}");
    fs.mkdirSync(path.join(root, "client", "dist.previous"), { recursive: true });
    fs.writeFileSync(path.join(root, "client", "dist.previous", "index.html"), "<html>old</html>");
    fs.mkdirSync(path.join(root, "client", "dist"), { recursive: true });
    fs.writeFileSync(path.join(root, "client", "dist", "index.html"), "<html>broken-new</html>");

    const { exitCode } = runInRoot(root);

    expect(exitCode).toBe(0);
    expect(fs.readFileSync(path.join(root, "client", "dist", "index.html"), "utf8")).toBe(
      "<html>old</html>",
    );
    expect(fs.existsSync(path.join(root, "client", "dist.previous"))).toBe(false);
  });

  it("leaves a durable .update-rollback-notice.json preserving the original journal content, for the Diagnostics page to surface", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-rollback-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, "ZomboidControlPanel.bundle-previous"), "old-binary-bytes");
    const journal = { version: "9.9.9", phase: "awaiting_startup_ack", appliedAt: "2026-09-08T09:00:00.000Z" };
    fs.writeFileSync(path.join(root, "update-bundle.json"), JSON.stringify(journal));

    runInRoot(root);

    const noticePath = path.join(root, ".update-rollback-notice.json");
    expect(fs.existsSync(noticePath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(noticePath, "utf8"))).toEqual(journal);
  });

  it("reports failure and retains the journal when neither the binary nor its backup can be made to exist", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-rollback-"));
    roots.push(root);
    // Deliberately no ZomboidControlPanel and no bundle-previous -- nothing
    // to restore from, and nothing currently runnable either.
    fs.writeFileSync(path.join(root, "update-bundle.json"), "{}");

    const { output, exitCode } = runInRoot(root);

    expect(exitCode).toBe(1);
    expect(fs.existsSync(path.join(root, "update-bundle.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".update-rollback-notice.json"))).toBe(false);
    expect(output).toContain("did not fully complete");
  });

  it("reports failure when the live binary path is unexpectedly a directory (rm -f cannot remove it, so the backup can never take its place)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-rollback-"));
    roots.push(root);
    // `rm -f` cannot remove a directory (no -r), so ZomboidControlPanel
    // survives as a directory and `mv bundle-previous ZomboidControlPanel`
    // moves the backup INSIDE it rather than replacing it -- the exact
    // "restore attempted but the live path still isn't a regular file"
    // shape a real permission/lock failure would also produce. restore_ok
    // must catch this rather than trust that the mv command merely ran.
    fs.mkdirSync(path.join(root, "ZomboidControlPanel"), { recursive: true });
    fs.writeFileSync(path.join(root, "ZomboidControlPanel.bundle-previous"), "old-binary-bytes");
    fs.writeFileSync(path.join(root, "update-bundle.json"), "{}");

    const { output, exitCode } = runInRoot(root);

    expect(exitCode).toBe(1);
    expect(fs.existsSync(path.join(root, "update-bundle.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".update-rollback-notice.json"))).toBe(false);
    expect(output).toContain("did not fully complete");
  });
});
